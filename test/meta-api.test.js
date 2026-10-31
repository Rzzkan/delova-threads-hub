import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-meta-'));
process.env.APP_SECRET = 'test-secret';
process.env.THREADS_DRY_RUN = 'true';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'password-123';
delete process.env.THREADS_APP_ID; delete process.env.INSTAGRAM_APP_ID; delete process.env.ANTHROPIC_API_KEY;

const { createApp, bootstrapAdmin } = await import('../src/server.js');
const W = await import('../src/whatsapp.js');
const A = await import('../src/autoreply.js');
const C = await import('../src/catalog.js');
const CR = await import('../src/catalog-routes.js');
const { get, all, run, now, setSetting } = await import('../src/db.js');
let server, base, admin, ed;
const call = async (ck, method, p, body) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'hub', cookie: ck }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
const login = async (email) => (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'hub' }, body: JSON.stringify({ email, password: 'password-123' }) })).headers.get('set-cookie')).split(';')[0];
before(async () => {
  bootstrapAdmin(); server = createApp().listen(0); base = `http://127.0.0.1:${server.address().port}`;
  admin = await login('admin@test.local');
  await call(admin, 'POST', '/api/users', { name: 'E', email: 'e@test.local', password: 'password-123', role: 'editor' });
  ed = await login('e@test.local');
  setSetting('auto_enabled', '1');
});
after(() => server.close());

const waBody = (id, from, text, pid = '555') => ({ object: 'whatsapp_business_account', entry: [{ id: 'w', changes: [{ field: 'messages', value: { metadata: { phone_number_id: pid }, contacts: [{ wa_id: from, profile: { name: 'Sari' } }], messages: [{ id, from, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });

test('migrasi auto_rules menerima whatsapp dan tabel baru ada', () => {
  assert.match(get("SELECT sql FROM sqlite_master WHERE name='auto_rules'").sql, /whatsapp/);
  for (const t of ['wa_numbers', 'wa_out', 'meta_catalogs']) assert.ok(get('SELECT 1 AS x FROM sqlite_master WHERE name=?', t), t);
});
test('nomor WhatsApp: hanya admin, token tidak bocor, phone id unik', async () => {
  assert.equal((await call(ed, 'PUT', '/api/wa/numbers/wardrobe', { phone_number_id: '555', token: 'EAAx' })).status, 403);
  const r = await call(admin, 'PUT', '/api/wa/numbers/wardrobe', { phone_number_id: '555', waba_id: '9', display_phone: '+62 811', token: 'EAAxsecret' });
  assert.equal(r.status, 200); assert.ok(!JSON.stringify(r.json).includes('EAAxsecret'));
  assert.equal((await call(admin, 'PUT', '/api/wa/numbers/kids', { phone_number_id: '555', token: 'EAAy' })).status, 400);
  const cfg = await call(ed, 'GET', '/api/wa/config');
  assert.equal(cfg.status, 200); assert.equal(cfg.json.verify_token, undefined); assert.match(cfg.json.webhook_url, /\/webhooks\/whatsapp$/);
});
test('parseWhatsApp memetakan pesan dan mengabaikan status', () => {
  const ev = A.parseWhatsApp(waBody('wamid.1', '62812', 'Kak ready?'));
  assert.equal(ev.length, 1); assert.equal(ev[0].platform, 'whatsapp'); assert.equal(ev[0].kind, 'dm'); assert.equal(ev[0].brand.id, 'wardrobe'); assert.equal(ev[0].ext_id, 'wamid.1');
  assert.equal(A.parseWhatsApp({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '555' }, statuses: [{ id: 'x' }] } }] }] }).length, 0);
  assert.equal(A.parseWhatsApp(waBody('wamid.2', '62812', 'x', 'tidak-dikenal')).length, 0);
});
test('webhook WhatsApp: tanda tangan wajib, pesan masuk jadi event, duplikat diabaikan', async () => {
  setSetting('meta_app_id', 'app1');
  const T = await import('../src/threads.js'); const { encrypt } = await import('../src/crypto.js');
  setSetting('meta_app_secret_enc', encrypt('s3cret'));
  const raw = JSON.stringify(waBody('wamid.9', '628550001111', 'Halo kak'));
  const post = (sig) => fetch(`${base}/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', ...(sig ? { 'x-hub-signature-256': sig } : {}) }, body: raw });
  assert.equal((await post(null)).status, 401);
  const sig = `sha256=${crypto.createHmac('sha256', 's3cret').update(raw).digest('hex')}`;
  assert.equal((await post(sig)).status, 200); assert.equal((await post(sig)).status, 200);
  assert.equal(all("SELECT * FROM auto_events WHERE platform='whatsapp' AND ext_id='wamid.9'").length, 1);
  void T;
});
test('jendela 24 jam: kirim teks ditolak di luar jendela, diterima di dalam', async () => {
  const out = await call(ed, 'POST', '/api/wa/send', { brand_id: 'wardrobe', to: '628999000111', text: 'Halo' });
  assert.equal(out.status, 409);
  const inn = await call(ed, 'POST', '/api/wa/send', { brand_id: 'wardrobe', to: '628550001111', text: 'Halo juga kak' });
  assert.equal(inn.status, 200); assert.equal(inn.json.dryRun, true);
  assert.equal((await call(ed, 'POST', '/api/wa/send', { brand_id: 'wardrobe', to: '12', text: 'x' })).status, 400);
  const th = await call(ed, 'GET', '/api/wa/conversations/wardrobe/628550001111');
  assert.ok(th.json.messages.some((m) => m.dir === 'in') && th.json.messages.some((m) => m.dir === 'out'));
  assert.ok((await call(ed, 'GET', '/api/wa/conversations?brand=wardrobe')).json.length >= 1);
});
test('template: hanya manager+, validasi nama, dry-run berhasil', async () => {
  assert.equal((await call(ed, 'POST', '/api/wa/send-template', { brand_id: 'wardrobe', to: '628999000111', name: 'promo', language: 'id', params: [] })).status, 403);
  assert.equal((await call(admin, 'POST', '/api/wa/send-template', { brand_id: 'wardrobe', to: '628999000111', name: 'Promo Besar', language: 'id', params: [] })).status, 400);
  const ok = await call(admin, 'POST', '/api/wa/send-template', { brand_id: 'wardrobe', to: '628999000111', name: 'promo_baru', language: 'id', params: ['Sari'] });
  assert.equal(ok.status, 200);
  assert.ok((await call(ed, 'GET', '/api/wa/wardrobe/templates')).json.length >= 1);
});
test('Kotak Pesan DM memuat bagian whatsapp', async () => {
  const r = await call(ed, 'GET', '/api/pesan?type=dm');
  assert.equal(r.status, 200); assert.ok(Array.isArray(r.json.whatsapp)); assert.ok(r.json.whatsapp.some((x) => x.author));
});

test('katalog: pemetaan item, harga coret jadi sale_price, masalah ditandai', () => {
  const a = C.toItem({ id: 'P1', name: 'Kebaya Rosa', price: 150000, original_price: 200000, in_stock: true, image: 'https://x/i.jpg', url: 'https://delova.id/p1', category: 'kebaya' }, 'Delova Wardrobe');
  assert.equal(a.item.price, '200000 IDR'); assert.equal(a.item.sale_price, '150000 IDR'); assert.equal(a.item.availability, 'in stock'); assert.deepEqual(a.issues, []);
  const b = C.toItem({ id: 'P2', name: 'Tanpa gambar', price: 0, in_stock: false }, 'Delova Kids');
  assert.equal(b.item.availability, 'out of stock'); assert.ok(b.issues.length >= 2);
});
test('katalog: sync live memakai items_batch per 200 item dan menyimpan hasil', async () => {
  setSetting('threads_mode', 'live'); setSetting('meta_app_id', 'app1');
  C.setToken('CATTOKEN'); C.saveCatalogId('wardrobe', '777');
  setSetting('store_api_key_enc', (await import('../src/crypto.js')).encrypt('k'));
  const calls = [];
  const real = globalThis.fetch;
  const products = Array.from({ length: 230 }, (_, i) => ({ id: `P${i}`, name: `Produk ${i}`, price: 10000, in_stock: true, image: 'https://x/i.jpg', url: 'https://delova.id/p' }));
  globalThis.fetch = async (url, opt) => {
    const u = String(url);
    if (u.startsWith(base)) return real(url, opt);
    if (u.includes('/products')) return new Response(JSON.stringify({ data: products.slice(0, u.includes('page=2') ? 0 : 100), meta: { total_pages: 3 } }));
    calls.push({ u, opt }); return new Response(JSON.stringify({ handles: ['h1'], validation_status: [] }));
  };
  try {
    const r = await call(admin, 'POST', '/api/catalog/wardrobe/sync', {});
    assert.equal(r.status, 200); assert.equal(r.json.simulated, false);
  } finally { globalThis.fetch = real; setSetting('threads_mode', 'sim'); }
  assert.ok(calls.length >= 1); assert.match(calls[0].u, /\/777\/items_batch$/); assert.match(calls[0].opt.headers.authorization, /CATTOKEN/);
  const sent = JSON.parse(new URLSearchParams(String(calls[0].opt.body)).get('requests'));
  assert.equal(sent[0].method, 'UPDATE'); assert.ok(sent.length <= 200);
  assert.ok(JSON.parse(get('SELECT last_result FROM meta_catalogs WHERE brand_id=?', 'wardrobe').last_result).sent >= 1);
});
test('katalog: rute pengaturan hanya admin/manager', async () => {
  assert.equal((await call(ed, 'GET', '/api/catalog/config')).status, 403);
  const r = await call(admin, 'GET', '/api/catalog/config'); assert.equal(r.status, 200); assert.equal(r.json.token_set, true); assert.ok(!JSON.stringify(r.json).includes('CATTOKEN'));
});

test('oEmbed: parsing URL ketat dan dry-run', async () => {
  assert.equal(CR.parsePostUrl('https://www.instagram.com/p/Cabc_12/').platform, 'instagram');
  assert.equal(CR.parsePostUrl('https://www.instagram.com/delova/reel/Xy1/').platform, 'instagram');
  assert.equal(CR.parsePostUrl('https://www.threads.com/@delova/post/Abc12').platform, 'threads');
  assert.equal(CR.parsePostUrl('https://threads.net/@delova/post/Abc12').platform, 'threads');
  assert.equal(CR.parsePostUrl('https://evil.com/p/abc/'), null);
  assert.equal(CR.parsePostUrl('http://www.instagram.com/p/abc/'), null);
  assert.equal(CR.parsePostUrl('https://www.instagram.com.evil.com/p/abc/'), null);
  const r = await call(ed, 'GET', `/api/embed?url=${encodeURIComponent('https://www.instagram.com/p/Cabc_12/')}`);
  assert.equal(r.status, 200); assert.match(r.json.html, /instagram-media/);
  const t = await call(ed, 'GET', `/api/embed?url=${encodeURIComponent('https://www.threads.com/@delova/post/Abc12')}`);
  assert.match(t.json.html, /text-post-media/);
  assert.equal((await call(ed, 'GET', '/api/embed?url=nope')).status, 400);
  assert.equal((await call(ed, 'GET', '/api/embed/own')).status, 200);
});
