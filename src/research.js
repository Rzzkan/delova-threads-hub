/** Logika bersama untuk Mention dan Kolaborasi (dipakai server dan scheduler). */
import { all, get, run, now, uid, audit, getSetting, setSetting } from './db.js';
import * as T from './threads.js';

export const MENTION_STATUS = ['baru', 'ditandai', 'dibalas', 'diabaikan'];
export const CREATOR_STATUS = ['prospek', 'dihubungi', 'negosiasi', 'deal', 'ditolak'];

/** Ambil mention terbaru sebuah brand dan simpan yang belum ada. Status & catatan yang sudah diisi tim tidak ditimpa. */
export async function collectMentions(brand, { days = 30 } = {}) {
  const items = await T.listMentions(brand, { days });
  let added = 0;
  for (const m of items) {
    const r = run(
      `INSERT OR IGNORE INTO mentions(id,media_id,brand_id,username,text,permalink,media_type,posted_at,collected_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      `${brand.id}:${m.id}`, m.id, brand.id, m.username, m.text, m.permalink, m.media_type, m.timestamp, now(),
    );
    if (r.changes) added++;
  }
  setSetting(`mentions_last:${brand.id}`, Date.now());
  return { total: items.length, added };
}

/** Dipanggil scheduler: kumpulkan mention tiap ±1 jam untuk akun yang terhubung (mode Live + izin tambahan aktif). */
export async function collectDueMentions() {
  if (getSetting('mentions_auto') !== '1' || !T.extraScopesOn() || T.isDryRun()) return;
  for (const b of all('SELECT * FROM brands WHERE token_enc IS NOT NULL')) {
    if (T.isDryRun(b)) continue;
    if (Date.now() - Number(getSetting(`mentions_last:${b.id}`) || 0) < 3600_000) continue;
    try {
      const r = await collectMentions(b);
      if (r.added) audit(null, 'mentions.collected', { brand: b.id, added: r.added });
    } catch (e) {
      setSetting(`mentions_last:${b.id}`, Date.now()); // jangan ulangi tiap 30 detik saat error
      audit(null, 'mentions.collect_failed', { brand: b.id, error: e.message });
    }
  }
}

export const cleanUsername = (u) => String(u || '').trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?threads\.(com|net)\/@/i, '').split(/[/?#]/)[0].toLowerCase();
export const validUsername = (u) => /^[a-z0-9._]{1,30}$/.test(u);

export function engagementRate(stats = {}) {
  const views = Number(stats.views_count || 0);
  if (!views) return null;
  const inter = ['likes_count', 'replies_count', 'reposts_count', 'quotes_count'].reduce((a, k) => a + Number(stats[k] || 0), 0);
  return Math.round((inter / views) * 10000) / 100;
}

export const publicCreator = (c) => {
  if (!c) return null;
  const stats = JSON.parse(c.stats || '{}');
  return { ...c, verified: !!c.verified, stats, engagement_rate: engagementRate(stats) };
};

/** Terapkan hasil profile_lookup ke baris kreator. */
export function applyProfile(id, p) {
  const stats = {};
  for (const k of ['likes_count', 'quotes_count', 'reposts_count', 'views_count', 'replies_count']) if (p[k] !== undefined) stats[k] = Number(p[k]) || 0;
  run(
    'UPDATE creators SET name=COALESCE(?,name), bio=COALESCE(?,bio), followers=COALESCE(?,followers), verified=?, stats=?, looked_up_at=?, updated_at=? WHERE id=?',
    p.name ?? null, p.biography ?? null, p.follower_count ?? null, p.is_verified ? 1 : 0, JSON.stringify(stats), now(), now(), id,
  );
}

export function createCreator({ username, name, bio, followers, niche, note, fee, brand_id, source, sample_url }, userId) {
  const u = cleanUsername(username);
  if (!validUsername(u)) throw Object.assign(new Error('Username Threads tidak valid (huruf, angka, titik, underscore).'), { status: 400 });
  const ex = get('SELECT * FROM creators WHERE username=?', u);
  if (ex) return { creator: ex, existed: true };
  const id = uid();
  const t = now();
  run(
    `INSERT INTO creators(id,username,name,bio,followers,niche,note,fee,brand_id,source,sample_url,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, u, name || null, bio || null, Number.isFinite(Number(followers)) && followers !== '' && followers != null ? Number(followers) : null,
    niche || null, note || null, fee || null, brand_id || null, ['manual', 'riset', 'mention'].includes(source) ? source : 'manual', sample_url || null, userId, t, t,
  );
  return { creator: get('SELECT * FROM creators WHERE id=?', id), existed: false };
}
