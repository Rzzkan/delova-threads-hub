/**
 * Klien Instagram API (Instagram API with Instagram Login, graph.instagram.com).
 *  - OAuth:   https://www.instagram.com/oauth/authorize  →  POST api.instagram.com/oauth/access_token  →  token jangka panjang (60 hari)
 *  - Publish: POST /{ig-id}/media (container) → (tunggu FINISHED) → POST /{ig-id}/media_publish
 *  - Komentar: /{media-id}/comments, /{comment-id}/replies, hide; DM: /{ig-id}/conversations & /{ig-id}/messages
 *  - Insight: /{ig-id}/insights dan /{media-id}/insights
 * Akun harus Instagram Professional (Business/Creator). Mode simulasi mengikuti saklar mode Threads
 * (THREADS_DRY_RUN / Pengaturan Meta) atau tidak adanya kredensial Instagram; tidak memanggil Meta sama sekali.
 */
import { decrypt, encrypt } from './crypto.js';
import { getSetting, get, run, all, now, audit } from './db.js';
import { modeSetting } from './threads.js';
import { expireMediaOfPost } from './media.js';

const VER = process.env.IG_API_VERSION || 'v24.0';
const GRAPH = 'https://graph.instagram.com';
const V = `${GRAPH}/${VER}`;

export const SCOPES = [
  'instagram_business_basic',
  'instagram_business_content_publish',
  'instagram_business_manage_comments',
  'instagram_business_manage_messages',
  'instagram_business_manage_insights',
];

export class IgError extends Error {
  constructor(message, detail) { super(message); this.detail = detail; }
}

/** Kredensial aplikasi Instagram (App ID Instagram berbeda dari App ID Meta/Threads). Dashboard → .env. */
export function creds() {
  const id = getSetting('ig_app_id'); const enc = getSetting('ig_app_secret_enc');
  if (id && enc) { try { return { appId: id, appSecret: decrypt(enc), source: 'dashboard' }; } catch { /* lanjut ke .env */ } }
  if (process.env.INSTAGRAM_APP_ID) return { appId: process.env.INSTAGRAM_APP_ID, appSecret: process.env.INSTAGRAM_APP_SECRET || '', source: 'env' };
  return { appId: '', appSecret: '', source: 'none' };
}
export const isDryRun = () => {
  const m = modeSetting();
  if (m === 'sim' || (m === 'auto' && process.env.THREADS_DRY_RUN === 'true')) return true;
  return !creds().appId;
};
export const redirectUri = () => `${(process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '')}/auth/instagram/callback`;

async function call(method, url, params = {}, { json = false } = {}) {
  const clean = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  const opts = { method };
  let u = url;
  if (method === 'GET') u += (url.includes('?') ? '&' : '?') + new URLSearchParams(clean.map(([k, v]) => [k, String(v)]));
  else if (json) {
    const { access_token, ...rest } = params;
    u += (url.includes('?') ? '&' : '?') + new URLSearchParams({ access_token });
    opts.body = JSON.stringify(rest); opts.headers = { 'content-type': 'application/json' };
  } else { opts.body = new URLSearchParams(clean.map(([k, v]) => [k, String(v)])); opts.headers = { 'content-type': 'application/x-www-form-urlencoded' }; }
  const r = await fetch(u, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error || j.error_message) throw new IgError(j.error?.message || j.error_message || `Instagram API HTTP ${r.status}`, j.error);
  return j;
}

export const accountOf = (brandId) => get('SELECT * FROM ig_accounts WHERE brand_id=?', brandId);
const tokenOf = (acc, brandName = '') => {
  if (!acc?.token_enc) throw new IgError(`Akun Instagram ${brandName} belum terhubung.`);
  return decrypt(acc.token_enc);
};
const seeded = (s, max) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % max; };

/* ---------------- OAuth ---------------- */
export function authorizeUrl(state) {
  const q = new URLSearchParams({ client_id: creds().appId, redirect_uri: redirectUri(), response_type: 'code', scope: SCOPES.join(','), state });
  return `https://www.instagram.com/oauth/authorize?${q}`;
}
export async function exchangeCode(code) {
  const { appId, appSecret } = creds();
  if (!appId || !appSecret) throw new IgError('Kredensial Instagram (App ID / App Secret) belum diisi.');
  const short = await call('POST', 'https://api.instagram.com/oauth/access_token', { client_id: appId, client_secret: appSecret, grant_type: 'authorization_code', redirect_uri: redirectUri(), code });
  const long = await call('GET', `${GRAPH}/access_token`, { grant_type: 'ig_exchange_token', client_secret: appSecret, access_token: short.access_token });
  const me = await call('GET', `${V}/me`, { fields: 'user_id,username,account_type,followers_count', access_token: long.access_token });
  return { token: long.access_token, expiresIn: long.expires_in || 60 * 24 * 3600, userId: String(me.user_id || me.id || short.user_id), username: me.username, accountType: me.account_type, followers: me.followers_count ?? null };
}
export async function refreshToken(acc) {
  const r = await call('GET', `${GRAPH}/refresh_access_token`, { grant_type: 'ig_refresh_token', access_token: tokenOf(acc) });
  return { token: r.access_token, expiresIn: r.expires_in || 60 * 24 * 3600 };
}

/* ---------------- Publish ---------------- */
export const isVideoUrl = (u) => /\.(mp4|mov)(\?|$)/i.test(u);
async function waitFinished(id, token, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const s = await call('GET', `${V}/${id}`, { fields: 'status_code,status', access_token: token });
    if (s.status_code === 'FINISHED' || s.status_code === 'PUBLISHED') return;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new IgError(s.status || `Container ${s.status_code}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new IgError('Container Instagram belum siap setelah menunggu. Coba lagi nanti.');
}

export async function publish(acc, brand, post) {
  if (isDryRun()) {
    const id = `igdry_${Date.now()}`;
    return { mediaId: id, permalink: `https://www.instagram.com/p/${id}/`, dryRun: true };
  }
  const token = tokenOf(acc, brand.name); const uid = acc.ig_user_id;
  const media = JSON.parse(post.media_urls || '[]');
  let creation;
  if (post.kind === 'reels') {
    creation = await call('POST', `${V}/${uid}/media`, { access_token: token, media_type: 'REELS', video_url: media[0], caption: post.caption, share_to_feed: true });
  } else if (post.kind === 'story') {
    const v = isVideoUrl(media[0]);
    creation = await call('POST', `${V}/${uid}/media`, { access_token: token, media_type: 'STORIES', [v ? 'video_url' : 'image_url']: media[0] });
  } else if (media.length === 1) {
    creation = await call('POST', `${V}/${uid}/media`, { access_token: token, image_url: media[0], caption: post.caption });
  } else {
    const children = [];
    for (const m of media) {
      const v = isVideoUrl(m);
      const c = await call('POST', `${V}/${uid}/media`, { access_token: token, is_carousel_item: true, ...(v ? { media_type: 'VIDEO', video_url: m } : { image_url: m }) });
      await waitFinished(c.id, token);
      children.push(c.id);
    }
    creation = await call('POST', `${V}/${uid}/media`, { access_token: token, media_type: 'CAROUSEL', children: children.join(','), caption: post.caption });
  }
  await waitFinished(creation.id, token);
  const pub = await call('POST', `${V}/${uid}/media_publish`, { creation_id: creation.id, access_token: token });
  let permalink = null;
  try { permalink = (await call('GET', `${V}/${pub.id}`, { fields: 'permalink', access_token: token })).permalink; } catch { /* opsional */ }
  return { mediaId: pub.id, permalink };
}

/* ---------------- Media & komentar ---------------- */
const SIM_CAPTIONS = [
  'Kebaya brokat sage, cocok untuk kondangan siang #kebayamodern', 'Behind the scene sesi foto koleksi terbaru',
  'Tips padu padan batik untuk kerja #batikmodern', 'Restock hari ini! Cek keranjang Shopee kami', 'Testimoni pelanggan: bahannya adem banget',
  'Cara pakai pashmina 3 gaya #hijabstyle', 'Promo kilat akhir pekan', 'Dress anak motif batik #delovakids',
];
export async function listMedia(acc, brand, limit = 12) {
  if (isDryRun()) {
    return SIM_CAPTIONS.slice(0, limit).map((c, i) => {
      const id = `${brand.id}_m${i + 1}`;
      return { id, caption: c, media_type: i % 4 === 3 ? 'VIDEO' : i % 3 === 2 ? 'CAROUSEL_ALBUM' : 'IMAGE', permalink: `https://www.instagram.com/p/sim${id}/`, timestamp: new Date(Date.now() - (i + 1) * 36 * 3600e3).toISOString(), like_count: 20 + seeded(id + 'l', 400), comments_count: 2 + seeded(id + 'c', 3) };
    });
  }
  const r = await call('GET', `${V}/${acc.ig_user_id}/media`, { fields: 'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,thumbnail_url,media_url', limit, access_token: tokenOf(acc, brand.name) });
  return r.data || [];
}
export async function listComments(acc, brand, mediaId) {
  if (isDryRun()) {
    const n = 2 + seeded(mediaId + 'c', 3);
    const bank = [['pembeli_contoh', 'Kak, ini ada ukuran XL nggak?'], ['ibu_rina', 'Bahannya adem ya? Cocok buat kondangan siang.'], ['dina.styles', 'Cantik banget motifnya 😍'], ['sari_m', 'Bisa COD kak?'], ['toko_spam99', 'Follow back yuk, promo murah https://spam.example']];
    return bank.slice(0, n).map(([username, text], i) => ({ id: `${mediaId}_c${i + 1}`, text, username, timestamp: new Date(Date.now() - (i + 1) * 3600e3).toISOString(), hidden: false, like_count: seeded(mediaId + i, 9), replies: i === 1 ? [{ id: `${mediaId}_c2_r1`, text: 'Halo Kak, betul adem dan jatuh 😊', username: brand.username || 'delova', timestamp: new Date().toISOString() }] : [] }));
  }
  const r = await call('GET', `${V}/${mediaId}/comments`, { fields: 'id,text,username,timestamp,hidden,like_count,replies{id,text,username,timestamp}', limit: 50, access_token: tokenOf(acc, brand.name) });
  return (r.data || []).map((c) => ({ ...c, replies: c.replies?.data || [] }));
}
export async function replyComment(acc, brand, commentId, text) {
  if (isDryRun()) return { id: `igdry_reply_${Date.now()}`, dryRun: true };
  return call('POST', `${V}/${commentId}/replies`, { message: text, access_token: tokenOf(acc, brand.name) });
}
export async function hideComment(acc, brand, commentId, hide = true) {
  if (isDryRun()) return { success: true, dryRun: true };
  return call('POST', `${V}/${commentId}`, { hide, access_token: tokenOf(acc, brand.name) });
}

/* ---------------- Pesan langsung (DM) ---------------- */
export async function listConversations(acc, brand) {
  if (isDryRun()) {
    const people = [['pembeli_contoh', 'Halo kak, kebaya sage masih ready ukuran M?', 2], ['ibu_rina', 'Terima kasih infonya kak 🙏', 30], ['sari_m', 'Boleh minta katalog untuk seragam kantor?', 5]];
    return people.map(([username, last, hrs], i) => ({ id: `${brand.id}_conv${i + 1}`, updated_time: new Date(Date.now() - hrs * 3600e3).toISOString(), participant: { id: `ig_${username}`, username }, last_message: last, can_reply: hrs < 24 }));
  }
  const r = await call('GET', `${V}/${acc.ig_user_id}/conversations`, { platform: 'instagram', fields: 'id,updated_time,participants,messages.limit(1){message,from,created_time}', limit: 25, access_token: tokenOf(acc, brand.name) });
  return (r.data || []).map((c) => {
    const other = (c.participants?.data || []).find((p) => String(p.id) !== String(acc.ig_user_id)) || {};
    const last = c.messages?.data?.[0];
    const age = Date.now() - Date.parse(last?.created_time || c.updated_time || 0);
    return { id: c.id, updated_time: c.updated_time, participant: { id: other.id, username: other.username }, last_message: last?.message || '', can_reply: !!last && String(last.from?.id) !== String(acc.ig_user_id) && age < 24 * 3600e3 };
  });
}
export async function getMessages(acc, brand, convId) {
  if (isDryRun()) {
    const user = convId.endsWith('conv2') ? 'ibu_rina' : convId.endsWith('conv3') ? 'sari_m' : 'pembeli_contoh';
    const t = (h) => new Date(Date.now() - h * 3600e3).toISOString();
    return [{ id: `${convId}_1`, from: { id: `ig_${user}`, username: user }, message: 'Halo kak, kebaya sage masih ready ukuran M?', created_time: t(3) }, { id: `${convId}_2`, from: { id: 'me', username: brand.username || 'delova' }, message: 'Halo Kak, masih ready ya 😊 Mau dikirim ke mana?', created_time: t(2.5) }, { id: `${convId}_3`, from: { id: `ig_${user}`, username: user }, message: 'Jogja kak, ongkirnya berapa?', created_time: t(2) }];
  }
  const r = await call('GET', `${V}/${convId}`, { fields: 'messages.limit(30){id,message,from,created_time}', access_token: tokenOf(acc, brand.name) });
  return (r.messages?.data || []).slice().reverse();
}
export async function sendMessage(acc, brand, recipientId, text) {
  if (isDryRun()) return { message_id: `igdry_dm_${Date.now()}`, dryRun: true };
  return call('POST', `${V}/${acc.ig_user_id}/messages`, { recipient: { id: recipientId }, message: { text }, access_token: tokenOf(acc, brand.name) }, { json: true });
}

/* ---------------- Insight ---------------- */
const ACCOUNT_METRICS = ['reach', 'views', 'accounts_engaged', 'total_interactions', 'likes', 'comments', 'shares', 'saves'];
const MEDIA_METRICS = ['reach', 'views', 'likes', 'comments', 'shares', 'saved', 'total_interactions'];
const settled = async (names, fn) => {
  const out = {};
  await Promise.all(names.map(async (m) => { try { out[m] = await fn(m); } catch { out[m] = null; /* metrik tak tersedia untuk akun/tipe ini */ } }));
  return out;
};
export async function accountInsights(acc, brand, days = 7) {
  if (isDryRun()) {
    const base = seeded(brand.id, 400);
    return { followers: 800 + seeded(brand.id + 'f', 9000), days, metrics: { reach: (3000 + base * 20) * days / 7 | 0, views: (9000 + base * 50) * days / 7 | 0, accounts_engaged: (400 + base) * days / 7 | 0, total_interactions: (900 + base * 3) * days / 7 | 0, likes: (700 + base * 2) * days / 7 | 0, comments: (60 + base / 4) * days / 7 | 0, shares: (40 + base / 5) * days / 7 | 0, saves: (90 + base / 3) * days / 7 | 0 } };
  }
  const token = tokenOf(acc, brand.name);
  const until = Math.floor(Date.now() / 1000); const since = until - days * 86400;
  const metrics = await settled(ACCOUNT_METRICS, async (m) => {
    const r = await call('GET', `${V}/${acc.ig_user_id}/insights`, { metric: m, period: 'day', metric_type: 'total_value', since, until, access_token: token });
    return r.data?.[0]?.total_value?.value ?? null;
  });
  let followers = null;
  try { followers = (await call('GET', `${V}/me`, { fields: 'followers_count', access_token: token })).followers_count ?? null; } catch { /* opsional */ }
  return { followers, days, metrics };
}
export async function mediaInsights(acc, brand, mediaId) {
  if (isDryRun()) {
    return { reach: 300 + seeded(mediaId + 'r', 6000), views: 500 + seeded(mediaId + 'v', 9000), likes: seeded(mediaId + 'l', 400), comments: seeded(mediaId + 'c', 40), shares: seeded(mediaId + 's', 60), saved: seeded(mediaId + 'sv', 90), total_interactions: 20 + seeded(mediaId + 't', 500) };
  }
  const token = tokenOf(acc, brand.name);
  return settled(MEDIA_METRICS, async (m) => {
    const r = await call('GET', `${V}/${mediaId}/insights`, { metric: m, access_token: token });
    return r.data?.[0]?.values?.[0]?.value ?? r.data?.[0]?.total_value?.value ?? null;
  });
}

/* ---------------- Penjadwal ---------------- */
const DAILY_LIMIT = 95; // batas resmi API: 100 post / 24 jam per akun
export async function publishIgPost(id, { allowFrom = ['scheduled'], userId = null } = {}) {
  const marks = allowFrom.map(() => '?').join(',');
  const claim = run(`UPDATE ig_posts SET status='publishing', error=NULL, updated_at=? WHERE id=? AND status IN (${marks})`, now(), id, ...allowFrom);
  if (!claim.changes) return get('SELECT * FROM ig_posts WHERE id=?', id);
  const post = get('SELECT * FROM ig_posts WHERE id=?', id);
  const brand = get('SELECT * FROM brands WHERE id=?', post.brand_id);
  try {
    const acc = accountOf(post.brand_id);
    if (!acc?.token_enc && !isDryRun()) throw new IgError(`Akun Instagram ${brand.name} belum terhubung.`);
    const since = new Date(Date.now() - 24 * 3600e3).toISOString();
    if (get("SELECT COUNT(*) AS n FROM ig_posts WHERE brand_id=? AND status='published' AND published_at>?", brand.id, since).n >= DAILY_LIMIT) throw new Error('Batas 100 post/24 jam Instagram hampir tercapai. Coba lagi nanti.');
    const r = await publish(acc, brand, post);
    run("UPDATE ig_posts SET status='published', published_at=?, ig_media_id=?, permalink=?, updated_at=? WHERE id=?", now(), r.mediaId, r.permalink, now(), id);
    expireMediaOfPost(id);
    audit(userId, 'ig.post.published', { id, brand: brand.id, dryRun: !!r.dryRun });
  } catch (e) {
    run("UPDATE ig_posts SET status='failed', error=?, updated_at=? WHERE id=?", String(e.message).slice(0, 500), now(), id);
    audit(userId, 'ig.post.failed', { id, error: e.message });
  }
  return get('SELECT * FROM ig_posts WHERE id=?', id);
}
export async function igTick() {
  for (const p of all("SELECT id FROM ig_posts WHERE status='scheduled' AND scheduled_at<=? ORDER BY scheduled_at LIMIT 10", now())) await publishIgPost(p.id);
}
export async function igRefreshTokens() {
  if (isDryRun()) return;
  const soon = new Date(Date.now() + 10 * 24 * 3600e3).toISOString();
  for (const a of all('SELECT * FROM ig_accounts WHERE token_enc IS NOT NULL AND token_expires_at<?', soon)) {
    try {
      const r = await refreshToken(a);
      run('UPDATE ig_accounts SET token_enc=?, token_expires_at=?, token_refreshed_at=? WHERE brand_id=?', encrypt(r.token), new Date(Date.now() + r.expiresIn * 1000).toISOString(), now(), a.brand_id);
      audit(null, 'ig.token.refreshed', { brand: a.brand_id });
    } catch (e) { audit(null, 'ig.token.refresh_failed', { brand: a.brand_id, error: e.message }); }
  }
}
