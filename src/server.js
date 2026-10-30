import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import * as C from './crypto.js';
import { all, get, run, now, uid, audit, getSetting, setSetting, policy } from './db.js';
import * as T from './threads.js';
import * as AI from './claude.js';
import { startScheduler, publishPost, threadsLength } from './scheduler.js';
import { registerTools } from './mcp-tools.js';
import { mountOAuth, baseUrl } from './oauth.js';
import * as M from './media.js';
import { mountLegal } from './legal.js';
import * as R from './research.js';
import { mountInstagram } from './ig-routes.js';
import { mountAuto } from './auto-routes.js';
import { mountPesan, mountTrends } from './pesan-routes.js';
import { mountEngage } from './engage-routes.js';
import * as Store from './store-api.js';

const RANK = { viewer: 0, editor: 1, manager: 2, admin: 3 };
const need = (min) => (req, res, next) =>
  RANK[req.user.role] >= RANK[min] ? next() : res.status(403).json({ error: `Butuh peran ${min} atau lebih tinggi.` });
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

const publicBrand = (b) => {
  if (!b) return null;
  const { token_enc, app_secret_enc, granted_scopes, ...rest } = b;
  // Akun yang terhubung sebelum izin dicatat dianggap hanya menyetujui izin dasar.
  let granted = [];
  if (token_enc) { try { granted = JSON.parse(granted_scopes || 'null') || T.SCOPES; } catch { granted = T.SCOPES; } }
  return { ...rest, granted_scopes: granted, all_scopes: T.ALL_SCOPES, pillars: JSON.parse(b.pillars || '[]'), connected: !!token_enc, simulated: T.isDryRun(b), has_own_creds: !!(b.app_id && app_secret_enc) };
};
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, active: !!u.active, has_api_token: !!u.api_token_hash });
const parsePost = (p) => (p ? { ...p, media_urls: JSON.parse(p.media_urls || '[]') } : null);
const brandOr404 = (id) => get('SELECT * FROM brands WHERE id=?', id);

function validatePost(b, { partial = false } = {}) {
  if (!partial || b.text !== undefined) {
    if (!b.text || !String(b.text).trim()) return 'Teks post wajib diisi.';
    if (threadsLength(b.text) > 500) return `Teks terlalu panjang (${threadsLength(b.text)}/500 karakter).`;
  }
  if (b.media_urls !== undefined) {
    if (!Array.isArray(b.media_urls) || b.media_urls.length > 20) return 'media_urls harus array (maks 20).';
    if (b.media_urls.length === 1 || b.media_urls.length === 0 || b.media_urls.length >= 2) {
      for (const u of b.media_urls) if (!/^https:\/\//i.test(u)) return 'URL media harus HTTPS dan bisa diakses publik.';
    }
  }
  if (b.topic_tag && /[.&]/.test(b.topic_tag)) return 'Topic tag tidak boleh mengandung titik atau &.';
  if (b.scheduled_at && Number.isNaN(Date.parse(b.scheduled_at))) return 'Format scheduled_at tidak valid (ISO 8601).';
  if (b.reply_control && !['everyone', 'accounts_you_follow', 'mentioned_only', 'followers_only'].includes(b.reply_control)) return 'reply_control tidak valid.';
  return null;
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Di balik reverse proxy (nginx/Caddy/Traefik) set TRUST_PROXY=1 agar req.ip = IP pengunjung asli,
  // bukan IP proxy. Tanpa ini, pembatas percobaan login akan menghitung SEMUA orang sebagai satu IP.
  if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    });
    next();
  });
  app.use(express.json({ limit: '9mb', verify: (req, _res, buf) => { if (req.originalUrl.startsWith('/webhooks/')) req.rawBody = buf; } })); // 9 MB: muat base64 gambar 6 MB dari Claude (MCP)
  app.use(express.urlencoded({ extended: false }));

  /* ---------------- Auth ---------------- */
  const secureCookie = baseUrl().startsWith('https');
  const attempts = new Map();

  const cookieUser = (req) => {
    const m = /(?:^|;\s*)hub=([^;]+)/.exec(req.headers.cookie || '');
    const p = m && C.verify(decodeURIComponent(m[1]));
    return p ? get('SELECT * FROM users WHERE id=? AND active=1', p.uid) : null;
  };
  const setCookie = (res, user) =>
    res.setHeader('Set-Cookie', `hub=${encodeURIComponent(C.sign({ uid: user.id }))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secureCookie ? '; Secure' : ''}`);

  function tryLogin(req, email, password) {
    const ip = req.ip;
    const a = attempts.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - a.t > 10 * 60_000) { a.n = 0; a.t = Date.now(); }
    if (a.n >= 10) return { error: 'Terlalu banyak percobaan. Coba lagi 10 menit lagi.', status: 429 };
    const u = get('SELECT * FROM users WHERE email=? AND active=1', String(email || '').toLowerCase().trim());
    if (!u || !C.verifyPassword(String(password || ''), u.pass_hash)) {
      attempts.set(ip, { ...a, n: a.n + 1 });
      return { error: 'Email atau password salah.', status: 401 };
    }
    attempts.delete(ip);
    return { user: u };
  }

  /** req.via: 'cookie' (dashboard, manusia) | 'token' (API token / MCP stdio) | 'oauth' (konektor claude.ai). */
  function auth(req, res, next) {
    const h = req.headers.authorization || '';
    let user = null;
    req.via = 'cookie';
    if (h.startsWith('Bearer ')) {
      const hash = C.sha256(h.slice(7));
      user = get('SELECT * FROM users WHERE api_token_hash=? AND active=1', hash);
      if (user) req.via = 'token';
      else {
        const t = get('SELECT * FROM oauth_tokens WHERE access_hash=? AND access_expires>?', hash, Date.now());
        if (t) { user = get('SELECT * FROM users WHERE id=? AND active=1', t.user_id); if (user) req.via = 'oauth'; }
      }
    } else {
      user = cookieUser(req);
      if (user && req.method !== 'GET' && req.headers['x-requested-with'] !== 'hub') return bad(res, 'Permintaan ditolak (CSRF).', 403);
    }
    if (!user) {
      if (req.originalUrl.startsWith('/mcp')) res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${baseUrl()}/.well-known/oauth-protected-resource"`);
      return bad(res, 'Belum login.', 401);
    }
    if (req.via !== 'cookie' && getSetting('claude_enabled') !== '1') return bad(res, 'Akses Claude sedang dimatikan oleh admin (dashboard → Kontrol Claude).', 403);
    req.user = user;
    next();
  }

  const A = (req, action, detail) => audit(req.user.id, action, { ...(detail || {}), via: req.via });
  const humanOnly = (req, res, next) => (req.via === 'cookie' ? next() : bad(res, 'Aksi ini hanya bisa dilakukan manusia lewat dashboard.', 403));
  const GATE_LABEL = { claude_create: 'Buat & edit draft', claude_approve: 'Setujui & jadwalkan', claude_publish: 'Publish langsung', claude_reply: 'Balas komentar', claude_brand: 'Ubah profil brand (voice, pillar, dll)' };
  const gate = (key) => (req, res, next) =>
    req.via === 'cookie' || getSetting(key) === '1' ? next() : bad(res, `Dimatikan oleh admin: "${GATE_LABEL[key]}" (dashboard → Kontrol Claude). Minta manajer melakukannya di dashboard.`, 403);
  const claudeCap = (req, res, next) => {
    if (req.via === 'cookie') return next();
    const cap = Number(getSetting('claude_daily_cap'));
    const n = get("SELECT COUNT(*) AS n FROM posts WHERE source='claude' AND created_at>?", new Date(Date.now() - 86_400_000).toISOString()).n;
    return n >= cap ? bad(res, `Batas ${cap} draft/24 jam dari Claude sudah tercapai (Kontrol Claude).`, 429) : next();
  };

  mountOAuth(app, { sessionUser: cookieUser, login: tryLogin, setCookie });
  mountLegal(app);

  app.get('/api/health', (req, res) =>
    res.json({ ok: true, simulated: T.isDryRun(), ai: AI.replyAiEnabled(), model: AI.replyAiEnabled() ? AI.replyAiLabel() : null }),
  );

  app.post('/api/login', (req, res) => {
    const r = tryLogin(req, req.body?.email, req.body?.password);
    if (r.error) return bad(res, r.error, r.status);
    setCookie(res, r.user);
    audit(r.user.id, 'login', { via: 'cookie' });
    res.json(publicUser(r.user));
  });

  app.post('/api/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'hub=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    res.json({ ok: true });
  });

  // Callback OAuth Threads (navigasi browser, memakai cookie sesi)
  app.get('/auth/threads/start', auth, need('manager'), (req, res) => {
    const b = brandOr404(String(req.query.brand));
    if (!b) return bad(res, 'Brand tidak ditemukan.', 404);
    if (T.isDryRun(b)) return bad(res, 'Mode simulasi aktif atau kredensial Meta belum diisi. Admin: buka menu Pengaturan Meta.');
    const state = C.randomToken('st');
    run('INSERT INTO oauth_states(state,brand_id,user_id,expires_at) VALUES (?,?,?,?)', state, b.id, req.user.id, Date.now() + 10 * 60_000);
    res.redirect(T.authorizeUrl(state, b));
  });

  app.get('/auth/threads/callback', auth, ah(async (req, res) => {
    const { code, state, error_description: err } = req.query;
    const st = get('SELECT * FROM oauth_states WHERE state=?', String(state || ''));
    if (!st || st.expires_at < Date.now() || st.user_id !== req.user.id) return res.redirect('/#/brands?connect=gagal');
    run('DELETE FROM oauth_states WHERE state=?', st.state);
    if (!code) return res.redirect(`/#/brands?connect=gagal&msg=${encodeURIComponent(err || 'dibatalkan')}`);
    try {
      const r = await T.exchangeCode(String(code), brandOr404(st.brand_id));
      run(
        'UPDATE brands SET token_enc=?, token_expires_at=?, token_refreshed_at=?, threads_user_id=?, username=?, granted_scopes=? WHERE id=?',
        C.encrypt(r.token), new Date(Date.now() + r.expiresIn * 1000).toISOString(), now(), r.userId, r.username, JSON.stringify(T.scopes()), st.brand_id,
      );
      A(req, 'brand.connected', { brand: st.brand_id, username: r.username });
      res.redirect('/#/brands?connect=ok');
    } catch (e) {
      res.redirect(`/#/brands?connect=gagal&msg=${encodeURIComponent(e.message)}`);
    }
  }));

  /* ---------------- API (login wajib) ---------------- */
  const api = express.Router();
  api.use(auth);

  api.get('/me', (req, res) => res.json(publicUser(req.user)));

  // ----- Brands
  api.get('/brands', (req, res) => res.json(all('SELECT * FROM brands ORDER BY sort').map(publicBrand)));
  api.get('/brands/:id', (req, res) => {
    const b = brandOr404(req.params.id);
    return b ? res.json(publicBrand(b)) : bad(res, 'Brand tidak ditemukan.', 404);
  });
  // ---- Profil brand (voice, pillar, hashtag, dos/donts). Setiap perubahan disimpan ke riwayat agar bisa dipulihkan.
  const PROFILE = { description: 500, voice: 4000, hashtags: 500, dos: 2000, donts: 2000 };
  const profileOf = (b) => ({ name: b.name, description: b.description, voice: b.voice, pillars: JSON.parse(b.pillars || '[]'), hashtags: b.hashtags, dos: b.dos, donts: b.donts });
  function validateProfile(f, { allowName }) {
    for (const [k, max] of Object.entries(PROFILE)) if (f[k] !== undefined && (typeof f[k] !== 'string' || f[k].length > max)) return `${k} harus teks (maks ${max} karakter).`;
    if (f.pillars !== undefined && (!Array.isArray(f.pillars) || f.pillars.length > 12 || f.pillars.some((x) => typeof x !== 'string' || x.length > 120))) return 'pillars harus daftar maks 12 butir (tiap butir maks 120 karakter).';
    if (f.name !== undefined && (!allowName || typeof f.name !== 'string' || !f.name.trim() || f.name.length > 80)) return 'Nama brand tidak dapat diubah lewat jalur ini.';
    return null;
  }
  /** Terapkan perubahan sebagian; hanya field yang dikirim yang berubah. Mengembalikan daftar field yang benar-benar berubah. */
  function applyProfile(b, f, req, allowName) {
    const before = profileOf(b);
    const next = { ...before };
    for (const k of ['description', 'voice', 'hashtags', 'dos', 'donts']) if (f[k] !== undefined) next[k] = f[k].trim();
    if (f.pillars !== undefined) next.pillars = f.pillars.map((x) => x.trim()).filter(Boolean);
    if (allowName && f.name !== undefined) next.name = f.name.trim();
    const changed = Object.keys(next).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(before[k]));
    if (!changed.length) return changed;
    run('INSERT INTO brand_history(brand_id,snapshot,changed_by,via,ts) VALUES (?,?,?,?,?)', b.id, JSON.stringify(before), req.user.id, req.via, now());
    run('UPDATE brands SET name=?, description=?, voice=?, pillars=?, hashtags=?, dos=?, donts=? WHERE id=?', next.name, next.description, next.voice, JSON.stringify(next.pillars), next.hashtags, next.dos, next.donts, b.id);
    A(req, 'brand.updated', { brand: b.id, fields: changed });
    return changed;
  }
  api.put('/brands/:id', humanOnly, need('manager'), (req, res) => {
    const b = brandOr404(req.params.id);
    if (!b) return bad(res, 'Brand tidak ditemukan.', 404);
    const err = validateProfile(req.body || {}, { allowName: true });
    if (err) return bad(res, err);
    applyProfile(b, req.body || {}, req, true);
    res.json(publicBrand(brandOr404(b.id)));
  });
  // Jalur Claude/MCP: tanpa nama & kredensial, dikunci saklar "Ubah profil brand" di Kontrol Claude (default mati).
  api.put('/brands/:id/profile', need('manager'), gate('claude_brand'), (req, res) => {
    const b = brandOr404(req.params.id);
    if (!b) return bad(res, 'Brand tidak ditemukan.', 404);
    const f = req.body || {};
    const err = validateProfile(f, { allowName: false });
    if (err) return bad(res, err);
    if (!Object.keys(PROFILE).concat('pillars').some((k) => f[k] !== undefined)) return bad(res, 'Kirim minimal satu field: description, voice, pillars, hashtags, dos, donts.');
    const changed = applyProfile(b, f, req, false);
    res.json({ changed, brand: publicBrand(brandOr404(b.id)) });
  });
  api.get('/brands/:id/history', need('manager'), (req, res) => {
    if (!brandOr404(req.params.id)) return bad(res, 'Brand tidak ditemukan.', 404);
    res.json(all(`SELECT h.id, h.ts, h.via, h.snapshot, u.name AS user_name FROM brand_history h LEFT JOIN users u ON u.id=h.changed_by WHERE h.brand_id=? ORDER BY h.id DESC LIMIT 30`, req.params.id)
      .map((h) => ({ id: h.id, ts: h.ts, via: h.via, user_name: h.user_name, snapshot: JSON.parse(h.snapshot) })));
  });
  api.post('/brands/:id/history/:hid/restore', humanOnly, need('manager'), (req, res) => {
    const b = brandOr404(req.params.id);
    const h = b && get('SELECT * FROM brand_history WHERE id=? AND brand_id=?', req.params.hid, b.id);
    if (!h) return bad(res, 'Versi tidak ditemukan.', 404);
    const snap = JSON.parse(h.snapshot);
    applyProfile(b, { description: snap.description || '', voice: snap.voice || '', hashtags: snap.hashtags || '', dos: snap.dos || '', donts: snap.donts || '', pillars: snap.pillars || [] }, req, false);
    A(req, 'brand.restored', { brand: b.id, from: h.id });
    res.json(publicBrand(brandOr404(b.id)));
  });
  api.post('/brands/:id/refresh-token', humanOnly, need('admin'), ah(async (req, res) => {
    const b = brandOr404(req.params.id);
    if (!b?.token_enc) return bad(res, 'Akun belum terhubung.');
    const r = await T.refreshToken(b);
    run('UPDATE brands SET token_enc=?, token_expires_at=?, token_refreshed_at=? WHERE id=?', C.encrypt(r.token), new Date(Date.now() + r.expiresIn * 1000).toISOString(), now(), b.id);
    res.json(publicBrand(brandOr404(b.id)));
  }));
  api.delete('/brands/:id/connection', humanOnly, need('admin'), (req, res) => {
    run('UPDATE brands SET token_enc=NULL, token_expires_at=NULL, threads_user_id=NULL, username=NULL WHERE id=?', req.params.id);
    A(req, 'brand.disconnected', { brand: req.params.id });
    res.json({ ok: true });
  });

  // ----- Dashboard
  api.get('/dashboard', (req, res) => {
    const brands = all('SELECT * FROM brands ORDER BY sort').map((b) => {
      const counts = Object.fromEntries(all('SELECT status, COUNT(*) AS n FROM posts WHERE brand_id=? GROUP BY status', b.id).map((r) => [r.status, r.n]));
      const next = get("SELECT id,text,scheduled_at FROM posts WHERE brand_id=? AND status='scheduled' ORDER BY scheduled_at LIMIT 1", b.id);
      return { ...publicBrand(b), counts, next_post: next || null };
    });
    res.json({ brands, simulated: T.isDryRun(), ai: AI.replyAiEnabled() });
  });

  // ----- Posts
  // Kalender: post yang punya tanggal (jadwal atau terbit) dalam rentang [from, to), opsional per brand
  api.get('/calendar', need('viewer'), (req, res) => {
    const from = new Date(String(req.query.from || '')); const to = new Date(String(req.query.to || ''));
    if (Number.isNaN(+from) || Number.isNaN(+to) || to <= from || to - from > 100 * 86400_000) return bad(res, 'Rentang tanggal tidak valid (maksimal 100 hari).');
    const args = [from.toISOString(), to.toISOString()];
    let brandSql = '';
    if (req.query.brand) { brandSql = 'AND brand_id=?'; args.push(String(req.query.brand)); }
    res.json(all(
      `SELECT id, brand_id, substr(text,1,140) AS text, status, scheduled_at, published_at FROM posts
       WHERE COALESCE(published_at, scheduled_at) >= ? AND COALESCE(published_at, scheduled_at) < ? ${brandSql}
       ORDER BY COALESCE(published_at, scheduled_at)`,
      ...args,
    ));
  });

  api.get('/posts', (req, res) => {
    const { brand, status } = req.query;
    const limit = Math.min(200, Number(req.query.limit) || 100);
    const where = [];
    const args = [];
    if (brand) { where.push('brand_id=?'); args.push(String(brand)); }
    if (status) { where.push('status=?'); args.push(String(status)); }
    const rows = all(
      `SELECT p.*, u.name AS author FROM posts p LEFT JOIN users u ON u.id=p.created_by
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY COALESCE(p.scheduled_at, p.created_at) DESC LIMIT ${limit}`,
      ...args,
    );
    res.json(rows.map(parsePost));
  });

  api.get('/posts/:id', (req, res) => {
    const p = get('SELECT * FROM posts WHERE id=?', req.params.id);
    return p ? res.json(parsePost(p)) : bad(res, 'Post tidak ditemukan.', 404);
  });

  api.post('/posts', need('editor'), gate('claude_create'), claudeCap, (req, res) => {
    const b = req.body || {};
    if (!brandOr404(b.brand_id)) return bad(res, 'Brand tidak ditemukan.', 404);
    const err = validatePost(b);
    if (err) return bad(res, err);
    const id = uid();
    run(
      `INSERT INTO posts(id,brand_id,text,media_urls,topic_tag,reply_control,status,scheduled_at,source,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?, 'draft', ?,?,?,?,?)`,
      id, b.brand_id, b.text.trim(), JSON.stringify(b.media_urls || []), b.topic_tag || null, b.reply_control || null,
      b.scheduled_at ? new Date(b.scheduled_at).toISOString() : null,
      req.via !== 'cookie' ? 'claude' : ['claude', 'ai'].includes(b.source) ? b.source : 'dashboard', req.user.id, now(), now(),
    );
    M.linkMedia(id, b.media_urls);
    A(req, 'post.created', { id, brand: b.brand_id, source: b.source });
    res.status(201).json(parsePost(get('SELECT * FROM posts WHERE id=?', id)));
  });

  const loadPost = (req, res) => {
    const p = get('SELECT * FROM posts WHERE id=?', req.params.id);
    if (!p) bad(res, 'Post tidak ditemukan.', 404);
    return p;
  };

  api.put('/posts/:id', need('editor'), gate('claude_create'), (req, res) => {
    const p = loadPost(req, res);
    if (!p) return;
    if (['published', 'publishing'].includes(p.status)) return bad(res, 'Post yang sudah terbit tidak bisa diedit.');
    if (req.user.role === 'editor' && p.created_by !== req.user.id) return bad(res, 'Editor hanya bisa mengedit post buatannya sendiri.', 403);
    const b = req.body || {};
    const err = validatePost(b, { partial: true });
    if (err) return bad(res, err);
    // edit isi pada post yang sudah diajukan/dijadwalkan mengembalikannya ke draft agar di-review ulang
    const contentChanged = ['text', 'media_urls', 'topic_tag'].some((k) => b[k] !== undefined);
    const status = ['pending_approval', 'scheduled'].includes(p.status) && contentChanged && RANK[req.user.role] < RANK.manager ? 'draft' : p.status === 'failed' ? 'draft' : p.status;
    run(
      `UPDATE posts SET text=?, media_urls=?, topic_tag=?, reply_control=?, scheduled_at=?, status=?, error=NULL, updated_at=? WHERE id=?`,
      b.text !== undefined ? b.text.trim() : p.text,
      b.media_urls !== undefined ? JSON.stringify(b.media_urls) : p.media_urls,
      b.topic_tag !== undefined ? b.topic_tag || null : p.topic_tag,
      b.reply_control !== undefined ? b.reply_control || null : p.reply_control,
      b.scheduled_at !== undefined ? (b.scheduled_at ? new Date(b.scheduled_at).toISOString() : null) : p.scheduled_at,
      status, now(), p.id,
    );
    if (b.media_urls !== undefined) M.linkMedia(p.id, b.media_urls);
    res.json(parsePost(get('SELECT * FROM posts WHERE id=?', p.id)));
  });

  api.post('/posts/:id/submit', need('editor'), gate('claude_create'), (req, res) => {
    const p = loadPost(req, res);
    if (!p) return;
    if (!['draft', 'failed'].includes(p.status)) return bad(res, `Post berstatus ${p.status}, tidak bisa diajukan.`);
    run("UPDATE posts SET status='pending_approval', review_note=NULL, error=NULL, updated_at=? WHERE id=?", now(), p.id);
    A(req, 'post.submitted', { id: p.id });
    res.json(parsePost(get('SELECT * FROM posts WHERE id=?', p.id)));
  });

  // Persetujuan massal (khusus dashboard/manusia). Satu transaksi; yang tidak memenuhi syarat dilewati dengan alasan.
  api.post('/posts/bulk', humanOnly, need('editor'), (req, res) => {
    const b = req.body || {};
    const action = String(b.action || '');
    if (!['approve', 'reject', 'submit'].includes(action)) return bad(res, 'Aksi tidak dikenal.');
    if (['approve', 'reject'].includes(action) && RANK[req.user.role] < RANK.manager) return bad(res, 'Butuh peran manager atau lebih tinggi.', 403);
    const ids = [...new Set(Array.isArray(b.ids) ? b.ids.map(String) : [])];
    if (!ids.length) return bad(res, 'Pilih minimal satu post.');
    if (ids.length > 50) return bad(res, 'Maksimal 50 post sekali proses.');
    const fill = b.fill_missing; // { start: ISO, interval_minutes }
    let slot = null; let step = 0;
    if (fill) {
      slot = Date.parse(fill.start); step = Number(fill.interval_minutes) * 60_000;
      if (Number.isNaN(slot) || !(step >= 5 * 60_000 && step <= 7 * 86400_000)) return bad(res, 'Jadwal otomatis tidak valid (jarak 5 menit - 7 hari).');
    }
    const note = String(b.note || '').slice(0, 300) || null;
    const done = []; const skipped = [];
    const rows = ids.map((id) => get('SELECT * FROM posts WHERE id=?', id));
    // urutan jadwal otomatis mengikuti urutan pilihan; post yang sudah punya jadwal tidak diubah
    for (let i = 0; i < ids.length; i++) {
      const p = rows[i]; const id = ids[i];
      if (!p) { skipped.push({ id, reason: 'Post tidak ditemukan.' }); continue; }
      if (action === 'submit') {
        if (!['draft', 'failed'].includes(p.status)) { skipped.push({ id, reason: `Post berstatus ${p.status}.` }); continue; }
        run("UPDATE posts SET status='pending_approval', review_note=NULL, error=NULL, updated_at=? WHERE id=?", now(), id);
        A(req, 'post.submitted', { id, bulk: true }); done.push(id); continue;
      }
      if (action === 'reject') {
        if (!['pending_approval', 'scheduled'].includes(p.status)) { skipped.push({ id, reason: `Post berstatus ${p.status}.` }); continue; }
        run("UPDATE posts SET status='draft', review_note=?, updated_at=? WHERE id=?", note, now(), id);
        A(req, 'post.rejected', { id, bulk: true }); done.push(id); continue;
      }
      if (!['pending_approval', 'draft', 'failed'].includes(p.status)) { skipped.push({ id, reason: `Post berstatus ${p.status}.` }); continue; }
      let when = p.scheduled_at;
      if (!when) {
        if (slot === null) { skipped.push({ id, reason: 'Belum punya jadwal.' }); continue; }
        when = new Date(slot).toISOString(); slot += step;
      } else if (Date.parse(when) < Date.now() - 60_000 && !b.allow_past) { skipped.push({ id, reason: 'Jadwalnya sudah lewat (akan langsung tayang).' }); continue; }
      run("UPDATE posts SET status='scheduled', scheduled_at=?, approved_by=?, error=NULL, updated_at=? WHERE id=?", when, req.user.id, now(), id);
      A(req, 'post.approved', { id, scheduled_at: when, bulk: true }); done.push(id);
    }
    res.json({ action, done, skipped });
  });

  api.post('/posts/:id/approve', need('manager'), gate('claude_approve'), (req, res) => {
    const p = loadPost(req, res);
    if (!p) return;
    if (!['pending_approval', 'draft', 'failed'].includes(p.status)) return bad(res, `Post berstatus ${p.status}.`);
    const when = req.body?.scheduled_at || p.scheduled_at || now();
    if (Number.isNaN(Date.parse(when))) return bad(res, 'Jadwal tidak valid.');
    run("UPDATE posts SET status='scheduled', scheduled_at=?, approved_by=?, error=NULL, updated_at=? WHERE id=?", new Date(when).toISOString(), req.user.id, now(), p.id);
    A(req, 'post.approved', { id: p.id, scheduled_at: when });
    res.json(parsePost(get('SELECT * FROM posts WHERE id=?', p.id)));
  });

  api.post('/posts/:id/reject', need('manager'), gate('claude_approve'), (req, res) => {
    const p = loadPost(req, res);
    if (!p) return;
    if (!['pending_approval', 'scheduled'].includes(p.status)) return bad(res, `Post berstatus ${p.status}.`);
    run("UPDATE posts SET status='draft', review_note=?, updated_at=? WHERE id=?", String(req.body?.note || '').slice(0, 300) || null, now(), p.id);
    A(req, 'post.rejected', { id: p.id });
    res.json(parsePost(get('SELECT * FROM posts WHERE id=?', p.id)));
  });

  api.post('/posts/:id/publish-now', need('manager'), gate('claude_publish'), ah(async (req, res) => {
    const p = loadPost(req, res);
    if (!p) return;
    const out = await publishPost(p.id, { allowFrom: ['draft', 'pending_approval', 'scheduled', 'failed'], userId: req.user.id });
    run('UPDATE posts SET approved_by=COALESCE(approved_by,?) WHERE id=?', req.user.id, p.id);
    A(req, 'post.publish_now', { id: p.id, brand: p.brand_id });
    res.json(parsePost(out));
  }));

  api.delete('/posts/:id', humanOnly, need('editor'), (req, res) => {
    const p = loadPost(req, res);
    if (!p) return;
    if (['published', 'publishing'].includes(p.status)) return bad(res, 'Post terbit tidak bisa dihapus dari dashboard (hapus langsung di Threads).');
    if (req.user.role === 'editor' && p.created_by !== req.user.id) return bad(res, 'Editor hanya bisa menghapus post buatannya sendiri.', 403);
    run('DELETE FROM posts WHERE id=?', p.id);
    A(req, 'post.deleted', { id: p.id });
    res.json({ ok: true });
  });

  // ----- Replies & Insights
  const publishedWithMedia = (brandId, n) =>
    all("SELECT * FROM posts WHERE brand_id=? AND status='published' AND threads_media_id IS NOT NULL ORDER BY published_at DESC LIMIT ?", brandId, n);

  api.get('/brands/:id/replies', need('editor'), ah(async (req, res) => {
    const b = brandOr404(req.params.id);
    if (!b) return bad(res, 'Brand tidak ditemukan.', 404);
    const out = [];
    for (const p of publishedWithMedia(b.id, 5)) {
      for (const r of await T.listReplies(b, p.threads_media_id)) out.push({ post_id: p.id, post_text: p.text, reply: r });
    }
    res.json(out);
  }));

  api.post('/brands/:id/replies/:replyId/reply', need('manager'), gate('claude_reply'), ah(async (req, res) => {
    const b = brandOr404(req.params.id);
    const text = String(req.body?.text || '').trim();
    if (!b || !text) return bad(res, 'Teks balasan wajib diisi.');
    if (threadsLength(text) > 500) return bad(res, 'Balasan maksimal 500 karakter.');
    const r = await T.replyTo(b, req.params.replyId, text);
    A(req, 'reply.sent', { brand: b.id, to: req.params.replyId });
    res.json(r);
  }));

  api.post('/brands/:id/replies/:replyId/hide', need('manager'), gate('claude_reply'), ah(async (req, res) => {
    const b = brandOr404(req.params.id);
    if (!b) return bad(res, 'Brand tidak ditemukan.', 404);
    res.json(await T.hideReply(b, req.params.replyId, req.body?.hide !== false));
  }));

  async function cached(key, ttlMs, fn) {
    const hit = get('SELECT * FROM insights_cache WHERE key=?', key);
    if (hit && Date.now() - hit.fetched_at < ttlMs) return JSON.parse(hit.data);
    const data = await fn();
    run('INSERT INTO insights_cache(key,data,fetched_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at', key, JSON.stringify(data), Date.now());
    return data;
  }

  async function brandInsights(b, days) {
    const account = await cached(`acc:${b.id}:${days}`, 15 * 60_000, () => T.userInsights(b, days));
    const posts = [];
    for (const p of publishedWithMedia(b.id, 15)) {
      const metrics = await cached(`post:${p.threads_media_id}`, 30 * 60_000, () => T.mediaInsights(b, p.threads_media_id));
      posts.push({ id: p.id, text: p.text, permalink: p.permalink, published_at: p.published_at, metrics });
    }
    return { account, posts, simulated: T.isDryRun(b) };
  }

  api.get('/brands/:id/insights', need('viewer'), ah(async (req, res) => {
    const b = brandOr404(req.params.id);
    if (!b) return bad(res, 'Brand tidak ditemukan.', 404);
    if (!b.token_enc && !T.isDryRun(b)) return bad(res, 'Akun belum terhubung ke Threads.');
    res.json(await brandInsights(b, Math.min(90, Number(req.query.days) || 7)));
  }));

  // Cek izin: panggilan baca ringan per izin (juga tercatat sebagai API call di halaman Testing Meta)
  api.post('/brands/:id/permission-check', humanOnly, need('manager'), ah(async (req, res) => {
    const b = brandOr404(req.params.id);
    if (!b) return bad(res, 'Brand tidak ditemukan.', 404);
    if (!b.token_enc && !T.isDryRun(b)) return bad(res, 'Akun belum terhubung ke Threads.');
    A(req, 'brand.permission_check', { brand: b.id });
    res.json({ checked_at: now(), results: await T.checkPermissions(b) });
  }));

  // ----- Claude (AI)
  const aiRoute = (min, fn) => [humanOnly, need(min), ah(async (req, res) => {
    const brand = brandOr404(req.body?.brand_id);
    if (!brand) return bad(res, 'brand_id wajib diisi.');
    const out = await fn(brand, req.body || {}, req);
    A(req, 'ai.used', { brand: brand.id, route: req.path });
    res.json(out);
  })];

  // Data produk/stok dari API delova.id untuk pembuat post (opsional; gagal → tanpa data, tidak menghentikan fitur)
  const postFacts = async (brand, texts, o = {}) => {
    const c = Store.storeConfig();
    if (!c.usePosts || !c.key) return { facts: '', used: [] };
    const r = await Store.productFacts(brand.id, texts.filter(Boolean), o);
    return { facts: r.facts, used: r.used };
  };

  api.post('/ai/generate', ...aiRoute('editor', async (brand, b) => {
    if (!b.brief?.trim()) { const e = new Error('Brief wajib diisi.'); e.status = 400; throw e; }
    const sf = await postFacts(brand, [b.brief, b.angle], { featured: true });
    return { variants: await AI.generatePosts(brand, { ...b, facts: sf.facts }), data_used: sf.used };
  }));
  api.post('/ai/improve', ...aiRoute('editor', async (brand, b) => {
    if (!b.text?.trim()) { const e = new Error('Teks wajib diisi.'); e.status = 400; throw e; }
    const sf = await postFacts(brand, [b.text, b.instruction]);
    return { variants: await AI.improvePost(brand, { ...b, facts: sf.facts }), data_used: sf.used };
  }));
  api.post('/ai/reply-suggestions', ...aiRoute('manager', async (brand, b) => ({
    suggestions: await AI.suggestReplies(brand, { postText: b.post_text, replies: b.replies || [], count: b.count }),
  })));
  api.post('/ai/weekly-plan', ...aiRoute('editor', async (brand, b) => {
    const sf = await postFacts(brand, [b.goal, b.promo], { featured: true });
    const items = await AI.weeklyPlan(brand, { ...b, facts: sf.facts });
    // beri usulan tanggal mulai besok (WIB), jam sesuai saran Claude
    const wibDate = new Date(Date.now() + 7 * 3600_000 + 86_400_000);
    return {
      items: items.map((it, i) => {
        const [h, m] = String(it.time || '19:00').match(/\d{1,2}/g)?.map(Number) || [19, 0];
        const d = new Date(Date.UTC(wibDate.getUTCFullYear(), wibDate.getUTCMonth(), wibDate.getUTCDate() + i, (h ?? 19) - 7, m ?? 0));
        return { ...it, scheduled_at: d.toISOString() };
      }),
    };
  }));
  api.post('/ai/analyze', ...aiRoute('manager', async (brand, b, req) => {
    if (!brand.token_enc && !T.isDryRun(brand)) { const e = new Error('Akun belum terhubung ke Threads.'); e.status = 400; throw e; }
    return { analysis: await AI.analyze(brand, await brandInsights(brand, Number(b.days) || 7)) };
  }));

  // ----- Riset post publik (threads_keyword_search)
  const fresh = (min) => need(min);
  api.get('/research/status', (req, res) => res.json({ extra_scopes: T.extraScopesOn(), mentions_auto: getSetting('mentions_auto') === '1', scopes: T.scopes() }));

  api.post('/research/search', fresh('editor'), ah(async (req, res) => {
    const f = req.body || {};
    const b = brandOr404(f.brand_id);
    if (!b) return bad(res, 'Pilih akun brand yang dipakai untuk mencari.');
    const q = String(f.q || '').trim();
    if (q.length < 2 || q.length > 200) return bad(res, 'Kata kunci harus 2-200 karakter.');
    if (!b.token_enc && !T.isDryRun(b)) return bad(res, 'Akun belum terhubung ke Threads.');
    const opts = {
      q,
      searchType: f.search_type === 'RECENT' ? 'RECENT' : 'TOP',
      searchMode: f.search_mode === 'TAG' ? 'TAG' : 'KEYWORD',
      mediaType: ['TEXT', 'IMAGE', 'VIDEO'].includes(f.media_type) ? f.media_type : undefined,
      days: Math.min(Math.max(Number(f.days) || 7, 1), 365),
      author: f.author ? String(f.author).replace(/^@/, '').trim().slice(0, 60) : undefined,
      limit: Math.min(Math.max(Number(f.limit) || 25, 1), 100),
    };
    // hasil identik dipakai ulang 10 menit: Meta membatasi 2.200 query per 24 jam
    const posts = await cached(`rs:${b.id}:${JSON.stringify(opts)}`, 10 * 60_000, () => T.keywordSearch(b, opts));
    A(req, 'research.search', { brand: b.id, q });
    res.json({ posts, simulated: T.isDryRun(b) });
  }));

  api.get('/research/saves', (req, res) =>
    res.json(all('SELECT * FROM research_saves ORDER BY created_at DESC LIMIT 100').map((r) => ({ ...r, result: JSON.parse(r.result || '[]') }))));
  api.post('/research/saves', fresh('editor'), (req, res) => {
    const f = req.body || {};
    const q = String(f.q || '').trim();
    if (!q || !Array.isArray(f.posts) || !f.posts.length) return bad(res, 'Tidak ada hasil untuk disimpan.');
    const posts = f.posts.slice(0, 100).map((p) => ({ id: String(p.id || ''), text: String(p.text || '').slice(0, 2000), username: String(p.username || ''), permalink: String(p.permalink || ''), timestamp: p.timestamp || null, media_type: p.media_type || 'TEXT' }));
    const id = uid();
    run('INSERT INTO research_saves(id,brand_id,query,mode,search_type,media_type,result,note,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id, f.brand_id || null, q.slice(0, 200), f.search_mode || null, f.search_type || null, f.media_type || null, JSON.stringify(posts), String(f.note || '').slice(0, 500) || null, req.user.id, now());
    A(req, 'research.saved', { id, q });
    res.status(201).json({ id });
  });
  api.delete('/research/saves/:id', fresh('editor'), (req, res) => {
    run('DELETE FROM research_saves WHERE id=?', req.params.id);
    res.json({ ok: true });
  });
  api.post('/ai/research', ...aiRoute('editor', async (brand, b) => {
    const posts = (Array.isArray(b.posts) ? b.posts : []).slice(0, 40).map((p) => ({ username: String(p.username || ''), text: String(p.text || '') }));
    if (!posts.length) { const e = new Error('Belum ada hasil riset untuk dianalisis.'); e.status = 400; throw e; }
    return { insights: await AI.researchInsights(brand, { query: String(b.q || '').slice(0, 200), posts }) };
  }));

  // ----- Mention (threads_manage_mentions)
  api.get('/mentions', (req, res) => {
    const { brand_id: bid, status } = req.query;
    const where = []; const p = [];
    if (bid) { where.push('brand_id=?'); p.push(String(bid)); }
    if (status && R.MENTION_STATUS.includes(String(status))) { where.push('status=?'); p.push(String(status)); }
    const rows = all(`SELECT * FROM mentions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY posted_at DESC LIMIT 500`, ...p);
    const counts = Object.fromEntries(all(`SELECT status, COUNT(*) AS n FROM mentions ${bid ? 'WHERE brand_id=?' : ''} GROUP BY status`, ...(bid ? [String(bid)] : [])).map((r) => [r.status, r.n]));
    res.json({ items: rows, counts, last_collected: bid ? Number(getSetting(`mentions_last:${bid}`) || 0) || null : null });
  });
  api.post('/mentions/collect', fresh('editor'), ah(async (req, res) => {
    const b = brandOr404(req.body?.brand_id);
    if (!b) return bad(res, 'Pilih akun brand.');
    if (!b.token_enc && !T.isDryRun(b)) return bad(res, 'Akun belum terhubung ke Threads.');
    const r = await R.collectMentions(b, { days: Math.min(Math.max(Number(req.body?.days) || 30, 1), 365) });
    A(req, 'mentions.collected', { brand: b.id, added: r.added });
    res.json({ ...r, simulated: T.isDryRun(b) });
  }));
  api.put('/mentions/:id', fresh('editor'), (req, res) => {
    const m = get('SELECT * FROM mentions WHERE id=?', req.params.id);
    if (!m) return bad(res, 'Mention tidak ditemukan.', 404);
    const f = req.body || {};
    if (f.status !== undefined && !R.MENTION_STATUS.includes(f.status)) return bad(res, 'Status tidak valid.');
    run('UPDATE mentions SET status=?, note=?, handled_by=? WHERE id=?', f.status ?? m.status, f.note !== undefined ? String(f.note).slice(0, 1000) : m.note, req.user.id, m.id);
    res.json(get('SELECT * FROM mentions WHERE id=?', m.id));
  });
  api.post('/mentions/:id/reply', fresh('manager'), gate('claude_reply'), ah(async (req, res) => {
    const m = get('SELECT * FROM mentions WHERE id=?', req.params.id);
    const text = String(req.body?.text || '').trim();
    if (!m || !text) return bad(res, 'Teks balasan wajib diisi.');
    if (threadsLength(text) > 500) return bad(res, 'Balasan maksimal 500 karakter.');
    const b = brandOr404(m.brand_id);
    const r = await T.replyTo(b, m.media_id, text);
    run("UPDATE mentions SET status='dibalas', handled_by=? WHERE id=?", req.user.id, m.id);
    A(req, 'mention.replied', { brand: b.id, to: m.media_id });
    res.json(r);
  }));
  api.get('/mentions.csv', (req, res) => {
    const bid = req.query.brand_id ? String(req.query.brand_id) : null;
    const rows = all(`SELECT * FROM mentions ${bid ? 'WHERE brand_id=?' : ''} ORDER BY posted_at DESC`, ...(bid ? [bid] : []));
    const cell = (v) => { let t = String(v ?? '').replace(/\r?\n/g, ' '); if (/^[=+\-@]/.test(t)) t = `'${t}`; return `"${t.replace(/"/g, '""')}"`; };
    const csv = ['brand,username,waktu,status,isi,catatan,link', ...rows.map((r) => [r.brand_id, '@' + r.username, r.posted_at, r.status, r.text, r.note, r.permalink].map(cell).join(','))].join('\n');
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="mention-threads.csv"' }).send('\ufeff' + csv);
  });

  // ----- Kolaborasi / endorse (threads_profile_discovery + pipeline kandidat)
  api.get('/creators', (req, res) => {
    const st = String(req.query.status || '');
    const rows = R.CREATOR_STATUS.includes(st) ? all('SELECT * FROM creators WHERE status=? ORDER BY updated_at DESC', st) : all('SELECT * FROM creators ORDER BY updated_at DESC');
    res.json(rows.map(R.publicCreator));
  });
  api.post('/creators', fresh('editor'), ah(async (req, res) => {
    const f = req.body || {};
    const { creator, existed } = R.createCreator(f, req.user.id);
    let lookup_error = null;
    if (f.lookup && !existed) {
      const lb = brandOr404(f.lookup_brand_id || f.brand_id);
      try {
        if (!lb) throw new Error('Pilih akun brand untuk lookup.');
        if (!lb.token_enc && !T.isDryRun(lb)) throw new Error('Akun belum terhubung ke Threads.');
        R.applyProfile(creator.id, await T.profileLookup(lb, creator.username));
      } catch (e) { lookup_error = e.message; }
    }
    A(req, existed ? 'creator.exists' : 'creator.added', { username: creator.username, source: creator.source });
    res.status(existed ? 200 : 201).json({ creator: R.publicCreator(get('SELECT * FROM creators WHERE id=?', creator.id)), existed, lookup_error });
  }));
  api.put('/creators/:id', fresh('editor'), (req, res) => {
    const c = get('SELECT * FROM creators WHERE id=?', req.params.id);
    if (!c) return bad(res, 'Kandidat tidak ditemukan.', 404);
    const f = req.body || {};
    if (f.status !== undefined && !R.CREATOR_STATUS.includes(f.status)) return bad(res, 'Status tidak valid.');
    const s = (k, max) => (f[k] !== undefined ? String(f[k] ?? '').slice(0, max) || null : c[k]);
    const fol = f.followers !== undefined ? (f.followers === '' || f.followers === null ? null : Math.max(0, Number(f.followers) || 0)) : c.followers;
    run('UPDATE creators SET status=?, name=?, bio=?, niche=?, note=?, fee=?, brand_id=?, followers=?, updated_at=? WHERE id=?',
      f.status ?? c.status, s('name', 100), s('bio', 500), s('niche', 100), s('note', 2000), s('fee', 100), f.brand_id !== undefined ? (brandOr404(f.brand_id)?.id || null) : c.brand_id, fol, now(), c.id);
    if (f.status && f.status !== c.status) A(req, 'creator.status', { username: c.username, from: c.status, to: f.status });
    res.json(R.publicCreator(get('SELECT * FROM creators WHERE id=?', c.id)));
  });
  api.delete('/creators/:id', fresh('manager'), (req, res) => {
    run('DELETE FROM creators WHERE id=?', req.params.id);
    A(req, 'creator.deleted', { id: req.params.id });
    res.json({ ok: true });
  });
  api.post('/creators/:id/lookup', fresh('editor'), ah(async (req, res) => {
    const c = get('SELECT * FROM creators WHERE id=?', req.params.id);
    const b = brandOr404(req.body?.brand_id);
    if (!c) return bad(res, 'Kandidat tidak ditemukan.', 404);
    if (!b) return bad(res, 'Pilih akun brand untuk lookup.');
    if (!b.token_enc && !T.isDryRun(b)) return bad(res, 'Akun belum terhubung ke Threads.');
    R.applyProfile(c.id, await T.profileLookup(b, c.username));
    res.json(R.publicCreator(get('SELECT * FROM creators WHERE id=?', c.id)));
  }));
  api.post('/ai/outreach', ...aiRoute('editor', async (brand, b) => {
    const c = get('SELECT * FROM creators WHERE id=?', b.creator_id);
    if (!c) { const e = new Error('Pilih kandidat.'); e.status = 400; throw e; }
    return { drafts: await AI.outreachDrafts(brand, { creator: c, offer: String(b.offer || '').slice(0, 600), count: b.count }) };
  }));

  // ----- Tim (admin)
  api.get('/users', humanOnly, need('admin'), (req, res) => res.json(all('SELECT * FROM users ORDER BY created_at').map(publicUser)));
  api.post('/users', humanOnly, need('admin'), (req, res) => {
    const { email, name, role, password } = req.body || {};
    if (!email || !name || !RANK.hasOwnProperty(role) || String(password || '').length < 8) return bad(res, 'Email, nama, peran, dan password (min 8 karakter) wajib diisi.');
    if (get('SELECT 1 AS x FROM users WHERE email=?', email.toLowerCase())) return bad(res, 'Email sudah terdaftar.');
    const id = uid();
    run('INSERT INTO users(id,email,name,role,pass_hash,created_at) VALUES (?,?,?,?,?,?)', id, email.toLowerCase().trim(), name, role, C.hashPassword(password), now());
    A(req, 'user.created', { email, role });
    res.status(201).json(publicUser(get('SELECT * FROM users WHERE id=?', id)));
  });
  api.put('/users/:id', humanOnly, need('admin'), (req, res) => {
    const u = get('SELECT * FROM users WHERE id=?', req.params.id);
    if (!u) return bad(res, 'User tidak ditemukan.', 404);
    const b = req.body || {};
    if (b.role && !RANK.hasOwnProperty(b.role)) return bad(res, 'Peran tidak valid.');
    if (u.id === req.user.id && (b.active === false || (b.role && b.role !== 'admin'))) return bad(res, 'Tidak bisa menurunkan/menonaktifkan akun admin Anda sendiri.');
    run('UPDATE users SET name=?, role=?, active=?, pass_hash=? WHERE id=?', b.name ?? u.name, b.role ?? u.role, b.active === undefined ? u.active : b.active ? 1 : 0, b.password ? C.hashPassword(b.password) : u.pass_hash, u.id);
    A(req, 'user.updated', { id: u.id });
    res.json(publicUser(get('SELECT * FROM users WHERE id=?', u.id)));
  });
  api.post('/users/:id/api-token', humanOnly, need('admin'), (req, res) => {
    const u = get('SELECT * FROM users WHERE id=?', req.params.id);
    if (!u) return bad(res, 'User tidak ditemukan.', 404);
    const token = C.randomToken('dth');
    run('UPDATE users SET api_token_hash=? WHERE id=?', C.sha256(token), u.id);
    A(req, 'user.api_token_created', { id: u.id });
    res.json({ token, note: 'Simpan sekarang. Token tidak akan ditampilkan lagi.' });
  });
  api.delete('/users/:id/api-token', humanOnly, need('admin'), (req, res) => {
    run('UPDATE users SET api_token_hash=NULL WHERE id=?', req.params.id);
    res.json({ ok: true });
  });
  api.get('/audit', humanOnly, need('admin'), (req, res) =>
    res.json(all('SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 100')),
  );

  // ----- Ringkasan untuk Claude (pintu masuk percakapan) + Kontrol Claude (admin)
  api.get('/overview', (req, res) => {
    const pick = (sql, ...a) => all(sql, ...a).map((p) => ({ id: p.id, brand: p.brand_id, text: p.text, status: p.status, scheduled_at: p.scheduled_at, error: p.error, source: p.source }));
    res.json({
      you: { name: req.user.name, role: req.user.role },
      pending_approval: pick("SELECT * FROM posts WHERE status='pending_approval' ORDER BY created_at LIMIT 20"),
      failed: pick("SELECT * FROM posts WHERE status='failed' ORDER BY updated_at DESC LIMIT 10"),
      upcoming: pick("SELECT * FROM posts WHERE status='scheduled' ORDER BY scheduled_at LIMIT 10"),
      drafts: get("SELECT COUNT(*) AS n FROM posts WHERE status='draft'").n,
      claude_policy: policy(),
      dashboard_url: `${baseUrl()}/#/queue?status=pending_approval`,
      now: now(),
    });
  });

  // ----- Kredensial Meta (admin, hanya manusia: tidak bisa lewat Claude/MCP)
  const idOk = (v) => /^[0-9A-Za-z_-]{5,40}$/.test(v);
  const secOk = (v) => /^[0-9A-Za-z_-]{16,128}$/.test(v);
  const metaStatus = () => {
    const g = T.creds();
    return {
      mode: T.modeSetting(),
      env_dry_run: process.env.THREADS_DRY_RUN === 'true',
      app_id: getSetting('meta_app_id') || '',
      has_secret: !!getSetting('meta_app_secret_enc'),
      env_has_creds: !!process.env.THREADS_APP_ID,
      global_source: g.source,
      redirect_uri: T.redirectUri(),
      legal: { privacy: `${baseUrl()}/privacy`, terms: `${baseUrl()}/terms`, deletion: `${baseUrl()}/data-deletion`, deauthorize: `${baseUrl()}/auth/threads/deauthorize`, delete_cb: `${baseUrl()}/auth/threads/delete` },
      scopes: T.scopes(),
      extra_scopes: T.extraScopesOn(),
      mentions_auto: getSetting('mentions_auto') === '1',
      simulated: T.isDryRun(),
      brands: all('SELECT * FROM brands ORDER BY sort').map((b) => ({
        id: b.id, name: b.name, app_id: b.app_id || '', has_secret: !!b.app_secret_enc,
        source: T.creds(b).source, simulated: T.isDryRun(b), connected: !!b.token_enc, username: b.username,
      })),
    };
  };
  api.get('/settings/meta', humanOnly, need('admin'), (req, res) => res.json(metaStatus()));
  api.put('/settings/meta', humanOnly, need('admin'), (req, res) => {
    const f = req.body || {};
    if (f.mode !== undefined && !['auto', 'live', 'sim'].includes(f.mode)) return bad(res, 'Mode tidak valid.');
    if (f.mode === 'live') {
      const nid = typeof f.app_id === 'string' ? f.app_id.trim() : getSetting('meta_app_id');
      const nsec = (typeof f.app_secret === 'string' && f.app_secret.trim()) || getSetting('meta_app_secret_enc');
      const brandOwn = all('SELECT 1 FROM brands WHERE app_id IS NOT NULL AND app_secret_enc IS NOT NULL LIMIT 1').length;
      if (!f.clear && !(nid && nsec) && !process.env.THREADS_APP_ID && !brandOwn) return bad(res, 'Isi App ID dan App Secret dulu sebelum memilih mode Live.');
    }
    if (f.clear) { setSetting('meta_app_id', ''); setSetting('meta_app_secret_enc', ''); }
    else {
      const id = typeof f.app_id === 'string' ? f.app_id.trim() : undefined;
      const sec = typeof f.app_secret === 'string' ? f.app_secret.trim() : '';
      if (id !== undefined && id !== '' && !idOk(id)) return bad(res, 'App ID tidak valid (hanya huruf/angka, 5-40 karakter).');
      if (sec && !secOk(sec)) return bad(res, 'App Secret tidak valid (16-128 karakter huruf/angka).');
      const effId = id ?? getSetting('meta_app_id');
      if (sec && !effId) return bad(res, 'Isi App ID bersama App Secret.');
      if (id !== undefined) setSetting('meta_app_id', id);
      if (sec) setSetting('meta_app_secret_enc', C.encrypt(sec));
    }
    if (f.mode !== undefined) setSetting('threads_mode', f.mode);
    if (typeof f.extra_scopes === 'boolean') setSetting('threads_extra_scopes', f.extra_scopes ? '1' : '0');
    if (typeof f.mentions_auto === 'boolean') setSetting('mentions_auto', f.mentions_auto ? '1' : '0');
    A(req, 'settings.meta.updated', { mode: f.mode, cleared: !!f.clear, app_id_changed: typeof f.app_id === 'string', secret_changed: !!(typeof f.app_secret === 'string' && f.app_secret.trim()) });
    res.json(metaStatus());
  });
  api.put('/brands/:id/credentials', humanOnly, need('admin'), (req, res) => {
    const b = brandOr404(req.params.id);
    if (!b) return bad(res, 'Brand tidak ditemukan.', 404);
    const f = req.body || {};
    if (f.clear) {
      run('UPDATE brands SET app_id=NULL, app_secret_enc=NULL WHERE id=?', b.id);
    } else {
      const id = String(f.app_id || '').trim();
      const sec = String(f.app_secret || '').trim();
      if (!idOk(id)) return bad(res, 'App ID tidak valid (hanya huruf/angka, 5-40 karakter).');
      if (sec && !secOk(sec)) return bad(res, 'App Secret tidak valid (16-128 karakter huruf/angka).');
      if (!sec && !b.app_secret_enc) return bad(res, 'Isi App Secret untuk brand ini.');
      run('UPDATE brands SET app_id=?, app_secret_enc=COALESCE(?, app_secret_enc) WHERE id=?', id, sec ? C.encrypt(sec) : null, b.id);
    }
    A(req, 'brand.credentials', { brand: b.id, cleared: !!f.clear });
    res.json(metaStatus());
  });

  api.get('/settings/claude', humanOnly, need('admin'), (req, res) => res.json(policy()));
  api.put('/settings/claude', humanOnly, need('admin'), (req, res) => {
    const b = req.body || {};
    const map = { claude_enabled: 'claude_enabled', can_create: 'claude_create', can_approve: 'claude_approve', can_publish: 'claude_publish', can_reply: 'claude_reply', can_edit_brand: 'claude_brand' };
    for (const [k, key] of Object.entries(map)) if (b[k] !== undefined) setSetting(key, b[k] ? '1' : '0');
    if (b.daily_create_cap !== undefined) setSetting('claude_daily_cap', String(Math.max(0, Math.min(500, parseInt(b.daily_create_cap, 10) || 0))));
    A(req, 'settings.claude_updated', policy());
    res.json(policy());
  });
  api.get('/claude/sessions', humanOnly, need('admin'), (req, res) =>
    res.json(all(`SELECT t.id, u.name AS user_name, u.role, c.name AS client_name, t.created_at, t.refresh_expires
                  FROM oauth_tokens t JOIN users u ON u.id=t.user_id JOIN oauth_clients c ON c.client_id=t.client_id ORDER BY t.created_at DESC`)),
  );
  api.delete('/claude/sessions', humanOnly, need('admin'), (req, res) => {
    run('DELETE FROM oauth_tokens');
    A(req, 'claude.sessions_revoked_all');
    res.json({ ok: true });
  });
  api.delete('/claude/sessions/:id', humanOnly, need('admin'), (req, res) => {
    run('DELETE FROM oauth_tokens WHERE id=?', req.params.id);
    A(req, 'claude.session_revoked', { id: req.params.id });
    res.json({ ok: true });
  });
  api.get('/claude/activity', humanOnly, need('admin'), (req, res) =>
    res.json(all(`SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id
                  WHERE a.detail LIKE '%"via":"oauth"%' OR a.detail LIKE '%"via":"token"%' ORDER BY a.id DESC LIMIT 50`)),
  );

  /* ---------------- Media sementara ---------------- */
  // Unggah mentah (body = isi file). Nama asli di header x-filename, akun di ?brand=
  api.post('/media', humanOnly, need('editor'), async (req, res) => {
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const row = await M.saveUpload(req, { mime, originalName: decodeURIComponent(String(req.headers['x-filename'] || '')), brandId: String(req.query.brand || '') || null, userId: req.user.id });
    A(req, 'media.uploaded', { name: row.name, bytes: row.bytes });
    res.status(201).json({ name: row.name, url: M.urlFor(baseUrl(), row.name), mime: row.mime, bytes: row.bytes, expires: 'Dihapus otomatis 24 jam setelah post terbit.' });
  });
  // Dipakai Claude (MCP): ambil gambar dari URL publik atau base64, simpan sementara, kembalikan URL hub
  api.post('/media/import', need('editor'), gate('claude_create'), claudeCap, async (req, res) => {
    const b = req.body || {};
    const row = await M.importMedia({ url: b.source_url, base64: b.base64, filename: b.filename, brandId: b.brand_id || null, userId: req.user.id });
    A(req, 'media.imported', { name: row.name, bytes: row.bytes, from: b.source_url ? new URL(b.source_url).hostname : 'base64' });
    res.status(201).json({ name: row.name, url: M.urlFor(baseUrl(), row.name), mime: row.mime, bytes: row.bytes, expires: 'Dihapus otomatis 24 jam setelah post terbit.' });
  });
  api.get('/media', need('viewer'), (req, res) => {
    res.json(M.listMedia(req.query.limit).map((m) => ({ ...m, url: M.urlFor(baseUrl(), m.name) })));
  });
  // Tautan unggah sekali-pakai-waktu (15 menit): user membuka di HP/laptop tanpa login, menjatuhkan foto,
  // lalu Claude mengambilnya lewat list_media. Solusi untuk foto yang hanya "terlihat" Claude di chat.
  api.post('/media/upload-link', need('editor'), gate('claude_create'), claudeCap, (req, res) => {
    const token = C.sign({ k: 'upl', uid: req.user.id, b: String(req.body?.brand_id || '') }, 15 * 60);
    A(req, 'media.upload_link', {});
    res.status(201).json({ url: `${baseUrl()}/upload/${token}`, expires_in_minutes: 15, max_files: 20 });
  });
  api.get('/media/usage', need('viewer'), (req, res) => {
    const r = get('SELECT COUNT(*) AS files, COALESCE(SUM(bytes),0) AS bytes FROM media');
    res.json({ ...r, max_bytes: M.MAX_TOTAL, keep_hours_after_post: 24 });
  });
  api.delete('/media/:name', humanOnly, need('editor'), (req, res) => {
    const m = get('SELECT * FROM media WHERE name=?', req.params.name);
    if (!m) return bad(res, 'File tidak ditemukan.', 404);
    if (m.post_id) return bad(res, 'File masih dipakai post. Hapus dari post-nya dulu.');
    M.removeMedia(m.name);
    A(req, 'media.deleted', { name: m.name });
    res.json({ ok: true });
  });
  const uploadUser = (tok) => { const p = C.verify(String(tok)); return p && p.k === 'upl' ? p : null; };
  const uploadCount = new Map(); // token -> jumlah file (batas 20 per tautan)
  app.get('/upload/:token', (req, res) => {
    if (!uploadUser(req.params.token)) return res.status(410).type('text/plain; charset=utf-8').send('Tautan unggah sudah kedaluwarsa. Minta Claude membuat tautan baru.');
    res.set('Cache-Control', 'no-store').sendFile('upload.html', { root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public') });
  });
  app.post('/upload/:token/file', async (req, res) => {
    const p = uploadUser(req.params.token);
    if (!p) return bad(res, 'Tautan unggah kedaluwarsa. Minta Claude membuat tautan baru.', 410);
    const user = get('SELECT id FROM users WHERE id=? AND active=1', p.uid);
    if (!user) return bad(res, 'Pembuat tautan sudah tidak aktif.', 403);
    const n = uploadCount.get(req.params.token) || 0;
    if (n >= 20) return bad(res, 'Batas 20 file per tautan tercapai.', 429);
    uploadCount.set(req.params.token, n + 1);
    if (uploadCount.size > 500) uploadCount.delete(uploadCount.keys().next().value);
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    try {
      const row = await M.saveUpload(req, { mime, originalName: decodeURIComponent(String(req.headers['x-filename'] || '')), brandId: p.b || null, userId: p.uid });
      audit(p.uid, 'media.uploaded', { name: row.name, bytes: row.bytes, via: 'upload-link' });
      res.status(201).json({ name: row.name, url: M.urlFor(baseUrl(), row.name), mime: row.mime });
    } catch (e) { uploadCount.set(req.params.token, n); throw e; }
  });
  // Publik tanpa login: Threads mengunduh media lewat URL ini. Nama acak 128-bit.
  app.get('/media/:name', (req, res) => {
    const m = M.isMediaName(req.params.name) && get('SELECT mime FROM media WHERE name=?', req.params.name);
    if (!m) return res.status(404).type('text/plain').send('Tidak ditemukan');
    res.set({ 'Content-Type': m.mime, 'Cache-Control': 'public, max-age=3600', 'Content-Disposition': 'inline' });
    res.sendFile(req.params.name, { root: M.MEDIA_DIR, dotfiles: 'deny', headers: { 'Content-Type': m.mime } });
  });

  mountInstagram(app, api, { auth, need, ah, bad, A, humanOnly, brandOr404, baseUrl });
  mountAuto(app, api, { need, ah, bad, A, humanOnly, brandOr404 });
  mountPesan(api, { need, ah, bad });
  mountTrends(api, { need, ah, bad, A });
  mountEngage(api, { need, ah, bad, A, humanOnly, brandOr404 });
  app.use('/api', api);

  /* ---------------- MCP lewat HTTP (stateless, Bearer token) ---------------- */
  const noSse = (req, res) => res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  app.get('/mcp', auth, noSse);
  app.delete('/mcp', auth, noSse);
  app.post('/mcp', auth, ah(async (req, res) => {
    const port = req.socket.localPort;
    const call = async (method, p, body) => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, {
        method,
        headers: { authorization: req.headers.authorization || '', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      return j;
    };
    if (!(req.headers.authorization || '').startsWith('Bearer ')) return bad(res, 'Endpoint /mcp hanya menerima Bearer API token.', 401);
    const server = new McpServer({ name: 'delova-threads-hub', version: '1.0.0' });
    registerTools(server, call, { role: req.user.role });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }));

  /* ---------------- Static + error ---------------- */
  app.use(express.static(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public')));
  app.use('/api', (req, res) => bad(res, 'Endpoint tidak ditemukan.', 404));
  app.use((err, req, res, next) => {
    const status = err.status || (err instanceof T.ThreadsError ? 502 : 500);
    if (status === 500) console.error(err);
    res.status(status).json({ error: err.message || 'Terjadi kesalahan.' });
  });
  return app;
}

/* ---------------- Bootstrap admin pertama ---------------- */
function bootstrapAdmin() {
  if (get('SELECT 1 AS x FROM users LIMIT 1')) return;
  const email = (process.env.ADMIN_EMAIL || 'admin@delova.local').toLowerCase();
  const password = process.env.ADMIN_PASSWORD || C.randomToken('pw').slice(0, 16);
  run('INSERT INTO users(id,email,name,role,pass_hash,created_at) VALUES (?,?,?,?,?,?)', uid(), email, 'Admin Delova', 'admin', C.hashPassword(password), now());
  console.log('\n=== Admin pertama dibuat ===');
  console.log(`Email    : ${email}`);
  console.log(process.env.ADMIN_PASSWORD ? 'Password : (sesuai ADMIN_PASSWORD di .env)' : `Password : ${password}   <- catat & ganti segera`);
  console.log('============================\n');
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  bootstrapAdmin();
  const port = Number(process.env.PORT) || 3000;
  const srv = createApp().listen(port, () => {
    console.log(`Delova Social Hub berjalan di http://localhost:${port}`);
    console.log(`Mode Threads: ${T.isDryRun() ? 'SIMULASI (tidak memposting ke Threads asli)' : 'LIVE'} | AI: ${AI.replyAiEnabled() ? AI.replyAiLabel() : 'nonaktif (isi ANTHROPIC_API_KEY atau atur model di menu Auto Reply)'}`);
  });
  const stopScheduler = startScheduler();
  // docker stop / restart mengirim SIGTERM: tutup rapi agar tidak memutus request yang sedang jalan
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      console.log(`${sig} diterima, menutup server…`);
      stopScheduler();
      srv.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 8000).unref();
    });
  }
}

export { bootstrapAdmin };
