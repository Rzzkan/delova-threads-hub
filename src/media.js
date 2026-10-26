// Penyimpanan media sementara: file foto/video untuk post disimpan di DATA_DIR/media,
// dicatat di tabel `media`, dan DIHAPUS OTOMATIS 24 jam setelah post-nya terbit.
// File diberi nama acak (tak bisa ditebak) dan disajikan publik di /media/<nama> karena Threads
// harus bisa mengunduhnya lewat URL HTTPS publik.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { all, get, run, now, db } from './db.js';

export const MEDIA_DIR = path.resolve(process.env.DATA_DIR || 'data', 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

db.exec(`CREATE TABLE IF NOT EXISTS media (
  name TEXT PRIMARY KEY,
  brand_id TEXT,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  original_name TEXT,
  uploaded_by TEXT,
  post_id TEXT,
  created_at TEXT NOT NULL,
  delete_after TEXT
);
CREATE INDEX IF NOT EXISTS media_post ON media(post_id);`);

export const KEEP_AFTER_POST_MS = 24 * 3600 * 1000; // dihapus 1 hari setelah terposting
export const ORPHAN_MS = 48 * 3600 * 1000; // diunggah tapi tak pernah dipakai di post
export const MAX_IMAGE = 8 * 1024 * 1024; // batas gambar Threads: 8 MB
export const MAX_VIDEO = 50 * 1024 * 1024;
export const MAX_TOTAL = Number(process.env.MEDIA_MAX_TOTAL_MB || 500) * 1024 * 1024;

const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/quicktime': 'mov' };
export const allowedTypes = () => Object.keys(TYPES);
export const limitFor = (mime) => (mime.startsWith('video/') ? MAX_VIDEO : MAX_IMAGE);
const NAME = /^[a-f0-9]{32}\.(jpg|png|webp|gif|mp4|mov)$/;
export const isMediaName = (n) => NAME.test(n);

/** Cek isi file sebenarnya (bukan hanya header Content-Type). */
export function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 6 && buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp') return buf.subarray(8, 12).toString('latin1').startsWith('qt') ? 'video/quicktime' : 'video/mp4';
  return null;
}

export const totalBytes = () => get('SELECT COALESCE(SUM(bytes),0) AS n FROM media').n;
export const urlFor = (base, name) => `${base}/media/${name}`;

/** Simpan stream unggahan ke disk (tanpa memuat seluruh file ke memori). Mengembalikan baris media. */
export function saveUpload(req, { mime, originalName, brandId, userId }) {
  return new Promise((resolve, reject) => {
    if (!TYPES[mime]) return reject(Object.assign(new Error('Format tidak didukung. Pakai JPG, PNG, WEBP, GIF, MP4, atau MOV.'), { status: 415 }));
    const limit = limitFor(mime);
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) return reject(Object.assign(new Error(`File terlalu besar (maks ${limit / 1024 / 1024} MB).`), { status: 413 }));
    if (totalBytes() + (declared || 0) > MAX_TOTAL) return reject(Object.assign(new Error('Penyimpanan sementara penuh. Tunggu file lama terhapus atau hapus post yang tak terpakai.'), { status: 507 }));
    const name = `${randomBytes(16).toString('hex')}.${TYPES[mime]}`;
    const file = path.join(MEDIA_DIR, name);
    const out = fs.createWriteStream(file);
    let size = 0; let head = Buffer.alloc(0); let failed = false;
    const fail = (e) => { if (failed) return; failed = true; out.destroy(); fs.rm(file, { force: true }, () => {}); reject(e); };
    req.on('data', (c) => {
      size += c.length;
      if (head.length < 16) head = Buffer.concat([head, c]).subarray(0, 16);
      if (size > limit) { req.unpipe(out); fail(Object.assign(new Error(`File terlalu besar (maks ${limit / 1024 / 1024} MB).`), { status: 413 })); }
    });
    req.on('error', fail); out.on('error', fail);
    out.on('finish', () => {
      if (failed) return;
      if (!size) return fail(Object.assign(new Error('File kosong.'), { status: 400 }));
      const real = sniff(head);
      if (real !== mime) return fail(Object.assign(new Error('Isi file tidak sesuai formatnya.'), { status: 415 }));
      run('INSERT INTO media(name,brand_id,mime,bytes,original_name,uploaded_by,created_at) VALUES (?,?,?,?,?,?,?)', name, brandId || null, mime, size, String(originalName || '').slice(0, 120) || null, userId || null, now());
      resolve(get('SELECT * FROM media WHERE name=?', name));
    });
    req.pipe(out);
  });
}

/** Nama file media milik kita yang dipakai di daftar URL. */
export function ownNames(urls) {
  const out = [];
  for (const u of urls || []) {
    const m = /\/media\/([a-f0-9]{32}\.[a-z0-9]{3,4})(?:\?|$)/.exec(String(u));
    if (m && isMediaName(m[1])) out.push(m[1]);
  }
  return out;
}

/** Hubungkan media ke post (dipanggil saat post dibuat/diedit). */
export function linkMedia(postId, urls) {
  run('UPDATE media SET post_id=NULL, delete_after=NULL WHERE post_id=?', postId);
  for (const n of ownNames(urls)) run('UPDATE media SET post_id=? WHERE name=?', postId, n);
}

/** Post terbit -> jadwalkan penghapusan file 24 jam kemudian. */
export function expireMediaOfPost(postId, at = Date.now()) {
  run('UPDATE media SET delete_after=? WHERE post_id=? AND delete_after IS NULL', new Date(at + KEEP_AFTER_POST_MS).toISOString(), postId);
}

export function removeMedia(name) {
  if (!isMediaName(name)) return;
  fs.rmSync(path.join(MEDIA_DIR, name), { force: true });
  run('DELETE FROM media WHERE name=?', name);
}

/** Hapus file yang sudah lewat masa simpannya. Mengembalikan jumlah file terhapus. */
export function cleanupMedia(at = Date.now()) {
  const iso = new Date(at).toISOString();
  const orphanBefore = new Date(at - ORPHAN_MS).toISOString();
  // post yang sudah dihapus dari dashboard: lepaskan tautan agar dihitung yatim
  run('UPDATE media SET post_id=NULL WHERE post_id IS NOT NULL AND post_id NOT IN (SELECT id FROM posts)');
  const dead = all('SELECT name FROM media WHERE (delete_after IS NOT NULL AND delete_after<=?) OR (post_id IS NULL AND created_at<?)', iso, orphanBefore);
  for (const { name } of dead) removeMedia(name);
  // file di disk tanpa catatan (sisa unggahan gagal)
  for (const f of fs.readdirSync(MEDIA_DIR)) {
    if (!isMediaName(f) || get('SELECT 1 AS x FROM media WHERE name=?', f)) continue;
    const st = fs.statSync(path.join(MEDIA_DIR, f));
    if (at - st.mtimeMs > 3600 * 1000) fs.rmSync(path.join(MEDIA_DIR, f), { force: true });
  }
  return dead.length;
}
