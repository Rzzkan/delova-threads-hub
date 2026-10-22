/**
 * Integrasi Claude (Anthropic API) di dalam dashboard: ide post, perbaikan teks, saran balasan,
 * rencana mingguan, dan analisis performa, semuanya mengikuti brand voice tiap akun.
 */
import Anthropic from '@anthropic-ai/sdk';
import { threadsLength } from './scheduler.js';

export const aiEnabled = () => !!process.env.ANTHROPIC_API_KEY;
export const aiModel = () => process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';

let client;
const getClient = () => {
  if (!aiEnabled()) {
    const e = new Error('Fitur Claude belum aktif. Isi ANTHROPIC_API_KEY di file .env lalu restart server.');
    e.status = 503;
    throw e;
  }
  return (client ||= new Anthropic());
};

const RULES = `Kamu adalah social media specialist untuk brand fashion Indonesia Delova di platform Threads.
Aturan wajib:
- Bahasa Indonesia kecuali diminta lain. Gaya conversational, bukan iklan kaku.
- Setiap post maksimal 500 karakter. Baris pertama harus hook yang membuat orang berhenti scroll.
- Threads bukan Instagram: hindari tumpukan hashtag. Maksimal 1 topic tag (tanpa tanda # di field topic_tag, tanpa titik/&).
- Jangan mengarang harga, diskon, stok, klaim bahan, atau testimoni yang tidak ada di brief.
- Variasikan sudut pandang antar opsi (pertanyaan, cerita singkat, opini ringan, tips, promo halus), jangan 5 versi yang mirip.
- Balas HANYA dengan JSON valid sesuai format yang diminta, tanpa teks lain, tanpa code fence.`;

function brandBlock(b) {
  const pillars = JSON.parse(b.pillars || '[]');
  return `PROFIL BRAND: ${b.name}
Deskripsi: ${b.description || '-'}
Brand voice: ${b.voice || '-'}
Content pillars: ${pillars.join('; ') || '-'}
Hashtag/topic yang lazim: ${b.hashtags || '-'}
Lakukan: ${b.dos || '-'}
Hindari: ${b.donts || '-'}`;
}

async function ask(brand, prompt, maxTokens = 3000) {
  const msg = await getClient().messages.create({
    model: aiModel(),
    max_tokens: maxTokens,
    system: [
      { type: 'text', text: RULES },
      { type: 'text', text: brandBlock(brand), cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: prompt }],
  });
  return msg.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
}

function parseJson(text) {
  const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const start = Math.min(...['[', '{'].map((c) => (t.indexOf(c) === -1 ? Infinity : t.indexOf(c))));
  const end = Math.max(t.lastIndexOf(']'), t.lastIndexOf('}'));
  if (!Number.isFinite(start) || end < start) throw new Error('Respons Claude tidak berformat JSON. Coba lagi.');
  return JSON.parse(t.slice(start, end + 1));
}

const fit = (items) =>
  items.map((it) => ({ ...it, length: threadsLength(it.text || ''), too_long: threadsLength(it.text || '') > 500 }));

export const clampCount = (n, min = 5, max = 10) => Math.min(max, Math.max(min, Number(n) || min));

export async function generatePosts(brand, { brief, count, angle }) {
  const n = clampCount(count);
  const out = await ask(
    brand,
    `Buat ${n} opsi post Threads yang berbeda sudut pandangnya.
Brief: ${brief}
${angle ? `Arahan sudut/pillar: ${angle}` : ''}
Format: [{"text": "...", "angle": "label sudut singkat", "topic_tag": "satu kata/frasa atau kosong"}]`,
  );
  return fit(parseJson(out));
}

export async function improvePost(brand, { text, instruction, count }) {
  const n = clampCount(count, 3, 5);
  const out = await ask(
    brand,
    `Perbaiki post berikut dan berikan ${n} versi alternatif.
Post asli:
"""${text}"""
Instruksi: ${instruction || 'Buat lebih kuat hook-nya, lebih ringkas, dan ajak interaksi.'}
Format: [{"text": "...", "angle": "apa yang diubah"}]`,
  );
  return fit(parseJson(out));
}

export async function suggestReplies(brand, { postText, replies, count }) {
  const n = clampCount(count, 3, 5);
  const list = replies.map((r, i) => `${i + 1}. @${r.username}: ${r.text}`).join('\n');
  const out = await ask(
    brand,
    `Post kami: """${postText || '(tidak tersedia)'}"""
Reply dari audiens:
${list}
Untuk SETIAP reply, buat ${n} opsi balasan singkat (maks 280 karakter), ramah dan sesuai brand voice. Jangan menjanjikan stok/harga/pengiriman yang tidak diketahui; arahkan ke Shopee/DM bila perlu.
Format: [{"index": 1, "options": ["...", "..."]}]`,
  );
  return parseJson(out);
}

export async function weeklyPlan(brand, { goal, days, promo }) {
  const n = clampCount(days, 5, 14);
  const out = await ask(
    brand,
    `Susun rencana konten Threads ${n} hari (1 post per hari) untuk minggu depan.
Tujuan minggu ini: ${goal || 'menaikkan engagement dan traffic ke Shopee'}
${promo ? `Info promo yang boleh disebut: ${promo}` : 'Tidak ada promo spesifik; jangan menyebut diskon.'}
Seimbangkan content pillars (rasio kira-kira 1 promo : 3 non-promo). Tulis naskah post lengkap.
Format: [{"day": 1, "time": "HH:MM (WIB, jam aktif audiens)", "pillar": "...", "text": "...", "topic_tag": ""}]`,
    4500,
  );
  return fit(parseJson(out));
}

export async function analyze(brand, { account, posts }) {
  const rows = posts
    .map((p) => `- [${p.metrics.views ?? 0} views, ${p.metrics.likes ?? 0} like, ${p.metrics.replies ?? 0} reply, ${p.metrics.reposts ?? 0} repost] ${p.text.slice(0, 160).replace(/\n/g, ' ')}`)
    .join('\n');
  const out = await ask(
    brand,
    `Data akun (periode terakhir): ${JSON.stringify(account)}
Performa post:
${rows || '(belum ada post terbit)'}
Berikan analisis singkat dan tindakan. Format: {"summary": "2-3 kalimat", "whats_working": ["..."], "whats_not": ["..."], "next_actions": ["minimal 5 tindakan konkret minggu depan"], "post_ideas": ["minimal 5 ide post baru"]}`,
  );
  return parseJson(out);
}
