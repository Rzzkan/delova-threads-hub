// Analisis tren: Threads (pencarian kata kunci publik) + Instagram (performa konten akun sendiri).
const STOP = new Set(('yang dan di ke dari untuk dengan ini itu atau juga pada adalah akan sudah belum bisa kak ada nya aja saja kalau karena jadi lebih sangat banget yuk ayo kami kita kamu anda mereka saya aku the and for you with this that from have are was not but your our')
  .split(' '));
const norm = (s) => String(s || '').toLowerCase();
export const hashtags = (t) => [...new Set((String(t || '').replace(/https?:\/\/\S+/g, ' ').match(/#[\p{L}\p{N}_]{2,40}/gu) || []).map(norm))];
export const terms = (t) => [...new Set((norm(t).replace(/https?:\/\/\S+|[#@][\p{L}\p{N}_.]+/gu, ' ').match(/[\p{L}]{4,24}/gu) || []).filter((w) => !STOP.has(w)))];
const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);

export function summarizeThreads(byKeyword, days) {
  const day = new Map(); const tag = new Map(); const term = new Map(); const users = new Map();
  const cut = Date.now() - (days / 2) * 86400e3; let late = 0, early = 0;
  const rows = [];
  for (const [kw, posts] of Object.entries(byKeyword)) {
    const kwl = norm(kw);
    let l = 0, e = 0;
    for (const p of posts) {
      const ts = Date.parse(p.timestamp || '') || 0;
      if (ts >= cut) l++; else e++;
      const d = new Date(ts || Date.now()).toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' });
      day.set(d, (day.get(d) || 0) + 1);
      for (const h of hashtags(p.text)) tag.set(h, (tag.get(h) || 0) + 1);
      for (const w of terms(p.text)) if (w !== kwl) term.set(w, (term.get(w) || 0) + 1);
      if (p.username) users.set(p.username, (users.get(p.username) || 0) + 1);
    }
    late += l; early += e;
    rows.push({ keyword: kw, posts: posts.length, recent_half: l, older_half: e, momentum: e ? Math.round(((l - e) / e) * 100) : (l ? 100 : 0) });
  }
  return {
    keywords: rows.sort((a, b) => b.posts - a.posts),
    hashtags: top(tag, 12).map(([k, n]) => ({ tag: k, posts: n })),
    terms: top(term, 15).map(([k, n]) => ({ term: k, posts: n })),
    authors: top(users, 8).map(([k, n]) => ({ username: k, posts: n })),
    daily: [...day.entries()].sort().map(([d, n]) => ({ day: d, posts: n })),
    momentum: early ? Math.round(((late - early) / early) * 100) : (late ? 100 : 0),
    total: late + early,
  };
}

// items: [{brand_id, caption, media_type, timestamp, insights:{...}, like_count, comments_count}]
export function summarizeInstagram(items) {
  const score = (m) => Number(m.insights?.total_interactions ?? ((m.like_count || 0) + (m.comments_count || 0))) || 0;
  const reach = (m) => Number(m.insights?.reach ?? 0) || 0;
  const tags = new Map(); const types = new Map(); const hours = new Map();
  for (const m of items) {
    const s = score(m);
    for (const h of hashtags(m.caption)) { const c = tags.get(h) || { n: 0, sum: 0 }; c.n++; c.sum += s; tags.set(h, c); }
    const t = types.get(m.media_type || '-') || { n: 0, sum: 0 }; t.n++; t.sum += s; types.set(m.media_type || '-', t);
    const ts = Date.parse(m.timestamp || '');
    if (ts) { const hr = Number(new Date(ts).toLocaleString('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', hour12: false })) % 24; const c = hours.get(hr) || { n: 0, sum: 0 }; c.n++; c.sum += s; hours.set(hr, c); }
  }
  const avg = (c) => Math.round(c.sum / c.n);
  return {
    total: items.length,
    top_posts: items.slice().sort((a, b) => score(b) - score(a)).slice(0, 8).map((m) => ({ brand_id: m.brand_id, caption: String(m.caption || '').slice(0, 140), permalink: m.permalink, media_type: m.media_type, interactions: score(m), reach: reach(m), at: m.timestamp })),
    hashtags: [...tags.entries()].map(([tag, c]) => ({ tag, posts: c.n, avg_interactions: avg(c) })).sort((a, b) => b.avg_interactions - a.avg_interactions || b.posts - a.posts).slice(0, 12),
    formats: [...types.entries()].map(([type, c]) => ({ type, posts: c.n, avg_interactions: avg(c) })).sort((a, b) => b.avg_interactions - a.avg_interactions),
    best_hours: [...hours.entries()].filter(([, c]) => c.n >= 1).map(([hour, c]) => ({ hour, posts: c.n, avg_interactions: avg(c) })).sort((a, b) => b.avg_interactions - a.avg_interactions).slice(0, 4),
  };
}
