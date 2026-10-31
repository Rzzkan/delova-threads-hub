// REST untuk Pengetahuan brand (daftar butir): lihat, tambah, ubah, aktif/nonaktif, hapus.
import * as K from './knowledge.js';
import { get } from './db.js';

export function mountKnowledge(api, { need, bad, A, humanOnly, brandOr404, gate }) {
  const view = (b) => ({ brand: b.id, name: b.name, categories: K.CATS, platforms: K.PLATS, max: K.MAX, usage: K.usage(b.id), items: K.list(b.id) });
  api.get('/knowledge/:brand', need('viewer'), (req, res) => {
    const b = brandOr404(req.params.brand); if (!b) return bad(res, 'Brand tidak ditemukan.', 404);
    res.json(view(b));
  });
  api.post('/knowledge/delete', need('manager'), humanOnly, (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 200) : [];
    if (!ids.length) return bad(res, 'Pilih butir yang dihapus.');
    const n = K.remove(ids); A(req, 'knowledge.delete', { count: n }); res.json({ deleted: n });
  });
  api.post('/knowledge/:brand', need('manager'), gate('claude_knowledge'), (req, res) => {
    const b = brandOr404(req.params.brand); if (!b) return bad(res, 'Brand tidak ditemukan.', 404);
    const f = req.body || {};
    const facts = Array.isArray(f.facts) ? f.facts.map(String) : (f.text ? [String(f.text)] : []);
    if (!facts.length || facts.length > 30) return bad(res, 'Kirim 1-30 butir pengetahuan.');
    try {
      const r = K.add(b.id, facts, { category: f.category, platforms: f.platforms, expires_at: f.expires_at, source: req.claude ? 'claude' : 'dashboard', userId: req.user.id });
      if (!r.added.length && r.skipped.length && !r.skipped.some((x) => /Sudah/.test(x.reason))) return bad(res, r.skipped[0].reason);
      A(req, 'knowledge.add', { brand: b.id, added: r.added.length, skipped: r.skipped.length });
      res.json({ ...r, usage: K.usage(b.id) });
    } catch (e) { bad(res, e.message); }
  });
  api.patch('/knowledge/item/:id', need('manager'), gate('claude_knowledge'), (req, res) => {
    const cur = get('SELECT brand_id FROM brand_knowledge WHERE id=?', req.params.id); if (!cur) return bad(res, 'Butir tidak ditemukan.', 404);
    try {
      const item = K.update(req.params.id, req.body || {});
      A(req, 'knowledge.update', { brand: cur.brand_id, id: req.params.id, fields: Object.keys(req.body || {}) });
      res.json({ item, usage: K.usage(cur.brand_id) });
    } catch (e) { bad(res, e.message); }
  });
}
