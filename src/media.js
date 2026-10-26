// Penyimpanan media sementara: file foto/video untuk post disimpan di DATA_DIR/media,
// dicatat di tabel `media`, dan DIHAPUS OTOMATIS 24 jam setelah post-nya terbit.
// File diberi nama acak (tak bisa ditebak) dan disajikan publik di /media/<nama> karena Threads
// harus bisa mengunduhnya lewat URL HTTPS publik.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import dns from 'node:dns';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
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

/* ---------------- Impor dari URL / base64 (dipakai Claude lewat MCP) ---------------- */
const ALLOW_LOCAL = () => process.env.MEDIA_IMPORT_ALLOW_LOCAL === '1'; // HANYA untuk tes/dev

/** Alamat privat/loopback/link-local tidak boleh dijangkau (cegah SSRF ke jaringan internal VPS). */
export function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::' || l.startsWith('fe8') || l.startsWith('fe9') || l.startsWith('fea') || l.startsWith('feb') || l.startsWith('fc') || l.startsWith('fd')) return true;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
    return m ? isPrivateIp(m[1]) : false;
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

// lookup yang memeriksa alamat HASIL resolve yang benar-benar dipakai koneksi (menutup DNS rebinding)
const safeLookup = (host, opts, cb) => dns.lookup(host, opts, (err, addr, fam) => {
  if (err) return cb(err);
  const list = Array.isArray(addr) ? addr : [{ address: addr, family: fam }];
  if (!ALLOW_LOCAL() && list.some((a) => isPrivateIp(a.address))) return cb(Object.assign(new Error('Alamat tujuan tidak diizinkan.'), { status: 400 }));
  return Array.isArray(addr) ? cb(null, list) : cb(null, addr, fam);
});

function fetchLimited(urlStr, limit, hops = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(Object.assign(new Error('URL tidak valid.'), { status: 400 })); }
    if (u.protocol !== 'https:' && !(ALLOW_LOCAL() && u.protocol === 'http:')) return reject(Object.assign(new Error('URL harus HTTPS.'), { status: 400 }));
    if (u.username || u.password) return reject(Object.assign(new Error('URL tidak boleh memuat kredensial.'), { status: 400 }));
    if (net.isIP(u.hostname) && !ALLOW_LOCAL() && isPrivateIp(u.hostname)) return reject(Object.assign(new Error('Alamat tujuan tidak diizinkan.'), { status: 400 }));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { lookup: safeLookup, timeout: 20_000, headers: { 'user-agent': 'DelovaThreadsHub/1 (+media-import)', accept: 'image/*,video/*' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (hops >= 3) return reject(Object.assign(new Error('Terlalu banyak pengalihan.'), { status: 400 }));
        return resolve(fetchLimited(new URL(res.headers.location, u).toString(), limit, hops + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(Object.assign(new Error(`Sumber gambar membalas ${res.statusCode}.`), { status: 400 })); }
      const chunks = []; let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > limit) { req.destroy(); reject(Object.assign(new Error(`File terlalu besar (maks ${limit / 1024 / 1024} MB).`), { status: 413 })); } else chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('Sumber gambar terlalu lama merespons.'), { status: 504 })));
    req.on('error', (e) => reject(e.status ? e : Object.assign(new Error(`Gagal mengunduh: ${e.message}`), { status: 400 })));
  });
}

/** Simpan buffer yang sudah ada di memori (jenis ditentukan dari isi file). */
export function saveBuffer(buf, { originalName, brandId, userId }) {
  const mime = sniff(buf);
  if (!mime) throw Object.assign(new Error('Format tidak didukung. Pakai JPG, PNG, WEBP, GIF, MP4, atau MOV.'), { status: 415 });
  if (buf.length > limitFor(mime)) throw Object.assign(new Error(`File terlalu besar (maks ${limitFor(mime) / 1024 / 1024} MB).`), { status: 413 });
  if (totalBytes() + buf.length > MAX_TOTAL) throw Object.assign(new Error('Penyimpanan sementara penuh.'), { status: 507 });
  const name = `${randomBytes(16).toString('hex')}.${TYPES[mime]}`;
  fs.writeFileSync(path.join(MEDIA_DIR, name), buf);
  run('INSERT INTO media(name,brand_id,mime,bytes,original_name,uploaded_by,created_at) VALUES (?,?,?,?,?,?,?)', name, brandId || null, mime, buf.length, String(originalName || '').slice(0, 120) || null, userId || null, now());
  return get('SELECT * FROM media WHERE name=?', name);
}

export async function importMedia({ url, base64, filename, brandId, userId }) {
  if (!!url === !!base64) throw Object.assign(new Error('Isi salah satu: source_url atau base64.'), { status: 400 });
  let buf;
  if (url) buf = await fetchLimited(String(url), MAX_VIDEO);
  else {
    const raw = String(base64).replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    if (raw.length > Math.ceil((MAX_IMAGE * 4) / 3) + 8) throw Object.assign(new Error(`Base64 terlalu besar (maks ${MAX_IMAGE / 1024 / 1024} MB). Gunakan source_url untuk file besar.`), { status: 413 });
    buf = Buffer.from(raw, 'base64');
  }
  return saveBuffer(buf, { originalName: filename || (url ? new URL(url).pathname.split('/').pop() : null), brandId, userId });
}

/** Daftar file tersimpan (terbaru dulu). `free` = belum dipakai post mana pun. */
export function listMedia(limit = 50) {
  return all('SELECT name, mime, bytes, original_name, brand_id, post_id, created_at, delete_after FROM media ORDER BY created_at DESC LIMIT ?', Math.min(Math.max(Number(limit) || 50, 1), 200))
    .map((m) => ({ ...m, free: !m.post_id, expires_at: m.delete_after || (m.post_id ? null : new Date(Date.parse(m.created_at) + ORPHAN_MS).toISOString()) }));
}
