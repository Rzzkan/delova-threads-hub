// Rute Instagram: akun (OAuth), konten & jadwal, komentar, DM, insight.
import * as I from './instagram.js';
import * as C from './crypto.js';
import * as M from './media.js';
import { all, get, run, now, uid, getSetting, setSetting, audit } from './db.js';

const RANK = { viewer: 0, editor: 1, manager: 2, admin: 3 };
const parse = (p) => (p ? { ...p, media_urls: JSON.parse(p.media_urls || '[]') } : null);
const KINDS = ['feed', 'reels', 'story'];
const isJpeg = (u) => /\.jpe?g(\?|$)/i.test(u);

export function validateIgPost(b, { partial = false } = {}) {
  if (!partial || b.kind !== undefined) if (!KINDS.includes(b.kind || 'feed')) return 'Jenis konten harus feed, reels, atau story.';
  if (!partial || b.caption !== undefined) {
    const c = String(b.caption ?? '');
    if (c.length > 2200) return `Caption terlalu panjang (${c.length}/2200).`;
    if ((c.match(/#[\p{L}\p{N}_]+/gu) || []).length > 30) return 'Maksimal 30 hashtag per post Instagram.';
  }
  if (!partial || b.media_urls !== undefined || b.kind !== undefined) {
    const m = b.media_urls ?? [];
    const kind = b.kind || 'feed';
    if (!Array.isArray(m) || m.some((u) => typeof u !== 'string' || !/^https:\/\//i.test(u))) return 'URL media harus HTTPS dan bisa diakses publik.';
    if (!partial || b.media_urls !== undefined) {
      if (!m.length) return 'Instagram butuh minimal satu foto atau video.';
      if (m.length > 10) return 'Maksimal 10 media per carousel.';
      if (kind === 'reels' && (m.length !== 1 || !I.isVideoUrl(m[0]))) return 'Reels harus tepat satu video (MP4/MOV).';
      if (kind === 'story' && m.length !== 1) return 'Story harus tepat satu foto atau video.';
      if (kind === 'feed' && m.length === 1 && I.isVideoUrl(m[0])) return 'Video tunggal dipublikasikan sebagai Reels. Ubah jenis konten ke Reels.';
      const bad = m.find((u) => !I.isVideoUrl(u) && !isJpeg(u));
      if (bad) return 'Instagram hanya menerima foto JPEG (.jpg). Konversi PNG/WEBP/GIF ke JPG dulu.';
    }
  }
  if (b.scheduled_at && Number.isNaN(Date.parse(b.scheduled_at))) return 'Format scheduled_at tidak valid (ISO 8601).';
  return null;
}

export function mountInstagram(app, api, { auth, need, ah, bad, A, humanOnly, brandOr404, baseUrl }) {
  const acct = (req, res) => {
    const b = brandOr404(req.params.brand);
    if (!b) { bad(res, 'Brand tidak ditemukan.', 404); return null; }
    const acc = I.accountOf(b.id);
    if (!acc?.token_enc && !I.isDryRun()) { bad(res, `Akun Instagram ${b.name} belum terhubung. Hubungkan di tab Akun.`, 409); return null; }
    return { brand: b, acc: acc || {} };
  };

  /* ---------- OAuth ---------- */
  app.get('/auth/instagram/start', auth, need('manager'), (req, res) => {
    const b = brandOr404(String(req.query.brand));
    if (!b) return bad(res, 'Brand tidak ditemukan.', 404);
    if (I.isDryRun()) return bad(res, 'Mode simulasi aktif atau kredensial Instagram belum diisi. Admin: isi di menu Instagram → Akun.');
    const state = C.randomToken('ig');
    run('INSERT INTO oauth_states(state,brand_id,user_id,expires_at) VALUES (?,?,?,?)', state, b.id, req.user.id, Date.now() + 10 * 60_000);
    res.redirect(I.authorizeUrl(state));
  });
  app.get('/auth/instagram/callback', auth, ah(async (req, res) => {
    const { code, state, error_description: err } = req.query;
    const st = get('SELECT * FROM oauth_states WHERE state=?', String(state || ''));
    if (!st || st.expires_at < Date.now() || st.user_id !== req.user.id) return res.redirect('/#/instagram?tab=akun&connect=gagal');
    run('DELETE FROM oauth_states WHERE state=?', st.state);
    if (!code) return res.redirect(`/#/instagram?tab=akun&connect=gagal&msg=${encodeURIComponent(err || 'dibatalkan')}`);
    try {
      const r = await I.exchangeCode(String(code).replace(/#_$/, ''));
      run(`INSERT INTO ig_accounts(brand_id,ig_user_id,username,account_type,followers,token_enc,token_expires_at,token_refreshed_at,granted_scopes,connected_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(brand_id) DO UPDATE SET ig_user_id=excluded.ig_user_id, username=excluded.username, account_type=excluded.account_type, followers=excluded.followers,
             token_enc=excluded.token_enc, token_expires_at=excluded.token_expires_at, token_refreshed_at=excluded.token_refreshed_at, granted_scopes=excluded.granted_scopes, connected_at=excluded.connected_at`,
      st.brand_id, r.userId, r.username, r.accountType || null, r.followers, C.encrypt(r.token), new Date(Date.now() + r.expiresIn * 1000).toISOString(), now(), JSON.stringify(I.SCOPES), now());
      A(req, 'ig.connected', { brand: st.brand_id, username: r.username });
      res.redirect('/#/instagram?tab=akun&connect=ok');
    } catch (e) {
      res.redirect(`/#/instagram?tab=akun&connect=gagal&msg=${encodeURIComponent(e.message)}`);
    }
  }));

  /* ---------- Status & akun ---------- */
  const status = (req) => {
    const c = I.creds();
    const admin = RANK[req.user.role] >= RANK.admin;
    return {
      simulated: I.isDryRun(), source: c.source, scopes: I.SCOPES, redirect_uri: I.redirectUri(),
      app_id: admin ? getSetting('ig_app_id') || '' : undefined, has_secret: admin ? !!getSetting('ig_app_secret_enc') : undefined,
      brands: all('SELECT * FROM brands ORDER BY sort').map((b) => {
        const a = I.accountOf(b.id);
        return { id: b.id, name: b.name, color: b.color, connected: !!a?.token_enc, username: a?.username || null, account_type: a?.account_type || null, followers: a?.followers ?? null, token_expires_at: a?.token_expires_at || null };
      }),
    };
  };
  api.get('/ig/status', (req, res) => res.json(status(req)));

  const idOk = (v) => /^[0-9A-Za-z_-]{5,40}$/.test(v);
  const secOk = (v) => /^[0-9A-Za-z_-]{16,128}$/.test(v);
  api.put('/ig/credentials', humanOnly, need('admin'), (req, res) => {
    const f = req.body || {};
    if (f.clear) { setSetting('ig_app_id', ''); setSetting('ig_app_secret_enc', ''); }
    else {
      const id = typeof f.app_id === 'string' ? f.app_id.trim() : undefined;
      const sec = typeof f.app_secret === 'string' ? f.app_secret.trim() : '';
      if (id !== undefined && id && !idOk(id)) return bad(res, 'Instagram App ID tidak valid.');
      if (sec && !secOk(sec)) return bad(res, 'Instagram App Secret tidak valid.');
      if (id !== undefined) setSetting('ig_app_id', id);
      if (sec) setSetting('ig_app_secret_enc', C.encrypt(sec));
    }
    A(req, 'ig.credentials', { cleared: !!f.clear });
    res.json(status(req));
  });
  api.delete('/ig/accounts/:brand', humanOnly, need('admin'), (req, res) => {
    run('DELETE FROM ig_accounts WHERE brand_id=?', req.params.brand);
    A(req, 'ig.disconnected', { brand: req.params.brand });
    res.json({ ok: true });
  });
  api.post('/ig/accounts/:brand/refresh', humanOnly, need('admin'), ah(async (req, res) => {
    const a = I.accountOf(req.params.brand);
    if (!a?.token_enc) return bad(res, 'Akun belum terhubung.');
    const r = await I.refreshToken(a);
    run('UPDATE ig_accounts SET token_enc=?, token_expires_at=?, token_refreshed_at=? WHERE brand_id=?', C.encrypt(r.token), new Date(Date.now() + r.expiresIn * 1000).toISOString(), now(), a.brand_id);
    res.json(status(req));
  }));

  /* ---------- Konten & jadwal ---------- */
  api.get('/ig/posts', (req, res) => {
    const where = []; const args = [];
    if (req.query.brand) { where.push('p.brand_id=?'); args.push(String(req.query.brand)); }
    if (req.query.status) { where.push('p.status=?'); args.push(String(req.query.status)); }
    const lim = Math.min(Number(req.query.limit) || 100, 200);
    res.json(all(`SELECT p.*, u.name AS author FROM ig_posts p LEFT JOIN users u ON u.id=p.created_by ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY COALESCE(p.scheduled_at, p.created_at) DESC LIMIT ${lim}`, ...args).map(parse));
  });
  /* ---------- Jadwal massal & rangkaian Story ---------- */
  const slotOf = (f) => { // { start, interval_minutes }
    if (!f) return { slot: null, step: 0 };
    const slot = Date.parse(f.start); const step = Number(f.interval_minutes) * 60_000;
    if (Number.isNaN(slot) || !(step >= 60_000 && step <= 7 * 86400_000)) return { error: 'Jadwal otomatis tidak valid (jarak 1 menit - 7 hari).' };
    return { slot, step };
  };
  api.post('/ig/posts/bulk', need('editor'), humanOnly, (req, res) => {
    const b = req.body || {}; const action = String(b.action || '');
    if (!['submit', 'approve', 'reject'].includes(action)) return bad(res, 'Aksi tidak dikenal.');
    if (action !== 'submit' && RANK[req.user.role] < RANK.manager) return bad(res, 'Butuh peran manager atau lebih tinggi.', 403);
    const ids = [...new Set(Array.isArray(b.ids) ? b.ids.map(String) : [])];
    if (!ids.length) return bad(res, 'Pilih minimal satu konten.');
    if (ids.length > 50) return bad(res, 'Maksimal 50 konten sekali proses.');
    let { slot, step, error } = slotOf(b.fill_missing); if (error) return bad(res, error);
    const done = []; const skipped = [];
    for (const id of ids) {
      const p = get('SELECT * FROM ig_posts WHERE id=?', id);
      if (!p) { skipped.push({ id, reason: 'Konten tidak ditemukan.' }); continue; }
      if (action === 'submit') {
        if (!['draft', 'failed'].includes(p.status)) { skipped.push({ id, reason: `Berstatus ${p.status}.` }); continue; }
        run("UPDATE ig_posts SET status='pending_approval', review_note=NULL, error=NULL, updated_at=? WHERE id=?", now(), id); A(req, 'ig.post.submitted', { id, bulk: true }); done.push(id); continue;
      }
      if (action === 'reject') {
        if (!['pending_approval', 'scheduled'].includes(p.status)) { skipped.push({ id, reason: `Berstatus ${p.status}.` }); continue; }
        run("UPDATE ig_posts SET status='draft', review_note=?, updated_at=? WHERE id=?", String(b.note || '').slice(0, 300) || null, now(), id); A(req, 'ig.post.rejected', { id, bulk: true }); done.push(id); continue;
      }
      if (!['pending_approval', 'draft', 'failed'].includes(p.status)) { skipped.push({ id, reason: `Berstatus ${p.status}.` }); continue; }
      let when = p.scheduled_at;
      if (!when) { if (slot === null) { skipped.push({ id, reason: 'Belum punya jadwal.' }); continue; } when = new Date(slot).toISOString(); slot += step; }
      else if (Date.parse(when) < Date.now() - 60_000 && !b.allow_past) { skipped.push({ id, reason: 'Jadwalnya sudah lewat (akan langsung tayang).' }); continue; }
      run("UPDATE ig_posts SET status='scheduled', scheduled_at=?, approved_by=?, error=NULL, updated_at=? WHERE id=?", when, req.user.id, now(), id);
      A(req, 'ig.post.approved', { id, scheduled_at: when, bulk: true }); done.push(id);
    }
    res.json({ action, done, skipped });
  });
  // Satu media = satu slide Story; slide dijadwalkan berurutan dengan jarak tetap.
  api.post('/ig/posts/story-series', need('editor'), humanOnly, (req, res) => {
    const b = req.body || {};
    if (!brandOr404(b.brand_id)) return bad(res, 'Brand tidak ditemukan.', 404);
    const media = Array.isArray(b.media_urls) ? b.media_urls : [];
    if (media.length < 1 || media.length > 10) return bad(res, 'Pilih 1-10 media (satu slide per media).');
    const sl = slotOf({ start: b.scheduled_at, interval_minutes: b.interval_minutes ?? 5 }); if (sl.error || !b.scheduled_at) return bad(res, sl.error || 'Tentukan jadwal tayang slide pertama.');
    for (const u of media) { const err = validateIgPost({ kind: 'story', media_urls: [u] }); if (err) return bad(res, err); }
    const status = b.submit ? 'pending_approval' : 'draft'; const ids = [];
    media.forEach((u, i) => {
      const id = uid();
      run('INSERT INTO ig_posts(id,brand_id,kind,caption,media_urls,status,scheduled_at,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        id, b.brand_id, 'story', '', JSON.stringify([u]), status, new Date(sl.slot + i * sl.step).toISOString(), req.user.id, now(), now());
      M.linkMedia(id, [u]); ids.push(id);
    });
    A(req, 'ig.story.series', { brand: b.brand_id, count: ids.length });
    res.status(201).json(ids.map((id) => parse(get('SELECT * FROM ig_posts WHERE id=?', id))));
  });
  api.post('/ig/posts', need('editor'), humanOnly, (req, res) => {
    const b = req.body || {};
    if (!brandOr404(b.brand_id)) return bad(res, 'Brand tidak ditemukan.', 404);
    const err = validateIgPost({ ...b, kind: b.kind || 'feed' });
    if (err) return bad(res, err);
    const id = uid();
    run(`INSERT INTO ig_posts(id,brand_id,kind,caption,media_urls,status,scheduled_at,created_by,created_at,updated_at) VALUES (?,?,?,?,?,'draft',?,?,?,?)`,
      id, b.brand_id, b.kind || 'feed', String(b.caption || '').trim(), JSON.stringify(b.media_urls), b.scheduled_at ? new Date(b.scheduled_at).toISOString() : null, req.user.id, now(), now());
    M.linkMedia(id, b.media_urls);
    A(req, 'ig.post.created', { id, brand: b.brand_id });
    res.status(201).json(parse(get('SELECT * FROM ig_posts WHERE id=?', id)));
  });
  const load = (req, res) => { const p = get('SELECT * FROM ig_posts WHERE id=?', req.params.id); if (!p) bad(res, 'Konten tidak ditemukan.', 404); return p; };
  api.put('/ig/posts/:id', need('editor'), humanOnly, (req, res) => {
    const p = load(req, res); if (!p) return;
    if (['published', 'publishing'].includes(p.status)) return bad(res, 'Konten yang sudah terbit tidak bisa diedit.');
    if (req.user.role === 'editor' && p.created_by !== req.user.id) return bad(res, 'Editor hanya bisa mengedit konten buatannya sendiri.', 403);
    const b = req.body || {};
    const merged = { kind: b.kind ?? p.kind, caption: b.caption ?? p.caption, media_urls: b.media_urls ?? JSON.parse(p.media_urls), scheduled_at: b.scheduled_at };
    const err = validateIgPost(merged);
    if (err) return bad(res, err);
    const contentChanged = ['kind', 'caption', 'media_urls'].some((k) => b[k] !== undefined);
    const status = ['pending_approval', 'scheduled'].includes(p.status) && contentChanged && RANK[req.user.role] < RANK.manager ? 'draft' : p.status === 'failed' ? 'draft' : p.status;
    run('UPDATE ig_posts SET kind=?, caption=?, media_urls=?, scheduled_at=?, status=?, error=NULL, updated_at=? WHERE id=?',
      merged.kind, String(merged.caption).trim(), JSON.stringify(merged.media_urls), b.scheduled_at !== undefined ? (b.scheduled_at ? new Date(b.scheduled_at).toISOString() : null) : p.scheduled_at, status, now(), p.id);
    M.linkMedia(p.id, merged.media_urls);
    res.json(parse(get('SELECT * FROM ig_posts WHERE id=?', p.id)));
  });
  api.delete('/ig/posts/:id', need('editor'), humanOnly, (req, res) => {
    const p = load(req, res); if (!p) return;
    if (['published', 'publishing'].includes(p.status)) return bad(res, 'Konten terbit tidak bisa dihapus dari dashboard (hapus langsung di Instagram).');
    if (req.user.role === 'editor' && p.created_by !== req.user.id) return bad(res, 'Editor hanya bisa menghapus konten buatannya sendiri.', 403);
    run('DELETE FROM ig_posts WHERE id=?', p.id);
    A(req, 'ig.post.deleted', { id: p.id });
    res.json({ ok: true });
  });
  api.post('/ig/posts/:id/submit', need('editor'), humanOnly, (req, res) => {
    const p = load(req, res); if (!p) return;
    if (!['draft', 'failed'].includes(p.status)) return bad(res, `Konten berstatus ${p.status}, tidak bisa diajukan.`);
    run("UPDATE ig_posts SET status='pending_approval', review_note=NULL, error=NULL, updated_at=? WHERE id=?", now(), p.id);
    A(req, 'ig.post.submitted', { id: p.id });
    res.json(parse(get('SELECT * FROM ig_posts WHERE id=?', p.id)));
  });
  api.post('/ig/posts/:id/approve', need('manager'), humanOnly, (req, res) => {
    const p = load(req, res); if (!p) return;
    if (!['pending_approval', 'draft', 'failed'].includes(p.status)) return bad(res, `Konten berstatus ${p.status}.`);
    const when = req.body?.scheduled_at || p.scheduled_at;
    if (!when || Number.isNaN(Date.parse(when))) return bad(res, 'Tentukan jadwal tayang dulu.');
    run("UPDATE ig_posts SET status='scheduled', scheduled_at=?, approved_by=?, error=NULL, updated_at=? WHERE id=?", new Date(when).toISOString(), req.user.id, now(), p.id);
    A(req, 'ig.post.approved', { id: p.id, scheduled_at: when });
    res.json(parse(get('SELECT * FROM ig_posts WHERE id=?', p.id)));
  });
  api.post('/ig/posts/:id/reject', need('manager'), humanOnly, (req, res) => {
    const p = load(req, res); if (!p) return;
    if (!['pending_approval', 'scheduled'].includes(p.status)) return bad(res, `Konten berstatus ${p.status}.`);
    run("UPDATE ig_posts SET status='draft', review_note=?, updated_at=? WHERE id=?", String(req.body?.note || '').slice(0, 300) || null, now(), p.id);
    res.json(parse(get('SELECT * FROM ig_posts WHERE id=?', p.id)));
  });
  api.post('/ig/posts/:id/publish-now', need('manager'), humanOnly, ah(async (req, res) => {
    const p = load(req, res); if (!p) return;
    const out = await I.publishIgPost(p.id, { allowFrom: ['draft', 'pending_approval', 'scheduled', 'failed'], userId: req.user.id });
    run('UPDATE ig_posts SET approved_by=COALESCE(approved_by,?) WHERE id=?', req.user.id, p.id);
    A(req, 'ig.post.publish_now', { id: p.id, brand: p.brand_id });
    res.json(parse(out));
  }));

  /* ---------- Komentar ---------- */
  // Komentar dari beberapa post terbaru sekaligus (default 6), dikelompokkan per post.
  api.get('/ig/:brand/comments', need('editor'), ah(async (req, res) => {
    const ctx = acct(req, res); if (!ctx) return;
    const media = (await I.listMedia(ctx.acc, ctx.brand, Math.min(Number(req.query.media) || 6, 12))).filter((m) => (m.comments_count ?? 1) > 0);
    const out = await Promise.all(media.map(async (m) => ({ media: { id: m.id, caption: (m.caption || '').slice(0, 120), permalink: m.permalink, timestamp: m.timestamp }, comments: await I.listComments(ctx.acc, ctx.brand, m.id).catch(() => []) })));
    res.json(out.filter((x) => x.comments.length));
  }));
  api.post('/ig/:brand/comments/:id/reply', need('editor'), humanOnly, ah(async (req, res) => {
    const ctx = acct(req, res); if (!ctx) return;
    const text = String(req.body?.text || '').trim();
    if (!text) return bad(res, 'Isi balasan wajib diisi.');
    if (text.length > 2200) return bad(res, 'Balasan terlalu panjang (maks 2200 karakter).');
    const r = await I.replyComment(ctx.acc, ctx.brand, req.params.id, text);
    A(req, 'ig.comment.replied', { brand: ctx.brand.id, comment: req.params.id });
    res.json({ ok: true, id: r.id, dryRun: !!r.dryRun });
  }));
  api.post('/ig/:brand/comments/:id/hide', need('editor'), humanOnly, ah(async (req, res) => {
    const ctx = acct(req, res); if (!ctx) return;
    const hide = req.body?.hide !== false;
    await I.hideComment(ctx.acc, ctx.brand, req.params.id, hide);
    A(req, hide ? 'ig.comment.hidden' : 'ig.comment.unhidden', { brand: ctx.brand.id, comment: req.params.id });
    res.json({ ok: true });
  }));

  /* ---------- DM ---------- */
  api.get('/ig/:brand/conversations', need('editor'), ah(async (req, res) => {
    const ctx = acct(req, res); if (!ctx) return;
    res.json(await I.listConversations(ctx.acc, ctx.brand));
  }));
  api.get('/ig/:brand/conversations/:id', need('editor'), ah(async (req, res) => {
    const ctx = acct(req, res); if (!ctx) return;
    res.json(await I.getMessages(ctx.acc, ctx.brand, req.params.id));
  }));
  api.post('/ig/:brand/conversations/:id/send', need('editor'), humanOnly, ah(async (req, res) => {
    const ctx = acct(req, res); if (!ctx) return;
    const text = String(req.body?.text || '').trim();
    const to = String(req.body?.recipient_id || '');
    if (!text || !to) return bad(res, 'Penerima dan isi pesan wajib diisi.');
    if (text.length > 1000) return bad(res, 'Pesan terlalu panjang (maks 1000 karakter).');
    const r = await I.sendMessage(ctx.acc, ctx.brand, to, text);
    A(req, 'ig.dm.sent', { brand: ctx.brand.id, conversation: req.params.id });
    res.json({ ok: true, id: r.message_id, dryRun: !!r.dryRun });
  }));

  /* ---------- Insight ---------- */
  api.get('/ig/:brand/insights', ah(async (req, res) => {
    const ctx = acct(req, res); if (!ctx) return;
    const days = [7, 14, 30].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
    res.json(await I.accountInsights(ctx.acc, ctx.brand, days));
  }));
  const cache = new Map(); // brand|limit -> {t, data}; insight per post cukup disegarkan tiap 10 menit
  api.get('/ig/:brand/media-insights', ah(async (req, res) => {
    const ctx = acct(req, res); if (!ctx) return;
    const limit = Math.min(Number(req.query.limit) || 24, 40);
    const key = `${ctx.brand.id}|${limit}`; const hit = cache.get(key);
    if (hit && Date.now() - hit.t < 10 * 60_000 && req.query.fresh !== '1') return res.json(hit.data);
    const media = await I.listMedia(ctx.acc, ctx.brand, limit);
    const data = [];
    for (let i = 0; i < media.length; i += 6) data.push(...await Promise.all(media.slice(i, i + 6).map(async (m) => ({ ...m, insights: await I.mediaInsights(ctx.acc, ctx.brand, m.id) }))));
    cache.set(key, { t: Date.now(), data });
    res.json(data);
  }));
}
