import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../src/engine.mjs';
import { encodePayload } from '../src/whatsapp.mjs';
import { SHOP, codOrder, fakes, storeWithShop, testConfig } from './helpers.mjs';

const RZP = { razorpayKeyId: 'rzp_test_abc123', razorpayKeySecret: 'secret', prepaidDiscountRupees: 50 };

async function setup(settings = RZP, configOverrides = {}, clock = () => Date.parse('2026-11-06T10:00:00Z')) {
  const store = await storeWithShop(settings);
  const { calls, deps } = fakes();
  const engine = createEngine({ store, config: testConfig(configOverrides), deps, logger: { error() {}, info() {} }, now: clock });
  return { store, calls, engine };
}

const tap = (action, orderId = '5550001', from = '919876543210') =>
  ({ kind: 'button', id: `m-${action}`, from, payload: encodePayload(action, SHOP, orderId) });

test('a COD order gets a WhatsApp template with confirm, prepaid and cancel buttons', async () => {
  const { engine, calls, store } = await setup();
  const result = await engine.handleOrderCreated(SHOP, codOrder());
  assert.equal(result.status, 'pending');
  const [sent] = calls.templates;
  assert.equal(sent.to, '919876543210');
  assert.equal(sent.name, 'cod_confirm');
  assert.deepEqual(sent.bodyParams, ['Priya', 'Kesar Threads', '#1042', '₹1,499', '₹50']);
  assert.equal(sent.quickReplies.length, 3);
  assert.deepEqual(calls.tagsAdded, [['5550001', 'cn-cod-pending']]);
  assert.equal(store.getOrder(SHOP, '5550001').status, 'pending');
});

test('without Razorpay keys the basic template is used and no prepaid button is offered', async () => {
  const { engine, calls } = await setup({});
  await engine.handleOrderCreated(SHOP, codOrder());
  assert.equal(calls.templates[0].name, 'cod_confirm_basic');
  assert.equal(calls.templates[0].quickReplies.length, 2);
  assert.equal(calls.templates[0].bodyParams.length, 4);
});

test('prepaid, paid and duplicate orders are not messaged', async () => {
  const { engine, calls } = await setup();
  await engine.handleOrderCreated(SHOP, codOrder({ payment_gateway_names: ['Razorpay'], financial_status: 'paid' }));
  await engine.handleOrderCreated(SHOP, codOrder({ id: 2, financial_status: 'paid' }));
  await engine.handleOrderCreated(SHOP, codOrder({ id: 3 }));
  await engine.handleOrderCreated(SHOP, codOrder({ id: 3 }));
  assert.equal(calls.templates.length, 1);
});

test('orders with no usable phone are tagged instead of messaged', async () => {
  const { engine, calls, store } = await setup();
  await engine.handleOrderCreated(SHOP, codOrder({ shipping_address: { first_name: 'A', phone: '12345' } }));
  assert.equal(calls.templates.length, 0);
  assert.equal(store.getOrder(SHOP, '5550001').status, 'no_phone');
  assert.deepEqual(calls.tagsAdded, [['5550001', 'cn-no-phone']]);
});

test('confirm tap tags the order confirmed and thanks the buyer', async () => {
  const { engine, calls, store } = await setup();
  await engine.handleOrderCreated(SHOP, codOrder());
  const result = await engine.handleReply(tap('confirm'));
  assert.equal(result.status, 'confirmed');
  assert.equal(store.getOrder(SHOP, '5550001').status, 'confirmed');
  assert.deepEqual(calls.tagsRemoved.at(-1), ['5550001', 'cn-cod-pending']);
  assert.deepEqual(calls.tagsAdded.at(-1), ['5550001', 'cn-cod-confirmed']);
  assert.match(calls.texts.at(-1).text, /confirmed/);
});

test('a tap from a different phone number is ignored', async () => {
  const { engine, store } = await setup();
  await engine.handleOrderCreated(SHOP, codOrder());
  const result = await engine.handleReply(tap('cancel', '5550001', '919000000000'));
  assert.equal(result.ignored, 'phone_mismatch');
  assert.equal(store.getOrder(SHOP, '5550001').status, 'pending');
});

test('cancel tap adds a do-not-ship note and never cancels the order itself', async () => {
  const { engine, calls } = await setup();
  await engine.handleOrderCreated(SHOP, codOrder());
  await engine.handleReply(tap('cancel'));
  assert.deepEqual(calls.tagsAdded.at(-1), ['5550001', 'cn-cod-cancel-requested']);
  assert.match(calls.notes[0][1], /Do not ship/);
  // A later tap cannot change a final answer.
  const again = await engine.handleReply(tap('confirm'));
  assert.equal(again.ignored, 'already_final');
});

test('prepaid tap creates a discounted Razorpay link; payment marks the order paid online', async () => {
  const { engine, calls, store } = await setup();
  await engine.handleOrderCreated(SHOP, codOrder());
  const result = await engine.handleReply(tap('prepaid'));
  assert.equal(result.status, 'prepaid_link_sent');
  assert.equal(calls.links[0].amountRupees, 1449);
  assert.equal(calls.links[0].keyId, 'rzp_test_abc123');
  assert.match(calls.texts.at(-1).text, /https:\/\/rzp\.io\/l\/abc/);

  const paid = await engine.handlePaidLink({ shop: SHOP, orderId: '5550001', linkId: 'plink_1', paymentId: 'pay_1', amountRupees: 1449 });
  assert.equal(paid.status, 'paid_online');
  assert.equal(store.getOrder(SHOP, '5550001').status, 'paid_online');
  assert.deepEqual(calls.tagsAdded.at(-1), ['5550001', 'cn-paid-online']);
  assert.match(calls.notes.at(-1)[1], /PREPAID/);

  const duplicate = await engine.handlePaidLink({ shop: SHOP, orderId: '5550001', linkId: 'plink_1', amountRupees: 1449 });
  assert.equal(duplicate.ignored, 'already_paid');
});

test('a payment for a different link is ignored', async () => {
  const { engine } = await setup();
  await engine.handleOrderCreated(SHOP, codOrder());
  await engine.handleReply(tap('prepaid'));
  const result = await engine.handlePaidLink({ shop: SHOP, orderId: '5550001', linkId: 'plink_other', amountRupees: 1 });
  assert.equal(result.ignored, 'link_mismatch');
});

test('billing gate stops messages when a plan is required and inactive', async () => {
  const { engine, calls } = await setup(RZP, { billing: { ...testConfig().billing, required: true } });
  const result = await engine.handleOrderCreated(SHOP, codOrder());
  assert.equal(result.skipped, 'no_subscription');
  assert.equal(calls.templates.length, 0);
});

test('savings only count cancels and prepaid conversions', async () => {
  const { engine } = await setup({ ...RZP, rtoCostRupees: 200, codRtoRatePercent: 25 });
  for (const id of [1, 2, 3]) await engine.handleOrderCreated(SHOP, codOrder({ id }));
  await engine.handleReply(tap('confirm', '1'));
  await engine.handleReply(tap('cancel', '2'));
  await engine.handleReply(tap('prepaid', '3'));
  await engine.handlePaidLink({ shop: SHOP, orderId: '3', linkId: 'plink_1', amountRupees: 1449 });
  const stats = engine.stats(SHOP);
  assert.equal(stats.cod.messaged, 3);
  assert.equal(stats.cod.responseRate, 100);
  assert.equal(stats.savings.fromCancels, 200);
  assert.equal(stats.savings.fromPrepaid, 50);
  assert.equal(stats.savings.total, 250);
});

test('abandoned checkout gets one reminder after the delay and is counted when recovered', async () => {
  let clock = Date.parse('2026-11-06T10:00:00Z');
  const { engine, calls, store } = await setup(RZP, {}, () => clock);
  await engine.handleCheckout(SHOP, { token: 'chk_1', phone: '9876543210', abandoned_checkout_url: 'https://kesar.in/checkouts/x', total_price: '1899.00', updated_at: '2026-11-06T10:00:00Z', shipping_address: { first_name: 'Priya' } });

  clock += 30 * 60_000;
  assert.equal((await engine.sweepCarts()).length, 0, 'too early');

  clock += 31 * 60_000;
  const [sent] = await engine.sweepCarts();
  assert.equal(sent.sent, true);
  assert.equal(calls.templates[0].name, 'cart_reminder');
  assert.equal(calls.templates[0].urlButtonParam, store.getCheckout(SHOP, 'chk_1').linkId);
  assert.equal((await engine.sweepCarts()).length, 0, 'only once');

  await engine.handleOrderCreated(SHOP, { id: 9, name: '#1050', total_price: '1899.00', financial_status: 'paid', payment_gateway_names: ['Razorpay'], checkout_token: 'chk_1' });
  const stats = engine.stats(SHOP);
  assert.equal(stats.carts.recovered, 1);
  assert.equal(stats.carts.recoveredValue, 1899);
});

test('settings validate input and keep secrets encrypted and hidden', async () => {
  const { engine, store } = await setup({});
  await assert.rejects(engine.updateSettings(SHOP, { prepaidDiscountRupees: -5 }), /between/);
  await assert.rejects(engine.updateSettings(SHOP, { razorpayKeyId: 'nope' }), /not valid/);
  const view = await engine.updateSettings(SHOP, { razorpayKeyId: 'rzp_live_ABC', razorpayKeySecret: 'top-secret', prepaidDiscountRupees: 40 });
  assert.equal(view.razorpayKeySecret, '');
  assert.equal(view.razorpayKeySecretSet, true);
  assert.notEqual(store.getShop(SHOP).settings.razorpayKeySecret, 'top-secret');
  assert.equal(engine.settingsFor(SHOP).razorpayKeySecret, 'top-secret');
  // Blank keeps, "-" clears.
  await engine.updateSettings(SHOP, { razorpayKeySecret: '' });
  assert.equal(engine.settingsFor(SHOP).razorpayKeySecret, 'top-secret');
  await engine.updateSettings(SHOP, { razorpayKeySecret: '-' });
  assert.equal(engine.settingsFor(SHOP).razorpayKeySecret, '');
});

test('pay-per-save: each saved parcel is charged once to the usage line item', async () => {
  const { engine, calls, store } = await setup(RZP, { billing: { ...testConfig().billing, required: true } });
  await store.saveShop(SHOP, { subscription: { status: 'ACTIVE', usageLineItemId: 'gid://shopify/AppSubscriptionLineItem/1' } });
  for (const id of [1, 2, 3]) await engine.handleOrderCreated(SHOP, codOrder({ id }));
  await engine.handleReply(tap('confirm', '1'));
  await engine.handleReply(tap('cancel', '2'));
  await engine.handleReply(tap('prepaid', '3'));
  await engine.handlePaidLink({ shop: SHOP, orderId: '3', linkId: 'plink_1', amountRupees: 1449 });
  await engine.handlePaidLink({ shop: SHOP, orderId: '3', linkId: 'plink_1', amountRupees: 1449 });
  assert.equal(calls.usage.length, 2, 'confirm is free; cancel and prepaid are charged once each');
  assert.equal(calls.usage[0].priceUsd, 0.16);
  assert.equal(calls.usage[0].lineItemId, 'gid://shopify/AppSubscriptionLineItem/1');
  assert.match(calls.usage[0].idempotencyKey, /2$/);
  const stats = engine.stats(SHOP);
  assert.equal(stats.billing.parcelsSavedThisMonth, 2);
  assert.equal(stats.billing.chargedInr, 30);
});

test('pay-per-save: beta stores are not charged and over-cap charges are skipped', async () => {
  const beta = await setup();
  await beta.engine.handleOrderCreated(SHOP, codOrder());
  await beta.engine.handleReply(tap('cancel'));
  assert.equal(beta.calls.usage.length, 0);
  assert.equal(beta.engine.stats(SHOP).billing.waivedInr, 15);

  const { engine, store } = await setup(RZP, { billing: { ...testConfig().billing, required: true } });
  await store.saveShop(SHOP, { subscription: { status: 'ACTIVE', usageLineItemId: 'li' } });
  const capped = createEngine({ store, config: testConfig({ billing: { ...testConfig().billing, required: true } }), logger: { error() {}, info() {} },
    deps: { ...fakes().deps, admin: () => ({ ...fakes().deps.admin(), async recordUsage() { throw new Error('appUsageRecordCreate: Total price exceeds balance remaining'); } }) } });
  await capped.handleOrderCreated(SHOP, codOrder({ id: 7 }));
  await capped.handleReply(tap('cancel', '7'));
  assert.equal(store.getOrder(SHOP, '7').billing.status, 'capped');
  assert.ok(engine);
});
