// Rute webhook Meta (Threads & Instagram) dan pengelolaan auto reply.
import * as A_ from './autoreply.js';
import * as T from './threads.js';
import * as I from './instagram.js';
import * as AI from './claude.js';
import * as C from './crypto.js';
import * as Store from './store-api.js';
import { all, get, run, now, uid, setSetting, getSetting, audit } from './db.js';

const PLATFORMS = ['threads', 'instagram'];

export function mountAuto(app, api, { need, ah, bad, A, humanOnly, brandOr404 }) {
  /* ---------- Webhook publik (diverifikasi tanda tangan HMAC) ---------- */
  for (const platform of PLATFORMS) {
    app.get(`/webhooks/${platform}`, (req, res) => {
      const c = A_.verifyChallenge(req.query);
      return c === null ? res.status(403).send('Verifikasi gagal') : res.type('text/plain').send(c);
    });
    app.post(`/webhooks/${platform}`, (req, res) => {
      if (!A_.verifySignature(platform, req.rawBody, req.get('x-hub-signature-256'))) return res.status(401).json({ error: 'Tanda tangan tidak valid.' });
      res.sendStatus(200); // balas cepat; Meta mengulang bila lambat
      try {
        const events = platform === 'threads' ? A_.parseThreads(req.body) : A_.parseInstagram(req.body);
        const ids = A_.ingest(events);
        for (const id of ids) setImmediate(() => A_.processEvent(id).catch((e) => console.error('[auto]', e.message)));
      } catch (e) { console.error('[webhook]', e.message); }
    });
  }

  /* ---------- Konfigurasi ---------- */
  api.get('/auto/config', need('viewer'), (req, res) => {
    const admin = req.user.role === 'admin';
    const brands = all('SELECT id,name,color,username FROM brands ORDER BY sort');
    res.json({
      enabled: A_.enabled(), ai: AI.replyAiEnabled(), model: AI.replyAiLabel(),
      llm: (() => { const c = AI.llmConfig(); return { provider: c.provider, base_url: c.baseUrl, model: c.model, has_key: !!c.key, fallback: c.fallback, claude_ready: AI.aiEnabled() }; })(),
      webhooks: PLATFORMS.map((p) => ({ platform: p, url: A_.webhookUrl(p), has_secret: p === 'instagram' ? !!(I.creds().appSecret || T.creds().appSecret) : !!T.creds().appSecret })),
      verify_token: admin ? A_.verifyToken() : undefined,
      store: (() => { const c = Store.storeConfig(); return { base_url: c.baseUrl, has_key: !!c.key, use_reply: c.useReply, use_posts: c.usePosts }; })(),
      llm_cap: Number(getSetting('auto_llm_daily_cap')) || 300,
      stats: A_.stats(),
      brands: brands.map((b) => ({
        ...b,
        rules: Object.fromEntries(PLATFORMS.map((p) => [p, A_.ruleOf(b.id, p)])),
        connected: { threads: !!get('SELECT token_enc FROM brands WHERE id=?', b.id)?.token_enc, instagram: !!I.accountOf(b.id)?.token_enc },
      })),
    });
  });
  api.put('/auto/global', need('admin'), humanOnly, (req, res) => {
    const f = req.body || {};
    if (f.enabled !== undefined) setSetting('auto_enabled', f.enabled ? '1' : '0');
    if (f.llm_cap !== undefined) setSetting('auto_llm_daily_cap', String(Math.min(5000, Math.max(0, Number(f.llm_cap) || 0))));
    if (f.regenerate_token) setSetting('webhook_verify_token', '');
    A(req, 'auto.global', { enabled: f.enabled, regenerate: !!f.regenerate_token });
    res.json({ ok: true });
  });
  api.put('/auto/llm', need('admin'), humanOnly, (req, res) => {
    const f = req.body || {};
    if (f.provider !== undefined && !['claude', 'openai'].includes(f.provider)) return bad(res, 'Penyedia tidak dikenal.');
    if (f.base_url !== undefined) { const e = AI.validateBaseUrl(String(f.base_url).trim()); if (e) return bad(res, e); }
    if (f.provider !== undefined) setSetting('llm_provider', f.provider);
    if (f.base_url !== undefined) setSetting('llm_base_url', String(f.base_url).trim().replace(/\/+$/, ''));
    if (f.model !== undefined) setSetting('llm_model', String(f.model).trim().slice(0, 120));
    if (f.fallback !== undefined) setSetting('llm_fallback', f.fallback ? '1' : '0');
    if (f.clear_key) setSetting('llm_key_enc', '');
    else if (typeof f.api_key === 'string' && f.api_key.trim()) setSetting('llm_key_enc', C.encrypt(f.api_key.trim()));
    A(req, 'auto.llm', { provider: f.provider, model: f.model }); // kunci tidak pernah dicatat
    res.json({ ok: true });
  });
  api.post('/auto/llm/test', need('admin'), humanOnly, ah(async (req, res) => {
    try { res.json({ ok: true, ...(await AI.testLlm(AI.llmConfig())) }); }
    catch (e) { bad(res, e.message, 502); }
  }));
  api.get('/auto/llm/models', need('admin'), humanOnly, ah(async (req, res) => {
    try { res.json({ models: await AI.listModels(AI.llmConfig(), { fresh: req.query.fresh === '1' }), current: AI.llmConfig().model }); }
    catch (e) { bad(res, e.message, 502); }
  }));

  /* ---------- Data produk (API delova.id) ---------- */
  api.get('/store/config', need('admin'), humanOnly, (req, res) => {
    const c = Store.storeConfig();
    res.json({ base_url: c.baseUrl, has_key: !!c.key, use_reply: c.useReply, use_posts: c.usePosts });
  });
  api.put('/store/config', need('admin'), humanOnly, (req, res) => {
    const f = req.body || {};
    if (f.base_url !== undefined) { const e = Store.validateBaseUrl(String(f.base_url).trim()); if (e) return bad(res, e); setSetting('store_api_url', String(f.base_url).trim().replace(/\/+$/, '')); }
    if (f.use_reply !== undefined) setSetting('store_use_reply', f.use_reply ? '1' : '0');
    if (f.use_posts !== undefined) setSetting('store_use_posts', f.use_posts ? '1' : '0');
    if (f.clear_key) setSetting('store_api_key_enc', '');
    else if (typeof f.api_key === 'string' && f.api_key.trim()) {
      if (f.api_key.trim().length < 16) return bad(res, 'API key terlalu pendek.');
      setSetting('store_api_key_enc', C.encrypt(f.api_key.trim()));
    }
    Store.clearStoreCache();
    A(req, 'store.config', { base_url: f.base_url, use_reply: f.use_reply, use_posts: f.use_posts }); // kunci tidak dicatat
    res.json({ ok: true });
  });
  api.post('/store/test', need('admin'), humanOnly, ah(async (req, res) => {
    try { res.json({ ok: true, ...(await Store.testStore()) }); } catch (e) { bad(res, e.message, e.status === 429 ? 429 : 502); }
  }));
  const storeFail = (res, e) => bad(res, e.message, [400, 401, 404, 429, 503].includes(e.status) ? e.status : 502);
  api.get('/store/search', need('viewer'), ah(async (req, res) => {
    if (!Store.storeReady()) return bad(res, 'API produk belum dikonfigurasi (admin: menu Auto Reply → Webhook & setup).', 503);
    try { res.json(await Store.searchCatalog({ q: req.query.q, brand: req.query.brand, in_stock: req.query.in_stock, sort: req.query.sort, limit: req.query.limit })); } catch (e) { storeFail(res, e); }
  }));
  api.get('/store/product/:ref', need('viewer'), ah(async (req, res) => {
    if (!Store.storeReady()) return bad(res, 'API produk belum dikonfigurasi.', 503);
    try { res.json(await Store.productDetail(req.params.ref)); } catch (e) { storeFail(res, e); }
  }));

  api.put('/auto/rules/:brand/:platform', need('manager'), humanOnly, (req, res) => {
    const b = brandOr404(req.params.brand);
    if (!b) return bad(res, 'Brand tidak ditemukan.', 404);
    if (!PLATFORMS.includes(req.params.platform)) return bad(res, 'Platform tidak dikenal.');
    const f = req.body || {};
    const cur = A_.ruleOf(b.id, req.params.platform);
    if (f.mode === 'auto' && cur.mode !== 'auto' && req.user.role !== 'admin') return bad(res, 'Hanya admin yang boleh mengaktifkan mode balas otomatis penuh.', 403);
    if (f.enabled && f.mode === 'auto' && req.user.role !== 'admin') return bad(res, 'Hanya admin yang boleh mengaktifkan mode balas otomatis penuh.', 403);
    const rule = A_.saveRule(b.id, req.params.platform, f);
    A(req, 'auto.rule', { brand: b.id, platform: req.params.platform, enabled: rule.enabled, mode: rule.mode });
    res.json(rule);
  });
  api.post('/auto/instagram/:brand/subscribe', need('manager'), humanOnly, ah(async (req, res) => {
    const b = brandOr404(req.params.brand);
    if (!b) return bad(res, 'Brand tidak ditemukan.', 404);
    const acc = I.accountOf(b.id);
    if (!acc?.token_enc && !I.isDryRun()) return bad(res, 'Akun Instagram belum terhubung.', 409);
    try { const r = await I.subscribeWebhooks(acc || {}, b); A(req, 'auto.subscribe', { brand: b.id }); res.json({ ok: true, ...r, fields: I.WEBHOOK_FIELDS }); }
    catch (e) { bad(res, `Gagal mendaftarkan webhook: ${e.message}`, 502); }
  }));

  /* ---------- Kotak masuk event ---------- */
  api.get('/auto/events', need('viewer'), (req, res) => {
    const { status, brand, platform } = req.query;
    const w = []; const p = [];
    if (status === 'open') w.push("status IN ('pending','failed')");
    else if (status) { w.push('status=?'); p.push(String(status)); }
    if (brand) { w.push('brand_id=?'); p.push(String(brand)); }
    if (PLATFORMS.includes(platform)) { w.push('platform=?'); p.push(platform); }
    const rows = all(`SELECT * FROM auto_events ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY received_at DESC LIMIT ?`, ...p, Math.min(200, Number(req.query.limit) || 60));
    res.json(rows.map((r) => ({ ...r, simulated: !!r.simulated, needs_human: !!r.needs_human })));
  });
  const ev = (req, res) => { const e = get('SELECT * FROM auto_events WHERE id=?', req.params.id); if (!e) bad(res, 'Event tidak ditemukan.', 404); return e; };
  api.post('/auto/events/:id/approve', need('editor'), humanOnly, ah(async (req, res) => {
    const e = ev(req, res); if (!e) return;
    const text = String(req.body?.text ?? e.draft ?? '').trim();
    if (!text && !(e.dm_text && e.platform === 'instagram' && e.kind === 'comment')) return bad(res, 'Teks balasan kosong.');
    const limit = e.platform === 'threads' ? 500 : e.kind === 'dm' ? 1000 : 2200;
    if ([...text].length > limit) return bad(res, `Balasan terlalu panjang (maks ${limit}).`);
    if (!['pending', 'failed'].includes(e.status)) return bad(res, `Event berstatus "${e.status}", tidak bisa dikirim.`, 409);
    A(req, 'auto.approve', { id: e.id });
    const r = await A_.send(e.id, text, req.user.id);
    if (r.status === 'failed') return bad(res, r.error || 'Gagal mengirim.', 502);
    res.json(r);
  }));
  api.post('/auto/events/:id/reject', need('editor'), humanOnly, (req, res) => { const e = ev(req, res); if (!e) return; return A_.reject(e.id, req.user.id) ? res.json({ ok: true }) : bad(res, 'Status event tidak memungkinkan.', 409); });
  api.post('/auto/events/:id/redraft', need('editor'), humanOnly, ah(async (req, res) => {
    const e = ev(req, res); if (!e) return;
    if (!A_.redraft(e.id)) return bad(res, 'Status event tidak memungkinkan.', 409);
    res.json(await A_.processEvent(e.id));
  }));
  /** Suntik event palsu lewat jalur yang sama dengan webhook; hanya saat platform dalam mode simulasi. */
  api.post('/auto/test-event', need('manager'), humanOnly, ah(async (req, res) => {
    const f = req.body || {};
    const b = brandOr404(String(f.brand_id || ''));
    if (!b || !PLATFORMS.includes(f.platform)) return bad(res, 'Brand/platform tidak valid.');
    const kind = f.kind || (f.platform === 'threads' ? 'reply' : 'comment');
    if (!A_.KINDS.includes(kind) || (f.platform === 'threads' && kind !== 'reply' && kind !== 'mention') || (f.platform === 'instagram' && kind === 'reply')) return bad(res, 'Jenis event tidak cocok dengan platform.');
    const dry = f.platform === 'threads' ? T.isDryRun(b) : I.isDryRun();
    if (!dry) return bad(res, 'Uji event hanya tersedia saat mode simulasi, supaya tidak mengirim ke akun asli.', 409);
    const text = String(f.text || '').trim().slice(0, 500);
    if (!text) return bad(res, 'Isi pesan uji kosong.');
    const id = `test_${uid()}`;
    const ids = A_.ingest([{ platform: f.platform, brand: b, kind, ext_id: id, target_id: kind === 'dm' ? `user_${String(f.username || 'pembeli_contoh').slice(0, 40)}` : id, media_id: 'media_test', author_id: `user_${String(f.username || 'pembeli_contoh').slice(0, 40)}`, author_username: String(f.username || 'pembeli_contoh').slice(0, 40), text, event_at: now() }], { simulated: true });
    A(req, 'auto.test_event', { brand: b.id, platform: f.platform });
    res.json(ids[0] ? await A_.processEvent(ids[0]) : { error: 'Duplikat' });
  }));
}
