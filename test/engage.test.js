import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-engage-'));
process.env.APP_SECRET = 'test-secret';
process.env.THREADS_DRY_RUN = 'true';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'password-123';
delete process.env.THREADS_APP_ID; delete process.env.INSTAGRAM_APP_ID; delete process.env.ANTHROPIC_API_KEY;

const { createApp, bootstrapAdmin } = await import('../src/server.js');
const TR = await import('../src/triggers.js');
const { run, get, all, now, uid, setSetting } = await import('../src/db.js');
let server, base, admin, mgr, ed;
const call = async (ck, method, p, body) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'hub', cookie: ck }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
const login = async (email) => (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'hub' }, body: JSON.stringify({ email, password: 'password-123' }) })).headers.get('set-cookie')).split(';')[0];
before(async () => {
  bootstrapAdmin(); server = createApp().listen(0); base = `http://127.0.0.1:${server.address().port}`;
  admin = await login('admin@test.local');
  for (const [n, e, r] of [['M', 'm@test.local', 'manager'], ['E', 'e@test.local', 'editor']]) await call(admin, 'POST', '/api/users', { name: n, email: e, password: 'password-123', role: r });
  mgr = await login('m@test.local'); ed = await login('e@test.local');
  setSetting('auto_enabled', '1');
});
after(() => server.close());
const ev = (ck, platform, kind, text, username = 'pembeli_contoh') => call(ck, 'POST', '/api/auto/test-event', { brand_id: 'wardrobe', platform, kind, text, username });

test('pencocokan keyword: kata utuh, tanpa aksen, mode any/all', () => {
  assert.ok(TR.hasKeyword('Kak, HARGA-nya berapa?', 'harga'));
  assert.ok(!TR.hasKeyword('hargai karyaku', 'harga'));
  assert.ok(TR.hasKeyword('minta katalog dong', 'minta katalog'));
  assert.ok(TR.matches({ keywords: ['a1', 'b2'], match_mode: 'all' }, 'a1 dan b2'));
  assert.ok(!TR.matches({ keywords: ['a1', 'b2'], match_mode: 'all' }, 'a1 saja'));
  assert.match(TR.render('Hai {nama}', { username: 'sari' }), /@sari/);
  assert.equal(TR.render('A\n---\nB', { seed: 'x' }).length, 1);
});
test('CRUD aturan: validasi, auto hanya admin, viewer tidak bisa', async () => {
  assert.equal((await call(mgr, 'POST', '/api/auto/triggers', { brand_id: 'wardrobe', platform: 'instagram', name: 'x', keywords: '', reply_text: 'a' })).status, 400);
  assert.equal((await call(mgr, 'POST', '/api/auto/triggers', { brand_id: 'wardrobe', platform: 'instagram', name: 'x', keywords: 'harga', reply_text: 'a', mode: 'auto' })).status, 403);
  assert.equal((await call(ed, 'POST', '/api/auto/triggers', { brand_id: 'wardrobe', platform: 'instagram', name: 'x', keywords: 'harga', reply_text: 'a' })).status, 403);
  const r = await call(mgr, 'POST', '/api/auto/triggers', { brand_id: 'wardrobe', platform: 'instagram', name: 'Tanya harga', keywords: 'harga, price list', reply_text: 'Halo {nama}, cek di Shopee ya 😊', dm_text: 'Ini katalog kami ya Kak.' });
  assert.equal(r.status, 200); assert.deepEqual(r.json.keywords, ['harga', 'price list']); assert.equal(r.json.mode, 'draft');
});
test('komentar cocok keyword -> draft aturan (tanpa LLM), DM ikut terkirim saat disetujui', async () => {
  const e = await ev(admin, 'instagram', 'comment', 'Kak harga kebaya ini berapa?');
  assert.equal(e.json.status, 'pending'); assert.equal(e.json.category, 'keyword'); assert.match(e.json.note, /Aturan keyword/); assert.match(e.json.draft, /@pembeli_contoh/); assert.ok(e.json.dm_text);
  const ok = await call(mgr, 'POST', `/api/auto/events/${e.json.id}/approve`, {});
  assert.equal(ok.status, 200); assert.equal(ok.json.status, 'sent'); assert.equal(ok.json.dm_status, 'sent'); assert.match(ok.json.note, /DM terkirim/);
});
test('penulis yang sama kena jeda; kata lain tidak memicu aturan', async () => {
  const again = await ev(admin, 'instagram', 'comment', 'harga berapa kak?');
  assert.equal(again.json.status, 'ignored'); assert.match(again.json.note, /sudah dibalas/);
  const other = await ev(admin, 'instagram', 'comment', 'cantik banget', 'orang_lain');
  assert.notEqual(other.json.category, 'keyword');
});
test('aturan hanya-DM dan aturan terbatas pada post tertentu', async () => {
  await call(mgr, 'POST', '/api/auto/triggers', { brand_id: 'wardrobe', platform: 'threads', name: 'Reseller', keywords: 'reseller', reply_text: 'Silakan DM ya Kak', media_id: 'post_lain' });
  const e = await ev(admin, 'threads', 'reply', 'bisa reseller?');
  assert.notEqual(e.json.category, 'keyword');
});
test('mode auto (dibuat admin) mengirim sendiri', async () => {
  const t = await call(admin, 'POST', '/api/auto/triggers', { brand_id: 'wardrobe', platform: 'threads', name: 'Ready stok', keywords: 'ready', reply_text: 'Ready Kak 😊', mode: 'auto' });
  assert.equal(t.json.mode, 'auto');
  const e = await ev(admin, 'threads', 'reply', 'ready ukuran M?', 'budi');
  assert.equal(e.json.status, 'sent'); assert.equal(e.json.decided_by, null);
});

test('peluang: scan menyaring dan menyimpan; draf butuh model AI; kirim dibatasi', async () => {
  const s = await call(ed, 'POST', '/api/opps/scan', { brand_id: 'wardrobe', keywords: 'kebaya' });
  assert.equal(s.status, 200); assert.ok(s.json.added >= 1);
  assert.equal((await call(ed, 'POST', '/api/opps/scan', { brand_id: 'wardrobe', keywords: 'kebaya' })).json.added, 0);
  assert.equal((await call(ed, 'POST', '/api/opps/draft', { ids: [] })).status, 409);
  const o = (await call(ed, 'GET', '/api/opps')).json.items[0];
  run("UPDATE opps SET status='drafted', draft='Setuju Kak, kebaya sage memang adem 😊' WHERE id=?", o.id);
  setSetting('opp_daily_cap', '1');
  const sent = await call(ed, 'POST', `/api/opps/${o.id}/send`, {});
  assert.equal(sent.status, 200); assert.equal(sent.json.status, 'sent');
  const o2 = (await call(ed, 'GET', '/api/opps?status=open')).json.items[0];
  run("UPDATE opps SET status='drafted', draft='Halo' WHERE id=?", o2.id);
  const blocked = await call(ed, 'POST', `/api/opps/${o2.id}/send`, {});
  assert.equal(blocked.status, 409); assert.match(blocked.json.error, /Batas|jeda/);
  const link = await call(ed, 'POST', `/api/opps/${o2.id}/send`, { text: 'cek https://x.co' });
  assert.equal(link.status, 409);
});

test('persetujuan massal: daftar, setujui/tolak terpilih, jadwal massal, peran', async () => {
  const mk = (tbl, extra) => { const id = uid(); const t = now(); if (tbl === 'posts') run("INSERT INTO posts(id,brand_id,text,status,scheduled_at,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", id, 'wardrobe', 'Post ' + id, 'pending_approval', extra, 'x', t, t); else run("INSERT INTO ig_posts(id,brand_id,caption,status,scheduled_at,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", id, 'wardrobe', 'Cap ' + id, 'pending_approval', extra, 'x', t, t); return id; };
  const p1 = mk('posts', new Date(Date.now() + 86400e3).toISOString()); const p2 = mk('posts', null); const i1 = mk('ig_posts', null);
  const e1 = (await ev(admin, 'instagram', 'comment', 'harga kebaya sage berapa?', 'siti')).json;
  const list = await call(mgr, 'GET', '/api/approvals');
  assert.ok(list.json.posts.length >= 2 && list.json.igposts.length >= 1 && list.json.counts.events >= 1, JSON.stringify([list.json.counts, e1.status, e1.note]));
  assert.equal((await call(ed, 'GET', '/api/approvals')).json.posts.length, 0);
  // tanpa jadwal -> p2 & i1 ditolak sistem, p1 lolos
  const r1 = await call(mgr, 'POST', '/api/approvals/bulk', { action: 'approve', items: [{ type: 'post', id: p1 }, { type: 'post', id: p2 }, { type: 'igpost', id: i1 }] });
  assert.equal(r1.json.ok, 1); assert.equal(r1.json.failed, 2); assert.equal(get('SELECT status FROM posts WHERE id=?', p1).status, 'scheduled');
  const when = new Date(Date.now() + 2 * 86400e3).toISOString();
  const r2 = await call(mgr, 'POST', '/api/approvals/bulk', { action: 'approve', scheduled_at: when, items: [{ type: 'post', id: p2 }, { type: 'igpost', id: i1 }] });
  assert.equal(r2.json.ok, 2); assert.equal(get('SELECT scheduled_at FROM ig_posts WHERE id=?', i1).scheduled_at, when);
  if (e1.status === 'pending') {
    const r3 = await call(mgr, 'POST', '/api/approvals/bulk', { action: 'reject', items: [{ type: 'event', id: e1.id }] });
    assert.equal(r3.json.ok, 1); assert.equal(get('SELECT status FROM auto_events WHERE id=?', e1.id).status, 'rejected');
  }
  const r4 = await call(ed, 'POST', '/api/approvals/bulk', { action: 'approve', items: [{ type: 'post', id: p1 }] });
  assert.equal(r4.json.failed, 1);
  assert.equal((await call(mgr, 'POST', '/api/approvals/bulk', { action: 'approve', items: [] })).status, 400);
});

test('jadwal massal: interval untuk item tanpa jadwal di Pusat Persetujuan', async () => {
  const t = now(); const ids = [];
  for (let i = 0; i < 3; i++) { const id = uid(); ids.push(id); run("INSERT INTO ig_posts(id,brand_id,caption,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?)", id, 'wardrobe', 'x' + i, 'pending_approval', 'x', t, t); }
  const start = new Date(Date.now() + 3600e3).toISOString();
  const r = await call(mgr, 'POST', '/api/approvals/bulk', { action: 'approve', scheduled_at: start, interval_minutes: 30, items: ids.map((id) => ({ type: 'igpost', id })) });
  assert.equal(r.json.ok, 3);
  const at = ids.map((id) => Date.parse(get('SELECT scheduled_at FROM ig_posts WHERE id=?', id).scheduled_at));
  assert.equal(at[1] - at[0], 30 * 60e3); assert.equal(at[2] - at[1], 30 * 60e3);
});
test('rangkaian Story: satu slide per media, berurutan; bulk IG; kalender memuat Instagram', async () => {
  const media = ['https://example.com/s1.jpg', 'https://example.com/s2.jpg', 'https://example.com/s3.mp4'];
  const start = new Date(Date.now() + 7200e3).toISOString();
  assert.equal((await call(ed, 'POST', '/api/ig/posts/story-series', { brand_id: 'kids', media_urls: media })).status, 400);
  assert.equal((await call(ed, 'POST', '/api/ig/posts/story-series', { brand_id: 'kids', media_urls: ['http://x/a.jpg'], scheduled_at: start })).status, 400);
  const r = await call(ed, 'POST', '/api/ig/posts/story-series', { brand_id: 'kids', media_urls: media, scheduled_at: start, interval_minutes: 5, submit: true });
  assert.equal(r.status, 201); assert.equal(r.json.length, 3);
  assert.ok(r.json.every((p) => p.kind === 'story' && p.status === 'pending_approval' && p.media_urls.length === 1));
  assert.equal(Date.parse(r.json[1].scheduled_at) - Date.parse(r.json[0].scheduled_at), 5 * 60e3);
  const ids = r.json.map((p) => p.id);
  assert.equal((await call(ed, 'POST', '/api/ig/posts/bulk', { action: 'approve', ids })).status, 403);
  const ok = await call(mgr, 'POST', '/api/ig/posts/bulk', { action: 'approve', ids });
  assert.equal(ok.json.done.length, 3);
  assert.equal(get('SELECT status FROM ig_posts WHERE id=?', ids[0]).status, 'scheduled');
  const from = new Date(Date.now() - 86400e3).toISOString(); const to = new Date(Date.now() + 5 * 86400e3).toISOString();
  const cal = await call(mgr, 'GET', `/api/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&brand=kids`);
  assert.ok(cal.json.filter((x) => x.platform === 'instagram' && x.kind === 'story').length >= 3);
});
