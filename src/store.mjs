import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// A small JSON-file store. Writes are serialised and atomic (temp file + rename).
// Good for a single instance with a persistent disk; swap for Postgres when running more than one instance.
const EMPTY = () => ({ shops: {}, orders: {}, checkouts: {}, webhooks: {}, events: [] });
const WEBHOOK_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_EVENTS = 5000;

export async function openStore(dir) {
  let data = EMPTY();
  const file = dir ? join(dir, 'db.json') : null;
  if (file) {
    await mkdir(dir, { recursive: true });
    try { data = { ...EMPTY(), ...JSON.parse(await readFile(file, 'utf8')) }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  let chain = Promise.resolve();
  const persist = () => {
    if (!file) return Promise.resolve();
    chain = chain.then(async () => {
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(data));
      await rename(temp, file);
    });
    return chain;
  };

  const orderKey = (shop, id) => `${shop}#${id}`;

  return {
    // ---- shops
    getShop: shop => data.shops[shop] || null,
    listShops: () => Object.keys(data.shops),
    async saveShop(shop, patch) {
      data.shops[shop] = { ...(data.shops[shop] || {}), ...patch, shop };
      await persist();
      return data.shops[shop];
    },
    async deleteShop(shop) {
      delete data.shops[shop];
      for (const k of Object.keys(data.orders)) if (k.startsWith(`${shop}#`)) delete data.orders[k];
      for (const k of Object.keys(data.checkouts)) if (k.startsWith(`${shop}#`)) delete data.checkouts[k];
      data.events = data.events.filter(e => e.shop !== shop);
      await persist();
    },

    // ---- orders
    getOrder: (shop, id) => data.orders[orderKey(shop, id)] || null,
    async saveOrder(shop, id, patch) {
      const k = orderKey(shop, id);
      data.orders[k] = { ...(data.orders[k] || {}), ...patch, shop, id: String(id) };
      await persist();
      return data.orders[k];
    },
    listOrders: shop => Object.values(data.orders).filter(o => o.shop === shop),

    // ---- checkouts (abandoned-cart reminders)
    getCheckout: (shop, token) => data.checkouts[orderKey(shop, token)] || null,
    async saveCheckout(shop, token, patch) {
      const k = orderKey(shop, token);
      data.checkouts[k] = { ...(data.checkouts[k] || {}), ...patch, shop, token };
      await persist();
      return data.checkouts[k];
    },
    listCheckouts: shop => Object.values(data.checkouts).filter(c => !shop || c.shop === shop),

    // ---- customer redaction (GDPR)
    async redactCustomer(shop, { email, phone, orderIds = [] }) {
      const ids = new Set(orderIds.map(String));
      for (const order of Object.values(data.orders)) {
        if (order.shop !== shop) continue;
        if (ids.has(order.id) || (phone && order.phone === phone)) { order.phone = null; order.customerName = null; }
      }
      for (const checkout of Object.values(data.checkouts)) {
        if (checkout.shop !== shop) continue;
        if ((email && checkout.email === email) || (phone && checkout.phone === phone)) {
          checkout.phone = null; checkout.email = null; checkout.customerName = null; checkout.url = null;
        }
      }
      await persist();
    },

    // ---- webhook idempotency: returns true the first time an id is seen
    async claimWebhook(id, now = Date.now()) {
      if (!id) return true;
      for (const [k, ts] of Object.entries(data.webhooks)) if (now - ts > WEBHOOK_TTL_MS) delete data.webhooks[k];
      if (data.webhooks[id]) return false;
      data.webhooks[id] = now;
      await persist();
      return true;
    },

    // ---- activity log shown on the dashboard
    async logEvent(shop, type, detail = {}) {
      data.events.push({ shop, type, at: new Date().toISOString(), ...detail });
      if (data.events.length > MAX_EVENTS) data.events.splice(0, data.events.length - MAX_EVENTS);
      await persist();
    },
    listEvents: (shop, limit = 30) => data.events.filter(e => e.shop === shop).slice(-limit).reverse(),

    flush: () => chain,
  };
}
