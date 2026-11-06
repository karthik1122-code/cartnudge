import { openStore } from '../src/store.mjs';
import { encrypt } from '../src/crypto.mjs';

export const SHOP = 'kesar-threads.myshopify.com';
export const APP_SECRET = 'test-app-secret-that-is-long-enough-123';

export function testConfig(overrides = {}) {
  return {
    port: 0, appUrl: 'https://cartnudge.test', dataDir: null, production: false, appSecret: APP_SECRET,
    shopify: { apiKey: 'test-key', apiSecret: 'shpss_test_secret', scopes: 'read_orders,write_orders', apiVersion: '2025-10' },
    whatsapp: { phoneNumberId: '', accessToken: '', appSecret: 'wa-app-secret', verifyToken: 'verify-me', graphVersion: 'v21.0', templateLanguage: 'en', codTemplate: 'cod_confirm', cartTemplate: 'cart_reminder' },
    billing: { planName: 'CartNudge Pay-per-save', parcelPriceInr: 15, parcelPriceUsd: 0.16, monthlyCapInr: 2999, monthlyCapUsd: 32, test: true, required: false },
    cartSweepMinutes: 5, devShop: '',
    ...overrides,
  };
}

export function fakes() {
  const calls = { templates: [], texts: [], tagsAdded: [], tagsRemoved: [], notes: [], links: [], usage: [] };
  const whatsapp = () => ({
    live: true,
    async sendTemplate(args) { calls.templates.push(args); return { id: `wamid.${calls.templates.length}`, dryRun: false }; },
    async sendText(args) { calls.texts.push(args); return { id: 'wamid.t', dryRun: false }; },
  });
  const admin = () => ({
    async addTags(id, tags) { calls.tagsAdded.push([id, ...tags]); },
    async removeTags(id, tags) { calls.tagsRemoved.push([id, ...tags]); },
    async appendNote(id, line) { calls.notes.push([id, line]); },
    async recordUsage(args) { calls.usage.push(args); return { appUsageRecord: { id: 'ur_1' } }; },
  });
  const createPaymentLink = async args => { calls.links.push(args); return { id: 'plink_1', url: 'https://rzp.io/l/abc', amountRupees: args.amountRupees }; };
  return { calls, deps: { whatsapp, admin, createPaymentLink } };
}

export async function storeWithShop(settings = {}) {
  const store = await openStore(null);
  const sealed = { ...settings };
  for (const key of ['razorpayKeySecret', 'razorpayWebhookSecret', 'waAccessToken']) if (sealed[key]) sealed[key] = encrypt(sealed[key], APP_SECRET);
  await store.saveShop(SHOP, { name: 'Kesar Threads', accessToken: encrypt('shpat_x', APP_SECRET), settings: sealed });
  return store;
}

export function codOrder(overrides = {}) {
  return {
    id: 5550001, name: '#1042', order_number: 1042, total_price: '1499.00', financial_status: 'pending',
    payment_gateway_names: ['Cash on Delivery (COD)'],
    shipping_address: { first_name: 'Priya', phone: '+91 98765 43210' },
    checkout_token: 'chk_1', created_at: '2026-11-06T10:00:00Z',
    ...overrides,
  };
}
