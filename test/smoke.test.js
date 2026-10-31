import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-'));
process.env.APP_SECRET = 'test-secret';
process.env.THREADS_DRY_RUN = 'true';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'password-123';
delete process.env.ANTHROPIC_API_KEY;

const { createApp, bootstrapAdmin } = await import('../src/server.js');

let server, base, cookie;
const api = async (method, p, body, headers = {}) => {
  const r = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'hub', ...(cookie ? { cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
};

before(async () => {
  bootstrapAdmin();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('login salah ditolak, login benar memberi cookie', async () => {
  assert.equal((await api('POST', '/api/login', { email: 'admin@test.local', password: 'salah' })).status, 401);
  const r = await api('POST', '/api/login', { email: 'admin@test.local', password: 'password-123' });
  assert.equal(r.status, 200);
  cookie = r.headers.get('set-cookie').split(';')[0];
  assert.equal(r.body.role, 'admin');
});

test('API butuh login & CSRF header', async () => {
  const noAuth = await fetch(base + '/api/brands');
  assert.equal(noAuth.status, 401);
  const noCsrf = await fetch(base + '/api/posts', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noCsrf.status, 403);
});

test('4 brand Delova tersedia', async () => {
  const r = await api('GET', '/api/brands');
  assert.deepEqual(r.body.map((b) => b.id), ['wardrobe', 'kids', 'scarf', 'daily']);
  assert.ok(!JSON.stringify(r.body).includes('token_enc'));
});

let postId;
test('alur draft → ajukan → setujui → publish (simulasi)', async () => {
  const long = await api('POST', '/api/posts', { brand_id: 'wardrobe', text: 'x'.repeat(501) });
  assert.equal(long.status, 400);

  const c = await api('POST', '/api/posts', { brand_id: 'wardrobe', text: 'Kebaya modern untuk kondangan siang ✨', topic_tag: 'kebaya' });
  assert.equal(c.status, 201);
  postId = c.body.id;
  assert.equal(c.body.status, 'draft');

  assert.equal((await api('POST', `/api/posts/${postId}/submit`)).body.status, 'pending_approval');
  assert.equal((await api('POST', `/api/posts/${postId}/approve`, { scheduled_at: new Date(Date.now() + 3600_000).toISOString() })).body.status, 'scheduled');
  const p = await api('POST', `/api/posts/${postId}/publish-now`);
  assert.equal(p.body.status, 'published');
  assert.match(p.body.permalink, /threads\.com/);
  assert.equal((await api('DELETE', `/api/posts/${postId}`)).status, 400);
});

test('replies, insights, dashboard berjalan di mode simulasi', async () => {
  const r = await api('GET', '/api/brands/wardrobe/replies');
  assert.equal(r.body.length, 3);
  const i = await api('GET', '/api/brands/wardrobe/insights');
  assert.ok(i.body.account.views > 0);
  assert.equal(i.body.posts.length, 1);
  const d = await api('GET', '/api/dashboard');
  assert.equal(d.body.brands.find((b) => b.id === 'wardrobe').counts.published, 1);
});

test('Claude nonaktif tanpa API key → 503 jelas', async () => {
  const r = await api('POST', '/api/ai/generate', { brand_id: 'scarf', brief: 'promo scarf' });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /ANTHROPIC_API_KEY/);
});

let editorToken;
test('peran: editor bisa membuat draft tapi tidak bisa menyetujui/publish', async () => {
  const u = await api('POST', '/api/users', { email: 'Editor@Test.local', name: 'Editor', role: 'editor', password: 'editor-pass-1' });
  assert.equal(u.status, 201);
  editorToken = (await api('POST', `/api/users/${u.body.id}/api-token`)).body.token;
  assert.match(editorToken, /^dth_/);

  const h = { authorization: `Bearer ${editorToken}`, cookie: '' };
  const saved = cookie; cookie = '';
  const c = await api('POST', '/api/posts', { brand_id: 'kids', text: 'Outfit lebaran si kecil', source: 'claude' }, h);
  assert.equal(c.status, 201);
  assert.equal(c.body.source, 'claude');
  assert.equal((await api('POST', `/api/posts/${c.body.id}/approve`, {}, h)).status, 403);
  assert.equal((await api('POST', `/api/posts/${c.body.id}/publish-now`, {}, h)).status, 403);
  assert.equal((await api('POST', `/api/posts/${c.body.id}/submit`, {}, h)).body.status, 'pending_approval');
  cookie = saved;
});

test('server MCP stdio: initialize + daftar tool + panggil tool', async () => {
  const mcp = spawn('node', ['mcp/server.js'], {
    env: { ...process.env, DELOVA_HUB_URL: base, DELOVA_HUB_TOKEN: editorToken },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines = [];
  let buf = '';
  mcp.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
  });
  const send = (o) => mcp.stdin.write(JSON.stringify(o) + '\n');
  const waitFor = async (id) => {
    for (let n = 0; n < 100; n++) {
      const m = lines.find((l) => l.id === id);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('timeout MCP');
  };
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  await waitFor(1);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tools = (await waitFor(2)).result.tools.map((t) => t.name);
  assert.ok(['list_brands', 'get_brand_voice', 'create_post', 'get_account_insights'].every((t) => tools.includes(t)));
  assert.ok(!tools.includes('publish_post'), 'tidak boleh ada tool publish');

  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_post', arguments: { brand: 'daily', text: 'Senin lagi, outfit aman?', submit: true } } });
  const res = await waitFor(3);
  assert.ok(!res.result.isError, JSON.stringify(res));
  assert.match(res.result.content[0].text, /pending_approval/);
  mcp.kill();
});

test('endpoint HTTP /mcp menolak tanpa Bearer token', async () => {
  const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', cookie } , body: '{}' });
  assert.ok([401, 403].includes(r.status));
});

test('Instagram: Claude (token) bisa buat & ajukan draft; setujui/publish tetap butuh manajer + saklar admin', async () => {
  const h = { authorization: `Bearer ${editorToken}`, cookie: '' };
  const saved = cookie; cookie = '';
  const c = await api('POST', '/api/ig/posts', { brand_id: 'kids', kind: 'feed', caption: 'Outfit lebaran 😊', media_urls: ['https://example.com/a.jpg'] }, h);
  assert.equal(c.status, 201);
  assert.equal((await api('POST', `/api/ig/posts/${c.body.id}/submit`, {}, h)).body.status, 'pending_approval');
  assert.equal((await api('POST', `/api/ig/posts/${c.body.id}/approve`, { scheduled_at: new Date(Date.now() + 3600e3).toISOString() }, h)).status, 403);
  assert.equal((await api('POST', `/api/ig/posts/${c.body.id}/publish-now`, {}, h)).status, 403);
  cookie = saved;
});
