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
