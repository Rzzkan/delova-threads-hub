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

test('4 brand Delova + akun tambahan tersedia (urutan tetap)', async () => {
  const r = await api('GET', '/api/brands');
  assert.deepEqual(r.body.map((b) => b.id), ['wardrobe', 'kids', 'scarf', 'daily', 'personal', 'temanseller']);
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

test('persetujuan: post Threads yang membahas produk tanpa gambar diberi info "disarankan pakai gambar"', async () => {
  const c = await api('POST', '/api/posts', { brand_id: 'kids', text: 'Hitam atau Putih, Moms? Satu dress, dua cerita. DRESS BELLE ada di link bio.' });
  assert.equal(c.status, 201);
  await api('POST', `/api/posts/${c.body.id}/submit`);
  const d = (await api('GET', '/api/approvals')).body;
  const x = d.posts.find((p) => p.id === c.body.id);
  assert.equal(x.visual.need, 'disarankan'); assert.equal(x.visual.missing, true); assert.match(x.visual.product, /dress|link bio/i);
});

test('Instagram: draft boleh tanpa foto/video; ajukan, setujui, dan publish butuh media', async () => {
  const c = await api('POST', '/api/ig/posts', { brand_id: 'kids', kind: 'feed', caption: 'Draft tanpa gambar' });
  assert.equal(c.status, 201); assert.deepEqual(c.body.media_urls, []);
  const s = await api('POST', '/api/ig/posts', { brand_id: 'kids', kind: 'story' });
  assert.equal(s.status, 201);
  assert.equal((await api('POST', `/api/ig/posts/${c.body.id}/submit`)).status, 400);
  assert.equal((await api('POST', `/api/ig/posts/${c.body.id}/approve`, { scheduled_at: new Date(Date.now() + 3600e3).toISOString() })).status, 400);
  assert.equal((await api('POST', `/api/ig/posts/${c.body.id}/publish-now`)).status, 400);
  const bad = await api('POST', '/api/ig/posts', { brand_id: 'kids', kind: 'feed', media_urls: ['http://example.com/a.jpg'] });
  assert.equal(bad.status, 400, 'URL non-HTTPS tetap ditolak');
  const u = await api('PUT', `/api/ig/posts/${c.body.id}`, { media_urls: ['https://example.com/a.jpg'] });
  assert.equal(u.status, 200);
  assert.equal((await api('POST', `/api/ig/posts/${c.body.id}/submit`)).body.status, 'pending_approval');
});

test('Instagram Story: daftarkan slot tanggal & jam saja (tanpa foto), foto menyusul', async () => {
  const t1 = new Date(Date.now() + 86400e3).toISOString(); const t2 = new Date(Date.now() + 2 * 86400e3).toISOString();
  const r = await api('POST', '/api/ig/posts/story-slots', { brand_id: 'kids', times: [t2, t1] });
  assert.equal(r.status, 201); assert.equal(r.body.length, 2);
  assert.ok(r.body.every((p) => p.kind === 'story' && p.status === 'draft' && p.media_urls.length === 0));
  assert.equal(r.body[0].scheduled_at, t1, 'urut waktu');
  assert.equal((await api('POST', '/api/ig/posts/story-slots', { brand_id: 'kids', times: ['bukan-tanggal'] })).status, 400);
  assert.equal((await api('POST', `/api/ig/posts/${r.body[0].id}/submit`)).status, 400, 'tanpa foto belum bisa diajukan');
  assert.equal((await api('PUT', `/api/ig/posts/${r.body[0].id}`, { media_urls: ['https://example.com/s.jpg'] })).status, 200);
  assert.equal((await api('POST', `/api/ig/posts/${r.body[0].id}/submit`)).body.status, 'pending_approval');
});

test('Upload PNG diterima; untuk Instagram otomatis jadi JPG (transparansi diratakan putih)', async () => {
  const { PNG } = await import('pngjs');
  const png = new PNG({ width: 4, height: 4 }); png.data.fill(0); // transparan penuh
  const buf = PNG.sync.write(png);
  const up = async (q) => { const r = await fetch(base + '/api/media' + q, { method: 'POST', headers: { 'content-type': 'image/png', 'x-requested-with': 'hub', cookie, 'x-filename': 'a.png' }, body: buf }); return { status: r.status, body: await r.json() }; };
  const plain = await up('?brand=kids');
  assert.equal(plain.status, 201); assert.match(plain.body.name, /\.png$/, 'Threads tetap menerima PNG apa adanya');
  const j = await up('?as=jpg&brand=kids');
  assert.equal(j.status, 201); assert.match(j.body.name, /\.jpg$/); assert.equal(j.body.mime, 'image/jpeg');
  const get1 = await fetch(`${base}/media/${j.body.name}`); const out = Buffer.from(await get1.arrayBuffer());
  assert.deepEqual([...out.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  // PNG yang sudah terlanjur diunggah juga dikonversi saat dipasang ke konten Instagram
  const c = await api('POST', '/api/ig/posts', { brand_id: 'kids', kind: 'feed', caption: 'x', media_urls: [plain.body.url.replace('http://localhost', 'https://localhost')] });
  assert.equal(c.status, 201); assert.match(c.body.media_urls[0], /\.jpg$/);
});

test('Inbox Reply: reply yang sudah dibalas menampilkan daftar balasannya', async () => {
  const p = await api('POST', '/api/posts', { brand_id: 'wardrobe', text: 'Tim Peach atau Mint?' });
  await api('POST', `/api/posts/${p.body.id}/submit`); await api('POST', `/api/posts/${p.body.id}/approve`); await api('POST', `/api/posts/${p.body.id}/publish`);
  const l1 = await api('GET', '/api/brands/wardrobe/replies');
  assert.ok(l1.body.length, 'ada reply simulasi');
  assert.deepEqual(l1.body[0].answers, []);
  const rid = l1.body[0].reply.id;
  assert.equal((await api('POST', `/api/brands/wardrobe/replies/${rid}/reply`, { text: 'Siap Bunda, ya!' })).status, 200);
  const l2 = (await api('GET', '/api/brands/wardrobe/replies')).body.find((x) => x.reply.id === rid);
  assert.equal(l2.answers.length, 1); assert.equal(l2.answers[0].text, 'Siap Bunda, ya!');
});

test('Dashboard: ringkasan Instagram feed & story ikut tampil per brand', async () => {
  const r = await api('GET', '/api/dashboard');
  const k = r.body.brands.find((b) => b.id === 'kids');
  assert.ok(k.instagram && k.instagram.feed && k.instagram.story, 'ada blok instagram');
  assert.ok(Object.keys(k.instagram.story).length > 0, 'slot story dari tes sebelumnya terhitung');
  assert.equal(typeof k.instagram.drafts_no_media, 'number');
});

test('Akun tambahan: Personal Brand & Teman Seller tersedia; admin bisa tambah/hapus akun baru', async () => {
  const ids = (await api('GET', '/api/brands')).body.map((b) => b.id);
  assert.ok(ids.includes('personal') && ids.includes('temanseller'), 'seed akun tambahan');
  const c = await api('POST', '/api/brands', { name: 'Toko Uji', color: '#112233' });
  assert.equal(c.status, 201); assert.equal(c.body.id, 'tokouji');
  assert.equal((await api('POST', '/api/brands', { name: 'Toko Uji' })).body.id, 'tokouji2', 'id bentrok diberi sufiks');
  assert.equal((await api('POST', '/api/brands', { name: '' })).status, 400);
  const post = await api('POST', '/api/posts', { brand_id: 'tokouji', text: 'halo' });
  assert.equal(post.status, 201);
  assert.equal((await api('DELETE', '/api/brands/tokouji')).status, 400, 'masih punya post');
  assert.equal((await api('DELETE', '/api/brands/wardrobe')).status, 400, 'brand Delova tidak bisa dihapus');
  assert.equal((await api('DELETE', '/api/brands/tokouji2')).status, 200);
  const d = await api('GET', '/api/dashboard');
  assert.ok(d.body.brands.some((b) => b.id === 'temanseller' && b.instagram));
  const ig = await api('GET', '/api/ig/status');
  assert.ok(ig.body.brands.some((b) => b.id === 'personal'), 'muncul di Instagram');
});
