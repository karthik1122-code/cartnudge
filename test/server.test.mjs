import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/server.mjs';
import { SHOP, codOrder, fakes, storeWithShop, testConfig } from './helpers.mjs';

async function boot(config = testConfig()) {
  const store = await storeWithShop({ razorpayKeyId: 'rzp_test_abc123', razorpayKeySecret: 'secret', razorpayWebhookSecret: 'rzp-hook' });
  const { calls, deps } = fakes();
  const app = await createApp({ config, store, deps, logger: { error() {}, info() {} } });
  await new Promise(resolve => app.server.listen(0, resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, calls, store, base, config };
}

const shopifySig = (secret, body) => createHmac('sha256', secret).update(body).digest('base64');

test('Shopify order webhook: rejects bad signatures, processes good ones once', async t => {
  const { app, calls, base, config } = await boot();
  t.after(() => app.close());
  const body = JSON.stringify(codOrder());
  const headers = { 'content-type': 'application/json', 'x-shopify-topic': 'orders/create', 'x-shopify-shop-domain': SHOP, 'x-shopify-webhook-id': 'wh-1' };

  const bad = await fetch(`${base}/webhooks/shopify`, { method: 'POST', body, headers: { ...headers, 'x-shopify-hmac-sha256': 'nope' } });
  assert.equal(bad.status, 401);

  const good = await fetch(`${base}/webhooks/shopify`, { method: 'POST', body, headers: { ...headers, 'x-shopify-hmac-sha256': shopifySig(config.shopify.apiSecret, body) } });
  assert.equal(good.status, 200);
  const again = await fetch(`${base}/webhooks/shopify`, { method: 'POST', body, headers: { ...headers, 'x-shopify-hmac-sha256': shopifySig(config.shopify.apiSecret, body) } });
  assert.equal(await again.text(), 'duplicate');
  await app.idle();
  assert.equal(calls.templates.length, 1);
});

test('WhatsApp webhook verification and signed button replies', async t => {
  const { app, calls, base, store, config } = await boot();
  t.after(() => app.close());
  const challenge = await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42`);
  assert.equal(await challenge.text(), '42');
  assert.equal((await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`)).status, 403);

  await app.engine.handleOrderCreated(SHOP, codOrder());
  const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: 'm1', from: '919876543210', type: 'button', button: { payload: `cn|confirm|${SHOP}|5550001` } }] } }] }] });
  const unsigned = await fetch(`${base}/webhooks/whatsapp`, { method: 'POST', body });
  assert.equal(unsigned.status, 401);
  const signed = await fetch(`${base}/webhooks/whatsapp`, { method: 'POST', body, headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', config.whatsapp.appSecret).update(body).digest('hex')}` } });
  assert.equal(signed.status, 200);
  await app.idle();
  assert.equal(store.getOrder(SHOP, '5550001').status, 'confirmed');
  assert.ok(calls.texts.length >= 1);
});

test('Razorpay webhook uses the store\'s own secret', async t => {
  const { app, base, store } = await boot();
  t.after(() => app.close());
  await app.engine.handleOrderCreated(SHOP, codOrder());
  await app.engine.handleReply({ kind: 'button', from: '919876543210', payload: `cn|prepaid|${SHOP}|5550001` });
  const body = JSON.stringify({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: 'plink_1', amount: 144900, amount_paid: 144900, notes: { cartnudge_shop: SHOP, cartnudge_order_id: '5550001' } } }, payment: { entity: { id: 'pay_1' } } } });
  const wrong = await fetch(`${base}/webhooks/razorpay/${SHOP}`, { method: 'POST', body, headers: { 'x-razorpay-signature': createHmac('sha256', 'other').update(body).digest('hex') } });
  assert.equal(wrong.status, 401);
  const right = await fetch(`${base}/webhooks/razorpay/${SHOP}`, { method: 'POST', body, headers: { 'x-razorpay-signature': createHmac('sha256', 'rzp-hook').update(body).digest('hex'), 'x-razorpay-event-id': 'ev1' } });
  assert.equal(right.status, 200);
  await app.idle();
  assert.equal(store.getOrder(SHOP, '5550001').status, 'paid_online');
});

test('shop/redact deletes the store and uninstall drops the token', async t => {
  const { app, base, store, config } = await boot();
  t.after(() => app.close());
  const send = (topic, id, payload = {}) => {
    const body = JSON.stringify(payload);
    return fetch(`${base}/webhooks/shopify`, { method: 'POST', body, headers: { 'x-shopify-topic': topic, 'x-shopify-shop-domain': SHOP, 'x-shopify-webhook-id': id, 'x-shopify-hmac-sha256': shopifySig(config.shopify.apiSecret, body) } });
  };
  await send('app/uninstalled', 'u1');
  await app.idle();
  assert.equal(store.getShop(SHOP).accessToken, null);
  await send('shop/redact', 'r1', { shop_domain: SHOP });
  await app.idle();
  assert.equal(store.getShop(SHOP), null);
});

test('dashboard API needs a session token; install redirects to Shopify', async t => {
  const { app, base } = await boot();
  t.after(() => app.close());
  assert.equal((await fetch(`${base}/api/overview`)).status, 401);
  const install = await fetch(`${base}/auth?shop=${SHOP}`, { redirect: 'manual' });
  assert.equal(install.status, 302);
  assert.match(install.headers.get('location'), new RegExp(`^https://${SHOP}/admin/oauth/authorize`));
  assert.equal((await fetch(`${base}/auth?shop=evil.com`, { redirect: 'manual' })).status, 400);
  const landing = await fetch(`${base}/`);
  assert.equal(landing.status, 200);
  assert.match(landing.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(`${base}/../package.json`)).status, 404);
});

test('dev preview serves seeded demo numbers without Shopify', async t => {
  const config = testConfig({ devShop: 'demo.myshopify.com' });
  const { createApp: make } = await import('../src/server.mjs');
  const { openStore } = await import('../src/store.mjs');
  const app = await make({ config, store: await openStore(null), deps: fakes().deps, logger: { error() {}, info() {} } });
  await new Promise(resolve => app.server.listen(0, resolve));
  t.after(() => app.close());
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/overview`);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.shop, 'demo.myshopify.com');
  assert.ok(data.stats.savings.total > 0);
});
