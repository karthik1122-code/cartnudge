// Central configuration. Every secret comes from the environment; nothing is hard-coded.
const env = process.env;

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  port: num(env.PORT, 3000),
  appUrl: (env.APP_URL || 'http://localhost:3000').replace(/\/$/, ''),
  dataDir: env.DATA_DIR || './data',
  production: env.NODE_ENV === 'production',

  // Used to encrypt merchant secrets at rest (32+ random characters).
  appSecret: env.APP_SECRET || '',

  shopify: {
    apiKey: env.SHOPIFY_API_KEY || '',
    apiSecret: env.SHOPIFY_API_SECRET || '',
    scopes: env.SHOPIFY_SCOPES || 'read_orders,write_orders,read_checkouts,read_customers',
    apiVersion: env.SHOPIFY_API_VERSION || '2025-10',
  },

  whatsapp: {
    // Platform-level WhatsApp Cloud API credentials (a merchant may override phone id + token in settings).
    phoneNumberId: env.WA_PHONE_NUMBER_ID || '',
    accessToken: env.WA_ACCESS_TOKEN || '',
    appSecret: env.WA_APP_SECRET || '',
    verifyToken: env.WA_VERIFY_TOKEN || '',
    graphVersion: env.WA_GRAPH_VERSION || 'v21.0',
    templateLanguage: env.WA_TEMPLATE_LANGUAGE || 'en',
    codTemplate: env.WA_COD_TEMPLATE || 'cod_confirm',
    cartTemplate: env.WA_CART_TEMPLATE || 'cart_reminder',
  },

  billing: {
    planName: env.PLAN_NAME || 'CartNudge Growth',
    priceUsd: num(env.PLAN_PRICE_USD, 12),
    trialDays: num(env.PLAN_TRIAL_DAYS, 7),
    // Shopify test charges unless explicitly live.
    test: env.BILLING_LIVE !== 'true',
    // Off while onboarding free beta stores; turn on to require an active plan before messages are sent.
    required: env.BILLING_REQUIRED === 'true',
  },

  cartSweepMinutes: num(env.CART_SWEEP_MINUTES, 5),

  // Local preview without Shopify: serves the dashboard for this shop with no session token.
  devShop: env.NODE_ENV === 'production' ? '' : (env.DEV_SHOP || ''),
};

export const DEFAULT_SETTINGS = Object.freeze({
  codConfirmEnabled: true,
  prepaidNudgeEnabled: true,
  cartRemindersEnabled: true,
  prepaidDiscountRupees: 50,
  rtoCostRupees: 200,          // forward + reverse shipping + packaging lost on one returned COD order
  codRtoRatePercent: 25,       // share of unconfirmed COD orders that usually come back
  cartDelayMinutes: 60,
  brandName: '',
  poweredBy: true,
  razorpayKeyId: '',
  razorpayKeySecret: '',       // stored encrypted
  razorpayWebhookSecret: '',   // stored encrypted
  waPhoneNumberId: '',
  waAccessToken: '',           // stored encrypted
});

export const SECRET_SETTING_KEYS = ['razorpayKeySecret', 'razorpayWebhookSecret', 'waAccessToken'];

export const TAGS = Object.freeze({
  pending: 'cn-cod-pending',
  confirmed: 'cn-cod-confirmed',
  cancelled: 'cn-cod-cancel-requested',
  prepaid: 'cn-paid-online',
  noPhone: 'cn-no-phone',
});
