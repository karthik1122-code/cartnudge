import { hmacBase64, hmacHex, isValidShopDomain, safeEqual } from './crypto.mjs';

export const WEBHOOK_TOPICS = ['ORDERS_CREATE', 'CHECKOUTS_CREATE', 'CHECKOUTS_UPDATE', 'APP_UNINSTALLED', 'APP_SUBSCRIPTIONS_UPDATE'];

export function installUrl({ shop, apiKey, scopes, redirectUri, state }) {
  if (!isValidShopDomain(shop)) throw new Error('Invalid shop domain');
  const params = new URLSearchParams({ client_id: apiKey, scope: scopes, redirect_uri: redirectUri, state });
  return `https://${shop}/admin/oauth/authorize?${params}`;
}

// Verifies the hmac Shopify adds to OAuth callbacks and app-launch URLs.
export function verifyQueryHmac(searchParams, apiSecret) {
  const params = new URLSearchParams(searchParams);
  const given = params.get('hmac');
  if (!given) return false;
  params.delete('hmac');
  params.delete('signature');
  const message = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&');
  return safeEqual(hmacHex(apiSecret, message), given);
}

export function verifyWebhookHmac(rawBody, headerHmac, apiSecret) {
  return safeEqual(hmacBase64(apiSecret, rawBody), headerHmac);
}

export async function exchangeCodeForToken({ shop, code, apiKey, apiSecret, fetchImpl = fetch }) {
  const response = await fetchImpl(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: apiKey, client_secret: apiSecret, code }),
  });
  if (!response.ok) throw new Error(`Token exchange failed (${response.status})`);
  const body = await response.json();
  if (!body.access_token) throw new Error('Token exchange returned no access token');
  return { accessToken: body.access_token, scope: body.scope };
}

export function createAdminClient({ shop, accessToken, apiVersion, fetchImpl = fetch }) {
  async function graphql(query, variables = {}) {
    const response = await fetchImpl(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shopify-access-token': accessToken },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) throw new Error(`Shopify Admin API ${response.status}`);
    const body = await response.json();
    if (body.errors?.length) throw new Error(`Shopify GraphQL: ${body.errors.map(e => e.message).join('; ')}`);
    return body.data;
  }

  const userErrors = (result, field) => {
    const errors = result?.[field]?.userErrors || [];
    if (errors.length) throw new Error(`${field}: ${errors.map(e => e.message).join('; ')}`);
    return result[field];
  };

  return {
    graphql,

    async addTags(orderId, tags) {
      const data = await graphql(
        'mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }',
        { id: `gid://shopify/Order/${orderId}`, tags });
      return userErrors(data, 'tagsAdd');
    },

    async removeTags(orderId, tags) {
      const data = await graphql(
        'mutation($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { field message } } }',
        { id: `gid://shopify/Order/${orderId}`, tags });
      return userErrors(data, 'tagsRemove');
    },

    async appendNote(orderId, line) {
      const read = await graphql('query($id: ID!) { order(id: $id) { note } }', { id: `gid://shopify/Order/${orderId}` });
      const current = read?.order?.note || '';
      const note = current ? `${current}\n${line}` : line;
      const data = await graphql(
        'mutation($input: OrderInput!) { orderUpdate(input: $input) { userErrors { field message } } }',
        { input: { id: `gid://shopify/Order/${orderId}`, note } });
      return userErrors(data, 'orderUpdate');
    },

    async shopInfo() {
      const data = await graphql('{ shop { name email currencyCode myshopifyDomain } }');
      return data.shop;
    },

    async registerWebhooks(baseUrl) {
      const results = [];
      for (const topic of WEBHOOK_TOPICS) {
        const data = await graphql(
          `mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
             webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
               webhookSubscription { id } userErrors { field message } } }`,
          { topic, sub: { callbackUrl: `${baseUrl}/webhooks/shopify`, format: 'JSON' } });
        const errors = data.webhookSubscriptionCreate.userErrors;
        // "already been taken" means it is registered from an earlier install; anything else is real.
        if (errors.length && !errors.every(e => /taken/i.test(e.message))) throw new Error(`Webhook ${topic}: ${errors.map(e => e.message).join('; ')}`);
        results.push(topic);
      }
      return results;
    },

    // Usage-only subscription: no monthly fee, charges are capped per 30-day period.
    async createUsageSubscription({ name, terms, cappedUsd, returnUrl, test }) {
      const data = await graphql(
        `mutation($name: String!, $returnUrl: URL!, $test: Boolean, $lineItems: [AppSubscriptionLineItemInput!]!) {
           appSubscriptionCreate(name: $name, returnUrl: $returnUrl, test: $test, lineItems: $lineItems) {
             confirmationUrl appSubscription { id status } userErrors { field message } } }`,
        { name, returnUrl, test, lineItems: [{ plan: { appUsagePricingDetails: { terms, cappedAmount: { amount: cappedUsd, currencyCode: 'USD' } } } }] });
      return userErrors(data, 'appSubscriptionCreate');
    },

    async activeSubscription() {
      const data = await graphql(`{ currentAppInstallation { activeSubscriptions {
        id name status test currentPeriodEnd
        lineItems { id plan { pricingDetails { __typename ... on AppUsagePricing { terms cappedAmount { amount } balanceUsed { amount } } } } } } } }`);
      const sub = data.currentAppInstallation.activeSubscriptions[0];
      if (!sub) return null;
      const usage = sub.lineItems.find(item => item.plan?.pricingDetails?.__typename === 'AppUsagePricing');
      return {
        id: sub.id, name: sub.name, status: sub.status, test: sub.test, currentPeriodEnd: sub.currentPeriodEnd,
        usageLineItemId: usage?.id || null,
        cappedUsd: Number(usage?.plan.pricingDetails.cappedAmount?.amount ?? 0),
        usedUsd: Number(usage?.plan.pricingDetails.balanceUsed?.amount ?? 0),
      };
    },

    async recordUsage({ lineItemId, priceUsd, description, idempotencyKey }) {
      const data = await graphql(
        `mutation($id: ID!, $price: MoneyInput!, $description: String!, $key: String) {
           appUsageRecordCreate(subscriptionLineItemId: $id, price: $price, description: $description, idempotencyKey: $key) {
             appUsageRecord { id } userErrors { field message } } }`,
        { id: lineItemId, price: { amount: priceUsd, currencyCode: 'USD' }, description, key: idempotencyKey });
      return userErrors(data, 'appUsageRecordCreate');
    },
  };
}

// ---- order helpers

const COD_GATEWAY = /cash\s*on\s*delivery|\bcod\b/i;

export function isCodOrder(order) {
  const gateways = order?.payment_gateway_names || [];
  const cod = gateways.some(g => COD_GATEWAY.test(String(g)));
  const unpaid = !order?.financial_status || ['pending', 'authorized', 'partially_paid'].includes(order.financial_status);
  return cod && unpaid && !order?.cancelled_at && !order?.test;
}

export function orderPhone(order) {
  return order?.phone
    || order?.shipping_address?.phone
    || order?.billing_address?.phone
    || order?.customer?.phone
    || order?.customer?.default_address?.phone
    || null;
}

export function orderCustomerName(order) {
  const first = order?.shipping_address?.first_name || order?.customer?.first_name || order?.billing_address?.first_name;
  return (first || 'there').trim();
}

export function orderAmountRupees(order) {
  const amount = Number(order?.total_outstanding ?? order?.total_price ?? 0);
  return Math.round(amount * 100) / 100;
}

export function checkoutPhone(checkout) {
  return checkout?.phone || checkout?.shipping_address?.phone || checkout?.billing_address?.phone || checkout?.customer?.phone || null;
}
