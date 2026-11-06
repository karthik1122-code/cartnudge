import { hmacHex, safeEqual } from './crypto.mjs';

// WhatsApp Cloud API client. Business-initiated messages must use pre-approved templates
// (see docs/whatsapp-templates.md); free-form text is only allowed inside the 24h window
// that opens when the customer replies.
export function createWhatsApp({ phoneNumberId, accessToken, graphVersion = 'v21.0', fetchImpl = fetch, logger = console }) {
  const live = Boolean(phoneNumberId && accessToken);

  async function send(payload) {
    if (!live) {
      logger.info?.(`[whatsapp:dry-run] ${JSON.stringify(payload)}`);
      return { dryRun: true, id: `dry_${Date.now()}` };
    }
    const response = await fetchImpl(`https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`WhatsApp ${response.status}: ${body?.error?.message || 'send failed'}`);
    return { dryRun: false, id: body?.messages?.[0]?.id };
  }

  return {
    live,
    sendTemplate({ to, name, language, bodyParams = [], quickReplies = [], urlButtonParam }) {
      const components = [];
      if (bodyParams.length) components.push({ type: 'body', parameters: bodyParams.map(text => ({ type: 'text', text: String(text) })) });
      quickReplies.forEach((payload, index) => components.push({ type: 'button', sub_type: 'quick_reply', index: String(index), parameters: [{ type: 'payload', payload }] }));
      if (urlButtonParam) components.push({ type: 'button', sub_type: 'url', index: String(quickReplies.length), parameters: [{ type: 'text', text: urlButtonParam }] });
      return send({ to, type: 'template', template: { name, language: { code: language }, components } });
    },
    sendText({ to, text }) {
      return send({ to, type: 'text', text: { body: text, preview_url: true } });
    },
  };
}

export function verifyWhatsAppSignature(rawBody, header, appSecret) {
  if (!header?.startsWith('sha256=')) return false;
  return safeEqual(hmacHex(appSecret, rawBody), header.slice('sha256='.length));
}

// Flattens a Cloud API webhook into the replies we care about.
export function parseInbound(body) {
  const replies = [];
  for (const entry of body?.entry || []) {
    for (const change of entry?.changes || []) {
      const value = change?.value || {};
      for (const message of value.messages || []) {
        const base = { id: message.id, from: message.from, phoneNumberId: value.metadata?.phone_number_id };
        if (message.type === 'button') replies.push({ ...base, kind: 'button', payload: message.button?.payload, text: message.button?.text });
        else if (message.type === 'interactive') {
          const reply = message.interactive?.button_reply || message.interactive?.list_reply;
          replies.push({ ...base, kind: 'button', payload: reply?.id, text: reply?.title });
        } else if (message.type === 'text') replies.push({ ...base, kind: 'text', text: message.text?.body });
      }
    }
  }
  return replies;
}

// Quick-reply payloads carry everything needed to act on a tap: cn|<action>|<shop>|<orderId>
export const encodePayload = (action, shop, orderId) => `cn|${action}|${shop}|${orderId}`;
export function decodePayload(payload) {
  const parts = String(payload || '').split('|');
  if (parts.length !== 4 || parts[0] !== 'cn') return null;
  const [, action, shop, orderId] = parts;
  if (!['confirm', 'prepaid', 'cancel'].includes(action) || !/^\d+$/.test(orderId)) return null;
  return { action, shop, orderId };
}
