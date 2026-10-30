import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pesan-'));
process.env.APP_SECRET = 'test-secret';
process.env.THREADS_DRY_RUN = 'true';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'password-123';
delete process.env.THREADS_APP_ID; delete process.env.INSTAGRAM_APP_ID; delete process.env.ANTHROPIC_API_KEY;

const { createApp, bootstrapAdmin } = await import('../src/server.js');
const { run, now, uid } = await import('../src/db.js');
let server, base, cookie, viewer;
const api = async (ck, p) => { const r = await fetch(base + p, { headers: { 'x-requested-with': 'hub', cookie: ck } }); return { status: r.status, json: await r.json().catch(() => null) }; };
const login = async (email) => (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'hub' }, body: JSON.stringify({ email, password: 'password-123' }) })).headers.get('set-cookie')).split(';')[0];
before(async () => {
  bootstrapAdmin(); server = createApp().listen(0); base = `http://127.0.0.1:${server.address().port}`;
  cookie = await login('admin@test.local');
  await fetch(base + '/api/users', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'hub', cookie }, body: JSON.stringify({ name: 'V', email: 'v@test.local', password: 'password-123', role: 'viewer' }) });
  viewer = await login('v@test.local');
});
after(() => server.close());

test('reply Threads muncul dari post terbit', async () => {
  run(`INSERT INTO posts(id,brand_id,text,status,threads_media_id,published_at,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`, uid(), 'wardrobe', 'Post uji', 'published', 'tm1', now(), 'x', now(), now());
  const r = await api(cookie, '/api/pesan?type=komentar&brand=wardrobe&fresh=1');
  assert.ok(r.json.threads.some((x) => x.kind === 'reply' && x.brand_id === 'wardrobe'));
});
test('komentar dipisah per platform dan tiap item membawa brand_id', async () => {
  const r = await api(cookie, '/api/pesan?type=komentar');
  assert.equal(r.status, 200);
  assert.ok(r.json.instagram.length >= 5);
  assert.ok(r.json.instagram.every((x) => x.platform === 'instagram' && x.brand_id));
  assert.ok(r.json.threads.every((x) => x.platform === 'threads' && x.brand_id));
  assert.ok(new Set(r.json.instagram.map((x) => x.brand_id)).size >= 2);
});
test('filter brand membatasi hasil; brand tak dikenal 404', async () => {
  const r = await api(cookie, '/api/pesan?type=komentar&brand=wardrobe');
  assert.ok(r.json.instagram.length && r.json.instagram.every((x) => x.brand_id === 'wardrobe'));
  assert.equal((await api(cookie, '/api/pesan?type=komentar&brand=nope')).status, 404);
});
test('DM hanya Instagram, Threads diberi catatan tanpa API DM', async () => {
  const r = await api(cookie, '/api/pesan?type=dm');
  assert.ok(r.json.instagram.length >= 3 && r.json.instagram.every((x) => x.kind === 'dm'));
  assert.equal(r.json.threads.length, 0);
  assert.match(r.json.threads_dm_note, /Threads/);
});
test('event webhook dan mention tersimpan ikut tampil sekali (tanpa duplikat)', async () => {
  const t = now();
  run(`INSERT INTO auto_events(id,platform,brand_id,kind,ext_id,target_id,author_username,text,status,received_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, uid(), 'instagram', 'kids', 'mention', 'ig_m1', 'x', 'bunda_s', 'Suka banget @delovakids', 'pending', t, t);
  run(`INSERT INTO mentions(id,media_id,brand_id,username,text,posted_at,collected_at) VALUES (?,?,?,?,?,?,?)`, 'scarf:m9', 'm9', 'scarf', 'hijabers', 'Cantik @delovascarf', t, t);
  const r = await api(cookie, '/api/pesan?type=komentar&fresh=1');
  assert.equal(r.json.instagram.filter((x) => x.ext_id === 'ig_m1').length, 1);
  assert.equal(r.json.instagram.find((x) => x.ext_id === 'ig_m1').kind, 'mention');
  assert.ok(r.json.threads.some((x) => x.kind === 'mention' && x.brand_id === 'scarf'));
});
test('viewer ditolak', async () => { assert.equal((await api(viewer, '/api/pesan?type=dm')).status, 403); });

const post = (ck, p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'hub', cookie: ck }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
test('tren: Threads per kata kunci + Instagram dari performa akun sendiri', async () => {
  const r = await post(cookie, '/api/trends', { keywords: 'kebaya, batik modern', days: 7 });
  assert.equal(r.status, 200);
  assert.equal(r.json.threads.keywords.length, 2);
  assert.ok(r.json.threads.total > 0 && Array.isArray(r.json.threads.daily));
  assert.ok(r.json.instagram.total > 0 && r.json.instagram.top_posts[0].interactions >= r.json.instagram.top_posts[1].interactions);
  assert.match(r.json.instagram_note, /hashtag/);
});
test('tren: tanpa kata kunci tetap memberi data Instagram dan catatan; viewer ditolak', async () => {
  const r = await post(cookie, '/api/trends', { keywords: '' });
  assert.equal(r.json.threads, null); assert.ok(r.json.notes.length && r.json.instagram);
  assert.equal((await post(viewer, '/api/trends', { keywords: 'x' })).status, 403);
});
test('ekstraksi hashtag/kata dan momentum', async () => {
  const T = await import('../src/trends.js');
  assert.deepEqual(T.hashtags('Ayo #Kebaya #kebaya #Batik_2 http://x.co/#frag'), ['#kebaya', '#batik_2']);
  assert.ok(!T.terms('yang kebaya modern @toko #tag').includes('yang'));
  const now = Date.now();
  const s = T.summarizeThreads({ a: [{ text: 'kebaya cantik', timestamp: new Date(now - 3600e3).toISOString(), username: 'u' }, { text: 'kebaya baru', timestamp: new Date(now - 3600e3).toISOString(), username: 'u' }, { text: 'lama', timestamp: new Date(now - 6 * 86400e3).toISOString(), username: 'v' }] }, 7);
  assert.equal(s.keywords[0].momentum, 100);
});
