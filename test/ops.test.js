import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ops-'));
process.env.APP_SECRET = 'test-secret';
process.env.THREADS_DRY_RUN = 'true';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'password-123';
process.env.TRUST_PROXY = '1';
delete process.env.ANTHROPIC_API_KEY;

const { createApp, bootstrapAdmin } = await import('../src/server.js');
bootstrapAdmin();
const server = createApp().listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const login = (ip, password = 'salah') =>
  fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ email: 'admin@test.local', password }) });

test('di balik proxy: pembatas login per IP pengunjung (bukan per IP proxy)', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await login('203.0.113.7')).status, 401);
  assert.equal((await login('203.0.113.7')).status, 429, 'IP yang sama terkunci setelah 10 percobaan');
  const other = await login('198.51.100.9', 'password-123'); // pengunjung lain tidak ikut terkunci
  assert.equal(other.status, 200);
});

test('header keamanan terpasang', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  const o = await fetch(base + '/oauth/authorize?client_id=x'); // halaman OAuth memakai CSP sendiri
  assert.match(o.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('skrip backup membuat salinan database yang bisa dibuka', async () => {
  const r = spawnSync('node', ['scripts/backup.mjs'], { env: { ...process.env }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Backup OK/);
  const { DatabaseSync } = await import('node:sqlite');
  const f = fs.readdirSync(path.join(process.env.DATA_DIR, 'backups')).find((x) => x.endsWith('.db'));
  const copy = new DatabaseSync(path.join(process.env.DATA_DIR, 'backups', f));
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM brands').get().n, 4);
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  copy.close();
  server.close();
});
