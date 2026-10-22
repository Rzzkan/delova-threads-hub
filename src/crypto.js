import crypto from 'node:crypto';

const secret = process.env.APP_SECRET;
if (!secret) {
  if (process.env.NODE_ENV === 'production') {
    console.error('APP_SECRET wajib diisi di production.');
    process.exit(1);
  }
  console.warn('[peringatan] APP_SECRET belum diisi, memakai kunci dev yang TIDAK aman.');
}
const key = crypto.scryptSync(secret || 'dev-insecure-secret-change-me', 'delova-hub-v1', 32);

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Enkripsi token Threads sebelum disimpan di database (AES-256-GCM). */
export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

export function decrypt(blob) {
  const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `s1$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  const [v, salt, hash] = (stored || '').split('$');
  if (v !== 's1' || !salt || !hash) return false;
  const test = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

const b64u = (b) => Buffer.from(b).toString('base64url');

/** Token sesi bertanda tangan (HMAC), dipakai di cookie. */
export function sign(payload, ttlSeconds = 60 * 60 * 24 * 7) {
  const body = b64u(JSON.stringify({ ...payload, exp: Date.now() + ttlSeconds * 1000 }));
  const mac = crypto.createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verify(token) {
  const [body, mac] = (token || '').split('.');
  if (!body || !mac) return null;
  const expect = crypto.createHmac('sha256', key).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch {
    return null;
  }
}

export const randomToken = (prefix) => `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
