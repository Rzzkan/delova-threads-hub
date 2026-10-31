// Aturan keyword, antrean peluang engage, dan pusat persetujuan massal.
import * as TR from './triggers.js';
import * as A_ from './autoreply.js';
import * as T from './threads.js';
import * as AI from './claude.js';
import * as Store from './store-api.js';
import { all, get, run, now, uid, getSetting, audit } from './db.js';

const RANK = { viewer: 1, editor: 2, manager: 3, admin: 4 };
const PLATFORMS = ['threads', 'instagram'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function mountEngage(api, { need, ah, bad, A, humanOnly, brandOr404 }) {
  /* ---------------- Aturan keyword ---------------- */
  api.get('/auto/triggers', need('viewer'), (req, res) => res.json(TR.list(req.query.brand ? String(req.query.brand) : null)));
  const putTrigger = (req, res, id) => {
    const f = req.body || {};
    const cur = id ? TR.byId(id) : null;
    if (id && !cur) return bad(res, 'Aturan tidak ditemukan.', 404);
    const brand = brandOr404(String(cur?.brand_id || f.brand_id || ''));
    const platform = cur?.platform || f.platform;
    if (!brand || !PLATFORMS.includes(platform)) return bad(res, 'Pilih brand dan platform.');
    const v = TR.validate(f, platform);
    if (v.error) return bad(res, v.error);
    let mode = f.mode === 'auto' ? 'auto' : 'draft';
    if (mode === 'auto' && cur?.mode !== 'auto' && RANK[req.user.role] < RANK.admin) return bad(res, 'Mode Auto hanya bisa diaktifkan admin.', 403);
    const t = TR.save(id, brand.id, platform, v.value, { mode, enabled: f.enabled !== false, userId: req.user.id });
    A(req, id ? 'trigger.updated' : 'trigger.created', { id: t.id, brand: brand.id, platform });
    res.json(t);
  };
  api.post('/auto/triggers', need('manager'), humanOnly, (req, res) => putTrigger(req, res, null));
  api.put('/auto/triggers/:id', need('manager'), humanOnly, (req, res) => putTrigger(req, res, req.params.id));
  api.delete('/auto/triggers/:id', need('manager'), humanOnly, (req, res) => {
    if (!TR.remove(req.params.id)) return bad(res, 'Aturan tidak ditemukan.', 404);
    A(req, 'trigger.deleted', { id: req.params.id }); res.json({ ok: true });
  });

  /* ---------------- Antrean peluang (balas post publik, selalu disetujui manusia) ---------------- */
  const cap = () => Math.min(100, Math.max(1, Number(getSetting('opp_daily_cap')) || 10));
  const sentToday = (brand) => get("SELECT COUNT(*) AS n FROM opps WHERE brand_id=? AND status='sent' AND updated_at>?", brand, new Date(Date.now() - 86400e3).toISOString()).n;
  api.get('/opps', need('editor'), (req, res) => {
    const w = []; const p = [];
    if (req.query.brand) { w.push('brand_id=?'); p.push(String(req.query.brand)); }
    if (req.query.status === 'open') w.push("status IN ('new','drafted','failed')"); else if (req.query.status) { w.push('status=?'); p.push(String(req.query.status)); }
    res.json({ items: all(`SELECT * FROM opps ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 200`, ...p), cap: cap(), sent_today: Object.fromEntries(all('SELECT id FROM brands').map((b) => [b.id, sentToday(b.id)])) });
  });
  api.put('/opps/config', need('admin'), humanOnly, (req, res) => { const n = Math.min(100, Math.max(1, Number(req.body?.daily_cap) || 10)); run("INSERT INTO settings(key,value) VALUES('opp_daily_cap',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(n)); res.json({ cap: n }); });
  api.post('/opps/scan', need('editor'), humanOnly, ah(async (req, res) => {
    const f = req.body || {};
    const b = brandOr404(String(f.brand_id || ''));
    if (!b) return bad(res, 'Pilih akun brand.');
    if (!b.token_enc && !T.isDryRun(b)) return bad(res, 'Akun belum terhubung ke Threads.');
    const kws = [...new Set((Array.isArray(f.keywords) ? f.keywords : String(f.keywords || '').split(',')).map((s) => String(s).trim()).filter((s) => s.length >= 2 && s.length <= 80))].slice(0, 5);
    if (!kws.length) return bad(res, 'Isi minimal satu kata kunci.');
    const own = new Set([b.username, ...all('SELECT username FROM brands').map((x) => x.username)].filter(Boolean).map((x) => x.toLowerCase()));
    const engaged = new Set(all("SELECT username FROM opps WHERE brand_id=? AND status='sent' AND updated_at>?", b.id, new Date(Date.now() - 7 * 86400e3).toISOString()).map((r) => String(r.username).toLowerCase()));
    let added = 0; let skipped = 0; const seen = new Set();
    for (const k of kws) {
      let posts = [];
      try { posts = await T.keywordSearch(b, { q: k, searchType: 'RECENT', days: 3, limit: 30 }); } catch (e) { return bad(res, `Pencarian "${k}" gagal: ${String(e.message).slice(0, 150)}`, 502); }
      for (const p of posts) {
        const u = String(p.username || '').toLowerCase();
        const ok = p.id && !seen.has(p.id) && !p.is_reply && !p.is_quote_post && String(p.text || '').trim().length >= 25 && !own.has(u) && !engaged.has(u) && !A_.SENSITIVE.test(p.text) && !/https?:\/\//i.test(p.text);
        seen.add(p.id);
        if (!ok) { skipped++; continue; }
        if (added >= 12) break;
        const r = run('INSERT OR IGNORE INTO opps(id,brand_id,keyword,ext_id,username,text,permalink,posted_at,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', uid(), b.id, k, p.id, p.username || null, String(p.text).slice(0, 1000), p.permalink || null, p.timestamp || null, 'new', now(), now());
        if (r.changes) { added++; engaged.add(u); } else skipped++;
      }
    }
    A(req, 'opps.scan', { brand: b.id, added });
    res.json({ added, skipped });
  }));
  api.post('/opps/draft', need('editor'), humanOnly, ah(async (req, res) => {
    if (!AI.replyAiEnabled()) return bad(res, 'Model AI belum dikonfigurasi (Pengaturan → Webhook & Setup).', 409);
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).slice(0, 8);
    const out = [];
    for (const id of ids) {
      const o = get("SELECT * FROM opps WHERE id=? AND status IN ('new','failed','drafted')", id); if (!o) continue;
      const b = brandOr404(o.brand_id);
      try {
        const rule = A_.ruleOf(o.brand_id, 'threads');
        const d = await AI.oppReply(b, { username: o.username, text: o.text, keyword: o.keyword, knowledge: rule.knowledge, maxChars: 280 });
        const draft = String(d.reply || '').trim(); const fit = Number(d.fit) || 0;
        const bad_ = A_.unsafeReason(draft, rule.knowledge, 280);
        if (fit < 0.6 || !draft) run("UPDATE opps SET status='skipped', note=?, updated_at=? WHERE id=?", `Kurang relevan (fit ${fit.toFixed(2)}): ${String(d.reason || '').slice(0, 160)}`, now(), id);
        else if (bad_ || /https?:\/\/|www\./i.test(draft)) run("UPDATE opps SET status='skipped', note=?, updated_at=? WHERE id=?", `Draf tidak aman: ${bad_ || 'memuat tautan'}`, now(), id);
        else run("UPDATE opps SET status='drafted', draft=?, note=?, updated_at=? WHERE id=?", draft, `fit ${fit.toFixed(2)}: ${String(d.reason || '').slice(0, 160)}`, now(), id);
      } catch (e) { run("UPDATE opps SET note=?, updated_at=? WHERE id=?", `Gagal membuat draf: ${String(e.message).slice(0, 160)}`, now(), id); }
      out.push(get('SELECT * FROM opps WHERE id=?', id));
    }
    res.json(out);
  }));

  // Kirim satu peluang: batas harian dan jeda minimum antar kiriman per akun.
  async function sendOpp(id, text, userId) {
    const o = get('SELECT * FROM opps WHERE id=?', id);
    if (!o || !['drafted', 'new', 'failed'].includes(o.status)) return { ok: false, msg: 'Status tidak memungkinkan.' };
    const t = String(text ?? o.draft ?? '').trim();
    if (!t) return { ok: false, msg: 'Teks balasan kosong.' };
    if ([...t].length > 500) return { ok: false, msg: 'Balasan melebihi 500 karakter.' };
    if (/https?:\/\/|www\./i.test(t)) return { ok: false, msg: 'Balasan ke post orang lain tidak boleh memuat tautan.' };
    if (sentToday(o.brand_id) >= cap()) return { ok: false, msg: `Batas ${cap()} balasan peluang per 24 jam untuk akun ini tercapai.` };
    const last = get("SELECT updated_at FROM opps WHERE brand_id=? AND status='sent' ORDER BY updated_at DESC LIMIT 1", o.brand_id);
    if (last && Date.now() - Date.parse(last.updated_at) < 120e3) return { ok: false, msg: 'Beri jeda minimal 2 menit antar balasan peluang.' };
    const b = brandOr404(o.brand_id);
    try {
      const r = await T.replyTo(b, o.ext_id, t);
      run("UPDATE opps SET status='sent', draft=?, sent_id=?, decided_by=?, error=NULL, updated_at=? WHERE id=?", t, String(r.mediaId || ''), userId, now(), id);
      audit(userId, 'opps.sent', { id, brand: o.brand_id, dryRun: !!r.dryRun });
      return { ok: true };
    } catch (e) { run("UPDATE opps SET status='failed', error=?, updated_at=? WHERE id=?", String(e.message).slice(0, 300), now(), id); return { ok: false, msg: String(e.message).slice(0, 160) }; }
  }
  api.post('/opps/:id/send', need('editor'), humanOnly, ah(async (req, res) => {
    const r = await sendOpp(req.params.id, req.body?.text, req.user.id);
    return r.ok ? res.json(get('SELECT * FROM opps WHERE id=?', req.params.id)) : bad(res, r.msg, 409);
  }));
  api.post('/opps/:id/skip', need('editor'), humanOnly, (req, res) => {
    run("UPDATE opps SET status='skipped', decided_by=?, updated_at=? WHERE id=? AND status IN ('new','drafted','failed')", req.user.id, now(), req.params.id);
    res.json({ ok: true });
  });
  api.put('/opps/:id', need('editor'), humanOnly, (req, res) => {
    const t = String(req.body?.draft || '').trim().slice(0, 500);
    run("UPDATE opps SET draft=?, status=CASE WHEN ?<>'' THEN 'drafted' ELSE status END, updated_at=? WHERE id=? AND status IN ('new','drafted','failed')", t, t, now(), req.params.id);
    res.json(get('SELECT * FROM opps WHERE id=?', req.params.id));
  });

  /* ---------------- Pusat persetujuan massal ---------------- */
  // Kebutuhan gambar/ilustrasi: Instagram selalu wajib; Threads opsional, tetapi teks bisa menandai butuh foto/ilustrasi.
  const HINT = /\[(?:foto|gambar|visual|ilustrasi|video|image|photo)[^\]]*\]|\((?:foto|gambar|visual|ilustrasi)\s*:[^)]*\)|\b(?:ilustrasi|foto produk|lampirkan (?:foto|gambar)|tambahkan (?:foto|gambar)|sertakan (?:foto|gambar))\b/i;
  const visualOf = (igKind, text, urls) => {
    const have = urls.length; const hint = String(text || '').match(HINT)?.[0] || null;
    const need = igKind ? 'wajib' : hint ? 'disarankan' : 'opsional';
    return { need, have, hint, missing: have === 0 && need !== 'opsional' };
  };
  api.get('/approvals', need('editor'), (req, res) => {
    const m = RANK[req.user.role] >= RANK.manager;
    const j = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };
    const posts = m ? all("SELECT id,brand_id,text,media_urls,scheduled_at,created_by,updated_at FROM posts WHERE status='pending_approval' ORDER BY scheduled_at IS NULL, scheduled_at, updated_at").map((p) => ({ ...p, media_urls: j(p.media_urls) })) : [];
    const igposts = m ? all("SELECT id,brand_id,kind,caption AS text,media_urls,scheduled_at,created_by,updated_at FROM ig_posts WHERE status='pending_approval' ORDER BY scheduled_at IS NULL, scheduled_at, updated_at").map((p) => ({ ...p, media_urls: j(p.media_urls) })) : [];
    const events = all("SELECT id,platform,brand_id,kind,author_username,text,draft,dm_text,category,needs_human,note,simulated,received_at FROM auto_events WHERE status='pending' ORDER BY needs_human, received_at DESC LIMIT 200").map((e) => ({ ...e, needs_human: !!e.needs_human, simulated: !!e.simulated }));
    const opps = all("SELECT id,brand_id,keyword,username,text,permalink,draft,note,created_at FROM opps WHERE status='drafted' ORDER BY created_at DESC LIMIT 100");
    res.json({ posts: posts.map((p) => ({ ...p, visual: visualOf(null, p.text, p.media_urls) })), igposts: igposts.map((p) => ({ ...p, visual: visualOf(p.kind || 'feed', p.text, p.media_urls) })), events, opps, counts: { posts: posts.length, igposts: igposts.length, events: events.length, opps: opps.length }, can_posts: m });
  });

  api.post('/approvals/bulk', need('editor'), humanOnly, ah(async (req, res) => {
    const action = req.body?.action === 'reject' ? 'reject' : req.body?.action === 'approve' ? 'approve' : null;
    if (!action) return bad(res, 'Aksi harus approve atau reject.');
    const items = (Array.isArray(req.body?.items) ? req.body.items : []).filter((i) => i && ['post', 'igpost', 'event', 'opp'].includes(i.type) && i.id).slice(0, 50);
    if (!items.length) return bad(res, 'Pilih minimal satu item.');
    const when = req.body?.scheduled_at ? new Date(req.body.scheduled_at) : null;
    if (when && Number.isNaN(when.getTime())) return bad(res, 'Jadwal tidak valid.');
    const step = Math.min(7 * 1440, Math.max(0, Number(req.body?.interval_minutes) || 0)) * 60_000;
    let slot = when ? when.getTime() : null;
    const note = String(req.body?.note || '').slice(0, 300) || null;
    const isMgr = RANK[req.user.role] >= RANK.manager;
    const results = []; let sentAny = false;
    for (const it of items) {
      const r = { type: it.type, id: it.id, ok: false, msg: '' };
      try {
        if ((it.type === 'post' || it.type === 'igpost') && !isMgr) r.msg = 'Butuh peran manager.';
        else if (it.type === 'post' || it.type === 'igpost') {
          const tbl = it.type === 'post' ? 'posts' : 'ig_posts';
          const p = get(`SELECT * FROM ${tbl} WHERE id=?`, it.id);
          if (!p) r.msg = 'Tidak ditemukan.';
          else if (action === 'approve') {
            if (p.status !== 'pending_approval') r.msg = `Berstatus ${p.status}.`;
            else if (it.type === 'igpost' && !JSON.parse(p.media_urls || '[]').length) r.msg = 'Belum ada gambar/video (wajib untuk Instagram). Lampirkan dulu di menu Instagram.';
            else {
              let at = p.scheduled_at;
              if (!at && slot !== null) { at = new Date(slot).toISOString(); slot += step; }
              if (!at) r.msg = 'Belum ada jadwal; isi "Jadwalkan yang belum bertanggal ke".';
              else { run(`UPDATE ${tbl} SET status='scheduled', scheduled_at=?, approved_by=?, error=NULL, updated_at=? WHERE id=? AND status='pending_approval'`, at, req.user.id, now(), p.id); audit(req.user.id, it.type === 'post' ? 'post.approved' : 'ig.post.approved', { id: p.id, bulk: true }); r.ok = true; r.msg = `Dijadwalkan ${at}`; }
            }
          } else if (p.status !== 'pending_approval') r.msg = `Berstatus ${p.status}.`;
          else { run(`UPDATE ${tbl} SET status='draft', review_note=?, updated_at=? WHERE id=?`, note, now(), p.id); audit(req.user.id, it.type === 'post' ? 'post.rejected' : 'ig.post.rejected', { id: p.id, bulk: true }); r.ok = true; r.msg = 'Dikembalikan ke draft.'; }
        } else if (it.type === 'event') {
          const e = get('SELECT * FROM auto_events WHERE id=?', it.id);
          if (!e) r.msg = 'Tidak ditemukan.';
          else if (e.status !== 'pending') r.msg = `Berstatus ${e.status}.`;
          else if (action === 'reject') { r.ok = A_.reject(e.id, req.user.id); r.msg = r.ok ? 'Ditolak.' : 'Gagal.'; }
          else {
            const text = String(e.draft || '').trim();
            if (!text && !e.dm_text) r.msg = 'Draf kosong.';
            else { if (sentAny) await sleep(400); const out = await A_.send(e.id, text, req.user.id); sentAny = true; r.ok = out.status === 'sent'; r.msg = r.ok ? 'Terkirim.' : (out.error || 'Gagal kirim.'); }
          }
        } else if (it.type === 'opp') {
          if (action === 'reject') { run("UPDATE opps SET status='skipped', decided_by=?, updated_at=? WHERE id=? AND status IN ('new','drafted','failed')", req.user.id, now(), it.id); r.ok = true; r.msg = 'Dilewati.'; }
          else { const o = await sendOpp(it.id, undefined, req.user.id); r.ok = o.ok; r.msg = o.ok ? 'Terkirim.' : o.msg; }
        }
      } catch (e) { r.msg = String(e.message).slice(0, 160); }
      results.push(r);
    }
    A(req, 'approvals.bulk', { action, total: items.length, ok: results.filter((x) => x.ok).length });
    res.json({ results, ok: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length });
  }));
}
