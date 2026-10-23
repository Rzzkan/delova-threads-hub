import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-meta-'));
process.env.APP_SECRET = 'test-secret';
process.env.THREADS_DRY_RUN = 'true';
process.env.APP_BASE_URL = 'https://threads.test.local';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'password-123';
delete process.env.THREADS_APP_ID;
delete process.env.ANTHROPIC_API_KEY;

const { createApp, bootstrapAdmin } = await import('../src/server.js');
const { all, getSetting } = await import('../src/db.js');

const GLOBAL_ID = '111122223333444';
const GLOBAL_SECRET = 'globalsecret0123456789abcdef';
const KIDS_ID = '999988887777666';
const KIDS_SECRET = 'kidssecret0123456789abcdefgh';

let server, base, adminCookie, editorCookie;
const call = async (cookie, method, p, body, extra = {}) => {
  const r = await fetch(base + p, {
    method,
    redirect: 'manual',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'hub', ...(cookie ? { cookie } : {}), ...extra },
    body: body && method !== 'GET' ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* bukan JSON */ }
  return { status: r.status, headers: r.headers, text, json };
};
const admin = (m, p, b) => call(adminCookie, m, p, b);
const login = async (email, password) => (await call(null, 'POST', '/api/login', { email, password })).headers.get('set-cookie').split(';')[0];

before(async () => {
  bootstrapAdmin();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  adminCookie = await login('admin@test.local', 'password-123');
  await admin('POST', '/api/users', { name: 'Editor', email: 'ed@test.local', password: 'password-123', role: 'editor' });
  editorCookie = await login('ed@test.local', 'password-123');
});
after(() => server.close());

test('hanya admin yang boleh membuka/mengubah pengaturan Meta', async () => {
  assert.equal((await call(editorCookie, 'GET', '/api/settings/meta')).status, 403);
  assert.equal((await call(editorCookie, 'PUT', '/api/settings/meta', { app_id: GLOBAL_ID })).status, 403);
  assert.equal((await call(editorCookie, 'PUT', '/api/brands/kids/credentials', { app_id: KIDS_ID, app_secret: KIDS_SECRET })).status, 403);
});

test('awal: simulasi, belum ada kredensial; input tidak valid & Live tanpa kredensial ditolak', async () => {
  const s = (await admin('GET', '/api/settings/meta')).json;
  assert.equal(s.simulated, true);
  assert.equal(s.has_secret, false);
  assert.equal(s.redirect_uri, 'https://threads.test.local/auth/threads/callback');
  assert.equal((await admin('PUT', '/api/settings/meta', { app_id: 'bad id!' })).status, 400);
  assert.equal((await admin('PUT', '/api/settings/meta', { app_id: GLOBAL_ID, app_secret: 'pendek' })).status, 400);
  assert.equal((await admin('PUT', '/api/settings/meta', { mode: 'live' })).status, 400);
  assert.equal((await admin('PUT', '/api/settings/meta', { mode: 'ngawur' })).status, 400);
});

test('kredensial global + mode Live: tersimpan terenkripsi dan tidak pernah dikembalikan', async () => {
  const r = await admin('PUT', '/api/settings/meta', { app_id: GLOBAL_ID, app_secret: GLOBAL_SECRET, mode: 'live' });
  assert.equal(r.status, 200);
  assert.equal(r.json.simulated, false);
  assert.equal(r.json.has_secret, true);
  assert.equal(r.json.global_source, 'dashboard');
  assert.ok(!r.text.includes(GLOBAL_SECRET));
  const stored = getSetting('meta_app_secret_enc');
  assert.ok(stored && !stored.includes(GLOBAL_SECRET));
  // mengosongkan kolom secret saat menyimpan ulang tidak menghapus secret lama
  const again = await admin('PUT', '/api/settings/meta', { app_id: GLOBAL_ID, mode: 'live' });
  assert.equal(again.json.has_secret, true);
  for (const b of again.json.brands) assert.equal(b.source, 'dashboard');
});

test('mulai OAuth memakai App ID global; brand dengan kredensial sendiri memakai miliknya', async () => {
  const w = await admin('GET', '/auth/threads/start?brand=wardrobe');
  assert.equal(w.status, 302);
  assert.equal(new URL(w.headers.get('location')).searchParams.get('client_id'), GLOBAL_ID);

  const set = await admin('PUT', '/api/brands/kids/credentials', { app_id: KIDS_ID, app_secret: KIDS_SECRET });
  assert.equal(set.status, 200);
  assert.ok(!set.text.includes(KIDS_SECRET));
  const k = await admin('GET', '/auth/threads/start?brand=kids');
  assert.equal(new URL(k.headers.get('location')).searchParams.get('client_id'), KIDS_ID);
  const w2 = await admin('GET', '/auth/threads/start?brand=wardrobe');
  assert.equal(new URL(w2.headers.get('location')).searchParams.get('client_id'), GLOBAL_ID);

  const st = (await admin('GET', '/api/settings/meta')).json;
  assert.equal(st.brands.find((b) => b.id === 'kids').source, 'brand');
  assert.equal(st.brands.find((b) => b.id === 'scarf').source, 'dashboard');
});

test('rahasia tidak bocor lewat API brand, dashboard, maupun audit', async () => {
  const brands = await admin('GET', '/api/brands');
  const dash = await admin('GET', '/api/dashboard');
  const audit = JSON.stringify(all('SELECT * FROM audit_log'));
  for (const blob of [brands.text, dash.text, audit]) {
    for (const sec of [GLOBAL_SECRET, KIDS_SECRET]) assert.ok(!blob.includes(sec));
    assert.ok(!blob.includes('app_secret_enc'));
  }
  const kids = brands.json.find((b) => b.id === 'kids');
  assert.equal(kids.has_own_creds, true);
  assert.equal(kids.app_id, KIDS_ID);
});

test('Claude (token API / MCP) tidak bisa membaca atau mengubah kredensial', async () => {
  const me = (await admin('GET', '/api/me')).json;
  const tok = (await admin('POST', `/api/users/${me.id}/api-token`)).json.token;
  const h = { authorization: `Bearer ${tok}` };
  assert.equal((await call(null, 'GET', '/api/settings/meta', null, h)).status, 403);
  assert.equal((await call(null, 'PUT', '/api/settings/meta', { mode: 'sim' }, h)).status, 403);
  assert.equal((await call(null, 'PUT', '/api/brands/kids/credentials', { clear: true }, h)).status, 403);
});

test('hapus override brand → kembali ke global; mode Simulasi menahan koneksi akun', async () => {
  const c = await admin('PUT', '/api/brands/kids/credentials', { clear: true });
  assert.equal(c.json.brands.find((b) => b.id === 'kids').source, 'dashboard');
  const sim = await admin('PUT', '/api/settings/meta', { mode: 'sim' });
  assert.equal(sim.json.simulated, true);
  assert.equal((await admin('GET', '/auth/threads/start?brand=wardrobe')).status, 400);
  const gone = await admin('PUT', '/api/settings/meta', { clear: true });
  assert.equal(gone.json.has_secret, false);
  assert.equal(gone.json.app_id, '');
});
