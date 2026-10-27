import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-media-'));
process.env.APP_SECRET = 'test-secret';
process.env.THREADS_DRY_RUN = 'true';
process.env.APP_BASE_URL = 'https://threads.test.local';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'password-123';
delete process.env.THREADS_APP_ID;

const { createApp, bootstrapAdmin } = await import('../src/server.js');
const M = await import('../src/media.js');
const { publishPost } = await import('../src/scheduler.js');
const { get } = await import('../src/db.js');

let server, base, cookie;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const api = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'hub', cookie }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const upload = async (buf, type = 'image/png', name = 'foto.png') => {
  const r = await fetch(base + '/api/media', { method: 'POST', headers: { 'content-type': type, 'x-requested-with': 'hub', 'x-filename': encodeURIComponent(name), cookie }, body: buf });
  return { status: r.status, json: await r.json().catch(() => null) };
};

before(async () => {
  bootstrapAdmin();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'hub' }, body: JSON.stringify({ email: 'admin@test.local', password: 'password-123' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
});
after(() => server.close());

test('media: unggah, tersaji publik tanpa login, dihapus 24 jam setelah terbit', async () => {
  const up = await upload(PNG);
  assert.equal(up.status, 201);
  assert.match(up.json.url, /^https:\/\/threads\.test\.local\/media\/[a-f0-9]{32}\.png$/);
  const pub = await fetch(base + new URL(up.json.url).pathname); // tanpa cookie
  assert.equal(pub.status, 200);
  assert.equal(pub.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await pub.arrayBuffer()).length, PNG.length);

  const brands = (await api('GET', '/api/brands')).json;
  const post = (await api('POST', '/api/posts', { brand_id: brands[0].id, text: 'Foto uji', media_urls: [up.json.url] })).json;
  assert.equal(get('SELECT post_id FROM media WHERE name=?', up.json.name).post_id, post.id);
  assert.equal(get('SELECT delete_after FROM media WHERE name=?', up.json.name).delete_after, null); // belum terbit

  assert.equal((await api('DELETE', `/api/media/${up.json.name}`)).status, 400); // masih dipakai post

  const done = await publishPost(post.id, { allowFrom: ['draft'] });
  assert.equal(done.status, 'published');
  const da = get('SELECT delete_after FROM media WHERE name=?', up.json.name).delete_after;
  const hours = (Date.parse(da) - Date.now()) / 3600e3;
  assert.ok(hours > 23.9 && hours <= 24.01, `delete_after ~24 jam, dapat ${hours}`);

  assert.equal(M.cleanupMedia(Date.now() + 23 * 3600e3), 0); // 23 jam: masih ada
  assert.equal((await fetch(base + new URL(up.json.url).pathname)).status, 200);
  assert.equal(M.cleanupMedia(Date.now() + 25 * 3600e3), 1); // 25 jam: terhapus
  assert.equal((await fetch(base + new URL(up.json.url).pathname)).status, 404);
  assert.equal(fs.existsSync(path.join(M.MEDIA_DIR, up.json.name)), false);
});

test('media: validasi tipe, isi file, ukuran; unggahan tak terpakai dibersihkan', async () => {
  assert.equal((await upload(Buffer.from('bukan gambar'), 'image/png')).status, 415); // isi tak cocok
  assert.equal((await upload(Buffer.from('x'), 'application/pdf')).status, 415);
  assert.equal((await upload(Buffer.alloc(0), 'image/png')).status, 400);
  assert.equal((await upload(Buffer.concat([PNG, Buffer.alloc(M.MAX_IMAGE)]))).status, 413);
  const left = fs.readdirSync(M.MEDIA_DIR).filter((f) => M.isMediaName(f) && !get('SELECT 1 AS x FROM media WHERE name=?', f));
  assert.deepEqual(left, []); // unggahan gagal tidak meninggalkan file
  assert.equal((await fetch(base + '/media/../../hub.db')).status, 404);
  assert.equal((await fetch(base + '/media/' + 'a'.repeat(32) + '.png')).status, 404);

  const up = await upload(PNG);
  assert.equal((await api('DELETE', `/api/media/${up.json.name}`)).status, 200); // belum dipakai: boleh hapus manual
  const orphan = await upload(PNG);
  assert.equal(M.cleanupMedia(Date.now() + 47 * 3600e3), 0);
  assert.equal(M.cleanupMedia(Date.now() + 49 * 3600e3), 1);
  assert.equal(get('SELECT 1 AS x FROM media WHERE name=?', orphan.json.name), undefined);
});

test('media: post dihapus -> filenya ikut dibersihkan', async () => {
  const up = await upload(PNG);
  const brands = (await api('GET', '/api/brands')).json;
  const post = (await api('POST', '/api/posts', { brand_id: brands[0].id, text: 'Akan dihapus', media_urls: [up.json.url] })).json;
  assert.equal((await api('DELETE', `/api/posts/${post.id}`)).status, 200);
  assert.equal(M.cleanupMedia(Date.now() + 49 * 3600e3), 1);
});

test('media: impor URL menolak alamat internal (SSRF) dan skema selain HTTPS', async () => {
  for (const u of ['https://127.0.0.1/a.png', 'https://localhost/a.png', 'https://10.0.0.5/a.png', 'https://169.254.169.254/latest/meta-data', 'https://192.168.1.1/a.png', 'https://[::1]/a.png', 'http://example.com/a.png', 'ftp://example.com/a.png', 'https://user:pw@example.com/a.png']) {
    const r = await api('POST', '/api/media/import', { source_url: u });
    assert.equal(r.status, 400, `${u} harus ditolak, dapat ${r.status}`);
  }
  assert.equal(M.isPrivateIp('172.20.0.1'), true);
  assert.equal(M.isPrivateIp('100.64.0.1'), true);
  assert.equal(M.isPrivateIp('::ffff:10.1.2.3'), true);
  assert.equal(M.isPrivateIp('fd00::1'), true);
  assert.equal(M.isPrivateIp('8.8.8.8'), false);
  assert.equal(M.isPrivateIp('172.32.0.1'), false);
  assert.equal(fs.readdirSync(M.MEDIA_DIR).filter((f) => M.isMediaName(f) && !get('SELECT 1 AS x FROM media WHERE name=?', f)).length, 0);
});

test('media: tautan unggah (untuk foto dari chat Claude) + list_media', async () => {
  const link = await api('POST', '/api/media/upload-link', { brand_id: 'kids' });
  assert.equal(link.status, 201);
  const u = new URL(link.json.url);
  assert.match(u.pathname, /^\/upload\/.+/);
  const page = await fetch(base + u.pathname); // tanpa login
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Unggah foto untuk Claude/);

  const send = (p, buf, type = 'image/png') => fetch(base + p + '/file', { method: 'POST', headers: { 'content-type': type, 'x-filename': encodeURIComponent('kebaya sage.png') }, body: buf });
  const ok = await send(u.pathname, PNG);
  assert.equal(ok.status, 201);
  const j = await ok.json();
  assert.equal((await send(u.pathname, Buffer.from('bukan gambar'))).status, 415);

  const list = (await api('GET', '/api/media?limit=5')).json;
  const mine = list.find((m) => m.name === j.name);
  assert.ok(mine && mine.free === true && mine.original_name === 'kebaya sage.png' && mine.brand_id === 'kids');
  assert.match(mine.url, /^https:\/\/threads\.test\.local\/media\//);

  assert.equal((await send(u.pathname + 'x', PNG)).status, 410); // token rusak
  assert.equal((await fetch(base + '/upload/abc.def')).status, 410);
  assert.equal((await fetch(base + '/upload/' + u.pathname.split('/')[2] + '/../..')).status !== 500, true);
});

test('persetujuan massal: setujui, jadwal otomatis, lewati yang tak layak, kembalikan, ajukan', async () => {
  const brands = (await api('GET', '/api/brands')).json;
  const mk = async (text, scheduled_at, b = brands[0].id) => (await api('POST', '/api/posts', { brand_id: b, text, scheduled_at })).json;
  const future = new Date(Date.now() + 5 * 3600e3).toISOString();
  const a = await mk('Massal A (berjadwal)', future);
  const b = await mk('Massal B (tanpa jadwal)');
  const c = await mk('Massal C (tanpa jadwal)', undefined, brands[1].id);
  const d = await mk('Massal D (lampau)', new Date(Date.now() - 3 * 3600e3).toISOString());
  for (const p of [a, b, c, d]) await api('POST', `/api/posts/${p.id}/submit`);
  const ids = [a.id, b.id, c.id, d.id];

  // tanpa jadwal otomatis: B & C dilewati, D (lampau) dilewati
  let r = (await api('POST', '/api/posts/bulk', { action: 'approve', ids })).json;
  assert.deepEqual(r.done, [a.id]);
  assert.equal(r.skipped.length, 3);
  assert.match(r.skipped.find((x) => x.id === d.id).reason, /lewat/);

  // dengan jadwal otomatis, urut pilihan, jarak 2 jam; lampau tetap dilewati
  const start = new Date(Date.now() + 24 * 3600e3).toISOString();
  r = (await api('POST', '/api/posts/bulk', { action: 'approve', ids: [b.id, c.id, d.id], fill_missing: { start, interval_minutes: 120 } })).json;
  assert.deepEqual(r.done, [b.id, c.id]);
  const get1 = async (id) => (await api('GET', `/api/posts?limit=200`)).json.find((x) => x.id === id);
  assert.equal((await get1(b.id)).status, 'scheduled');
  assert.equal(new Date((await get1(b.id)).scheduled_at).toISOString(), start);
  assert.equal(Date.parse((await get1(c.id)).scheduled_at) - Date.parse(start), 2 * 3600e3);
  assert.equal((await get1(a.id)).scheduled_at, future); // jadwal sendiri tidak diubah

  // lampau diizinkan eksplisit
  r = (await api('POST', '/api/posts/bulk', { action: 'approve', ids: [d.id], allow_past: true })).json;
  assert.deepEqual(r.done, [d.id]);

  // kembalikan massal + catatan, lalu ajukan lagi
  r = (await api('POST', '/api/posts/bulk', { action: 'reject', ids: [a.id, b.id], note: 'Ganti foto' })).json;
  assert.equal(r.done.length, 2);
  assert.equal((await get1(a.id)).status, 'draft');
  assert.equal((await get1(a.id)).review_note, 'Ganti foto');
  r = (await api('POST', '/api/posts/bulk', { action: 'submit', ids: [a.id, b.id, c.id] })).json;
  assert.deepEqual(r.done, [a.id, b.id]); // c masih terjadwal -> dilewati
  assert.equal(r.skipped[0].id, c.id);

  // validasi
  assert.equal((await api('POST', '/api/posts/bulk', { action: 'approve', ids: [] })).status, 400);
  assert.equal((await api('POST', '/api/posts/bulk', { action: 'hapus', ids: [a.id] })).status, 400);
  assert.equal((await api('POST', '/api/posts/bulk', { action: 'approve', ids: Array.from({ length: 51 }, (_, i) => `x${i}`) })).status, 400);
  assert.equal((await api('POST', '/api/posts/bulk', { action: 'approve', ids: [a.id], fill_missing: { start: 'x', interval_minutes: 60 } })).status, 400);
  assert.equal((await api('POST', '/api/posts/bulk', { action: 'approve', ids: ['tidak-ada'] })).json.skipped[0].reason, 'Post tidak ditemukan.');
});
