// WhatsApp Business: pengaturan nomor per brand, percakapan, kirim teks (dalam 24 jam) dan template.
import * as W from './whatsapp.js';
import * as A_ from './autoreply.js';
import { all, get, now } from './db.js';

export function mountWhatsApp(api, { need, ah, bad, A, humanOnly, brandOr404 }) {
  api.get('/wa/config', need('viewer'), (req, res) => {
    const admin = req.user.role === 'admin';
    res.json({
      simulated: W.isDryRun(), webhook_url: A_.webhookUrl('whatsapp'), verify_token: admin ? A_.verifyToken() : undefined,
      fields: ['messages'],
      brands: all('SELECT id,name,color FROM brands ORDER BY sort').map((b) => ({ ...b, number: W.publicNumber(W.numberOf(b.id)) })),
    });
  });
  api.put('/wa/numbers/:brand', need('admin'), humanOnly, (req, res) => {
    if (!brandOr404(req.params.brand)) return bad(res, 'Brand tidak ditemukan.', 404);
    try {
      const n = W.saveNumber(req.params.brand, req.body || {});
      A(req, 'wa.number.saved', { brand: req.params.brand });
      res.json(W.publicNumber(n));
    } catch (e) { bad(res, e.message); }
  });
  api.delete('/wa/numbers/:brand', need('admin'), humanOnly, (req, res) => {
    if (!W.removeNumber(req.params.brand)) return bad(res, 'Nomor tidak ditemukan.', 404);
    A(req, 'wa.number.removed', { brand: req.params.brand }); res.json({ ok: true });
  });
  api.post('/wa/numbers/:brand/test', need('admin'), humanOnly, ah(async (req, res) => {
    if (!W.numberOf(req.params.brand) && !W.isDryRun()) return bad(res, 'Nomor belum disimpan.', 409);
    try { res.json(await W.testNumber(req.params.brand)); } catch (e) { bad(res, `Gagal: ${e.message}`, 502); }
  }));

  // Daftar percakapan: dikelompokkan per pelanggan dari event webhook + pesan keluar dari Hub.
  api.get('/wa/conversations', need('editor'), (req, res) => {
    const brand = req.query.brand ? String(req.query.brand) : null;
    const inb = all(`SELECT brand_id, author_id AS wa_id, MAX(author_username) AS name, COUNT(*) AS n, MAX(received_at) AS last_in FROM auto_events WHERE platform='whatsapp' ${brand ? 'AND brand_id=?' : ''} GROUP BY brand_id, author_id`, ...(brand ? [brand] : []));
    const out = inb.map((c) => {
      const last = get("SELECT text, status FROM auto_events WHERE platform='whatsapp' AND brand_id=? AND author_id=? ORDER BY received_at DESC LIMIT 1", c.brand_id, c.wa_id);
      const open = get("SELECT COUNT(*) AS n FROM auto_events WHERE platform='whatsapp' AND brand_id=? AND author_id=? AND status IN ('pending','failed')", c.brand_id, c.wa_id).n;
      return { ...c, last_text: last?.text || '', needs_action: open, can_reply: W.windowOpen(c.brand_id, c.wa_id) };
    }).sort((a, b) => String(b.last_in).localeCompare(String(a.last_in))).slice(0, 100);
    res.json(out);
  });
  api.get('/wa/conversations/:brand/:wa', need('editor'), (req, res) => {
    const { brand, wa } = req.params;
    const msgs = [];
    for (const e of all("SELECT * FROM auto_events WHERE platform='whatsapp' AND brand_id=? AND author_id=? ORDER BY received_at LIMIT 200", brand, wa)) {
      msgs.push({ dir: 'in', text: e.text, at: e.received_at, event_id: e.id, status: e.status, draft: e.draft, note: e.note });
      if (e.status === 'sent' && e.reply_text) msgs.push({ dir: 'out', text: e.reply_text, at: e.updated_at, auto: !e.decided_by });
    }
    for (const o of all('SELECT * FROM wa_out WHERE brand_id=? AND to_id=? ORDER BY created_at LIMIT 200', brand, wa)) msgs.push({ dir: 'out', text: o.kind === 'template' ? `[Template ${o.template}] ${o.text}` : o.text, at: o.created_at, manual: true });
    msgs.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    res.json({ messages: msgs, can_reply: W.windowOpen(brand, wa) });
  });

  api.post('/wa/send', need('editor'), humanOnly, ah(async (req, res) => {
    const b = brandOr404(String(req.body?.brand_id || '')); if (!b) return bad(res, 'Brand tidak ditemukan.', 404);
    const to = W.digits(req.body?.to); const text = String(req.body?.text || '').trim();
    if (to.length < 8 || to.length > 15) return bad(res, 'Nomor tujuan tidak valid (format internasional tanpa +, mis. 62812...).');
    if (!text) return bad(res, 'Isi pesan kosong.');
    if ([...text].length > 1000) return bad(res, 'Pesan terlalu panjang (maks 1000 karakter).');
    if (!W.numberOf(b.id)?.token_enc && !W.isDryRun()) return bad(res, 'Nomor WhatsApp brand ini belum terhubung.', 409);
    if (!W.windowOpen(b.id, to)) return bad(res, 'Di luar jendela 24 jam sejak pesan terakhir pelanggan. Kirim lewat Template yang disetujui.', 409);
    try {
      const r = await W.sendText(b, to, text);
      W.recordOut(b.id, to, { text, waId: r.id, userId: req.user.id, simulated: !!r.dryRun });
      A(req, 'wa.sent', { brand: b.id, dryRun: !!r.dryRun });
      res.json({ ok: true, id: r.id, dryRun: !!r.dryRun });
    } catch (e) { bad(res, e.message, 502); }
  }));
  api.get('/wa/:brand/templates', need('editor'), ah(async (req, res) => {
    const b = brandOr404(req.params.brand); if (!b) return bad(res, 'Brand tidak ditemukan.', 404);
    try { res.json(await W.listTemplates(b)); } catch (e) { bad(res, e.message, 502); }
  }));
  api.post('/wa/send-template', need('manager'), humanOnly, ah(async (req, res) => {
    const b = brandOr404(String(req.body?.brand_id || '')); if (!b) return bad(res, 'Brand tidak ditemukan.', 404);
    const to = W.digits(req.body?.to); const name = String(req.body?.name || '').trim(); const language = String(req.body?.language || 'id').trim();
    const params = (Array.isArray(req.body?.params) ? req.body.params : []).map((x) => String(x).trim()).slice(0, 10);
    if (to.length < 8 || to.length > 15) return bad(res, 'Nomor tujuan tidak valid.');
    if (!/^[a-z0-9_]{1,512}$/.test(name) || !/^[a-zA-Z_]{2,10}$/.test(language)) return bad(res, 'Nama/bahasa template tidak valid.');
    if (params.some((p) => !p)) return bad(res, 'Semua variabel template harus diisi.');
    if (!W.numberOf(b.id)?.token_enc && !W.isDryRun()) return bad(res, 'Nomor WhatsApp brand ini belum terhubung.', 409);
    try {
      const r = await W.sendTemplate(b, to, { name, language, params });
      W.recordOut(b.id, to, { kind: 'template', template: name, text: params.join(' | '), waId: r.id, userId: req.user.id, simulated: !!r.dryRun });
      A(req, 'wa.template.sent', { brand: b.id, template: name, dryRun: !!r.dryRun });
      res.json({ ok: true, id: r.id, dryRun: !!r.dryRun, at: now() });
    } catch (e) { bad(res, e.message, 502); }
  }));
}
