import { hmacHex, safeEqual } from './crypto.mjs';

// Payment links are created on the merchant's own Razorpay account, so money settles to them directly.
export async function createPaymentLink({ keyId, keySecret, amountRupees, orderName, customerName, phone, shop, orderId, callbackUrl, fetchImpl = fetch }) {
  if (!keyId || !keySecret) throw new Error('Razorpay keys are not configured for this store');
  const amount = Math.round(amountRupees * 100);
  if (amount < 100) throw new Error('Payment link amount must be at least ₹1');
  const response = await fetchImpl('https://api.razorpay.com/v1/payment_links', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}` },
    body: JSON.stringify({
      amount,
      currency: 'INR',
      accept_partial: false,
      reference_id: `cn_${orderId}_${Date.now().toString(36)}`.slice(0, 40),
      description: `Order ${orderName}`.slice(0, 2048),
      customer: { name: customerName, contact: phone ? `+${phone}` : undefined },
      notify: { sms: false, email: false },
      reminder_enable: false,
      expire_by: Math.floor(Date.now() / 1000) + 48 * 3600,
      notes: { cartnudge_shop: shop, cartnudge_order_id: String(orderId) },
      ...(callbackUrl ? { callback_url: callbackUrl, callback_method: 'get' } : {}),
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Razorpay ${response.status}: ${body?.error?.description || 'payment link failed'}`);
  return { id: body.id, url: body.short_url, amountRupees: amount / 100 };
}

export function verifyRazorpayWebhook(rawBody, signature, secret) {
  return Boolean(secret) && safeEqual(hmacHex(secret, rawBody), signature);
}

export function parsePaidLink(body) {
  if (body?.event !== 'payment_link.paid') return null;
  const link = body?.payload?.payment_link?.entity;
  const payment = body?.payload?.payment?.entity;
  const notes = link?.notes || {};
  if (!notes.cartnudge_shop || !notes.cartnudge_order_id) return null;
  return {
    shop: notes.cartnudge_shop,
    orderId: String(notes.cartnudge_order_id),
    linkId: link.id,
    paymentId: payment?.id,
    amountRupees: Number(link.amount_paid ?? link.amount) / 100,
  };
}
