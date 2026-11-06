import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export const hmacHex = (secret, data) => createHmac('sha256', secret).update(data).digest('hex');
export const hmacBase64 = (secret, data) => createHmac('sha256', secret).update(data).digest('base64');
export const randomToken = (bytes = 24) => randomBytes(bytes).toString('base64url');

// AES-256-GCM with a key derived from APP_SECRET. Output: v1.<iv>.<tag>.<ciphertext> (base64url).
function key(secret) {
  if (!secret || secret.length < 16) throw new Error('APP_SECRET must be set (32+ random characters) to store merchant secrets');
  return createHash('sha256').update(secret).digest();
}

export function encrypt(plain, secret) {
  if (plain === '' || plain == null) return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(secret), iv);
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

export function decrypt(sealed, secret) {
  if (!sealed) return '';
  const [version, iv, tag, body] = String(sealed).split('.');
  if (version !== 'v1' || !iv || !tag || !body) throw new Error('Unrecognised encrypted value');
  const decipher = createDecipheriv('aes-256-gcm', key(secret), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}

// Verifies a Shopify App Bridge session token (HS256 JWT signed with the app's API secret).
export function verifySessionToken(token, { apiKey, apiSecret, now = Date.now() }) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signature] = parts;
  let header, payload;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch { return null; }
  if (header.alg !== 'HS256') return null;
  const expected = createHmac('sha256', apiSecret).update(`${headerB64}.${payloadB64}`).digest('base64url');
  if (!safeEqual(expected, signature)) return null;
  const seconds = Math.floor(now / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < seconds - 5) return null;
  if (typeof payload.nbf === 'number' && payload.nbf > seconds + 5) return null;
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(apiKey)) return null;
  let shop;
  try { shop = new URL(payload.dest).hostname; } catch { return null; }
  if (!isValidShopDomain(shop)) return null;
  return { shop, userId: payload.sub, payload };
}

export function isValidShopDomain(shop) {
  return typeof shop === 'string' && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop);
}
