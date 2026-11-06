import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as defaultConfig } from './config.mjs';
import { decrypt, encrypt, isValidShopDomain, randomToken, safeEqual, verifySessionToken } from './crypto.mjs';
import { createEngine, httpError } from './engine.mjs';
import { createPaymentLink, parsePaidLink, verifyRazorpayWebhook } from './razorpay.mjs';
import { createAdminClient, exchangeCodeForToken, installUrl, verifyQueryHmac, verifyWebhookHmac } from './shopify.mjs';
import { normalizePhone } from './phone.mjs';
import { openStore } from './store.mjs';
import { createWhatsApp, parseInbound, verifyWhatsAppSignature } from './whatsapp.mjs';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MAX_BODY = 1024 * 1024;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

export async function createApp({ config = defaultConfig, store, deps = {}, logger = console } = {}) {
  store ??= await openStore(config.dataDir);
  if (config.devShop && !store.getShop(config.devShop)) await seedDemo(store, config.devShop);

  const adminFor = shop => {
    const record = store.getShop(shop);
    if (!record?.accessToken) throw new Error(`No access token for ${shop}`);
    return createAdminClient({ shop, accessToken: decrypt(record.accessToken, config.appSecret), apiVersion: config.shopify.apiVersion, fetchImpl: deps.fetch });
  };
  const whatsappFor = settings => createWhatsApp({
    phoneNumberId: settings.waPhoneNumberId || config.whatsapp.phoneNumberId,
    accessToken: settings.waAccessToken || config.whatsapp.accessToken,
    graphVersion: config.whatsapp.graphVersion,
    fetchImpl: deps.fetch,
    logger,
  });

  const engine = createEngine({
    store, config, logger,
    deps: {
      admin: deps.admin || adminFor,
      whatsapp: deps.whatsapp || whatsappFor,
      createPaymentLink: deps.createPaymentLink || (args => createPaymentLink({ ...args, fetchImpl: deps.fetch })),
    },
  });

  // Webhook work runs after the 200 is sent; failures are logged, never lost silently.
  const background = (label, task) => Promise.resolve().then(task).catch(error => logger.error?.(`[${label}] ${error.stack || error.message}`));
  const pending = new Set();
  const later = (label, task) => { const p = background(label, task); pending.add(p); p.finally(() => pending.delete(p)); };

  async function handle(request, response) {
    const url = new URL(request.url, config.appUrl);
    const path = url.pathname;
    const method = request.method;
    securityHeaders(response, path, url.searchParams.get('shop'));

    if (method === 'GET' && path === '/health') return json(response, 200, { status: 'ok' });

    // ------------------------------------------------------------ OAuth install
    if (method === 'GET' && path === '/auth') {
      const shop = url.searchParams.get('shop');
      if (!isValidShopDomain(shop)) return text(response, 400, 'Missing or invalid ?shop=your-store.myshopify.com');
      const state = randomToken();
      response.setHeader('set-cookie', cookie('cn_state', state, 600));
      return redirect(response, installUrl({ shop, apiKey: config.shopify.apiKey, scopes: config.shopify.scopes, redirectUri: `${config.appUrl}/auth/callback`, state }));
    }

    if (method === 'GET' && path === '/auth/callback') {
      const shop = url.searchParams.get('shop');
      const state = url.searchParams.get('state');
      if (!isValidShopDomain(shop) || !verifyQueryHmac(url.searchParams, config.shopify.apiSecret)) return text(response, 400, 'Install request could not be verified');
      if (!safeEqual(readCookie(request, 'cn_state'), state)) return text(response, 400, 'Install session expired, please start again');
      const { accessToken, scope } = await exchangeCodeForToken({ shop, code: url.searchParams.get('code'), apiKey: config.shopify.apiKey, apiSecret: config.shopify.apiSecret, fetchImpl: deps.fetch });
      const existing = store.getShop(shop);
      await store.saveShop(shop, { accessToken: encrypt(accessToken, config.appSecret), scope, installedAt: existing?.installedAt || new Date().toISOString(), uninstalledAt: null, settings: existing?.settings || {} });
      const admin = adminFor(shop);
      try {
        const info = await admin.shopInfo();
        await store.saveShop(shop, { name: info.name, email: info.email, currency: info.currencyCode });
        await admin.registerWebhooks(config.appUrl);
      } catch (error) {
        logger.error?.(`[install] ${shop}: ${error.message}`);
        await store.logEvent(shop, 'error', { message: `Setup step failed: ${error.message}` });
      }
      await store.logEvent(shop, 'installed');
      response.setHeader('set-cookie', cookie('cn_state', '', 0));
      return redirect(response, `https://${shop}/admin/apps/${config.shopify.apiKey}`);
    }

    // ------------------------------------------------------------ embedded dashboard
    if (method === 'GET' && (path === '/app' || path === '/app/')) {
      const shop = url.searchParams.get('shop');
      if (config.devShop && !shop) return sendFile(response, 'app.html', { apiKey: config.shopify.apiKey });
      if (!isValidShopDomain(shop)) return text(response, 400, 'Open CartNudge from your Shopify admin');
      if (url.searchParams.has('hmac') && !verifyQueryHmac(url.searchParams, config.shopify.apiSecret)) return text(response, 400, 'Request could not be verified');
      if (!store.getShop(shop)?.accessToken) return redirect(response, `/auth?shop=${encodeURIComponent(shop)}`);
      return sendFile(response, 'app.html', { apiKey: config.shopify.apiKey });
    }

    // ------------------------------------------------------------ dashboard API (App Bridge session token)
    if (path.startsWith('/api/')) {
      const shop = authenticate(request);
      if (!shop) return json(response, 401, { error: 'Session expired. Reload the app from Shopify admin.' });
      if (!store.getShop(shop)?.accessToken && !config.devShop) return json(response, 401, { error: 'Store is not installed' });

      if (method === 'GET' && path === '/api/overview') {
        let subscription = store.getShop(shop)?.subscription || null;
        if (!config.devShop) {
          try {
            const live = await adminFor(shop).activeSubscription();
            subscription = live;
            await store.saveShop(shop, { subscription });
          } catch (error) { logger.error?.(`[billing] ${shop}: ${error.message}`); }
        }
        return json(response, 200, {
          shop,
          name: store.getShop(shop)?.name || shop,
          settings: engine.publicSettings(shop),
          stats: engine.stats(shop),
          events: store.listEvents(shop, 25),
          subscription,
          billingRequired: config.billing.required,
          plan: { name: config.billing.planName, parcelPriceInr: config.billing.parcelPriceInr, monthlyCapInr: config.billing.monthlyCapInr },
          whatsappLive: Boolean((engine.settingsFor(shop).waPhoneNumberId || config.whatsapp.phoneNumberId) && (engine.settingsFor(shop).waAccessToken || config.whatsapp.accessToken)),
          razorpayWebhookUrl: `${config.appUrl}/webhooks/razorpay/${shop}`,
        });
      }

      if (method === 'PUT' && path === '/api/settings') {
        return json(response, 200, { settings: await engine.updateSettings(shop, await readJson(request)) });
      }

      if (method === 'POST' && path === '/api/billing/subscribe') {
        const { parcelPriceInr, parcelPriceUsd, monthlyCapInr, monthlyCapUsd } = config.billing;
        const result = await adminFor(shop).createUsageSubscription({
          name: config.billing.planName, cappedUsd: monthlyCapUsd,
          terms: `₹${parcelPriceInr} (US$${parcelPriceUsd}) per parcel saved: a COD order cancelled before shipping or moved to prepaid. No monthly fee. Capped at ₹${monthlyCapInr} (US$${monthlyCapUsd}) per 30 days.`,
          returnUrl: `https://${shop}/admin/apps/${config.shopify.apiKey}`, test: config.billing.test,
        });
        return json(response, 200, { confirmationUrl: result.confirmationUrl });
      }

      if (method === 'POST' && path === '/api/test-message') {
        const { phone } = await readJson(request);
        const to = normalizePhone(phone);
        if (!to) return json(response, 400, { error: 'Enter a valid WhatsApp number' });
        const settings = engine.settingsFor(shop);
        const sent = await whatsappFor(settings).sendTemplate({
          to, name: `${config.whatsapp.codTemplate}_basic`, language: config.whatsapp.templateLanguage,
          bodyParams: ['there', settings.brandName || store.getShop(shop)?.name || shop, '#TEST', '₹999'],
          quickReplies: [`cn|confirm|${shop}|0`, `cn|cancel|${shop}|0`],
        });
        await store.logEvent(shop, 'test_message', { dryRun: sent.dryRun });
        return json(response, 200, { ok: true, dryRun: sent.dryRun });
      }

      return json(response, 404, { error: 'Not found' });
    }

    // ------------------------------------------------------------ Shopify webhooks (incl. mandatory compliance topics)
    if (method === 'POST' && path === '/webhooks/shopify') {
      const raw = await readBody(request);
      if (!verifyWebhookHmac(raw, request.headers['x-shopify-hmac-sha256'], config.shopify.apiSecret)) return text(response, 401, 'Invalid signature');
      const topic = String(request.headers['x-shopify-topic'] || '');
      const shop = String(request.headers['x-shopify-shop-domain'] || '');
      if (!isValidShopDomain(shop)) return text(response, 400, 'Invalid shop');
      if (!(await store.claimWebhook(request.headers['x-shopify-webhook-id'] || request.headers['x-shopify-event-id']))) return text(response, 200, 'duplicate');
      const body = JSON.parse(raw.toString('utf8') || '{}');
      text(response, 200, 'ok');
      later(`webhook ${topic}`, () => routeShopifyWebhook(topic, shop, body));
      return;
    }

    // ------------------------------------------------------------ WhatsApp Cloud API webhook
    if (method === 'GET' && path === '/webhooks/whatsapp') {
      const ok = url.searchParams.get('hub.mode') === 'subscribe' && config.whatsapp.verifyToken && safeEqual(url.searchParams.get('hub.verify_token'), config.whatsapp.verifyToken);
      return ok ? text(response, 200, url.searchParams.get('hub.challenge') || '') : text(response, 403, 'Forbidden');
    }
    if (method === 'POST' && path === '/webhooks/whatsapp') {
      const raw = await readBody(request);
      if (!verifyWhatsAppSignature(raw, request.headers['x-hub-signature-256'], config.whatsapp.appSecret)) return text(response, 401, 'Invalid signature');
      const replies = parseInbound(JSON.parse(raw.toString('utf8') || '{}'));
      text(response, 200, 'ok');
      for (const reply of replies) {
        if (!(await store.claimWebhook(`wa:${reply.id}`))) continue;
        later('whatsapp reply', () => engine.handleReply(reply));
      }
      return;
    }

    // ------------------------------------------------------------ Razorpay webhook (one URL per store, signed with that store's secret)
    const rzp = path.match(/^\/webhooks\/razorpay\/([a-z0-9-]+\.myshopify\.com)$/i);
    if (method === 'POST' && rzp) {
      const shop = rzp[1].toLowerCase();
      const raw = await readBody(request);
      const secret = store.getShop(shop) ? engine.settingsFor(shop).razorpayWebhookSecret : '';
      if (!verifyRazorpayWebhook(raw, request.headers['x-razorpay-signature'], secret)) return text(response, 401, 'Invalid signature');
      const eventId = request.headers['x-razorpay-event-id'];
      if (eventId && !(await store.claimWebhook(`rzp:${eventId}`))) return text(response, 200, 'duplicate');
      const paid = parsePaidLink(JSON.parse(raw.toString('utf8') || '{}'));
      text(response, 200, 'ok');
      if (paid && paid.shop === shop) later('razorpay paid', () => engine.handlePaidLink(paid));
      return;
    }

    // ------------------------------------------------------------ cart reminder redirect (tracks clicks)
    const cart = path.match(/^\/r\/([A-Za-z0-9_-]{6,40})$/);
    if (method === 'GET' && cart) {
      const checkout = engine.checkoutForLink(cart[1]);
      if (!checkout?.url || checkout.completedAt) return redirect(response, '/');
      await engine.recordCartClick(checkout);
      return redirect(response, checkout.url);
    }

    // ------------------------------------------------------------ public site
    if (method === 'GET') {
      const file = path === '/' ? 'index.html' : path.slice(1);
      return sendFile(response, file);
    }
    return text(response, 405, 'Method not allowed');
  }

  async function routeShopifyWebhook(topic, shop, body) {
    switch (topic) {
      case 'orders/create': return store.getShop(shop)?.accessToken ? engine.handleOrderCreated(shop, body) : null;
      case 'checkouts/create':
      case 'checkouts/update': return store.getShop(shop)?.accessToken ? engine.handleCheckout(shop, body) : null;
      case 'app/uninstalled':
        await store.saveShop(shop, { accessToken: null, uninstalledAt: new Date().toISOString(), subscription: null });
        return store.logEvent(shop, 'uninstalled');
      case 'app_subscriptions/update': {
        const sub = body?.app_subscription || {};
        const previous = store.getShop(shop)?.subscription || {};
        let subscription = { ...previous, id: sub.admin_graphql_api_id, status: String(sub.status || '').toUpperCase(), name: sub.name };
        // The webhook carries no line items; fetch them so usage charges know where to go.
        if (subscription.status === 'ACTIVE') {
          try { subscription = (await adminFor(shop).activeSubscription()) || subscription; } catch (error) { logger.error?.(`[billing] ${shop}: ${error.message}`); }
        }
        await store.saveShop(shop, { subscription });
        return store.logEvent(shop, 'subscription', { status: sub.status });
      }
      // Mandatory privacy webhooks.
      case 'customers/data_request':
        // CartNudge keeps only order status, first name and phone; the merchant already holds all of it in Shopify.
        return store.logEvent(shop, 'data_request', { orders: (body?.orders_requested || []).length });
      case 'customers/redact':
        return store.redactCustomer(shop, { email: body?.customer?.email, phone: body?.customer?.phone, orderIds: body?.orders_to_redact || [] });
      case 'shop/redact':
        return store.deleteShop(shop);
      default:
        logger.info?.(`[webhook] ignored topic ${topic}`);
    }
  }

  function authenticate(request) {
    const header = String(request.headers.authorization || '');
    if (header.startsWith('Bearer ')) {
      const session = verifySessionToken(header.slice(7), { apiKey: config.shopify.apiKey, apiSecret: config.shopify.apiSecret });
      if (session) return session.shop;
    }
    return config.devShop || null;
  }

  function securityHeaders(response, path, shop) {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
    // The dashboard is framed by Shopify admin; everything else may not be framed at all.
    const ancestors = path.startsWith('/app') && isValidShopDomain(shop) ? `https://${shop} https://admin.shopify.com` : (path.startsWith('/app') ? 'https://admin.shopify.com' : "'none'");
    response.setHeader('content-security-policy', `frame-ancestors ${ancestors}`);
  }

  async function sendFile(response, file, vars) {
    const safe = normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = join(PUBLIC_DIR, safe);
    if (!full.startsWith(PUBLIC_DIR)) return text(response, 404, 'Not found');
    try {
      let content = await readFile(full);
      if (vars) content = Buffer.from(content.toString('utf8').replace(/%%(\w+)%%/g, (_, key) => escapeHtml(vars[key] ?? '')));
      response.writeHead(200, { 'content-type': TYPES[extname(full)] || 'application/octet-stream', 'cache-control': extname(full) === '.html' ? 'no-store' : 'public, max-age=3600' });
      response.end(content);
    } catch { text(response, 404, 'Not found'); }
  }

  const server = createServer((request, response) => {
    handle(request, response).catch(error => {
      const status = error.status || 500;
      if (status >= 500) logger.error?.(`[http] ${request.method} ${request.url}: ${error.stack || error.message}`);
      if (!response.headersSent) json(response, status, { error: status >= 500 ? 'Something went wrong' : error.message });
      else response.end();
    });
  });

  let sweeper = null;
  return {
    server, store, engine,
    startSweeper() {
      sweeper = setInterval(() => background('cart sweep', () => engine.sweepCarts()), config.cartSweepMinutes * 60_000);
      sweeper.unref();
    },
    async idle() { await Promise.all([...pending]); await store.flush(); },
    async close() { clearInterval(sweeper); await new Promise(resolve => server.close(resolve)); await store.flush(); },
  };
}

// Local preview data so the dashboard has something to show without a real store.
async function seedDemo(store, shop) {
  await store.saveShop(shop, { name: 'Demo Store', installedAt: new Date().toISOString(), settings: {} });
  const day = 24 * 3600_000;
  const rows = [
    ['1001', '#1001', 1499, 'confirmed'], ['1002', '#1002', 899, 'cancel_requested'], ['1003', '#1003', 2299, 'paid_online'],
    ['1004', '#1004', 649, 'pending'], ['1005', '#1005', 1199, 'confirmed'], ['1006', '#1006', 3499, 'paid_online'],
    ['1007', '#1007', 799, 'cancel_requested'], ['1008', '#1008', 1599, 'confirmed'], ['1009', '#1009', 999, 'no_phone'],
  ];
  for (const [id, name, amount, status] of rows) {
    await store.saveOrder(shop, id, { name, amount, status, customerName: 'Demo', phone: status === 'no_phone' ? null : '919800000000',
      messagedAt: status === 'no_phone' ? undefined : new Date(Date.now() - day).toISOString(),
      paidAmount: status === 'paid_online' ? amount - 50 : undefined });
    const type = { confirmed: 'confirmed', cancel_requested: 'cancel_requested', paid_online: 'paid_online', pending: 'cod_message_sent', no_phone: 'no_phone' }[status];
    await store.logEvent(shop, type, { orderId: id, order: name, amount: status === 'paid_online' ? amount - 50 : amount });
  }
  await store.saveCheckout(shop, 'demo1', { phone: '919800000000', url: 'https://example.com', total: 1899, remindedAt: new Date().toISOString(), clickedAt: new Date().toISOString(), recoveredAt: new Date().toISOString(), recoveredValue: 1899, completedAt: new Date().toISOString(), linkId: 'demolink1' });
  await store.saveCheckout(shop, 'demo2', { phone: '919800000001', url: 'https://example.com', total: 1299, remindedAt: new Date().toISOString(), linkId: 'demolink2' });
  await store.logEvent(shop, 'cart_recovered', { order: '#1010', amount: 1899 });
}

// ---------------------------------------------------------------- tiny HTTP helpers

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}
function text(response, status, body) {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(body);
}
function redirect(response, location) {
  response.writeHead(302, { location });
  response.end();
}
function cookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}
function readCookie(request, name) {
  const match = String(request.headers.cookie || '').split(/;\s*/).find(part => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : '';
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw httpError(413, 'Body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function readJson(request) {
  const raw = await readBody(request);
  try { return JSON.parse(raw.toString('utf8') || '{}'); } catch { throw httpError(400, 'Invalid JSON'); }
}

// ---------------------------------------------------------------- entry point

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const missing = ['SHOPIFY_API_KEY', 'SHOPIFY_API_SECRET', 'APP_SECRET', 'APP_URL'].filter(key => !process.env[key]);
  if (missing.length && defaultConfig.production) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (missing.length) console.warn(`[cartnudge] running without ${missing.join(', ')} — local preview only`);
  const app = await createApp();
  app.startSweeper();
  app.server.listen(defaultConfig.port, () => console.log(`[cartnudge] listening on ${defaultConfig.appUrl} (port ${defaultConfig.port})`));
  const stop = async () => { await app.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
