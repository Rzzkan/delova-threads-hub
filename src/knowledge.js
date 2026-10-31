// Pengetahuan brand sebagai daftar butir (database): ditambah, diedit, dinonaktifkan, dihapus satu per satu.
// Dibaca Auto Reply lewat composeFor(): hanya butir aktif, belum kedaluwarsa, dan berlaku untuk platform terkait.
import { all, get, run, now, uid, getSetting, setSetting } from './db.js';

export const CATS = { kebijakan: 'Kebijakan & retur', pengiriman: 'Pengiriman', ukuran: 'Ukuran & produk', order: 'Cara order', promo: 'Promo', faq: 'FAQ', sapaan: 'Admin & sapaan', lainnya: 'Lainnya' };
export const PLATS = ['threads', 'instagram', 'whatsapp'];
export const MAX = 6000;
const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().replace(/^[-•*]\s*/, '');
const plats = (v) => [...new Set((Array.isArray(v) ? v : []).filter((p) => PLATS.includes(p)))];
const covers = (e, p) => !e.platforms.length || e.platforms.includes(p);
const parse = (r) => ({ ...r, active: !!r.active, platforms: JSON.parse(r.platforms || '[]') });

export const list = (brandId) => all('SELECT * FROM brand_knowledge WHERE brand_id=? ORDER BY active DESC, category, created_at', brandId).map(parse);
const live = (brandId) => all('SELECT * FROM brand_knowledge WHERE brand_id=? AND active=1 AND (expires_at IS NULL OR expires_at>?) ORDER BY category, created_at', brandId, now()).map(parse);

export function composeFor(brandId, platform) {
  const rows = live(brandId).filter((e) => covers(e, platform));
  const out = []; let len = 0;
  for (const c of Object.keys(CATS)) {
    const mine = rows.filter((e) => e.category === c); if (!mine.length) continue;
    const block = [`${CATS[c].toUpperCase()}`];
    for (const e of mine) { if (len + e.text.length + 4 > MAX) break; block.push(`- ${e.text}`); len += e.text.length + 4; }
    if (block.length > 1) out.push(block.join('\n'));
  }
  return out.join('\n\n');
}
export const usage = (brandId) => Object.fromEntries(PLATS.map((p) => [p, composeFor(brandId, p).length]));
const overLimit = (brandId) => PLATS.filter((p) => live(brandId).filter((e) => covers(e, p)).reduce((n, e) => n + e.text.length + 4, 0) > MAX);

/** Tambah butir. Mengembalikan { added[], skipped[] } atau melempar bila melewati batas. */
export function add(brandId, facts, { category = 'lainnya', platforms = [], expires_at = null, source = 'dashboard', userId = null } = {}) {
  const cat = CATS[category] ? category : 'lainnya'; const pl = plats(platforms);
  const exp = expires_at ? new Date(expires_at) : null; if (exp && Number.isNaN(+exp)) throw new Error('Tanggal berakhir tidak valid.');
  const have = list(brandId); const added = []; const skipped = []; const ids = [];
  for (const raw of facts) {
    const t = clean(raw); const n = norm(t);
    if (t.length < 4 || t.length > 500) { skipped.push({ text: t.slice(0, 60), reason: 'Panjang harus 4-500 karakter.' }); continue; }
    const dup = have.find((e) => { const m = norm(e.text); return (m === n || m.includes(n) || n.includes(m)) && (!e.platforms.length || !pl.length || e.platforms.some((x) => pl.includes(x))); });
    if (dup) { skipped.push({ text: t.slice(0, 60), reason: dup.active ? 'Sudah ada.' : 'Sudah ada (nonaktif); aktifkan saja.' }); continue; }
    const id = uid(); const ts = now();
    run('INSERT INTO brand_knowledge(id,brand_id,text,category,platforms,active,expires_at,source,created_by,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?,?,?,?)', id, brandId, t, cat, JSON.stringify(pl), exp ? exp.toISOString() : null, source, userId, ts, ts);
    have.push(parse(get('SELECT * FROM brand_knowledge WHERE id=?', id))); ids.push(id); added.push({ id, text: t });
  }
  const over = overLimit(brandId);
  if (over.length) { for (const id of ids) run('DELETE FROM brand_knowledge WHERE id=?', id); throw new Error(`Melebihi ${MAX} karakter untuk ${over.join(', ')}. Hapus atau nonaktifkan butir lama dulu.`); }
  return { added, skipped };
}
export function update(id, f) {
  const cur = get('SELECT * FROM brand_knowledge WHERE id=?', id); if (!cur) return null;
  const sets = []; const args = [];
  if (f.text !== undefined) { const t = clean(f.text); if (t.length < 4 || t.length > 500) throw new Error('Isi 4-500 karakter.'); sets.push('text=?'); args.push(t); }
  if (f.category !== undefined) { if (!CATS[f.category]) throw new Error('Kategori tidak dikenal.'); sets.push('category=?'); args.push(f.category); }
  if (f.platforms !== undefined) { sets.push('platforms=?'); args.push(JSON.stringify(plats(f.platforms))); }
  if (f.active !== undefined) { sets.push('active=?'); args.push(f.active ? 1 : 0); }
  if (f.expires_at !== undefined) { const d = f.expires_at ? new Date(f.expires_at) : null; if (d && Number.isNaN(+d)) throw new Error('Tanggal berakhir tidak valid.'); sets.push('expires_at=?'); args.push(d ? d.toISOString() : null); }
  if (!sets.length) throw new Error('Tidak ada perubahan.');
  run(`UPDATE brand_knowledge SET ${sets.join(',')}, updated_at=? WHERE id=?`, ...args, now(), id);
  const over = overLimit(cur.brand_id);
  if (over.length && f.active !== false) { run('UPDATE brand_knowledge SET text=?,category=?,platforms=?,active=?,expires_at=?,updated_at=? WHERE id=?', cur.text, cur.category, cur.platforms, cur.active, cur.expires_at, cur.updated_at, id); throw new Error(`Melebihi ${MAX} karakter untuk ${over.join(', ')}.`); }
  return parse(get('SELECT * FROM brand_knowledge WHERE id=?', id));
}
export const remove = (ids) => ids.reduce((n, id) => n + run('DELETE FROM brand_knowledge WHERE id=?', id).changes, 0);

/** Sekali jalan: pindahkan teks Pengetahuan lama (per brand+platform) menjadi butir database. */
export function migrateLegacy() {
  if (getSetting('kn_migrated') === '1') return;
  const byBrand = {};
  for (const r of all("SELECT brand_id, platform, knowledge FROM auto_rules WHERE TRIM(knowledge)<>''")) {
    for (const line of r.knowledge.split('\n')) {
      const t = clean(line); if (t.length < 4 || /^contoh:?$/i.test(t)) continue;
      const m = (byBrand[r.brand_id] ||= new Map()); const k = norm(t);
      const e = m.get(k) || { text: t.slice(0, 500), platforms: new Set() }; e.platforms.add(r.platform); m.set(k, e);
    }
  }
  for (const [brand, m] of Object.entries(byBrand)) {
    for (const e of m.values()) {
      const all3 = e.platforms.size === PLATS.length; const ts = now();
      run('INSERT INTO brand_knowledge(id,brand_id,text,category,platforms,active,source,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?,?)', uid(), brand, e.text, 'lainnya', JSON.stringify(all3 ? [] : [...e.platforms]), 'migrasi', ts, ts);
    }
  }
  run("UPDATE auto_rules SET knowledge=''");
  setSetting('kn_migrated', '1');
}
migrateLegacy();
