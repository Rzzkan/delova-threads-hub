import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Server Anthropic tiruan: memverifikasi prompt (brand voice masuk system) dan membalas JSON.
let lastReq;
const mock = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    lastReq = JSON.parse(b);
    const prompt = lastReq.messages[0].content;
    let out;
    if (prompt.includes('rencana konten')) out = Array.from({ length: 7 }, (_, i) => ({ day: i + 1, time: '19:30', pillar: 'Styling', text: `Hari ${i + 1}: styling scarf`, topic_tag: '' }));
    else if (prompt.includes('Reply dari audiens')) out = [{ index: 1, options: ['a', 'b', 'c', 'd', 'e'] }];
    else out = Array.from({ length: 5 }, (_, i) => ({ text: `Opsi ${i + 1} ${'x'.repeat(i === 4 ? 600 : 10)}`, angle: `sudut ${i}`, topic_tag: 'scarf' }));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: lastReq.model, content: [{ type: 'text', text: '```json\n' + JSON.stringify(out) + '\n```' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
  });
});
await new Promise((r) => mock.listen(0, r));

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ai-'));
process.env.APP_SECRET = 'test-secret';
process.env.THREADS_DRY_RUN = 'true';
process.env.ADMIN_EMAIL = 'a@test.local';
process.env.ADMIN_PASSWORD = 'password-123';
process.env.ANTHROPIC_API_KEY = 'sk-test';
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${mock.address().port}`;

const { createApp, bootstrapAdmin } = await import('../src/server.js');
let server, base, cookie;
const api = async (m, p, body) => {
  const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', 'x-requested-with': 'hub', cookie: cookie || '' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json(), headers: r.headers };
};
before(async () => {
  bootstrapAdmin();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  cookie = (await api('POST', '/api/login', { email: 'a@test.local', password: 'password-123' })).headers.get('set-cookie').split(';')[0];
});
after(() => { server.close(); mock.close(); });

test('generate: minimal 5 opsi, brand voice masuk system prompt, flag too_long', async () => {
  const r = await api('POST', '/api/ai/generate', { brand_id: 'scarf', brief: 'Scarf viscose motif baru', count: 2 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.variants.length >= 5);
  assert.equal(r.body.variants[4].too_long, true);
  assert.match(JSON.stringify(lastReq.system), /Delova Scarf/);
  assert.match(lastReq.messages[0].content, /Buat 5 opsi/); // count 2 dinaikkan ke minimum 5
});

test('weekly-plan memberi jadwal ISO per hari', async () => {
  const r = await api('POST', '/api/ai/weekly-plan', { brand_id: 'wardrobe', days: 7, goal: 'traffic Shopee' });
  assert.equal(r.body.items.length, 7);
  const d0 = new Date(r.body.items[0].scheduled_at), d1 = new Date(r.body.items[1].scheduled_at);
  assert.equal(d1 - d0, 86_400_000);
  assert.equal(new Date(d0.getTime() + 7 * 3600_000).getUTCHours(), 19); // 19:30 WIB
});

test('reply-suggestions mengembalikan 5 opsi', async () => {
  const r = await api('POST', '/api/ai/reply-suggestions', { brand_id: 'kids', post_text: 'x', replies: [{ username: 'u', text: 'ukuran?' }], count: 5 });
  assert.equal(r.body.suggestions[0].options.length, 5);
});
