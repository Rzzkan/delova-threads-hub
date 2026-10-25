import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-research-'));
process.env.APP_SECRET = 'test-secret';
process.env.THREADS_DRY_RUN = 'true';
process.env.APP_BASE_URL = 'https://threads.test.local';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'password-123';
delete process.env.THREADS_APP_ID;
delete process.env.ANTHROPIC_API_KEY;

const { createApp, bootstrapAdmin } = await import('../src/server.js');
const { all } = await import('../src/db.js');
const R = await import('../src/research.js');
const T = await import('../src/threads.js');

let server, base, adminCookie, viewerCookie;
const call = async (cookie, method, p, body, extra = {}) => {
  const r = await fetch(base + p, {
    method, redirect: 'manual',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'hub', ...(cookie ? { cookie } : {}), ...extra },
    body: body && method !== 'GET' ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* bukan JSON */ }
  return { status: r.status, headers: r.headers, text, json };
};
const admin = (m, p, b) => call(adminCookie, m, p, b);
const login = async (email) => (await call(null, 'POST', '/api/login', { email, password: 'password-123' })).headers.get('set-cookie').split(';')[0];

before(async () => {
  bootstrapAdmin();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  adminCookie = await login('admin@test.local');
  await admin('POST', '/api/users', { name: 'Viewer', email: 'v@test.local', password: 'password-123', role: 'viewer' });
  viewerCookie = await login('v@test.local');
});
after(() => server.close());

test('riset: validasi, hasil simulasi, simpan & hapus; viewer tidak boleh mencari', async () => {
  assert.equal((await admin('POST', '/api/research/search', { brand_id: 'wardrobe', q: 'k' })).status, 400);
  assert.equal((await admin('POST', '/api/research/search', { brand_id: 'nope', q: 'kebaya' })).status, 400);
  assert.equal((await call(viewerCookie, 'POST', '/api/research/search', { brand_id: 'wardrobe', q: 'kebaya' })).status, 403);
  const r = await admin('POST', '/api/research/search', { brand_id: 'wardrobe', q: 'kebaya modern', days: 7 });
  assert.equal(r.status, 200);
  assert.equal(r.json.simulated, true);
  assert.ok(r.json.posts.length >= 5);
  assert.ok(r.json.posts.every((p) => p.username && p.text.includes('kebaya modern')));
  const s = await admin('POST', '/api/research/saves', { brand_id: 'wardrobe', q: 'kebaya modern', posts: r.json.posts });
  assert.equal(s.status, 201);
  const list = (await admin('GET', '/api/research/saves')).json;
  assert.equal(list.length, 1);
  assert.equal(list[0].result.length, r.json.posts.length);
  assert.equal((await call(viewerCookie, 'DELETE', `/api/research/saves/${s.json.id}`)).status, 403);
  assert.equal((await admin('DELETE', `/api/research/saves/${s.json.id}`)).status, 200);
  assert.equal((await admin('POST', '/api/ai/research', { brand_id: 'wardrobe', q: 'x', posts: r.json.posts })).status, 503);
});

test('mention: kumpulkan, tidak menimpa status tim, filter, balas, ekspor CSV aman', async () => {
  const c1 = (await admin('POST', '/api/mentions/collect', { brand_id: 'kids' })).json;
  assert.equal(c1.added, 4);
  const list = (await admin('GET', '/api/mentions?brand_id=kids')).json;
  assert.equal(list.items.length, 4);
  assert.equal(list.counts.baru, 4);
  const id = list.items[0].id;
  const up = await admin('PUT', `/api/mentions/${encodeURIComponent(id)}`, { status: 'ditandai', note: 'cek stok XL' });
  assert.equal(up.json.status, 'ditandai');
  assert.equal((await admin('PUT', `/api/mentions/${encodeURIComponent(id)}`, { status: 'ngawur' })).status, 400);
  const c2 = (await admin('POST', '/api/mentions/collect', { brand_id: 'kids' })).json;
  assert.equal(c2.added, 0);
  const again = (await admin('GET', '/api/mentions?brand_id=kids&status=ditandai')).json;
  assert.equal(again.items.length, 1);
  assert.equal(again.items[0].note, 'cek stok XL');
  assert.equal((await call(viewerCookie, 'POST', '/api/mentions/collect', { brand_id: 'kids' })).status, 403);
  assert.equal((await call(viewerCookie, 'POST', `/api/mentions/${encodeURIComponent(id)}/reply`, { text: 'hai' })).status, 403);
  // Claude (token API) tidak boleh membalas kecuali admin mengizinkan (default mati)
  const me = (await admin('GET', '/api/me')).json;
  const tok = (await admin('POST', `/api/users/${me.id}/api-token`)).json.token;
  const denied = await call(null, 'POST', `/api/mentions/${encodeURIComponent(id)}/reply`, { text: 'hai' }, { authorization: `Bearer ${tok}` });
  assert.equal(denied.status, 403);
  const rep = await admin('POST', `/api/mentions/${encodeURIComponent(id)}/reply`, { text: 'Terima kasih kak!' });
  assert.equal(rep.status, 200);
  assert.equal((await admin('GET', '/api/mentions?brand_id=kids&status=dibalas')).json.items.length, 1);
  // CSV: rumus di sel harus dinetralkan
  const evil = '=HYPERLINK("http://x")';
  all('SELECT 1');
  const { run } = await import('../src/db.js');
  run("UPDATE mentions SET text=? WHERE id=?", evil, id);
  const csv = await admin('GET', '/api/mentions.csv?brand_id=kids');
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.ok(csv.text.includes(`"'=HYPERLINK(""http://x"")"`));
  assert.ok(csv.text.replace(/^﻿/, '').startsWith('brand,username'));
});

test('kolaborasi: tambah (normalisasi username, profil simulasi), duplikat, ubah tahap, hapus', async () => {
  assert.equal((await admin('POST', '/api/creators', { username: 'bad name!' })).status, 400);
  const a = await admin('POST', '/api/creators', { username: 'https://www.threads.com/@Kebaya.Nusantara?x=1', brand_id: 'wardrobe', niche: 'kebaya', lookup: true, lookup_brand_id: 'wardrobe', source: 'riset' });
  assert.equal(a.status, 201);
  const c = a.json.creator;
  assert.equal(c.username, 'kebaya.nusantara');
  assert.ok(c.followers > 0 && c.stats.views_count > 0);
  assert.ok(c.engagement_rate > 0);
  assert.equal(c.source, 'riset');
  const dup = await admin('POST', '/api/creators', { username: '@kebaya.nusantara' });
  assert.equal(dup.status, 200);
  assert.equal(dup.json.existed, true);
  const st = await admin('PUT', `/api/creators/${c.id}`, { status: 'dihubungi', note: 'DM terkirim', fee: 'barter' });
  assert.equal(st.json.status, 'dihubungi');
  assert.equal((await admin('PUT', `/api/creators/${c.id}`, { status: 'x' })).status, 400);
  assert.equal((await admin('GET', '/api/creators?status=dihubungi')).json.length, 1);
  assert.equal((await admin('GET', '/api/creators?status=prospek')).json.length, 0);
  assert.equal((await call(viewerCookie, 'POST', '/api/creators', { username: 'abc' })).status, 403);
  assert.equal((await call(viewerCookie, 'GET', '/api/creators')).status, 200);
  assert.equal((await admin('POST', `/api/creators/${c.id}/lookup`, { brand_id: 'wardrobe' })).status, 200);
  assert.equal((await admin('POST', '/api/ai/outreach', { brand_id: 'wardrobe', creator_id: c.id })).status, 503);
  assert.equal((await admin('DELETE', `/api/creators/${c.id}`)).status, 200);
});

test('izin tambahan: default mati, hanya diminta saat OAuth bila diaktifkan admin; live tanpa izin ditolak', async () => {
  assert.deepEqual(T.scopes(), T.SCOPES);
  assert.equal((await admin('GET', '/api/research/status')).json.extra_scopes, false);
  const put = await admin('PUT', '/api/settings/meta', { app_id: '111122223333444', app_secret: 'globalsecret0123456789abcdef', mode: 'live', extra_scopes: true });
  assert.equal(put.json.extra_scopes, true);
  assert.ok(T.scopes().includes('threads_keyword_search'));
  const start = await admin('GET', '/auth/threads/start?brand=wardrobe');
  const scope = new URL(start.headers.get('location')).searchParams.get('scope');
  for (const s of ['threads_keyword_search', 'threads_manage_mentions', 'threads_profile_discovery', 'threads_basic']) assert.ok(scope.includes(s));
  await admin('PUT', '/api/settings/meta', { extra_scopes: false });
  const live = await admin('POST', '/api/research/search', { brand_id: 'wardrobe', q: 'kebaya' });
  assert.equal(live.status, 400); // akun belum terhubung (mode live)
  await assert.rejects(() => T.keywordSearch({ id: 'x', app_id: '99999', app_secret_enc: 'x' }, { q: 'kebaya' }), /izin tambahan|Akun/i);
  await admin('PUT', '/api/settings/meta', { mode: 'sim', clear: true });
});

test('util: engagement rate & normalisasi username', () => {
  assert.equal(R.engagementRate({ views_count: 1000, likes_count: 40, replies_count: 5, reposts_count: 3, quotes_count: 2 }), 5);
  assert.equal(R.engagementRate({}), null);
  assert.equal(R.cleanUsername('@Abc.Def'), 'abc.def');
  assert.equal(R.cleanUsername('https://threads.net/@xy_z/post/1'), 'xy_z');
});
