import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-oauth-'));
process.env.APP_SECRET = 'test-secret';
process.env.THREADS_DRY_RUN = 'true';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'password-123';
delete process.env.ANTHROPIC_API_KEY;

const { createApp, bootstrapAdmin } = await import('../src/server.js');

let server, base, adminCookie, clientId, tokens;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const form = (o) => new URLSearchParams(o).toString();

const http = async (method, p, { body, headers = {}, json = true } = {}) => {
  const r = await fetch(base + p, { method, headers, body, redirect: 'manual' });
  const text = await r.text();
  return { status: r.status, headers: r.headers, text, body: json ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null };
};
const admin = (method, p, body) =>
  http(method, p, { body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', 'x-requested-with': 'hub', cookie: adminCookie } });
const bearer = (tok, method, p, body) =>
  http(method, p, { body: body && method !== 'GET' ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` } });

const mcp = async (tok, method, params, id = 1) => {
  const r = await http('POST', '/mcp', {
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok}` },
    json: false,
  });
  const line = r.text.split('\n').find((l) => l.startsWith('data: '));
  return { status: r.status, msg: line ? JSON.parse(line.slice(6)) : null };
};

const pkce = () => {
  const verifier = crypto.randomBytes(48).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};

/** Jalankan alur browser: authorize → login → consent → kode. */
async function getCode(challenge, { allow = true } = {}) {
  const q = form({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', resource: `${base}/mcp` });
  const authUrl = `/oauth/authorize?${q}`;
  const a = await http('GET', authUrl, { json: false });
  assert.match(a.text, /Masuk ke Delova Threads Hub/);
  const bad = await http('POST', '/oauth/login', { body: form({ back: authUrl, email: 'admin@test.local', password: 'salah' }), headers: { 'content-type': 'application/x-www-form-urlencoded' }, json: false });
  assert.equal(bad.status, 401);
  const l = await http('POST', '/oauth/login', { body: form({ back: authUrl, email: 'admin@test.local', password: 'password-123' }), headers: { 'content-type': 'application/x-www-form-urlencoded' }, json: false });
  assert.equal(l.status, 302);
  const cookie = l.headers.get('set-cookie').split(';')[0];
  const c = await http('GET', authUrl, { headers: { cookie }, json: false });
  assert.match(c.text, /Izinkan akses Claude/);
  assert.equal(c.headers.get('x-frame-options'), 'DENY');
  const ticket = /name="ticket" value="([^"]+)"/.exec(c.text)[1];
  const r = await http('POST', '/oauth/consent', { body: form({ ticket, action: allow ? 'allow' : 'deny' }), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, json: false });
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, REDIRECT);
  assert.equal(loc.searchParams.get('state'), 'xyz');
  return { code: loc.searchParams.get('code'), error: loc.searchParams.get('error') };
}

before(async () => {
  bootstrapAdmin();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_BASE_URL = base;
  const l = await http('POST', '/api/login', { body: JSON.stringify({ email: 'admin@test.local', password: 'password-123' }), headers: { 'content-type': 'application/json' } });
  adminCookie = l.headers.get('set-cookie').split(';')[0];
});
after(() => server.close());

test('discovery: /mcp tanpa token → 401 + WWW-Authenticate, metadata lengkap', async () => {
  const r = await http('POST', '/mcp', { body: '{}', headers: { 'content-type': 'application/json' } });
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource"/);
  const prm = await http('GET', '/.well-known/oauth-protected-resource');
  assert.equal(prm.body.resource, `${base}/mcp`);
  const as = await http('GET', '/.well-known/oauth-authorization-server');
  assert.deepEqual(as.body.code_challenge_methods_supported, ['S256']);
  assert.ok(as.body.registration_endpoint.endsWith('/oauth/register'));
});

test('registrasi klien: redirect berbahaya ditolak, claude.ai diterima', async () => {
  const j = { 'content-type': 'application/json' };
  const bad = await http('POST', '/oauth/register', { body: JSON.stringify({ redirect_uris: ['javascript:alert(1)'] }), headers: j });
  assert.equal(bad.status, 400);
  const http1 = await http('POST', '/oauth/register', { body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }), headers: j });
  assert.equal(http1.status, 400);
  const ok = await http('POST', '/oauth/register', { body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT] }), headers: j });
  assert.equal(ok.status, 201);
  clientId = ok.body.client_id;
});

test('authorize menolak redirect_uri yang tidak terdaftar & tanpa PKCE', async () => {
  const q = form({ response_type: 'code', client_id: clientId, redirect_uri: 'https://evil.example/cb', code_challenge: 'x', code_challenge_method: 'S256' });
  assert.equal((await http('GET', `/oauth/authorize?${q}`, { json: false })).status, 400);
  const q2 = form({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT });
  const r = await http('GET', `/oauth/authorize?${q2}`, { json: false });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /error=invalid_request/);
});

test('user menolak di halaman izin → access_denied', async () => {
  const { error, code } = await getCode(pkce().challenge, { allow: false });
  assert.equal(error, 'access_denied');
  assert.equal(code, null);
});

test('PKCE salah ditolak; kode hanya sekali pakai', async () => {
  const { verifier, challenge } = pkce();
  const { code } = await getCode(challenge);
  const wrong = await http('POST', '/oauth/token', { body: form({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: pkce().verifier }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(wrong.body.error, 'invalid_grant');
  const again = await http('POST', '/oauth/token', { body: form({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: verifier }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(again.body.error, 'invalid_grant'); // kode sudah hangus setelah percobaan pertama
});

test('alur penuh → token → /mcp: tools & prompts tampil', async () => {
  const { verifier, challenge } = pkce();
  const { code } = await getCode(challenge);
  const t = await http('POST', '/oauth/token', { body: form({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: verifier }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(t.status, 200);
  assert.equal(t.body.token_type, 'Bearer');
  tokens = t.body;

  const init = await mcp(tokens.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1' } });
  assert.equal(init.status, 200);
  const tl = await mcp(tokens.access_token, 'tools/list', {}, 2);
  const names = tl.msg.result.tools.map((x) => x.name);
  for (const n of ['get_overview', 'create_post', 'approve_post', 'send_reply', 'publish_post_now']) assert.ok(names.includes(n), `tool ${n} ada untuk manager/admin`);
  const pl = await mcp(tokens.access_token, 'prompts/list', {}, 3);
  assert.ok(pl.msg.result.prompts.map((x) => x.name).includes('rencana_mingguan'));
  const ov = await mcp(tokens.access_token, 'tools/call', { name: 'get_overview', arguments: {} }, 4);
  const overview = JSON.parse(ov.msg.result.content[0].text);
  assert.equal(overview.claude_policy.can_approve, false);
  assert.equal(overview.claude_policy.can_create, true);
});

let postId;
test('kebijakan default: Claude boleh buat draft, tidak boleh setujui/publish/balas', async () => {
  const c = await bearer(tokens.access_token, 'POST', '/api/posts', { brand_id: 'scarf', text: 'Mix & match scarf untuk kuliah', source: 'dashboard' });
  assert.equal(c.status, 201);
  assert.equal(c.body.source, 'claude', 'sumber dipaksa "claude" untuk jalur MCP');
  postId = c.body.id;
  assert.equal((await bearer(tokens.access_token, 'POST', `/api/posts/${postId}/submit`)).body.status, 'pending_approval');

  const ap = await bearer(tokens.access_token, 'POST', `/api/posts/${postId}/approve`, {});
  assert.equal(ap.status, 403);
  assert.match(ap.body.error, /Kontrol Claude/);
  assert.equal((await bearer(tokens.access_token, 'POST', `/api/posts/${postId}/publish-now`)).status, 403);
  assert.equal((await bearer(tokens.access_token, 'POST', '/api/brands/scarf/replies/x/reply', { text: 'hi' })).status, 403);

  // lewat tool MCP: user_confirmed wajib
  const noConfirm = await mcp(tokens.access_token, 'tools/call', { name: 'approve_post', arguments: { id: postId, user_confirmed: false } }, 5);
  assert.equal(noConfirm.msg.result.isError, true);
  assert.match(noConfirm.msg.result.content[0].text, /konfirmasi eksplisit/);
});

test('endpoint admin & AI & hapus: khusus manusia (dashboard), tertutup untuk Claude', async () => {
  for (const [m, p] of [['GET', '/api/users'], ['PUT', '/api/settings/claude'], ['DELETE', `/api/posts/${postId}`], ['PUT', '/api/brands/scarf'], ['POST', '/api/ai/generate']]) {
    const r = await bearer(tokens.access_token, m, p, {});
    assert.equal(r.status, 403, `${m} ${p}`);
  }
});

test('admin mengaktifkan setujui → Claude bisa; publish tetap mati', async () => {
  assert.equal((await admin('PUT', '/api/settings/claude', { can_approve: true })).body.can_approve, true);
  const ap = await mcp(tokens.access_token, 'tools/call', { name: 'approve_post', arguments: { id: postId, scheduled_at: new Date(Date.now() + 3600_000).toISOString(), user_confirmed: true } }, 6);
  assert.ok(!ap.msg.result.isError, JSON.stringify(ap.msg));
  assert.match(ap.msg.result.content[0].text, /"status": "scheduled"/);
  assert.equal((await bearer(tokens.access_token, 'POST', `/api/posts/${postId}/publish-now`)).status, 403);
});

test('batas harian draft Claude', async () => {
  await admin('PUT', '/api/settings/claude', { daily_create_cap: 1 }); // sudah ada 1 draft dari Claude
  const r = await bearer(tokens.access_token, 'POST', '/api/posts', { brand_id: 'kids', text: 'tes batas' });
  assert.equal(r.status, 429);
  await admin('PUT', '/api/settings/claude', { daily_create_cap: 30 });
});

test('aktivitas Claude tercatat dengan via=oauth di audit', async () => {
  const a = await admin('GET', '/api/claude/activity');
  assert.ok(a.body.some((x) => x.action === 'post.approved' && x.detail.includes('"via":"oauth"')));
  const s = await admin('GET', '/api/claude/sessions');
  assert.equal(s.body[0].client_name, 'Claude');
});

test('refresh token berotasi: token lama mati, baru hidup', async () => {
  const r = await http('POST', '/oauth/token', { body: form({ grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(r.status, 200);
  assert.equal((await bearer(tokens.access_token, 'GET', '/api/me')).status, 401);
  assert.equal((await bearer(r.body.access_token, 'GET', '/api/me')).status, 200);
  const reuse = await http('POST', '/oauth/token', { body: form({ grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(reuse.body.error, 'invalid_grant');
  tokens = r.body;
});

test('saklar utama: Claude dimatikan → semua jalur Claude 403, dashboard tetap jalan', async () => {
  await admin('PUT', '/api/settings/claude', { claude_enabled: false });
  assert.equal((await bearer(tokens.access_token, 'GET', '/api/me')).status, 403);
  const m = await mcp(tokens.access_token, 'tools/list', {}, 7);
  assert.equal(m.status, 403);
  assert.equal((await admin('GET', '/api/posts')).status, 200);
  await admin('PUT', '/api/settings/claude', { claude_enabled: true });
  assert.equal((await bearer(tokens.access_token, 'GET', '/api/me')).status, 200);
});

test('admin memutus sesi Claude → token langsung tidak berlaku', async () => {
  const s = await admin('GET', '/api/claude/sessions');
  assert.equal((await admin('DELETE', `/api/claude/sessions/${s.body[0].id}`)).status, 200);
  assert.equal((await bearer(tokens.access_token, 'GET', '/api/me')).status, 401);
});
