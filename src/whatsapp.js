// WhatsApp Business (Cloud API): kirim teks/template, daftar template, parsing webhook.
import { all, get, run, now, uid } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { modeSetting } from './threads.js';

const V = 'https://graph.facebook.com/v23.0';
export class WaError extends Error { constructor(m, detail) { super(m); this.detail = detail; } }
/** Simulasi bila saklar mode = sim, atau mode auto dengan THREADS_DRY_RUN. Token yang kosong baru gagal saat dipakai. */
export const isDryRun = () => { const m = modeSetting(); return m === 'sim' || (m === 'auto' && process.env.THREADS_DRY_RUN === 'true'); };
export const numberOf = (brandId) => get('SELECT * FROM wa_numbers WHERE brand_id=?', brandId);
export const numberByPhoneId = (pid) => get('SELECT * FROM wa_numbers WHERE phone_number_id=?', String(pid));
const tokenOf = (n) => {
  if (!n?.token_enc) throw new WaError('Nomor WhatsApp belum terhubung (token belum diisi).');
  try { return decrypt(n.token_enc); } catch { throw new WaError('Token WhatsApp tidak terbaca (APP_SECRET berubah). Isi ulang token.'); }
};
export const digits = (s) => String(s || '').replace(/\D/g, '');

async function call(method, path, token, body) {
  const r = await fetch(`${V}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new WaError(j.error?.error_user_msg || j.error?.message || `WhatsApp API HTTP ${r.status}`, j.error);
  return j;
}

export function saveNumber(brandId, f) {
  const cur = numberOf(brandId);
  const pid = digits(f.phone_number_id) || cur?.phone_number_id;
  if (!pid) throw new WaError('Phone number ID wajib diisi (angka dari WhatsApp Manager).');
  const token = String(f.token || '').trim();
  const enc = token ? encrypt(token) : cur?.token_enc || null;
  const other = numberByPhoneId(pid);
  if (other && other.brand_id !== brandId) throw new WaError('Phone number ID itu sudah dipakai brand lain.');
  run(`INSERT INTO wa_numbers(brand_id,phone_number_id,waba_id,display_phone,token_enc,connected_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(brand_id) DO UPDATE SET phone_number_id=excluded.phone_number_id, waba_id=excluded.waba_id, display_phone=excluded.display_phone, token_enc=excluded.token_enc`,
    brandId, pid, digits(f.waba_id) || cur?.waba_id || null, String(f.display_phone ?? cur?.display_phone ?? '').slice(0, 30) || null, enc, cur?.connected_at || now());
  return numberOf(brandId);
}
export const removeNumber = (brandId) => run('DELETE FROM wa_numbers WHERE brand_id=?', brandId).changes > 0;
export const publicNumber = (n) => n && { phone_number_id: n.phone_number_id, waba_id: n.waba_id, display_phone: n.display_phone, has_token: !!n.token_enc, connected_at: n.connected_at };

export async function testNumber(brandId) {
  if (isDryRun()) return { ok: true, dryRun: true, verified_name: 'Simulasi', display_phone_number: '+62 812-0000-0000', quality_rating: 'GREEN' };
  const n = numberOf(brandId);
  const r = await call('GET', `/${n.phone_number_id}?fields=verified_name,display_phone_number,quality_rating`, tokenOf(n));
  return { ok: true, ...r };
}

/** Teks bebas: hanya boleh dalam 24 jam setelah pesan terakhir pelanggan. */
export async function sendText(brand, to, text) {
  const dest = digits(to);
  if (!dest) throw new WaError('Nomor tujuan tidak valid.');
  if (isDryRun()) return { id: `wadry_${Date.now()}`, dryRun: true };
  const n = numberOf(brand.id);
  const r = await call('POST', `/${n.phone_number_id}/messages`, tokenOf(n), { messaging_product: 'whatsapp', recipient_type: 'individual', to: dest, type: 'text', text: { body: text, preview_url: false } });
  return { id: r.messages?.[0]?.id || '' };
}
export async function sendTemplate(brand, to, { name, language, params = [] }) {
  const dest = digits(to);
  if (!dest) throw new WaError('Nomor tujuan tidak valid.');
  if (isDryRun()) return { id: `wadry_${Date.now()}`, dryRun: true };
  const n = numberOf(brand.id);
  const components = params.length ? [{ type: 'body', parameters: params.map((t) => ({ type: 'text', text: String(t).slice(0, 1000) })) }] : undefined;
  const r = await call('POST', `/${n.phone_number_id}/messages`, tokenOf(n), { messaging_product: 'whatsapp', to: dest, type: 'template', template: { name, language: { code: language }, ...(components ? { components } : {}) } });
  return { id: r.messages?.[0]?.id || '' };
}
export async function markRead(brand, messageId) {
  if (isDryRun()) return;
  const n = numberOf(brand.id); if (!n?.token_enc) return;
  try { await call('POST', `/${n.phone_number_id}/messages`, tokenOf(n), { messaging_product: 'whatsapp', status: 'read', message_id: messageId }); } catch { /* opsional */ }
}
export async function listTemplates(brand) {
  if (isDryRun()) return [
    { name: 'konfirmasi_pesanan', language: 'id', status: 'APPROVED', category: 'UTILITY', body: 'Halo {{1}}, pesanan {{2}} sudah kami terima dan sedang diproses. Terima kasih sudah belanja di Delova!', params: 2 },
    { name: 'info_restock', language: 'id', status: 'APPROVED', category: 'MARKETING', body: 'Halo {{1}}, kebaya favoritmu sudah restock. Cek sekarang sebelum kehabisan!', params: 1 },
    { name: 'tindak_lanjut_chat', language: 'id', status: 'PENDING', category: 'UTILITY', body: 'Halo {{1}}, kami menindaklanjuti pertanyaan Kakak sebelumnya.', params: 1 },
  ];
  const n = numberOf(brand.id);
  if (!n?.waba_id) throw new WaError('WABA ID belum diisi untuk brand ini.');
  const r = await call('GET', `/${n.waba_id}/message_templates?fields=name,language,status,category,components&limit=100`, tokenOf(n));
  return (r.data || []).map((t) => { const body = (t.components || []).find((c) => c.type === 'BODY')?.text || ''; return { name: t.name, language: t.language, status: t.status, category: t.category, body, params: new Set(body.match(/\{\{\d+\}\}/g) || []).size }; });
}

/** Pelanggan boleh dibalas teks bebas bila pesan masuk terakhirnya < 24 jam. */
export function windowOpen(brandId, waId) {
  const last = get("SELECT received_at FROM auto_events WHERE platform='whatsapp' AND brand_id=? AND author_id=? ORDER BY received_at DESC LIMIT 1", brandId, String(waId));
  return !!last && Date.now() - Date.parse(last.received_at) < 24 * 3600e3;
}
export function recordOut(brandId, to, { kind = 'text', text = '', template = null, waId = '', userId = null, simulated = false }) {
  run('INSERT INTO wa_out(id,brand_id,to_id,kind,text,template,wa_msg_id,sent_by,simulated,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', uid(), brandId, digits(to), kind, text, template, waId, userId, simulated ? 1 : 0, now());
}
export const allNumbers = () => all('SELECT * FROM wa_numbers');
