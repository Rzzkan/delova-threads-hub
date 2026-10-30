// Memeriksa bentuk permintaan ke Instagram API (mode LIVE) dengan fetch palsu — tanpa memanggil Meta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-iglive-'));
process.env.APP_SECRET = 'test-secret';
process.env.APP_BASE_URL = 'https://threads.test.local';
delete process.env.THREADS_DRY_RUN; delete process.env.INSTAGRAM_APP_ID;

const I = await import('../src/instagram.js');
const { setSetting } = await import('../src/db.js');
const { encrypt } = await import('../src/crypto.js');
setSetting('threads_mode', 'live');
setSetting('ig_app_id', '99887766554433');
setSetting('ig_app_secret_enc', encrypt('secretsecretsecretsecret1234'));

const acc = { brand_id: 'wardrobe', ig_user_id: '1784', token_enc: encrypt('TOK') };
const brand = { id: 'wardrobe', name: 'Delova Wardrobe', username: 'delovawardrobe' };
const log = [];
const reply = (fn) => { globalThis.fetch = async (url, opts = {}) => { const u = new URL(url); const rec = { method: opts.method || 'GET', path: u.pathname, q: Object.fromEntries(u.searchParams), body: opts.body ? (opts.headers?.['content-type']?.includes('json') ? JSON.parse(opts.body) : Object.fromEntries(new URLSearchParams(String(opts.body)))) : null, host: u.host }; log.push(rec); const out = fn(rec); return { ok: !out.__err, status: out.__err ? 400 : 200, json: async () => (out.__err ? { error: { message: out.__err } } : out) }; }; };

test('live: bukan simulasi bila ada kredensial & mode live', () => {
  assert.equal(I.isDryRun(), false);
});

test('live: OAuth — tukar kode lalu token jangka panjang lalu profil', async () => {
  log.length = 0;
  reply((r) => (r.path === '/oauth/access_token' ? { access_token: 'SHORT', user_id: 1784 } : r.path === '/access_token' ? { access_token: 'LONG', expires_in: 5184000 } : { user_id: '1784', username: 'delovawardrobe', account_type: 'BUSINESS', followers_count: 1234 }));
  const r = await I.exchangeCode('CODE');
  assert.equal(r.token, 'LONG'); assert.equal(r.username, 'delovawardrobe'); assert.equal(r.followers, 1234);
  assert.equal(log[0].host, 'api.instagram.com'); assert.equal(log[0].method, 'POST');
  assert.equal(log[0].body.grant_type, 'authorization_code'); assert.equal(log[0].body.client_id, '99887766554433');
  assert.equal(log[1].host, 'graph.instagram.com'); assert.equal(log[1].q.grant_type, 'ig_exchange_token'); assert.equal(log[1].q.access_token, 'SHORT');
  assert.equal(log[2].q.access_token, 'LONG');
});

test('live: publish foto tunggal, carousel, reels, story', async () => {
  let n = 0;
  const mk = (r) => (r.path.endsWith('/media_publish') ? { id: 'PUB1' } : r.path.endsWith('/media') ? { id: `C${++n}` } : r.q.fields === 'permalink' ? { permalink: 'https://www.instagram.com/p/XYZ/' } : { status_code: 'FINISHED' });

  log.length = 0; reply(mk);
  let r = await I.publish(acc, brand, { kind: 'feed', caption: 'Hai', media_urls: JSON.stringify(['https://x.test/a.jpg']) });
  assert.equal(r.permalink, 'https://www.instagram.com/p/XYZ/');
  const c1 = log.find((x) => x.path.endsWith('/media'));
  assert.equal(c1.body.image_url, 'https://x.test/a.jpg'); assert.equal(c1.body.caption, 'Hai'); assert.equal(c1.body.access_token, 'TOK');
  assert.ok(c1.path.includes('/1784/media'));
  assert.equal(log.find((x) => x.path.endsWith('/media_publish')).body.creation_id, 'C1');

  log.length = 0; n = 0; reply(mk);
  await I.publish(acc, brand, { kind: 'feed', caption: 'Slide', media_urls: JSON.stringify(['https://x.test/a.jpg', 'https://x.test/b.jpg']) });
  const items = log.filter((x) => x.path.endsWith('/media') && x.body.is_carousel_item);
  assert.equal(items.length, 2);
  const parent = log.find((x) => x.body?.media_type === 'CAROUSEL');
  assert.equal(parent.body.children, 'C1,C2'); assert.equal(parent.body.caption, 'Slide');

  log.length = 0; reply(mk);
  await I.publish(acc, brand, { kind: 'reels', caption: 'Reel', media_urls: JSON.stringify(['https://x.test/v.mp4']) });
  const reel = log.find((x) => x.path.endsWith('/media'));
  assert.equal(reel.body.media_type, 'REELS'); assert.equal(reel.body.video_url, 'https://x.test/v.mp4'); assert.equal(reel.body.share_to_feed, 'true');

  log.length = 0; reply(mk);
  await I.publish(acc, brand, { kind: 'story', caption: '', media_urls: JSON.stringify(['https://x.test/s.jpg']) });
  const st = log.find((x) => x.path.endsWith('/media'));
  assert.equal(st.body.media_type, 'STORIES'); assert.equal(st.body.image_url, 'https://x.test/s.jpg'); assert.equal(st.body.caption, undefined);
});

test('live: komentar, balas, sembunyikan', async () => {
  log.length = 0;
  reply((r) => (r.path.endsWith('/comments') ? { data: [{ id: 'c1', text: 'Halo', username: 'a', replies: { data: [{ id: 'r1', text: 'Hai' }] } }] } : { id: 'new', success: true }));
  const cs = await I.listComments(acc, brand, 'M1');
  assert.equal(cs[0].replies.length, 1);
  assert.match(log[0].q.fields, /replies\{/);
  await I.replyComment(acc, brand, 'c1', 'Terima kasih');
  assert.ok(log[1].path.endsWith('/c1/replies')); assert.equal(log[1].body.message, 'Terima kasih');
  await I.hideComment(acc, brand, 'c1', true);
  assert.ok(log[2].path.endsWith('/c1')); assert.equal(log[2].body.hide, 'true');
});

test('live: DM — daftar, jendela 24 jam, kirim (JSON)', async () => {
  const recent = new Date(Date.now() - 3600e3).toISOString(); const old = new Date(Date.now() - 40 * 3600e3).toISOString();
  log.length = 0;
  reply((r) => (r.path.endsWith('/conversations') ? { data: [
    { id: 'cv1', updated_time: recent, participants: { data: [{ id: '1784' }, { id: 'U1', username: 'pembeli' }] }, messages: { data: [{ message: 'Ready kak?', from: { id: 'U1' }, created_time: recent }] } },
    { id: 'cv2', updated_time: old, participants: { data: [{ id: '1784' }, { id: 'U2', username: 'lama' }] }, messages: { data: [{ message: 'ok', from: { id: 'U2' }, created_time: old }] } },
    { id: 'cv3', updated_time: recent, participants: { data: [{ id: '1784' }, { id: 'U3', username: 'sudahdibalas' }] }, messages: { data: [{ message: 'Siap', from: { id: '1784' }, created_time: recent }] } },
  ] } : { message_id: 'm1' }));
  const cv = await I.listConversations(acc, brand);
  assert.equal(log[0].q.platform, 'instagram');
  assert.deepEqual(cv.map((c) => [c.participant.username, c.can_reply]), [['pembeli', true], ['lama', false], ['sudahdibalas', false]]);
  await I.sendMessage(acc, brand, 'U1', 'Ready Kak 😊');
  const s = log[1];
  assert.equal(s.method, 'POST'); assert.ok(s.path.endsWith('/1784/messages')); assert.equal(s.q.access_token, 'TOK');
  assert.deepEqual(s.body, { recipient: { id: 'U1' }, message: { text: 'Ready Kak 😊' } });
});

test('live: insight toleran terhadap metrik yang tak tersedia', async () => {
  reply((r) => {
    if (r.q.fields === 'followers_count') return { followers_count: 4321 };
    if (r.q.metric === 'saves') return { __err: 'metric not supported' };
    return { data: [{ name: r.q.metric, total_value: { value: 10 } }] };
  });
  const a = await I.accountInsights(acc, brand, 14);
  assert.equal(a.metrics.reach, 10); assert.equal(a.metrics.saves, null); assert.equal(a.followers, 4321);
  reply((r) => (r.q.metric === 'views' ? { __err: 'nope' } : { data: [{ name: r.q.metric, values: [{ value: 7 }] }] }));
  const m = await I.mediaInsights(acc, brand, 'M1');
  assert.equal(m.reach, 7); assert.equal(m.views, null);
});

test('live: galat Meta diteruskan sebagai IgError berpesan jelas', async () => {
  reply(() => ({ __err: 'Application does not have permission for this action' }));
  await assert.rejects(() => I.replyComment(acc, brand, 'c1', 'x'), (e) => e instanceof I.IgError && /permission/.test(e.message));
  await assert.rejects(() => I.listComments({}, brand, 'M1'), /belum terhubung/);
});
