import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { decrypt, encrypt, verifySessionToken } from '../src/crypto.mjs';
import { normalizePhone } from '../src/phone.mjs';
import { parsePaidLink, verifyRazorpayWebhook } from '../src/razorpay.mjs';
import { isCodOrder, verifyQueryHmac, verifyWebhookHmac } from '../src/shopify.mjs';
import { decodePayload, encodePayload, parseInbound, verifyWhatsAppSignature } from '../src/whatsapp.mjs';

test('phone numbers normalise to WhatsApp format', () => {
  assert.equal(normalizePhone('+91 98765 43210'), '919876543210');
  assert.equal(normalizePhone('09876543210'), '919876543210');
  assert.equal(normalizePhone('9876543210'), '919876543210');
  assert.equal(normalizePhone('5876543210'), null);
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone('+44 7700 900123'), '447700900123');
  assert.equal(normalizePhone(null), null);
});

test('COD detection needs a COD gateway and an unpaid order', () => {
  assert.equal(isCodOrder({ payment_gateway_names: ['Cash on Delivery (COD)'], financial_status: 'pending' }), true);
  assert.equal(isCodOrder({ payment_gateway_names: ['cod'], financial_status: 'pending' }), true);
  assert.equal(isCodOrder({ payment_gateway_names: ['Razorpay'], financial_status: 'pending' }), false);
  assert.equal(isCodOrder({ payment_gateway_names: ['Cash on Delivery (COD)'], financial_status: 'paid' }), false);
  assert.equal(isCodOrder({ payment_gateway_names: ['Cash on Delivery (COD)'], financial_status: 'pending', cancelled_at: '2026' }), false);
});

test('secrets round-trip through AES-GCM and tampering is detected', () => {
  const secret = 'a-long-enough-application-secret';
  const sealed = encrypt('rzp_secret', secret);
  assert.notEqual(sealed, 'rzp_secret');
  assert.equal(decrypt(sealed, secret), 'rzp_secret');
  const parts = sealed.split('.');
  parts[3] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => decrypt(parts.join('.'), secret));
  assert.throws(() => encrypt('x', 'short'));
});

test('Shopify OAuth query hmac is verified', () => {
  const secret = 'shpss_secret';
  const params = new URLSearchParams({ code: 'abc', shop: 'a.myshopify.com', state: 'xyz', timestamp: '1700000000' });
  const message = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&');
  params.set('hmac', createHmac('sha256', secret).update(message).digest('hex'));
  assert.equal(verifyQueryHmac(params, secret), true);
  params.set('shop', 'evil.myshopify.com');
  assert.equal(verifyQueryHmac(params, secret), false);
});

test('webhook signatures are verified for Shopify, WhatsApp and Razorpay', () => {
  const body = Buffer.from('{"a":1}');
  assert.equal(verifyWebhookHmac(body, createHmac('sha256', 's').update(body).digest('base64'), 's'), true);
  assert.equal(verifyWebhookHmac(body, 'wrong', 's'), false);
  assert.equal(verifyWhatsAppSignature(body, `sha256=${createHmac('sha256', 'w').update(body).digest('hex')}`, 'w'), true);
  assert.equal(verifyWhatsAppSignature(body, 'sha256=00', 'w'), false);
  assert.equal(verifyRazorpayWebhook(body, createHmac('sha256', 'r').update(body).digest('hex'), 'r'), true);
  assert.equal(verifyRazorpayWebhook(body, 'x', ''), false);
});

test('App Bridge session tokens are verified', () => {
  const apiKey = 'key', apiSecret = 'secret';
  const sign = payload => {
    const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${h}.${p}.${createHmac('sha256', apiSecret).update(`${h}.${p}`).digest('base64url')}`;
  };
  const now = Date.parse('2026-11-06T10:00:00Z');
  const exp = now / 1000 + 60;
  const good = sign({ aud: apiKey, dest: 'https://kesar.myshopify.com', exp, nbf: exp - 120, sub: '1' });
  assert.equal(verifySessionToken(good, { apiKey, apiSecret, now })?.shop, 'kesar.myshopify.com');
  assert.equal(verifySessionToken(sign({ aud: 'other', dest: 'https://kesar.myshopify.com', exp }), { apiKey, apiSecret, now }), null);
  assert.equal(verifySessionToken(sign({ aud: apiKey, dest: 'https://kesar.myshopify.com', exp: now / 1000 - 60 }), { apiKey, apiSecret, now }), null);
  assert.equal(verifySessionToken(good.slice(0, -2) + 'xx', { apiKey, apiSecret, now }), null);
});

test('quick-reply payloads round-trip and reject junk', () => {
  assert.deepEqual(decodePayload(encodePayload('prepaid', 'a.myshopify.com', '42')), { action: 'prepaid', shop: 'a.myshopify.com', orderId: '42' });
  assert.equal(decodePayload('cn|delete|a.myshopify.com|42'), null);
  assert.equal(decodePayload('cn|confirm|a.myshopify.com|42;drop'), null);
  assert.equal(decodePayload('hello'), null);
});

test('inbound WhatsApp webhooks are parsed into replies', () => {
  const replies = parseInbound({ entry: [{ changes: [{ value: { metadata: { phone_number_id: '1' }, messages: [
    { id: 'm1', from: '919876543210', type: 'button', button: { payload: 'cn|confirm|a.myshopify.com|1', text: 'Confirm order' } },
    { id: 'm2', from: '919876543210', type: 'text', text: { body: 'hi' } },
  ] } }] }] });
  assert.equal(replies.length, 2);
  assert.equal(replies[0].kind, 'button');
  assert.equal(replies[0].payload, 'cn|confirm|a.myshopify.com|1');
  assert.equal(replies[1].kind, 'text');
});

test('Razorpay payment_link.paid events are parsed', () => {
  const paid = parsePaidLink({ event: 'payment_link.paid', payload: {
    payment_link: { entity: { id: 'plink_1', amount: 144900, amount_paid: 144900, notes: { cartnudge_shop: 'a.myshopify.com', cartnudge_order_id: '42' } } },
    payment: { entity: { id: 'pay_1' } } } });
  assert.deepEqual(paid, { shop: 'a.myshopify.com', orderId: '42', linkId: 'plink_1', paymentId: 'pay_1', amountRupees: 1449 });
  assert.equal(parsePaidLink({ event: 'payment.captured' }), null);
});
