/**
 * Webhook Meta (Threads + Instagram) dan auto reply berbasis LLM.
 * Alur: webhook (tanda tangan valid) → normalisasi → simpan (dedupe) → pemfilter → draf Claude →
 * mode "draft": menunggu persetujuan manusia | mode "auto": kirim hanya bila lolos semua pagar pengaman.
 */
import crypto from 'node:crypto';
import { all, get, run, now, uid, getSetting, setSetting, audit } from './db.js';
import * as T from './threads.js';
import * as I from './instagram.js';
import * as AI from './claude.js';
import * as C from './crypto.js';

export const KINDS = ['reply', 'mention', 'comment', 'dm'];
const MAX = { threads: { reply: 280, mention: 280 }, instagram: { comment: 300, mention: 300, dm: 800 } };
const maxChars = (platform, kind) => MAX[platform]?.[kind] || 280;
const MIN_CONFIDENCE = 0.75;
const SAFE_CATEGORIES = ['sapaan', 'pujian', 'pertanyaan_produk', 'pertanyaan_umum'];
// kata yang selalu butuh manusia, apa pun jawaban LLM
const SENSITIVE = /\b(refund|retur|pengembalian|komplain|complain|kecewa|penipu|tipu|scam|lapor|polisi|pengacara|somasi|rusak|cacat|salah kirim|belum sampai|nggak sampai|tidak sampai|cancel|batal|uang kembali|konsumen|ylki|viral|endorse|kolaborasi|collab|kerja ?sama|media partner|wartawan)\b/i;

let drafter = null; // dapat diganti saat uji; null = pakai Claude
export const setDrafter = (fn) => { drafter = fn || null; };
const draftWith = (brand, args) => (drafter ? drafter(brand, args) : AI.aiReply(brand, args));

/* ---------------- Pengaturan ---------------- */
export const enabled = () => getSetting('auto_enabled') === '1';
export function verifyToken() {
  let t = getSetting('webhook_verify_token');
  if (!t) { t = crypto.randomBytes(16).toString('hex'); setSetting('webhook_verify_token', t); }
  return t;
}
export const baseUrl = () => (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
export const webhookUrl = (platform) => `${baseUrl()}/webhooks/${platform}`;

export function ruleOf(brandId, platform) {
  const r = get('SELECT * FROM auto_rules WHERE brand_id=? AND platform=?', brandId, platform);
  return r ? { ...r, enabled: !!r.enabled, kinds: JSON.parse(r.kinds || '[]') }
    : { brand_id: brandId, platform, enabled: false, mode: 'draft', kinds: ['reply', 'mention', 'comment'], hourly_cap: 20, knowledge: '' };
}
export function saveRule(brandId, platform, f) {
  const cur = ruleOf(brandId, platform);
  const kinds = Array.isArray(f.kinds) ? f.kinds.filter((k) => KINDS.includes(k)) : cur.kinds;
  const cap = Math.min(200, Math.max(1, Number(f.hourly_cap ?? cur.hourly_cap) || 20));
  const rule = {
    enabled: f.enabled === undefined ? cur.enabled : !!f.enabled,
    mode: f.mode === 'auto' || f.mode === 'draft' ? f.mode : cur.mode,
    kinds, hourly_cap: cap, knowledge: String(f.knowledge ?? cur.knowledge).slice(0, 6000),
  };
  run(`INSERT INTO auto_rules(brand_id,platform,enabled,mode,kinds,hourly_cap,knowledge,updated_at) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(brand_id,platform) DO UPDATE SET enabled=excluded.enabled, mode=excluded.mode, kinds=excluded.kinds, hourly_cap=excluded.hourly_cap, knowledge=excluded.knowledge, updated_at=excluded.updated_at`,
    brandId, platform, rule.enabled ? 1 : 0, rule.mode, JSON.stringify(rule.kinds), rule.hourly_cap, rule.knowledge, now());
  return ruleOf(brandId, platform);
}

/* ---------------- Tanda tangan webhook ---------------- */
function secrets(platform) {
  const out = new Set();
  const add = (s) => { if (s) out.add(s); };
  if (platform === 'instagram') { add(I.creds().appSecret); add(T.creds().appSecret); }
  else { add(T.creds().appSecret); for (const b of all('SELECT * FROM brands')) add(T.creds(b).appSecret); }
  return [...out];
}
export function verifySignature(platform, rawBody, header) {
  const m = /^sha256=([0-9a-f]{64})$/i.exec(String(header || ''));
  if (!m || !rawBody) return false;
  const got = Buffer.from(m[1], 'hex');
  return secrets(platform).some((s) => {
    const exp = crypto.createHmac('sha256', s).update(rawBody).digest();
    return exp.length === got.length && crypto.timingSafeEqual(exp, got);
  });
}
export function verifyChallenge(q) {
  const tok = String(q['hub.verify_token'] || '');
  const mine = verifyToken();
  const ok = q['hub.mode'] === 'subscribe' && tok.length === mine.length && crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(mine));
  return ok ? String(q['hub.challenge'] ?? '') : null;
}

/* ---------------- Normalisasi payload ---------------- */
const iso = (t) => { const n = Number(t); const d = Number.isFinite(n) && n > 0 ? new Date(n < 1e12 ? n * 1000 : n) : new Date(t || Date.now()); return Number.isNaN(d.getTime()) ? now() : d.toISOString(); };

export function parseThreads(body) {
  const out = [];
  for (const en of body?.entry || []) {
    const brand = get('SELECT * FROM brands WHERE threads_user_id=?', String(en.id));
    if (!brand) continue;
    for (const ch of en.changes || []) {
      const kind = { replies: 'reply', mentions: 'mention' }[ch.field];
      const v = ch.value || {};
      if (!kind || !v.id) continue;
      out.push({ platform: 'threads', brand, kind, ext_id: String(v.id), target_id: String(v.id), media_id: String(v.replied_to?.id || v.root_post?.id || ''),
        author_id: String(v.owner?.id || v.user_id || ''), author_username: v.username || '', text: v.text || '', permalink: v.permalink || '', event_at: iso(v.timestamp || en.time) });
    }
  }
  return out;
}
export function parseInstagram(body) {
  const out = [];
  for (const en of body?.entry || []) {
    const acc = get('SELECT * FROM ig_accounts WHERE ig_user_id=?', String(en.id));
    const brand = acc && get('SELECT * FROM brands WHERE id=?', acc.brand_id);
    if (!brand) continue;
    for (const ch of en.changes || []) {
      const v = ch.value || {};
      if (ch.field === 'comments' && v.id) {
        out.push({ platform: 'instagram', brand, kind: 'comment', ext_id: String(v.id), target_id: String(v.parent_id || v.id), media_id: String(v.media?.id || ''),
          author_id: String(v.from?.id || ''), author_username: v.from?.username || '', text: v.text || '', permalink: '', event_at: iso(en.time) });
      } else if (ch.field === 'mentions' && v.comment_id) {
        out.push({ platform: 'instagram', brand, kind: 'mention', ext_id: String(v.comment_id), target_id: String(v.comment_id), media_id: String(v.media_id || ''),
          author_id: '', author_username: '', text: v.text || '', permalink: '', event_at: iso(en.time) });
      }
    }
    for (const m of en.messaging || []) {
      const mid = m.message?.mid;
      if (!mid) continue;
      out.push({ platform: 'instagram', brand, kind: 'dm', ext_id: String(mid), target_id: String(m.sender?.id || ''), media_id: '',
        author_id: String(m.sender?.id || ''), author_username: '', text: m.message?.text || '', permalink: '',
        is_echo: !!m.message?.is_echo, event_at: iso(m.timestamp || en.time) });
    }
  }
  return out;
}

/* ---------------- Simpan & proses ---------------- */
export function ingest(events, { simulated = false } = {}) {
  const ids = [];
  for (const e of events) {
    if (!e.target_id) continue;
    const id = uid();
    const r = run(`INSERT OR IGNORE INTO auto_events(id,platform,brand_id,kind,ext_id,target_id,media_id,author_id,author_username,text,permalink,simulated,status,received_at,updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, e.platform, e.brand.id, e.kind, e.ext_id, e.target_id, e.media_id || null, e.author_id || null, e.author_username || null, String(e.text).slice(0, 2000), e.permalink || null, simulated ? 1 : 0,
      e.is_echo ? 'ignored' : 'new', e.event_at || now(), now());
    if (r.changes) {
      if (e.is_echo) run("UPDATE auto_events SET note='Pesan keluar dari akun sendiri.' WHERE id=?", id);
      else ids.push(id);
    }
  }
  return ids;
}
const set = (id, f) => {
  const keys = Object.keys(f);
  run(`UPDATE auto_events SET ${keys.map((k) => `${k}=?`).join(',')}, updated_at=? WHERE id=?`, ...keys.map((k) => f[k]), now(), id);
};
const isSelf = (ev, brand) => {
  const u = String(ev.author_username || '').toLowerCase();
  if (u && [brand.username, I.accountOf(brand.id)?.username].filter(Boolean).some((x) => x.toLowerCase() === u)) return true;
  const own = [brand.threads_user_id, I.accountOf(brand.id)?.ig_user_id].filter(Boolean).map(String);
  return !!ev.author_id && own.includes(String(ev.author_id));
};
const isDry = (ev, brand) => !!ev.simulated || (ev.platform === 'threads' ? T.isDryRun(brand) : I.isDryRun());
const URL_RE = /(https?:\/\/|www\.)\S+|\b\S+\.(com|id|co|me|link|shop)\b\S*/gi;

/** Kembalikan alasan penolakan bila draf tidak aman untuk dikirim, atau null bila aman. */
export function unsafeReason(text, knowledge, limit) {
  if (!text || !text.trim()) return 'Draf kosong.';
  if ([...text].length > limit) return `Draf melebihi ${limit} karakter.`;
  const known = String(knowledge || '').toLowerCase();
  for (const u of text.match(URL_RE) || []) if (!known.includes(u.toLowerCase().replace(/[.,!?)]+$/, ''))) return `Draf memuat tautan yang tidak ada di pengetahuan brand (${u}).`;
  const squash = (x) => x.replace(/(?<=\d)[\s.-]+(?=\d)/g, '');
  if (/(?<!\d)(\+?62|0)8\d{8,11}(?!\d)/.test(squash(text)) && !/\d{8}/.test(squash(known))) return 'Draf memuat nomor telepon yang tidak ada di pengetahuan brand.';
  return null;
}

export async function processEvent(id) {
  if (!run("UPDATE auto_events SET status='processing', updated_at=? WHERE id=? AND status='new'", now(), id).changes) return get('SELECT * FROM auto_events WHERE id=?', id);
  const ev = get('SELECT * FROM auto_events WHERE id=?', id);
  const brand = get('SELECT * FROM brands WHERE id=?', ev.brand_id);
  try {
    const rule = ruleOf(ev.brand_id, ev.platform);
    if (!enabled()) return end(id, 'ignored', 'Auto reply dimatikan (saklar utama).');
    if (!rule.enabled) return end(id, 'ignored', 'Auto reply belum diaktifkan untuk akun ini.');
    if (!rule.kinds.includes(ev.kind)) return end(id, 'ignored', `Jenis "${ev.kind}" tidak diaktifkan.`);
    if (isSelf(ev, brand)) return end(id, 'ignored', 'Berasal dari akun brand sendiri.');
    if (!ev.text.trim()) return end(id, 'ignored', 'Tidak ada teks (hanya media/stiker).');
    if (ev.kind === 'dm' && Date.now() - Date.parse(ev.received_at) > 23.5 * 3600e3) return end(id, 'ignored', 'Di luar jendela balas 24 jam Instagram.');
    if (!drafter && !AI.replyAiEnabled()) return end(id, 'pending', 'Model AI belum dikonfigurasi (Auto Reply → Webhook & setup).', { needs_human: 1 });

    const cap = Number(getSetting('auto_llm_daily_cap')) || 300;
    if (get('SELECT COUNT(*) AS n FROM auto_events WHERE drafted_at>?', new Date(Date.now() - 86400e3).toISOString()).n >= cap) return end(id, 'pending', 'Batas draf LLM harian tercapai; tulis balasan manual.', { needs_human: 1 });

    let postText = '';
    try {
      if (ev.platform === 'threads' && ev.media_id) postText = await T.postText(brand, ev.media_id);
      if (ev.platform === 'instagram' && ev.media_id && ev.kind !== 'dm') postText = await I.mediaCaption(I.accountOf(brand.id), brand, ev.media_id);
    } catch { /* konteks opsional */ }

    const limit = maxChars(ev.platform, ev.kind);
    let d;
    try { d = await draftWith(brand, { platform: ev.platform, kind: ev.kind, username: ev.author_username, text: ev.text, postText, knowledge: rule.knowledge, maxChars: limit }); }
    catch (e) { return end(id, 'pending', `Gagal membuat draf: ${e.message}`.slice(0, 300), { needs_human: 1 }); }
    set(id, { drafted_at: now() });

    const action = ['reply', 'escalate', 'skip'].includes(d.action) ? d.action : 'escalate';
    const draft = String(d.reply || '').trim();
    const f = { category: String(d.category || '').slice(0, 40), draft };
    const reason = String(d.reason || '').slice(0, 300);
    if (action === 'skip') return end(id, 'skipped', reason || 'Tidak perlu dibalas.', f);

    let human = action === 'escalate' || SENSITIVE.test(ev.text) || !SAFE_CATEGORIES.includes(f.category) || !(Number(d.confidence) >= MIN_CONFIDENCE);
    let why = human ? (SENSITIVE.test(ev.text) ? 'Memuat kata sensitif (komplain/refund/kerja sama).' : reason || 'Perlu ditinjau manusia.') : '';
    const bad = unsafeReason(draft, rule.knowledge, limit);
    if (bad) { human = true; why = bad; }
    if (rule.mode !== 'auto') return end(id, 'pending', human ? why : 'Menunggu persetujuan.', { ...f, needs_human: human ? 1 : 0 });
    if (human) return end(id, 'pending', why, { ...f, needs_human: 1 });
    const since = new Date(Date.now() - 3600e3).toISOString();
    if (get("SELECT COUNT(*) AS n FROM auto_events WHERE brand_id=? AND platform=? AND status='sent' AND decided_by IS NULL AND updated_at>?", ev.brand_id, ev.platform, since).n >= rule.hourly_cap)
      return end(id, 'pending', `Batas ${rule.hourly_cap} balasan otomatis/jam tercapai.`, f);
    set(id, { ...f, status: 'approved' });
    return await send(id, draft, null);
  } catch (e) {
    return end(id, 'failed', String(e.message).slice(0, 300), { error: String(e.message).slice(0, 300) });
  }
}
function end(id, status, note, extra = {}) { set(id, { status, note, ...extra }); return get('SELECT * FROM auto_events WHERE id=?', id); }

/** Kirim balasan. userId null = otomatis. Aman dipanggil ganda: hanya satu yang berhasil mengklaim. */
export async function send(id, text, userId) {
  if (!run("UPDATE auto_events SET status='sending', updated_at=? WHERE id=? AND status IN ('pending','approved','failed')", now(), id).changes) return get('SELECT * FROM auto_events WHERE id=?', id);
  const ev = get('SELECT * FROM auto_events WHERE id=?', id);
  const brand = get('SELECT * FROM brands WHERE id=?', ev.brand_id);
  try {
    const t = String(text || '').trim();
    if (!t) throw new Error('Teks balasan kosong.');
    let r;
    if (ev.platform === 'threads') r = await T.replyTo(brand, ev.target_id, t);
    else {
      const acc = I.accountOf(brand.id);
      if (!acc?.token_enc && !isDry(ev, brand)) throw new Error('Akun Instagram belum terhubung.');
      r = ev.kind === 'dm' ? await I.sendMessage(acc || {}, brand, ev.author_id, t) : await I.replyComment(acc || {}, brand, ev.target_id, t);
    }
    if (ev.simulated && !r.dryRun) throw new Error('Event simulasi tidak boleh dikirim ke API asli.');
    set(id, { status: 'sent', reply_text: t, sent_id: String(r.mediaId || r.id || r.message_id || ''), decided_by: userId, error: null, note: r.dryRun ? 'Terkirim (simulasi, tidak ke platform asli).' : 'Terkirim.' });
    audit(userId, 'auto.sent', { id, platform: ev.platform, brand: brand.id, auto: !userId, dryRun: !!r.dryRun });
  } catch (e) {
    set(id, { status: 'failed', error: String(e.message).slice(0, 300) });
    audit(userId, 'auto.send_failed', { id, error: e.message });
  }
  return get('SELECT * FROM auto_events WHERE id=?', id);
}

export function reject(id, userId) {
  const r = run("UPDATE auto_events SET status='rejected', decided_by=?, updated_at=? WHERE id=? AND status IN ('pending','failed','skipped')", userId, now(), id);
  if (r.changes) audit(userId, 'auto.rejected', { id });
  return r.changes > 0;
}
export function redraft(id) {
  const r = run("UPDATE auto_events SET status='new', error=NULL, needs_human=0, draft=NULL, updated_at=? WHERE id=? AND status IN ('pending','failed','skipped','rejected')", now(), id);
  return r.changes > 0;
}

/** Proses event tertinggal (server restart, error sementara). */
export async function processBacklog(limit = 10) {
  run("UPDATE auto_events SET status='new' WHERE status='processing' AND updated_at<?", new Date(Date.now() - 5 * 60e3).toISOString());
  run("UPDATE auto_events SET status='failed', error='Server restart saat mengirim. Periksa platform sebelum mencoba lagi.' WHERE status='sending' AND updated_at<?", new Date(Date.now() - 5 * 60e3).toISOString());
  for (const e of all("SELECT id FROM auto_events WHERE status='new' ORDER BY received_at LIMIT ?", limit)) await processEvent(e.id);
}
export const purgeOld = () => run("DELETE FROM auto_events WHERE received_at<? AND status NOT IN ('pending','new','processing','sending')", new Date(Date.now() - 30 * 86400e3).toISOString()).changes;

export const stats = () => Object.fromEntries(all('SELECT status, COUNT(*) AS n FROM auto_events GROUP BY status').map((r) => [r.status, r.n]));
