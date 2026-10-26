import { all, get, run, now, audit } from './db.js';
import * as T from './threads.js';
import { encrypt } from './crypto.js';
import { collectDueMentions } from './research.js';
import { expireMediaOfPost, cleanupMedia } from './media.js';

const DAILY_LIMIT = 240; // batas resmi Threads: 250 post / 24 jam per akun

export function threadsLength(text) {
  let n = 0;
  for (const ch of text) n += ch.codePointAt(0) > 0xffff ? 4 : 1; // emoji dihitung konservatif
  return n;
}

/** Klaim post secara atomik lalu publish. Mengembalikan post terbaru. */
export async function publishPost(id, { allowFrom = ['scheduled'], userId = null } = {}) {
  const marks = allowFrom.map(() => '?').join(',');
  const claim = run(
    `UPDATE posts SET status='publishing', error=NULL, updated_at=? WHERE id=? AND status IN (${marks})`,
    now(), id, ...allowFrom,
  );
  if (!claim.changes) return get('SELECT * FROM posts WHERE id=?', id);

  const post = get('SELECT * FROM posts WHERE id=?', id);
  const brand = get('SELECT * FROM brands WHERE id=?', post.brand_id);
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { n } = get("SELECT COUNT(*) AS n FROM posts WHERE brand_id=? AND status='published' AND published_at>?", brand.id, since);
    if (n >= DAILY_LIMIT) throw new Error('Batas 250 post/24 jam per akun hampir tercapai. Coba lagi nanti.');

    const r = await T.publish(brand, post);
    run(
      `UPDATE posts SET status='published', published_at=?, threads_media_id=?, permalink=?, updated_at=? WHERE id=?`,
      now(), r.mediaId, r.permalink, now(), id,
    );
    expireMediaOfPost(id); // foto/video post ini dihapus 24 jam lagi
    audit(userId, 'post.published', { id, brand: brand.id, dryRun: !!r.dryRun });
  } catch (e) {
    run(`UPDATE posts SET status='failed', error=?, updated_at=? WHERE id=?`, String(e.message).slice(0, 500), now(), id);
    audit(userId, 'post.failed', { id, error: e.message });
  }
  return get('SELECT * FROM posts WHERE id=?', id);
}

async function tick() {
  const due = all("SELECT id FROM posts WHERE status='scheduled' AND scheduled_at<=? ORDER BY scheduled_at LIMIT 10", now());
  for (const p of due) await publishPost(p.id);
}

/** Perpanjang token yang kedaluwarsa dalam 10 hari (token Threads berumur ~60 hari). */
async function refreshTokens() {
  if (T.isDryRun()) return;
  const soon = new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString();
  for (const b of all('SELECT * FROM brands WHERE token_enc IS NOT NULL AND token_expires_at<?', soon)) {
    try {
      const r = await T.refreshToken(b);
      run(
        'UPDATE brands SET token_enc=?, token_expires_at=?, token_refreshed_at=? WHERE id=?',
        encrypt(r.token), new Date(Date.now() + r.expiresIn * 1000).toISOString(), now(), b.id,
      );
      audit(null, 'token.refreshed', { brand: b.id });
    } catch (e) {
      audit(null, 'token.refresh_failed', { brand: b.id, error: e.message });
    }
  }
}

export function startScheduler() {
  const safe = (fn) => () => fn().catch((e) => console.error('[scheduler]', e.message));
  // post yang tertinggal di "publishing" setelah restart dikembalikan ke failed agar terlihat tim
  run("UPDATE posts SET status='failed', error='Server restart saat publish. Periksa Threads lalu coba lagi.' WHERE status='publishing'");
  const a = setInterval(safe(tick), 30_000);
  const b = setInterval(safe(refreshTokens), 6 * 3600 * 1000);
  const c = setInterval(safe(collectDueMentions), 10 * 60_000);
  const d = setInterval(safe(async () => { const n = cleanupMedia(); if (n) audit(null, 'media.cleanup', { removed: n }); }), 30 * 60_000);
  setTimeout(safe(async () => { cleanupMedia(); }), 15_000);
  setTimeout(safe(tick), 3000);
  setTimeout(safe(refreshTokens), 10_000);
  setTimeout(safe(collectDueMentions), 20_000);
  return () => { clearInterval(a); clearInterval(b); clearInterval(c); clearInterval(d); };
}
