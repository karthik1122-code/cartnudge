import { DEFAULT_SETTINGS, SECRET_SETTING_KEYS, TAGS } from './config.mjs';
import { decrypt, encrypt, randomToken } from './crypto.mjs';
import { normalizePhone } from './phone.mjs';
import { checkoutPhone, isCodOrder, orderAmountRupees, orderCustomerName, orderPhone } from './shopify.mjs';
import { decodePayload, encodePayload } from './whatsapp.mjs';

const FINAL = new Set(['confirmed', 'cancel_requested', 'paid_online']);
const rupees = n => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

// The business logic, with every outside system injected so it can be tested without network.
//   deps.admin(shop)            -> Shopify admin client for that shop
//   deps.whatsapp(settings)     -> WhatsApp client (merchant number or platform number)
//   deps.createPaymentLink(...) -> Razorpay payment link
export function createEngine({ store, config, deps, logger = console, now = () => Date.now() }) {
  const wa = config.whatsapp;

  // ---------------------------------------------------------------- settings

  function settingsFor(shop) {
    const record = store.getShop(shop);
    const saved = record?.settings || {};
    const merged = { ...DEFAULT_SETTINGS, ...saved };
    for (const key of SECRET_SETTING_KEYS) merged[key] = saved[key] ? decrypt(saved[key], config.appSecret) : '';
    return merged;
  }

  function publicSettings(shop) {
    const settings = settingsFor(shop);
    const view = { ...settings };
    for (const key of SECRET_SETTING_KEYS) { view[key] = ''; view[`${key}Set`] = Boolean(settings[key]); }
    return view;
  }

  async function updateSettings(shop, patch) {
    const record = store.getShop(shop);
    if (!record) throw httpError(404, 'Store is not installed');
    const next = { ...(record.settings || {}) };
    const bool = k => { if (k in patch) next[k] = Boolean(patch[k]); };
    const int = (k, min, max) => {
      if (!(k in patch)) return;
      const value = Number(patch[k]);
      if (!Number.isFinite(value) || value < min || value > max) throw httpError(400, `${k} must be between ${min} and ${max}`);
      next[k] = Math.round(value);
    };
    const str = (k, max, pattern) => {
      if (!(k in patch)) return;
      const value = String(patch[k] ?? '').trim();
      if (value.length > max || (value && pattern && !pattern.test(value))) throw httpError(400, `${k} is not valid`);
      next[k] = value;
    };
    ['codConfirmEnabled', 'prepaidNudgeEnabled', 'cartRemindersEnabled', 'poweredBy'].forEach(bool);
    int('prepaidDiscountRupees', 0, 5000);
    int('rtoCostRupees', 0, 5000);
    int('codRtoRatePercent', 0, 100);
    int('cartDelayMinutes', 15, 1440);
    str('brandName', 60);
    str('razorpayKeyId', 64, /^rzp_(test|live)_[A-Za-z0-9]+$/);
    str('waPhoneNumberId', 32, /^\d+$/);
    // Secrets: an empty string means "keep the current value"; "-" clears it.
    for (const key of SECRET_SETTING_KEYS) {
      if (!(key in patch) || patch[key] === '' || patch[key] == null) continue;
      next[key] = patch[key] === '-' ? '' : encrypt(String(patch[key]).trim(), config.appSecret);
    }
    await store.saveShop(shop, { settings: next });
    return publicSettings(shop);
  }

  // ---------------------------------------------------------------- helpers

  const brand = (shop, settings) => settings.brandName || store.getShop(shop)?.name || shop.replace('.myshopify.com', '');
  const footer = settings => (settings.poweredBy ? '\n\n— sent with CartNudge' : '');
  const prepaidAvailable = settings => settings.prepaidNudgeEnabled && Boolean(settings.razorpayKeyId && settings.razorpayKeySecret);

  function billingAllows(shop) {
    if (!config.billing.required) return true;
    return store.getShop(shop)?.subscription?.status === 'ACTIVE';
  }

  async function safeTag(shop, orderId, add = [], remove = []) {
    try {
      const admin = deps.admin(shop);
      if (remove.length) await admin.removeTags(orderId, remove);
      if (add.length) await admin.addTags(orderId, add);
    } catch (error) {
      logger.error?.(`[tags] ${shop} order ${orderId}: ${error.message}`);
      await store.logEvent(shop, 'error', { orderId, message: `Could not update order tags: ${error.message}` });
    }
  }

  async function safeNote(shop, orderId, line) {
    try { await deps.admin(shop).appendNote(orderId, line); }
    catch (error) { logger.error?.(`[note] ${shop} order ${orderId}: ${error.message}`); }
  }

  // ---------------------------------------------------------------- pay-per-save billing

  // Called once per order when CartNudge saves a parcel (cancel caught before shipping, or moved to prepaid).
  async function chargeSavedParcel(shop, orderId, reason) {
    const order = store.getOrder(shop, orderId);
    if (!order || order.billing) return order?.billing || null;
    const { parcelPriceInr, parcelPriceUsd } = config.billing;
    const base = { reason, priceInr: parcelPriceInr, at: new Date(now()).toISOString() };
    if (!config.billing.required) {
      const billing = { ...base, status: 'free_beta' };
      await store.saveOrder(shop, orderId, { billing });
      return billing;
    }
    const lineItemId = store.getShop(shop)?.subscription?.usageLineItemId;
    if (!lineItemId) {
      const billing = { ...base, status: 'unbilled', note: 'No active pay-per-save plan' };
      await store.saveOrder(shop, orderId, { billing });
      return billing;
    }
    try {
      await deps.admin(shop).recordUsage({
        lineItemId, priceUsd: parcelPriceUsd,
        description: `Parcel saved: order ${order.name} (${reason === 'cancel_requested' ? 'cancelled before shipping' : 'moved to prepaid'})`,
        idempotencyKey: `cn-${shop}-${orderId}`.slice(0, 64),
      });
      const billing = { ...base, status: 'charged' };
      await store.saveOrder(shop, orderId, { billing });
      return billing;
    } catch (error) {
      // Over the monthly cap Shopify refuses the record; the store is simply not charged.
      const status = /cap|exceed/i.test(error.message) ? 'capped' : 'failed';
      const billing = { ...base, status, note: error.message };
      await store.saveOrder(shop, orderId, { billing });
      if (status === 'failed') await store.logEvent(shop, 'error', { orderId, message: `Usage charge failed: ${error.message}` });
      return billing;
    }
  }

  // ---------------------------------------------------------------- orders/create

  async function handleOrderCreated(shop, order) {
    await markCheckoutCompleted(shop, order);

    const settings = settingsFor(shop);
    if (!settings.codConfirmEnabled || !isCodOrder(order)) return { skipped: 'not_cod_or_disabled' };
    if (!billingAllows(shop)) return { skipped: 'no_subscription' };

    const id = String(order.id);
    const existing = store.getOrder(shop, id);
    if (existing?.messagedAt) return { skipped: 'already_messaged' };

    const phone = normalizePhone(orderPhone(order));
    const base = {
      name: order.name || `#${order.order_number || id}`,
      amount: orderAmountRupees(order),
      customerName: orderCustomerName(order),
      phone,
      createdAt: new Date(now()).toISOString(),
    };

    if (!phone) {
      await store.saveOrder(shop, id, { ...base, status: 'no_phone' });
      await safeTag(shop, id, [TAGS.noPhone]);
      await store.logEvent(shop, 'no_phone', { orderId: id, order: base.name });
      return { status: 'no_phone' };
    }

    await store.saveOrder(shop, id, { ...base, status: 'pending' });
    const withPrepaid = prepaidAvailable(settings) && base.amount - settings.prepaidDiscountRupees >= 1;
    const quickReplies = [encodePayload('confirm', shop, id)];
    if (withPrepaid) quickReplies.push(encodePayload('prepaid', shop, id));
    quickReplies.push(encodePayload('cancel', shop, id));

    const bodyParams = [base.customerName, brand(shop, settings), base.name, rupees(base.amount)];
    if (withPrepaid) bodyParams.push(rupees(settings.prepaidDiscountRupees));

    try {
      const sent = await deps.whatsapp(settings).sendTemplate({
        to: phone,
        name: withPrepaid ? wa.codTemplate : `${wa.codTemplate}_basic`,
        language: wa.templateLanguage,
        bodyParams,
        quickReplies,
      });
      await store.saveOrder(shop, id, { messagedAt: new Date(now()).toISOString(), messageId: sent.id, dryRun: sent.dryRun, prepaidOffered: withPrepaid });
      await safeTag(shop, id, [TAGS.pending]);
      await store.logEvent(shop, 'cod_message_sent', { orderId: id, order: base.name, amount: base.amount });
      return { status: 'pending', messageId: sent.id };
    } catch (error) {
      await store.saveOrder(shop, id, { status: 'send_failed', error: error.message });
      await store.logEvent(shop, 'error', { orderId: id, order: base.name, message: `WhatsApp send failed: ${error.message}` });
      return { status: 'send_failed', error: error.message };
    }
  }

  // ---------------------------------------------------------------- WhatsApp replies

  async function handleReply(reply) {
    if (reply.kind !== 'button') return { ignored: 'not_a_button' };
    const decoded = decodePayload(reply.payload);
    if (!decoded) return { ignored: 'unknown_payload' };
    const { action, shop, orderId } = decoded;
    const order = store.getOrder(shop, orderId);
    if (!order) return { ignored: 'unknown_order' };
    // Only the customer the message was sent to can act on the order.
    if (normalizePhone(reply.from) !== order.phone) return { ignored: 'phone_mismatch' };

    const settings = settingsFor(shop);
    const whatsapp = deps.whatsapp(settings);
    const say = text => whatsapp.sendText({ to: order.phone, text: text + footer(settings) }).catch(error =>
      logger.error?.(`[whatsapp] reply to ${shop}/${orderId} failed: ${error.message}`));
    const stamp = new Date(now()).toISOString();

    if (FINAL.has(order.status)) {
      await say(`Your choice for order ${order.name} is already recorded. For any change please contact ${brand(shop, settings)}.`);
      return { ignored: 'already_final', status: order.status };
    }

    if (action === 'confirm') {
      await store.saveOrder(shop, orderId, { status: 'confirmed', respondedAt: stamp });
      await safeTag(shop, orderId, [TAGS.confirmed], [TAGS.pending]);
      await store.logEvent(shop, 'confirmed', { orderId, order: order.name, amount: order.amount });
      await say(`Thank you ${order.customerName}! Order ${order.name} is confirmed and will be shipped soon. Please keep ${rupees(order.amount)} ready at delivery.`);
      return { status: 'confirmed' };
    }

    if (action === 'cancel') {
      await store.saveOrder(shop, orderId, { status: 'cancel_requested', respondedAt: stamp });
      await safeTag(shop, orderId, [TAGS.cancelled], [TAGS.pending]);
      await safeNote(shop, orderId, `CartNudge: customer asked to cancel this COD order on WhatsApp (${stamp}). Do not ship.`);
      await store.logEvent(shop, 'cancel_requested', { orderId, order: order.name, amount: order.amount });
      await chargeSavedParcel(shop, orderId, 'cancel_requested');
      await say(`Okay, we've told ${brand(shop, settings)} that you don't want order ${order.name}. It will not be shipped.`);
      return { status: 'cancel_requested' };
    }

    // action === 'prepaid'
    if (!prepaidAvailable(settings)) {
      await say(`Online payment isn't available right now. Your order ${order.name} stays on cash on delivery.`);
      return { ignored: 'prepaid_unavailable' };
    }
    if (order.paymentLink?.url && order.status === 'prepaid_link_sent') {
      await say(`Here is your payment link again for order ${order.name}: ${order.paymentLink.url}`);
      return { status: 'prepaid_link_sent', reused: true };
    }
    const amount = Math.max(1, order.amount - settings.prepaidDiscountRupees);
    try {
      const link = await deps.createPaymentLink({
        keyId: settings.razorpayKeyId, keySecret: settings.razorpayKeySecret,
        amountRupees: amount, orderName: order.name, customerName: order.customerName,
        phone: order.phone, shop, orderId,
      });
      await store.saveOrder(shop, orderId, { status: 'prepaid_link_sent', respondedAt: stamp, paymentLink: link });
      await store.logEvent(shop, 'prepaid_link_sent', { orderId, order: order.name, amount: link.amountRupees });
      await say(`Pay ${rupees(link.amountRupees)} instead of ${rupees(order.amount)} for order ${order.name}: ${link.url}\nThe link is valid for 48 hours. If you don't pay, your order stays on cash on delivery.`);
      return { status: 'prepaid_link_sent', link };
    } catch (error) {
      await store.logEvent(shop, 'error', { orderId, order: order.name, message: `Payment link failed: ${error.message}` });
      await say(`Sorry, we couldn't create a payment link right now. Your order ${order.name} stays on cash on delivery.`);
      return { status: 'error', error: error.message };
    }
  }

  // ---------------------------------------------------------------- Razorpay payment_link.paid

  async function handlePaidLink(paid) {
    const order = store.getOrder(paid.shop, paid.orderId);
    if (!order) return { ignored: 'unknown_order' };
    if (order.status === 'paid_online') return { ignored: 'already_paid' };
    if (order.paymentLink?.id && paid.linkId && order.paymentLink.id !== paid.linkId) return { ignored: 'link_mismatch' };
    const stamp = new Date(now()).toISOString();
    await store.saveOrder(paid.shop, paid.orderId, { status: 'paid_online', paidAt: stamp, paidAmount: paid.amountRupees, paymentId: paid.paymentId });
    await safeTag(paid.shop, paid.orderId, [TAGS.prepaid], [TAGS.pending]);
    await safeNote(paid.shop, paid.orderId, `CartNudge: customer paid ${rupees(paid.amountRupees)} online via Razorpay (payment ${paid.paymentId || paid.linkId}). Ship as PREPAID — do not collect cash.`);
    await store.logEvent(paid.shop, 'paid_online', { orderId: paid.orderId, order: order.name, amount: paid.amountRupees });
    await chargeSavedParcel(paid.shop, paid.orderId, 'paid_online');
    const settings = settingsFor(paid.shop);
    await deps.whatsapp(settings).sendText({ to: order.phone, text: `Payment received ✅ Order ${order.name} is now prepaid. No cash needed at delivery.${footer(settings)}` })
      .catch(error => logger.error?.(`[whatsapp] paid receipt failed: ${error.message}`));
    return { status: 'paid_online' };
  }

  // ---------------------------------------------------------------- abandoned checkouts

  async function handleCheckout(shop, checkout) {
    const token = checkout?.token;
    if (!token) return { ignored: 'no_token' };
    if (checkout.completed_at) {
      await store.saveCheckout(shop, token, { completedAt: checkout.completed_at });
      return { status: 'completed' };
    }
    const existing = store.getCheckout(shop, token);
    await store.saveCheckout(shop, token, {
      phone: normalizePhone(checkoutPhone(checkout)),
      email: checkout.email || null,
      customerName: checkout.shipping_address?.first_name || checkout.customer?.first_name || 'there',
      url: checkout.abandoned_checkout_url || null,
      total: Number(checkout.total_price || 0),
      createdAt: existing?.createdAt || checkout.created_at || new Date(now()).toISOString(),
      updatedAt: checkout.updated_at || new Date(now()).toISOString(),
      linkId: existing?.linkId || randomToken(9),
    });
    return { status: 'tracked' };
  }

  async function markCheckoutCompleted(shop, order) {
    const token = order?.checkout_token;
    if (!token) return;
    const checkout = store.getCheckout(shop, token);
    if (!checkout || checkout.completedAt) return;
    const patch = { completedAt: order.created_at || new Date(now()).toISOString() };
    if (checkout.remindedAt) {
      patch.recoveredAt = patch.completedAt;
      patch.recoveredValue = Number(order.total_price || checkout.total || 0);
      await store.logEvent(shop, 'cart_recovered', { order: order.name, amount: patch.recoveredValue });
    }
    await store.saveCheckout(shop, token, patch);
  }

  async function sweepCarts() {
    const results = [];
    const t = now();
    for (const checkout of store.listCheckouts()) {
      if (checkout.completedAt || checkout.remindedAt || !checkout.phone || !checkout.url) continue;
      const settings = settingsFor(checkout.shop);
      if (!settings.cartRemindersEnabled || !store.getShop(checkout.shop)?.accessToken || !billingAllows(checkout.shop)) continue;
      const age = t - Date.parse(checkout.updatedAt);
      if (!(age >= settings.cartDelayMinutes * 60_000 && age <= 24 * 3600_000)) continue;
      try {
        const sent = await deps.whatsapp(settings).sendTemplate({
          to: checkout.phone,
          name: wa.cartTemplate,
          language: wa.templateLanguage,
          bodyParams: [checkout.customerName, brand(checkout.shop, settings), rupees(checkout.total)],
          urlButtonParam: checkout.linkId,
        });
        await store.saveCheckout(checkout.shop, checkout.token, { remindedAt: new Date(t).toISOString(), messageId: sent.id });
        await store.logEvent(checkout.shop, 'cart_reminder_sent', { amount: checkout.total });
        results.push({ token: checkout.token, sent: true });
      } catch (error) {
        await store.saveCheckout(checkout.shop, checkout.token, { remindedAt: new Date(t).toISOString(), error: error.message });
        await store.logEvent(checkout.shop, 'error', { message: `Cart reminder failed: ${error.message}` });
        results.push({ token: checkout.token, sent: false, error: error.message });
      }
    }
    return results;
  }

  function checkoutForLink(linkId) {
    return store.listCheckouts().find(c => c.linkId === linkId) || null;
  }

  async function recordCartClick(checkout) {
    if (!checkout.clickedAt) await store.saveCheckout(checkout.shop, checkout.token, { clickedAt: new Date(now()).toISOString() });
  }

  // ---------------------------------------------------------------- dashboard numbers

  function stats(shop) {
    const settings = settingsFor(shop);
    const orders = store.listOrders(shop);
    const count = status => orders.filter(o => o.status === status).length;
    const messaged = orders.filter(o => o.messagedAt).length;
    const confirmed = count('confirmed');
    const cancelRequested = count('cancel_requested');
    const paidOnline = count('paid_online');
    const linkSent = count('prepaid_link_sent');
    const responded = confirmed + cancelRequested + paidOnline + linkSent;
    const prepaidValue = orders.filter(o => o.status === 'paid_online').reduce((sum, o) => sum + (o.paidAmount || 0), 0);

    // Conservative: only count shipments that were avoided (cancel requests) and the expected
    // return cost removed by moving an order to prepaid. Confirmations are not counted as savings.
    const savedFromCancels = cancelRequested * settings.rtoCostRupees;
    const savedFromPrepaid = paidOnline * settings.rtoCostRupees * (settings.codRtoRatePercent / 100);

    const monthStart = new Date(now()); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
    const billedThisMonth = orders.filter(o => o.billing && Date.parse(o.billing.at) >= monthStart.getTime());
    const sumInr = statuses => billedThisMonth.filter(o => statuses.includes(o.billing.status)).reduce((sum, o) => sum + o.billing.priceInr, 0);
    const billing = {
      parcelsSavedThisMonth: billedThisMonth.length,
      chargedInr: Math.min(sumInr(['charged']), config.billing.monthlyCapInr),
      waivedInr: sumInr(['free_beta', 'unbilled', 'capped']),
      parcelPriceInr: config.billing.parcelPriceInr,
      monthlyCapInr: config.billing.monthlyCapInr,
    };

    const checkouts = store.listCheckouts(shop);
    const reminded = checkouts.filter(c => c.remindedAt && !c.error).length;
    const recovered = checkouts.filter(c => c.recoveredAt);
    return {
      cod: {
        orders: orders.length, messaged, confirmed, cancelRequested, paidOnline, linkSent,
        noPhone: count('no_phone'), failed: count('send_failed'),
        responseRate: messaged ? Math.round((responded / messaged) * 100) : 0,
        prepaidValue: Math.round(prepaidValue),
      },
      savings: {
        total: Math.round(savedFromCancels + savedFromPrepaid),
        fromCancels: Math.round(savedFromCancels),
        fromPrepaid: Math.round(savedFromPrepaid),
        rtoCostRupees: settings.rtoCostRupees,
        codRtoRatePercent: settings.codRtoRatePercent,
      },
      billing,
      carts: {
        tracked: checkouts.length, reminded,
        clicked: checkouts.filter(c => c.clickedAt).length,
        recovered: recovered.length,
        recoveredValue: Math.round(recovered.reduce((sum, c) => sum + (c.recoveredValue || 0), 0)),
      },
    };
  }

  return {
    settingsFor, publicSettings, updateSettings,
    handleOrderCreated, handleReply, handlePaidLink,
    handleCheckout, sweepCarts, checkoutForLink, recordCartClick,
    stats, billingAllows,
  };
}

export function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
