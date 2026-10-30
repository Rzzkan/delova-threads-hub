import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ig-'));
process.env.APP_SECRET = 'test-secret';
process.env.THREADS_DRY_RUN = 'true';
process.env.APP_BASE_URL = 'https://threads.test.local';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'password-123';
delete process.env.THREADS_APP_ID; delete process.env.INSTAGRAM_APP_ID;

const { createApp, bootstrapAdmin } = await import('../src/server.js');
const I = await import('../src/instagram.js');
const M = await import('../src/media.js');
const { get, run } = await import('../src/db.js');

let server, base, admin, viewer;
const req = async (cookie, method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'hub', cookie }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const A = (m, p, b) => req(admin, m, p, b);
const login = async (email) => (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'hub' }, body: JSON.stringify({ email, password: 'password-123' }) })).headers.get('set-cookie')).split(';')[0];
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 3)]);
const upJpg = async () => {
  const r = await fetch(base + '/api/media', { method: 'POST', headers: { 'content-type': 'image/jpeg', 'x-requested-with': 'hub', cookie: admin }, body: JPG });
  return r.json();
};

before(async () => {
  bootstrapAdmin();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await login('admin@test.local');
  await A('POST', '/api/users', { name: 'Viewer', email: 'v@test.local', password: 'password-123', role: 'viewer' });
  viewer = await login('v@test.local');
});
after(() => server.close());

test('ig: status, kredensial hanya admin & rahasia tak pernah dikembalikan', async () => {
  const s = (await A('GET', '/api/ig/status')).json;
  assert.equal(s.simulated, true);
  assert.equal(s.brands.length, 4);
  assert.ok(s.scopes.includes('instagram_business_manage_messages'));
  assert.equal((await req(viewer, 'GET', '/api/ig/status')).json.app_id, undefined); // viewer tak melihat app id
  assert.equal((await req(viewer, 'PUT', '/api/ig/credentials', { app_id: '1234567890' })).status, 403);
  assert.equal((await A('PUT', '/api/ig/credentials', { app_id: 'x' })).status, 400);
  const ok = await A('PUT', '/api/ig/credentials', { app_id: '1234567890123', app_secret: 'abcdef0123456789abcdef0123456789' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.app_id, '1234567890123');
  assert.equal(ok.json.has_secret, true);
  assert.ok(!JSON.stringify(ok.json).includes('abcdef0123456789'));
  assert.equal(I.creds().appSecret, 'abcdef0123456789abcdef0123456789'); // terenkripsi di DB, terbaca server
  assert.match(I.authorizeUrl('st1'), /^https:\/\/www\.instagram\.com\/oauth\/authorize\?.*client_id=1234567890123.*instagram_business_content_publish/);
  assert.equal(I.isDryRun(), true); // THREADS_DRY_RUN tetap memaksa simulasi
  await A('PUT', '/api/ig/credentials', { clear: true });
  assert.equal((await A('GET', '/api/ig/status')).json.has_secret, false);
});

test('ig: validasi konten (feed/reels/story, JPEG, hashtag, panjang)', async () => {
  const j = await upJpg();
  const v = (b) => A('POST', '/api/ig/posts', { brand_id: 'wardrobe', ...b });
  assert.equal((await v({ caption: 'x', media_urls: [] })).status, 400); // butuh media
  assert.match((await v({ caption: 'x', media_urls: ['https://x.test/a.png'] })).json.error, /JPEG/);
  assert.match((await v({ kind: 'reels', media_urls: [j.url] })).json.error, /Reels/);
  assert.match((await v({ kind: 'story', media_urls: [j.url, j.url] })).json.error, /Story/);
  assert.match((await v({ kind: 'feed', media_urls: ['https://x.test/v.mp4'] })).json.error, /Reels/);
  assert.equal((await v({ media_urls: Array(11).fill(j.url) })).status, 400);
  assert.match((await v({ caption: Array(31).fill('#a').join(' '), media_urls: [j.url] })).json.error, /30 hashtag/);
  assert.equal((await v({ caption: 'x'.repeat(2201), media_urls: [j.url] })).status, 400);
  assert.equal((await v({ kind: 'reels', media_urls: ['https://x.test/v.mp4'] })).status, 201);
  assert.equal((await v({ kind: 'story', media_urls: [j.url] })).status, 201);
  assert.equal((await A('POST', '/api/ig/posts', { brand_id: 'tidak-ada', media_urls: [j.url] })).status, 404);
});

test('ig: alur draft → ajukan → setujui → terbit; media dihapus 24 jam setelahnya', async () => {
  const j = await upJpg();
  const c = await A('POST', '/api/ig/posts', { brand_id: 'kids', caption: 'Koleksi baru #delovakids', media_urls: [j.url] });
  assert.equal(c.status, 201);
  const id = c.json.id;
  assert.equal(get('SELECT post_id FROM media WHERE name=?', j.name).post_id, id);
  assert.equal((await A('POST', `/api/ig/posts/${id}/approve`, {})).status, 400); // tanpa jadwal
  assert.equal((await A('POST', `/api/ig/posts/${id}/submit`)).json.status, 'pending_approval');
  const when = new Date(Date.now() + 3600e3).toISOString();
  const ap = (await A('POST', `/api/ig/posts/${id}/approve`, { scheduled_at: when })).json;
  assert.equal(ap.status, 'scheduled');
  // kembalikan lalu setujui lagi
  assert.equal((await A('POST', `/api/ig/posts/${id}/reject`, { note: 'ganti foto' })).json.review_note, 'ganti foto');
  await A('POST', `/api/ig/posts/${id}/approve`, { scheduled_at: when });
  const pub = (await A('POST', `/api/ig/posts/${id}/publish-now`)).json;
  assert.equal(pub.status, 'published');
  assert.match(pub.permalink, /instagram\.com\/p\//);
  const da = get('SELECT delete_after FROM media WHERE name=?', j.name).delete_after;
  assert.ok(da && Math.abs((Date.parse(da) - Date.now()) / 3600e3 - 24) < 0.1);
  assert.equal(M.cleanupMedia(Date.now() + 25 * 3600e3) >= 1, true);
  assert.equal((await A('PUT', `/api/ig/posts/${id}`, { caption: 'edit' })).status, 400); // terbit: tak bisa diedit
  assert.equal((await A('DELETE', `/api/ig/posts/${id}`)).status, 400);
});

test('ig: penjadwal menerbitkan konten yang jatuh tempo; hapus konten melepas media', async () => {
  const j = await upJpg();
  const id = (await A('POST', '/api/ig/posts', { brand_id: 'scarf', caption: 'Terjadwal', media_urls: [j.url] })).json.id;
  await A('POST', `/api/ig/posts/${id}/approve`, { scheduled_at: new Date(Date.now() + 3600e3).toISOString() });
  await I.igTick();
  assert.equal(get('SELECT status FROM ig_posts WHERE id=?', id).status, 'scheduled'); // belum waktunya
  run('UPDATE ig_posts SET scheduled_at=? WHERE id=?', new Date(Date.now() - 60e3).toISOString(), id);
  await I.igTick();
  assert.equal(get('SELECT status FROM ig_posts WHERE id=?', id).status, 'published');

  const j2 = await upJpg();
  const id2 = (await A('POST', '/api/ig/posts', { brand_id: 'scarf', caption: 'Akan dihapus', media_urls: [j2.url] })).json.id;
  assert.equal((await A('DELETE', `/api/ig/posts/${id2}`)).status, 200);
  assert.equal(M.cleanupMedia(Date.now() + 49 * 3600e3) >= 1, true);
  assert.equal(get('SELECT 1 AS x FROM media WHERE name=?', j2.name), undefined);
});

test('ig: komentar — daftar, balas, sembunyikan, validasi, peran', async () => {
  const list = (await A('GET', '/api/ig/wardrobe/comments')).json;
  assert.ok(list.length >= 1 && list[0].comments.length >= 1);
  const cm = list[0].comments[0];
  assert.equal((await A('POST', `/api/ig/wardrobe/comments/${cm.id}/reply`, { text: '  ' })).status, 400);
  const r = await A('POST', `/api/ig/wardrobe/comments/${cm.id}/reply`, { text: 'Halo Kak, ready ya 😊' });
  assert.equal(r.status, 200); assert.equal(r.json.dryRun, true);
  assert.equal((await A('POST', `/api/ig/wardrobe/comments/${cm.id}/hide`, { hide: true })).status, 200);
  assert.equal((await A('POST', `/api/ig/tidak-ada/comments/x/hide`, {})).status, 404);
  assert.equal((await req(viewer, 'GET', '/api/ig/wardrobe/comments')).status, 403); // butuh editor
  assert.equal((await req(viewer, 'POST', `/api/ig/wardrobe/comments/${cm.id}/reply`, { text: 'hi' })).status, 403);
});

test('ig: DM — percakapan, pesan, kirim, validasi, peran', async () => {
  const convs = (await A('GET', '/api/ig/kids/conversations')).json;
  assert.ok(convs.length >= 2);
  assert.ok(convs.some((c) => c.can_reply === true) && convs.some((c) => c.can_reply === false)); // jendela 24 jam
  const msgs = (await A('GET', `/api/ig/kids/conversations/${convs[0].id}`)).json;
  assert.ok(msgs.length >= 2 && msgs[0].message);
  const send = (b) => A('POST', `/api/ig/kids/conversations/${convs[0].id}/send`, b);
  assert.equal((await send({ text: '' , recipient_id: 'x' })).status, 400);
  assert.equal((await send({ text: 'Halo', recipient_id: '' })).status, 400);
  assert.equal((await send({ text: 'x'.repeat(1001), recipient_id: 'x' })).status, 400);
  const ok = await send({ text: 'Ongkir ke Jogja Rp9.000 ya Kak', recipient_id: convs[0].participant.id });
  assert.equal(ok.status, 200); assert.equal(ok.json.dryRun, true);
  assert.equal((await req(viewer, 'GET', '/api/ig/kids/conversations')).status, 403);
});

test('ig: insight akun & per konten, viewer boleh membaca', async () => {
  const a7 = (await req(viewer, 'GET', '/api/ig/wardrobe/insights?days=7')).json;
  const a30 = (await req(viewer, 'GET', '/api/ig/wardrobe/insights?days=30')).json;
  assert.equal(a7.days, 7); assert.equal(a30.days, 30);
  assert.ok(a30.metrics.reach > a7.metrics.reach && a7.followers > 0);
  assert.equal((await A('GET', '/api/ig/wardrobe/insights?days=99')).json.days, 7);
  const mi = (await req(viewer, 'GET', '/api/ig/scarf/media-insights?limit=8')).json;
  assert.equal(mi.length, 8);
  assert.ok(mi.every((m) => m.caption && typeof m.insights.reach === 'number' && m.permalink));
  const again = (await A('GET', '/api/ig/scarf/media-insights?limit=8')).json; // cache 10 menit: sama persis
  assert.deepEqual(again.map((m) => m.id), mi.map((m) => m.id));
});

test('ig: OAuth tidak bisa dimulai saat simulasi / tanpa kredensial', async () => {
  const r = await fetch(`${base}/auth/instagram/start?brand=wardrobe`, { headers: { cookie: admin }, redirect: 'manual' });
  assert.equal(r.status, 400);
  const cb = await fetch(`${base}/auth/instagram/callback?code=abc&state=palsu`, { headers: { cookie: admin }, redirect: 'manual' });
  assert.equal(cb.status, 302);
  assert.match(cb.headers.get('location'), /connect=gagal/);
});
