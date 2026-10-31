// Kotak Pesan: daftar gabungan komentar/reply/mention dan DM, dipisah per platform dan diberi penanda brand.
import * as T from './threads.js';
import * as I from './instagram.js';
import { all, get } from './db.js';
import { summarizeThreads, summarizeInstagram } from './trends.js';

const TTL = 60_000;
const cache = new Map();
const cached = async (key, fresh, fn) => {
  const c = cache.get(key);
  if (!fresh && c && Date.now() - c.at < TTL) return c.v;
  const v = await fn();
  cache.set(key, { at: Date.now(), v });
  return v;
};
const iso = (t) => { const d = new Date(t || 0); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
const byTime = (a, b) => String(b.at || '').localeCompare(String(a.at || ''));

export function mountPesan(api, { need, ah, bad }) {
  const brandRows = () => all('SELECT id, name, color, username FROM brands ORDER BY sort');

  // ---- sumber live (dibatasi 5 post terbaru per akun agar hemat kuota API)
  async function igComments(b) {
    const acc = I.accountOf(b.id);
    if (!acc?.token_enc && !I.isDryRun()) return { skipped: 'Instagram belum terhubung' };
    const media = (await I.listMedia(acc || {}, b, 5)).filter((m) => (m.comments_count ?? 1) > 0);
    const out = [];
    for (const m of media) {
      for (const c of await I.listComments(acc || {}, b, m.id).catch(() => [])) {
        const mine = (c.replies || []).some((r) => String(r.username || '').toLowerCase() === String(acc?.username || b.username || 'delova').toLowerCase());
        out.push({ ext_id: c.id, kind: 'comment', author: c.username, text: c.text, at: iso(c.timestamp), permalink: m.permalink || null, post: (m.caption || '').slice(0, 100), hidden: !!c.hidden, answered: mine, source: 'live' });
      }
    }
    return { items: out };
  }
  async function thReplies(b) {
    if (!b.token_enc && !T.isDryRun(b)) return { skipped: 'Threads belum terhubung' };
    const posts = all("SELECT * FROM posts WHERE brand_id=? AND status='published' AND threads_media_id IS NOT NULL ORDER BY published_at DESC LIMIT 5", b.id);
    const out = [];
    for (const p of posts) {
      for (const r of await T.listReplies(b, p.threads_media_id).catch(() => [])) {
        out.push({ ext_id: r.id, kind: 'reply', author: r.username, text: r.text, at: iso(r.timestamp), permalink: null, post: (p.text || '').slice(0, 100), hidden: r.hide_status === 'HIDDEN', source: 'live' });
      }
    }
    return { items: out };
  }
  async function igDms(b) {
    const acc = I.accountOf(b.id);
    if (!acc?.token_enc && !I.isDryRun()) return { skipped: 'Instagram belum terhubung' };
    const list = await I.listConversations(acc || {}, b);
    return { items: list.map((c) => ({ ext_id: c.id, kind: 'dm', author: c.participant?.username || c.participant?.id || '-', text: c.last_message || '', at: iso(c.updated_time), conv_id: c.id, recipient_id: c.participant?.id || null, can_reply: !!c.can_reply, source: 'live' })) };
  }

  // ---- sumber tersimpan (webhook + tabel mention Threads)
  const stored = (platform, kinds, brand) => {
    const ph = kinds.map(() => '?').join(',');
    return all(`SELECT * FROM auto_events WHERE platform=? AND kind IN (${ph}) ${brand ? 'AND brand_id=?' : ''} ORDER BY received_at DESC LIMIT 300`, platform, ...kinds, ...(brand ? [brand] : []));
  };

  api.get('/pesan', need('editor'), ah(async (req, res) => {
    const type = req.query.type === 'dm' ? 'dm' : 'komentar';
    const fresh = req.query.fresh === '1';
    const brands = brandRows();
    const only = brands.find((b) => b.id === req.query.brand);
    if (req.query.brand && !only) return bad(res, 'Brand tidak ditemukan.', 404);
    const targets = only ? [only] : brands;
    const out = { instagram: [], threads: [], whatsapp: [], notes: [], fetched_at: new Date().toISOString() };
    const seen = new Set();
    const push = (platform, brand, x) => {
      const k = `${platform}:${x.ext_id}`;
      if (x.ext_id && seen.has(k)) return;
      if (x.ext_id) seen.add(k);
      out[platform].push({ ...x, platform, brand_id: brand.id });
    };

    await Promise.all(targets.map(async (b) => {
      const full = get('SELECT * FROM brands WHERE id=?', b.id);
      const jobs = type === 'dm'
        ? [['instagram', () => igDms(full)]]
        : [['instagram', () => igComments(full)], ['threads', () => thReplies(full)]];
      for (const [platform, fn] of jobs) {
        try {
          const r = await cached(`${type}:${platform}:${b.id}`, fresh, fn);
          if (r.skipped) out.notes.push({ brand_id: b.id, platform, text: r.skipped });
          for (const x of r.items || []) push(platform, b, x);
        } catch (e) { out.notes.push({ brand_id: b.id, platform, text: `Gagal memuat: ${String(e.message || e).slice(0, 140)}`, error: true }); }
      }
    }));

    // Gabungkan data webhook (termasuk mention yang tidak bisa ditarik lewat API list).
    const kinds = type === 'dm' ? ['dm'] : ['comment', 'reply', 'mention'];
    for (const platform of type === 'dm' ? ['instagram', 'threads', 'whatsapp'] : ['instagram', 'threads']) {
      for (const e of stored(platform, kinds, only?.id)) {
        const b = brands.find((x) => x.id === e.brand_id); if (!b) continue;
        const exist = out[platform].find((x) => x.ext_id === e.ext_id);
        if (exist) { exist.event_id = e.id; exist.status = e.status; continue; }
        push(platform, b, { ext_id: e.ext_id, kind: e.kind, author: e.author_username || e.author_id || '-', text: e.text, at: iso(e.received_at), permalink: e.permalink, event_id: e.id, status: e.status, simulated: !!e.simulated, source: 'webhook', conv_id: e.kind === 'dm' ? e.target_id : undefined, recipient_id: e.kind === 'dm' ? e.author_id : undefined });
      }
    }
    if (type === 'komentar') {
      // Mention Threads hasil pengumpulan berkala.
      const ms = all(`SELECT * FROM mentions ${only ? 'WHERE brand_id=?' : ''} ORDER BY posted_at DESC LIMIT 300`, ...(only ? [only.id] : []));
      const dup = new Set(out.threads.filter((x) => x.kind === 'mention').map((x) => x.ext_id));
      for (const m of ms) {
        const b = brands.find((x) => x.id === m.brand_id); if (!b || dup.has(m.media_id)) continue;
        push('threads', b, { ext_id: `m:${m.id}`, kind: 'mention', author: m.username, text: m.text || '', at: iso(m.posted_at), permalink: m.permalink, status: m.status, source: 'mention' });
      }
    } else {
      out.threads_dm_note = 'Threads belum menyediakan API pesan langsung (DM), jadi DM Threads tidak bisa ditampilkan di Hub. Balas DM Threads langsung dari aplikasi Threads.';
    }
    out.instagram.sort(byTime); out.threads.sort(byTime); out.whatsapp.sort(byTime);
    res.json(out);
  }));
}

// ---- Tren (Threads: pencarian publik; Instagram: performa konten akun sendiri)
export function mountTrends(api, { need, ah, bad, A }) {
  api.post('/trends', need('editor'), ah(async (req, res) => {
    const f = req.body || {};
    const brandsAll = all('SELECT * FROM brands ORDER BY sort');
    const searchBrand = brandsAll.find((b) => b.id === f.brand_id) || brandsAll.find((b) => b.token_enc) || brandsAll[0];
    const kws = [...new Set((Array.isArray(f.keywords) ? f.keywords : String(f.keywords || '').split(','))
      .map((s) => String(s).trim().replace(/^#/, '')).filter((s) => s.length >= 2 && s.length <= 100))].slice(0, 6);
    const days = Math.min(Math.max(Number(f.days) || 7, 1), 30);
    const out = { days, keywords: kws, threads: null, instagram: null, notes: [] };
    if (kws.length) {
      if (!searchBrand.token_enc && !T.isDryRun(searchBrand)) out.notes.push('Akun Threads untuk mencari belum terhubung.');
      else {
        const by = {};
        await Promise.all(kws.map(async (k) => {
          try { by[k] = await cached(`tr:${searchBrand.id}:${k}:${days}`, false, () => T.keywordSearch(searchBrand, { q: k, searchType: 'RECENT', days, limit: 60 })); }
          catch (e) { by[k] = []; out.notes.push(`Kata kunci “${k}” gagal: ${String(e.message || e).slice(0, 120)}`); }
        }));
        out.threads = { ...summarizeThreads(by, days), search_brand: searchBrand.id, sample: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.slice(0, 5).map((p) => ({ username: p.username, text: String(p.text || '').slice(0, 280), permalink: p.permalink, timestamp: p.timestamp }))])) };
        A(req, 'trends.search', { kws });
      }
    } else out.notes.push('Isi kata kunci untuk melihat tren di Threads.');
    // Instagram: tidak ada pencarian hashtag publik di API Instagram Login, jadi pakai performa konten akun sendiri.
    const ids = Array.isArray(f.ig_brands) && f.ig_brands.length ? f.ig_brands : brandsAll.map((b) => b.id);
    const items = [];
    await Promise.all(brandsAll.filter((b) => ids.includes(b.id)).map(async (b) => {
      const acc = I.accountOf(b.id);
      if (!acc?.token_enc && !I.isDryRun()) return;
      try {
        const media = await cached(`trig:${b.id}`, false, async () => {
          const m = await I.listMedia(acc || {}, b, 24); const r = [];
          for (let i = 0; i < m.length; i += 6) r.push(...await Promise.all(m.slice(i, i + 6).map(async (x) => ({ ...x, insights: await I.mediaInsights(acc || {}, b, x.id).catch(() => ({})) }))));
          return r;
        });
        for (const m of media) items.push({ ...m, brand_id: b.id });
      } catch (e) { out.notes.push(`Instagram ${b.name}: ${String(e.message || e).slice(0, 100)}`); }
    }));
    out.instagram = items.length ? summarizeInstagram(items) : null;
    out.instagram_note = 'API Instagram tidak menyediakan pencarian hashtag/konten publik untuk akun yang login lewat Instagram Login, jadi tren Instagram dihitung dari performa 24 post terakhir akun brand sendiri.';
    res.json(out);
  }));
}
