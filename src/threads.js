/**
 * Klien Threads API (Meta). Base URL & alur mengikuti dokumentasi resmi:
 *  - OAuth:  https://threads.com/oauth/authorize  →  POST graph.threads.com/oauth/access_token
 *  - Publish: POST /{user-id}/threads  →  (tunggu FINISHED)  →  POST /{user-id}/threads_publish
 * Mode simulasi (THREADS_DRY_RUN=true, atau THREADS_APP_ID kosong) tidak memanggil Meta sama sekali.
 */
import { decrypt } from './crypto.js';
import { getSetting, get } from './db.js';

const GRAPH = 'https://graph.threads.com';
const V = `${GRAPH}/v1.0`;

export const SCOPES = [
  'threads_basic',
  'threads_content_publish',
  'threads_read_replies',
  'threads_manage_replies',
  'threads_manage_insights',
];
/** Izin tambahan untuk Riset, Mention, dan Kolaborasi. Hanya diminta bila admin mengaktifkannya (izin harus sudah ditambahkan di app Meta). */
export const EXTRA_SCOPES = ['threads_keyword_search', 'threads_manage_mentions', 'threads_profile_discovery'];
export const extraScopesOn = () => getSetting('threads_extra_scopes') === '1';
export const scopes = () => (extraScopesOn() ? [...SCOPES, ...EXTRA_SCOPES] : SCOPES);

/**
 * Kredensial Meta: prioritas  (1) milik brand  →  (2) pengaturan global di dashboard  →  (3) .env.
 * Satu aplikasi Meta cukup untuk semua akun; override per brand hanya jika brand memakai aplikasi Meta sendiri.
 */
export function creds(brand) {
  try {
    if (brand?.app_id && brand?.app_secret_enc) return { appId: brand.app_id, appSecret: decrypt(brand.app_secret_enc), source: 'brand' };
  } catch { /* secret tak terbaca (APP_SECRET berubah): jatuh ke global */ }
  const gid = getSetting('meta_app_id');
  const genc = getSetting('meta_app_secret_enc');
  if (gid && genc) {
    try { return { appId: gid, appSecret: decrypt(genc), source: 'dashboard' }; } catch { /* lanjut ke .env */ }
  }
  if (process.env.THREADS_APP_ID) return { appId: process.env.THREADS_APP_ID, appSecret: process.env.THREADS_APP_SECRET || '', source: 'env' };
  return { appId: '', appSecret: '', source: 'none' };
}

/** Saklar mode: 'sim' memaksa simulasi, 'live' memaksa nyata, 'auto' mengikuti THREADS_DRY_RUN di .env. */
export const modeSetting = () => {
  const m = getSetting('threads_mode');
  return m === 'live' || m === 'sim' ? m : 'auto';
};
const forcedSim = () => {
  const m = modeSetting();
  return m === 'sim' || (m === 'auto' && process.env.THREADS_DRY_RUN === 'true');
};
/** Tanpa argumen: simulasi jika saklar simulasi, atau tidak ada kredensial sama sekali (global maupun brand). */
export const isDryRun = (brand) => {
  if (forcedSim()) return true;
  if (brand) return !creds(brand).appId;
  if (creds().appId) return false;
  return !get("SELECT 1 AS x FROM brands WHERE app_id IS NOT NULL AND app_id<>'' AND app_secret_enc IS NOT NULL LIMIT 1");
};
export const redirectUri = () => `${(process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '')}/auth/threads/callback`;

export class ThreadsError extends Error {
  constructor(message, detail) {
    super(message);
    this.detail = detail;
  }
}

async function call(method, url, params = {}) {
  const qs = new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => [k, String(v)]),
  );
  const opts = { method };
  let u = url;
  if (method === 'GET') u += (url.includes('?') ? '&' : '?') + qs;
  else {
    opts.body = qs;
    opts.headers = { 'content-type': 'application/x-www-form-urlencoded' };
  }
  const r = await fetch(u, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new ThreadsError(j.error?.message || `Threads API HTTP ${r.status}`, j.error);
  return j;
}

const tokenOf = (brand) => {
  if (!brand.token_enc) throw new ThreadsError(`Akun ${brand.name} belum terhubung ke Threads.`);
  return decrypt(brand.token_enc);
};

/* ---------------- OAuth ---------------- */
export function authorizeUrl(state, brand) {
  const q = new URLSearchParams({
    client_id: creds(brand).appId,
    redirect_uri: redirectUri(),
    scope: scopes().join(','),
    response_type: 'code',
    state,
  });
  return `https://threads.com/oauth/authorize?${q}`;
}

export async function exchangeCode(code, brand) {
  const { appId, appSecret } = creds(brand);
  if (!appId || !appSecret) throw new ThreadsError('Kredensial Meta (App ID / App Secret) belum diisi.');
  const short = await call('POST', `${GRAPH}/oauth/access_token`, {
    client_id: appId,
    client_secret: appSecret,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(),
    code,
  });
  const long = await call('GET', `${GRAPH}/access_token`, {
    grant_type: 'th_exchange_token',
    client_secret: appSecret,
    access_token: short.access_token,
  });
  const profile = await call('GET', `${V}/me`, { fields: 'id,username,name', access_token: long.access_token });
  return {
    token: long.access_token,
    expiresIn: long.expires_in || 60 * 24 * 3600,
    userId: String(profile.id || short.user_id),
    username: profile.username,
  };
}

export async function refreshToken(brand) {
  const r = await call('GET', `${GRAPH}/refresh_access_token`, {
    grant_type: 'th_refresh_token',
    access_token: tokenOf(brand),
  });
  return { token: r.access_token, expiresIn: r.expires_in || 60 * 24 * 3600 };
}

/* ---------------- Publish ---------------- */
const isVideo = (u) => /\.(mp4|mov)(\?|$)/i.test(u);

async function waitFinished(id, token, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const s = await call('GET', `${V}/${id}`, { fields: 'status,error_message', access_token: token });
    if (s.status === 'FINISHED' || s.status === 'PUBLISHED') return;
    if (s.status === 'ERROR' || s.status === 'EXPIRED') throw new ThreadsError(s.error_message || `Container ${s.status}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new ThreadsError('Container Threads belum siap setelah menunggu. Coba lagi nanti.');
}

export async function publish(brand, post) {
  if (isDryRun(brand)) {
    const id = `dry_${Date.now()}`;
    return { mediaId: id, permalink: `https://www.threads.com/@${brand.username || brand.id}/post/${id}`, dryRun: true };
  }
  const token = tokenOf(brand);
  const uid = brand.threads_user_id;
  const media = JSON.parse(post.media_urls || '[]');
  const base = { access_token: token, reply_control: post.reply_control, topic_tag: post.topic_tag };
  let creation;

  if (media.length === 0) {
    creation = await call('POST', `${V}/${uid}/threads`, { ...base, media_type: 'TEXT', text: post.text });
  } else if (media.length === 1) {
    const v = isVideo(media[0]);
    creation = await call('POST', `${V}/${uid}/threads`, {
      ...base,
      media_type: v ? 'VIDEO' : 'IMAGE',
      [v ? 'video_url' : 'image_url']: media[0],
      text: post.text,
    });
  } else {
    const children = [];
    for (const m of media) {
      const v = isVideo(m);
      const c = await call('POST', `${V}/${uid}/threads`, {
        access_token: token,
        media_type: v ? 'VIDEO' : 'IMAGE',
        is_carousel_item: true,
        [v ? 'video_url' : 'image_url']: m,
      });
      await waitFinished(c.id, token);
      children.push(c.id);
    }
    creation = await call('POST', `${V}/${uid}/threads`, {
      ...base,
      media_type: 'CAROUSEL',
      children: children.join(','),
      text: post.text,
    });
  }

  await waitFinished(creation.id, token);
  const pub = await call('POST', `${V}/${uid}/threads_publish`, { creation_id: creation.id, access_token: token });
  let permalink = null;
  try {
    permalink = (await call('GET', `${V}/${pub.id}`, { fields: 'permalink', access_token: token })).permalink;
  } catch {
    /* permalink opsional */
  }
  return { mediaId: pub.id, permalink };
}

/* ---------------- Replies ---------------- */
export async function listReplies(brand, mediaId) {
  if (isDryRun(brand)) {
    return [
      { id: `${mediaId}_r1`, text: 'Kak, ini ada ukuran XL nggak?', username: 'pembeli_contoh', timestamp: new Date().toISOString(), hide_status: 'NOT_HUSHED' },
      { id: `${mediaId}_r2`, text: 'Bahannya adem ya? Cocok buat kondangan siang.', username: 'ibu_rina', timestamp: new Date().toISOString(), hide_status: 'NOT_HUSHED' },
      { id: `${mediaId}_r3`, text: 'Cantik banget motifnya 😍', username: 'dina.styles', timestamp: new Date().toISOString(), hide_status: 'NOT_HUSHED' },
    ];
  }
  const r = await call('GET', `${V}/${mediaId}/replies`, {
    fields: 'id,text,username,timestamp,hide_status',
    reverse: 'true',
    access_token: tokenOf(brand),
  });
  return r.data || [];
}

export async function postText(brand, id) {
  if (isDryRun(brand)) return 'Kebaya brokat sage, cocok untuk kondangan siang #kebayamodern';
  const r = await call('GET', `${V}/${id}`, { fields: 'text', access_token: tokenOf(brand) });
  return r.text || '';
}

export async function replyTo(brand, targetId, text) {
  if (isDryRun(brand)) return { mediaId: `dry_reply_${Date.now()}`, dryRun: true };
  const token = tokenOf(brand);
  const c = await call('POST', `${V}/${brand.threads_user_id}/threads`, {
    access_token: token,
    media_type: 'TEXT',
    text,
    reply_to_id: targetId,
  });
  await waitFinished(c.id, token);
  const p = await call('POST', `${V}/${brand.threads_user_id}/threads_publish`, { creation_id: c.id, access_token: token });
  return { mediaId: p.id };
}

export async function hideReply(brand, replyId, hide = true) {
  if (isDryRun(brand)) return { success: true, dryRun: true };
  return call('POST', `${V}/${replyId}/manage_reply`, { hide, access_token: tokenOf(brand) });
}

/* ---------------- Insights ---------------- */
const seeded = (s, max) => {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % max;
};

export async function mediaInsights(brand, mediaId) {
  if (isDryRun(brand)) {
    return { views: 200 + seeded(mediaId, 4000), likes: seeded(mediaId + 'l', 120), replies: seeded(mediaId + 'r', 25), reposts: seeded(mediaId + 'p', 15), quotes: seeded(mediaId + 'q', 6), shares: seeded(mediaId + 's', 10) };
  }
  const r = await call('GET', `${V}/${mediaId}/insights`, {
    metric: 'views,likes,replies,reposts,quotes,shares',
    access_token: tokenOf(brand),
  });
  return Object.fromEntries((r.data || []).map((m) => [m.name, m.values?.[0]?.value ?? m.total_value?.value ?? 0]));
}

export async function userInsights(brand, days = 7) {
  if (isDryRun(brand)) {
    return { views: 1500 + seeded(brand.id, 9000), likes: 80 + seeded(brand.id + 'l', 500), replies: 10 + seeded(brand.id + 'r', 90), reposts: seeded(brand.id + 'p', 60), quotes: seeded(brand.id + 'q', 20), followers_count: 300 + seeded(brand.id + 'f', 5000) };
  }
  const token = tokenOf(brand);
  const until = Math.floor(Date.now() / 1000);
  const since = until - days * 86400;
  const totals = await call('GET', `${V}/${brand.threads_user_id}/threads_insights`, {
    metric: 'views,likes,replies,reposts,quotes',
    since,
    until,
    access_token: token,
  });
  const out = {};
  for (const m of totals.data || []) {
    out[m.name] = m.total_value?.value ?? (m.values || []).reduce((a, v) => a + (v.value || 0), 0);
  }
  try {
    const f = await call('GET', `${V}/${brand.threads_user_id}/threads_insights`, { metric: 'followers_count', access_token: token });
    out.followers_count = f.data?.[0]?.total_value?.value ?? null;
  } catch {
    out.followers_count = null;
  }
  return out;
}

/* ---------------- Riset, Mention, Profil (izin tambahan) ---------------- */
const needExtra = (brand) => {
  if (isDryRun(brand)) return;
  if (!extraScopesOn()) throw new ThreadsError('Fitur ini butuh izin tambahan. Admin: aktifkan "Izin riset, mention & kolaborasi" di Pengaturan Meta, lalu hubungkan ulang akun.');
};
const POST_FIELDS = 'id,text,media_type,permalink,timestamp,username,has_replies,is_quote_post,is_reply';
const mapPost = (m) => ({
  id: String(m.id), text: m.text || '', media_type: m.media_type || 'TEXT', permalink: m.permalink || '',
  timestamp: m.timestamp || null, username: m.username || '', has_replies: !!m.has_replies, is_quote_post: !!m.is_quote_post, is_reply: !!m.is_reply,
});

const NAMES = ['kebaya.nusantara', 'batik.by.laras', 'ibu.stylish.jogja', 'mom.and.mini', 'hijab.daily.id', 'wastra_story', 'ootd.keluarga', 'rinaberbusana'];
const SNIPS = [
  'Lagi cari {q} buat kondangan akhir pekan, ada rekomendasi yang adem dipakai seharian?',
  'Akhirnya nemu {q} yang jahitannya rapi dan nggak gerah. Worth it banget!',
  'Tips padu padan {q} biar nggak terlihat kaku, cocok buat ke kantor maupun acara keluarga.',
  'Thread: kenapa {q} lagi naik daun tahun ini? Ini 5 alasannya.',
  'Ada yang pernah pakai {q} untuk anak? Bahannya aman nggak buat kulit sensitif?',
  'Budget terbatas tapi pengin {q} yang kelihatan mewah. Ada saran?',
  'Review jujur {q} setelah dipakai 3 bulan: warna tetap, bahan nggak melar.',
  'Mau tanya, {q} yang bagus belinya di mana ya? Yang ready stock dan pengirimannya cepat.',
];
const seed = (str, max) => {
  let h = 0;
  for (const ch of String(str)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % max;
};

export async function keywordSearch(brand, { q, searchType = 'TOP', searchMode = 'KEYWORD', mediaType, days = 7, author, limit = 25 }) {
  needExtra(brand);
  const until = Math.floor(Date.now() / 1000);
  const since = until - Math.min(Math.max(Number(days) || 7, 1), 365) * 86400;
  if (isDryRun(brand)) {
    const base = seed(q, 1000);
    return SNIPS.slice(0, Math.min(limit, 8)).map((t, i) => ({
      id: `dry_s_${base}_${i}`,
      text: t.replaceAll('{q}', q),
      media_type: i % 4 === 3 ? 'IMAGE' : 'TEXT',
      permalink: `https://www.threads.com/@${NAMES[i % NAMES.length]}/post/dry${base}${i}`,
      timestamp: new Date(Date.now() - (i + 1) * 5 * 3600_000).toISOString(),
      username: author || NAMES[(base + i) % NAMES.length],
      has_replies: i % 2 === 0, is_quote_post: false, is_reply: false,
    }));
  }
  const r = await call('GET', `${V}/keyword_search`, {
    q, search_type: searchType, search_mode: searchMode, media_type: mediaType, since, until,
    author_username: author ? String(author).replace(/^@/, '') : undefined,
    limit: Math.min(Math.max(Number(limit) || 25, 1), 100), fields: POST_FIELDS, access_token: tokenOf(brand),
  });
  return (r.data || []).map(mapPost);
}

export async function listMentions(brand, { days = 30 } = {}) {
  needExtra(brand);
  if (isDryRun(brand)) {
    const n = Date.now();
    return [
      { id: `dry_m_${brand.id}_1`, text: `@${brand.username || brand.id} kebayanya cantik banget, ukuran XL masih ada kak?`, username: 'dina.styles', media_type: 'TEXT', permalink: 'https://www.threads.com/@dina.styles/post/dry1', timestamp: new Date(n - 3 * 3600_000).toISOString() },
      { id: `dry_m_${brand.id}_2`, text: `Rekomendasi banget @${brand.username || brand.id}, paket sampai dengan aman dan bahan adem!`, username: 'ibu_rina', media_type: 'TEXT', permalink: 'https://www.threads.com/@ibu_rina/post/dry2', timestamp: new Date(n - 26 * 3600_000).toISOString() },
      { id: `dry_m_${brand.id}_3`, text: `Review outfit lebaran bareng @${brand.username || brand.id} 🥰`, username: 'mom.and.mini', media_type: 'IMAGE', permalink: 'https://www.threads.com/@mom.and.mini/post/dry3', timestamp: new Date(n - 50 * 3600_000).toISOString() },
      { id: `dry_m_${brand.id}_4`, text: `Ada yang tahu @${brand.username || brand.id} buka reseller nggak?`, username: 'warung.fashion', media_type: 'TEXT', permalink: 'https://www.threads.com/@warung.fashion/post/dry4', timestamp: new Date(n - 80 * 3600_000).toISOString() },
    ];
  }
  const until = Math.floor(Date.now() / 1000);
  const since = until - Math.min(Math.max(Number(days) || 30, 1), 365) * 86400;
  const out = [];
  let after;
  for (let page = 0; page < 5; page++) {
    const r = await call('GET', `${V}/${brand.threads_user_id}/mentions`, { fields: POST_FIELDS, since, until, limit: 50, after, access_token: tokenOf(brand) });
    out.push(...(r.data || []).map(mapPost));
    after = r.paging?.next ? r.paging?.cursors?.after : undefined;
    if (!after) break;
  }
  return out;
}

export async function profileLookup(brand, username) {
  needExtra(brand);
  const u = String(username || '').replace(/^@/, '').trim();
  if (!u) throw new ThreadsError('Username wajib diisi.');
  if (isDryRun(brand)) {
    const followers = 1200 + seed(u, 90000);
    const views = 8000 + seed(u + 'v', 400000);
    const likes = Math.round(views * (0.02 + seed(u + 'l', 40) / 1000));
    return {
      username: u, name: u.replace(/[._]/g, ' '), biography: 'Konten fashion & gaya hidup keluarga. Kolaborasi: DM.', is_verified: false,
      profile_picture_url: '', follower_count: followers, likes_count: likes, quotes_count: seed(u + 'q', 40), reposts_count: seed(u + 'r', 120), views_count: views, replies_count: seed(u + 'p', 200),
    };
  }
  return call('GET', `${V}/profile_lookup`, {
    username: u,
    fields: 'username,name,profile_picture_url,biography,is_verified,follower_count,likes_count,quotes_count,reposts_count,views_count,replies_count',
    access_token: tokenOf(brand),
  });
}

/* ---------------- Cek izin (hanya panggilan baca, tanpa efek samping) ---------------- */
export const ALL_SCOPES = [...SCOPES, ...EXTRA_SCOPES];
/**
 * Menguji tiap izin dengan panggilan baca ringan. Hasil per izin: { status: ok | gagal | belum_diminta | tidak_dicek | belum_bisa, detail }.
 * threads_content_publish dan threads_manage_replies hanya bisa diuji dengan memposting/membalas, jadi tidak diuji di sini.
 */
export async function checkPermissions(brand) {
  const res = {};
  if (isDryRun(brand)) {
    for (const sc of ALL_SCOPES) res[sc] = { status: 'ok', detail: 'simulasi' };
    return res;
  }
  const run = async (scope, fn) => {
    try {
      const r = await fn();
      res[scope] = typeof r === 'object' && r ? r : { status: 'ok', detail: r || '' };
    } catch (e) {
      res[scope] = { status: 'gagal', detail: e.message };
    }
  };
  await run('threads_basic', async () => {
    const r = await call('GET', `${V}/me`, { fields: 'id,username', access_token: tokenOf(brand) });
    return `@${r.username}`;
  });
  await run('threads_manage_insights', async () => { await userInsights(brand, 7); });
  await run('threads_read_replies', async () => {
    const p = await call('GET', `${V}/me/threads`, { fields: 'id', limit: 1, access_token: tokenOf(brand) });
    const id = p.data?.[0]?.id;
    if (!id) return { status: 'belum_bisa', detail: 'Belum ada post untuk dicek.' };
    await listReplies(brand, id);
  });
  for (const sc of ['threads_content_publish', 'threads_manage_replies']) res[sc] = { status: 'tidak_dicek', detail: 'Hanya bisa diuji dengan memposting atau membalas.' };
  if (!extraScopesOn()) {
    for (const sc of EXTRA_SCOPES) res[sc] = { status: 'belum_diminta', detail: 'Izin tambahan belum diaktifkan di Pengaturan Meta.' };
  } else {
    await run('threads_keyword_search', async () => { await keywordSearch(brand, { q: 'kebaya', limit: 1 }); });
    await run('threads_manage_mentions', async () => { await listMentions(brand, { days: 1 }); });
    await run('threads_profile_discovery', async () => { await profileLookup(brand, 'threads'); });
  }
  return res;
}
