// Aturan keyword: balas otomatis / kirim DM bila komentar atau reply memuat kata kunci tertentu di post kita sendiri.
import { all, get, run, now, uid } from './db.js';

export const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Kata kunci cocok bila muncul sebagai kata/frasa utuh (bukan potongan kata lain). */
export const hasKeyword = (text, kw) => { const k = norm(kw); return !!k && new RegExp(`(?<![\\p{L}\\p{N}])${esc(k)}(?![\\p{L}\\p{N}])`, 'u').test(norm(text)); };
export const matches = (t, text) => {
  const kws = t.keywords || [];
  if (!kws.length) return false;
  return t.match_mode === 'all' ? kws.every((k) => hasKeyword(text, k)) : kws.some((k) => hasKeyword(text, k));
};
const row = (r) => r && ({ ...r, keywords: JSON.parse(r.keywords || '[]'), enabled: !!r.enabled });
export const list = (brand) => all(`SELECT * FROM kw_triggers ${brand ? 'WHERE brand_id=?' : ''} ORDER BY created_at DESC`, ...(brand ? [brand] : [])).map(row);
export const byId = (id) => row(get('SELECT * FROM kw_triggers WHERE id=?', id));

/** Variasi balasan dipisah baris "---"; dipilih stabil berdasarkan id event agar tidak berulang-ulang sama. */
export function render(template, { username, seed = '' }) {
  const v = String(template || '').split(/\n\s*-{3,}\s*\n/).map((x) => x.trim()).filter(Boolean);
  if (!v.length) return '';
  let h = 0; for (const c of String(seed)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return v[h % v.length].replaceAll('{nama}', username ? `@${String(username).replace(/^@/, '')}` : 'Kak');
}

export function validate(f, platform) {
  const keywords = [...new Set((Array.isArray(f.keywords) ? f.keywords : String(f.keywords || '').split(/[\n,]/)).map((k) => String(k).trim()).filter((k) => k.length >= 2 && k.length <= 60))].slice(0, 20);
  if (!String(f.name || '').trim()) return { error: 'Beri nama aturan.' };
  if (!keywords.length) return { error: 'Isi minimal satu kata kunci (2 karakter atau lebih).' };
  const reply_text = String(f.reply_text || '').trim().slice(0, 2000);
  const dm_text = platform === 'instagram' ? String(f.dm_text || '').trim().slice(0, 1000) : '';
  if (!reply_text && !dm_text) return { error: 'Isi balasan publik, atau pesan DM (khusus Instagram).' };
  const max = platform === 'threads' ? 500 : 2200;
  for (const v of reply_text.split(/\n\s*-{3,}\s*\n/)) if ([...v].length > max) return { error: `Satu variasi balasan melebihi ${max} karakter.` };
  return { value: { name: String(f.name).trim().slice(0, 80), keywords, match_mode: f.match_mode === 'all' ? 'all' : 'any', media_id: String(f.media_id || '').trim().slice(0, 80) || null, reply_text, dm_text, cooldown_h: Math.min(720, Math.max(0, Number(f.cooldown_h ?? 24) || 0)) } };
}
export function save(id, brand_id, platform, v, { mode, enabled, userId }) {
  const t = now();
  if (id) run('UPDATE kw_triggers SET name=?,keywords=?,match_mode=?,media_id=?,reply_text=?,dm_text=?,cooldown_h=?,mode=?,enabled=?,updated_at=? WHERE id=?', v.name, JSON.stringify(v.keywords), v.match_mode, v.media_id, v.reply_text, v.dm_text, v.cooldown_h, mode, enabled ? 1 : 0, t, id);
  else { id = uid(); run('INSERT INTO kw_triggers(id,brand_id,platform,name,keywords,match_mode,media_id,reply_text,dm_text,mode,cooldown_h,enabled,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, brand_id, platform, v.name, JSON.stringify(v.keywords), v.match_mode, v.media_id, v.reply_text, v.dm_text, mode, v.cooldown_h, enabled ? 1 : 0, userId, t, t); }
  return byId(id);
}
export const remove = (id) => run('DELETE FROM kw_triggers WHERE id=?', id).changes > 0;

/** Cari aturan pertama yang cocok untuk event (komentar/reply/mention; bukan DM). */
export function find(ev) {
  if (!['comment', 'reply', 'mention'].includes(ev.kind)) return null;
  return list(ev.brand_id).filter((t) => t.enabled && t.platform === ev.platform && (!t.media_id || t.media_id === ev.media_id) && matches(t, ev.text)).sort((a, b) => (b.media_id ? 1 : 0) - (a.media_id ? 1 : 0))[0] || null;
}
/** Penulis yang sama tidak dibalas lagi oleh aturan yang sama dalam masa jeda. */
export function inCooldown(t, ev) {
  if (!t.cooldown_h) return false;
  const since = new Date(Date.now() - t.cooldown_h * 3600e3).toISOString();
  const who = ev.author_id || ev.author_username; if (!who) return false;
  return !!get("SELECT 1 AS x FROM auto_events WHERE trigger_id=? AND id<>? AND (author_id=? OR author_username=?) AND status IN ('sent','pending','sending','approved') AND received_at>? LIMIT 1", t.id, ev.id, ev.author_id || '', ev.author_username || '', since);
}
