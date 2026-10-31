// Katalog Meta (Catalog API) dan Embed Post (oEmbed).
import * as C from './catalog.js';
import * as T from './threads.js';
import * as I from './instagram.js';
import { all, get, getSetting, setSetting } from './db.js';
import { storeReady } from './store-api.js';

const V = 'https://graph.facebook.com/v23.0';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Kenali URL post. Mengembalikan { platform, url } atau null. Hanya host resmi yang diterima. */
export function parsePostUrl(raw) {
  let u; try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'instagram.com' && /^\/(?:[\w.]+\/)?(p|reel|reels|tv)\/[\w-]+\/?$/.test(u.pathname)) return { platform: 'instagram', url: `https://www.instagram.com${u.pathname.replace(/\/?$/, '/')}` };
  if ((host === 'threads.net' || host === 'threads.com') && /^\/@[\w.]+\/post\/[\w-]+\/?$/.test(u.pathname)) return { platform: 'threads', url: `https://www.threads.com${u.pathname.replace(/\/$/, '')}` };
  return null;
}
export const threadsSnippet = (url) => `<blockquote class="text-post-media" data-text-post-permalink="${esc(url)}" data-text-post-version="0" style="max-width:540px;width:100%"><a href="${esc(url)}">Lihat di Threads</a></blockquote>\n<script async src="https://www.threads.com/embed.js"></script>`;

export async function oembed(parsed) {
  if (parsed.platform === 'threads') return { platform: 'threads', html: threadsSnippet(parsed.url), generated: true, note: 'Snippet dibuat lokal mengikuti format embed Threads; belum diverifikasi lewat API oEmbed Threads.' };
  if (I.isDryRun()) return { platform: 'instagram', simulated: true, author_name: 'delovawardrobe', thumbnail_url: null, html: `<blockquote class="instagram-media" data-instgrm-permalink="${esc(parsed.url)}" data-instgrm-version="14"><a href="${esc(parsed.url)}">Lihat di Instagram</a></blockquote>\n<script async src="//www.instagram.com/embed.js"></script>` };
  const { appId, appSecret } = T.creds();
  if (!appId || !appSecret) throw new Error('Meta App ID/Secret belum diisi (Pengaturan Meta).');
  const q = new URLSearchParams({ url: parsed.url, omitscript: 'false', access_token: `${appId}|${appSecret}` });
  const r = await fetch(`${V}/instagram_oembed?${q}`, { signal: AbortSignal.timeout(10000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const m = j.error?.message || `HTTP ${r.status}`;
    throw new Error(/permission|feature|oembed/i.test(m) ? `${m} — fitur "Meta oEmbed Read" harus disetujui di App Review.` : m);
  }
  return { platform: 'instagram', html: j.html, author_name: j.author_name, thumbnail_url: j.thumbnail_url, title: j.title };
}

export function mountCatalog(api, { need, ah, bad, A, humanOnly, brandOr404 }) {
  const view = (b) => { const c = C.catalogOf(b.id); let last = null; try { last = c?.last_result ? JSON.parse(c.last_result) : null; } catch { /* abaikan */ } return { id: b.id, name: b.name, color: b.color, catalog_id: c?.catalog_id || '', last_sync_at: c?.last_sync_at || null, last }; };
  api.get('/catalog/config', need('manager'), (req, res) => res.json({ simulated: C.isDryRun(), token_set: C.hasToken(), auto: C.autoOn(), store_ready: storeReady(), brands: all('SELECT * FROM brands ORDER BY sort').map(view) }));
  api.put('/catalog/config', need('admin'), humanOnly, (req, res) => {
    const b = req.body || {};
    if (b.clear_token) C.setToken(''); else if (b.token) C.setToken(b.token);
    if (b.auto !== undefined) setSetting('catalog_auto', b.auto ? '1' : '0');
    A(req, 'catalog.config', { token: !!b.token, clear: !!b.clear_token, auto: b.auto }); res.json({ ok: true });
  });
  api.put('/catalog/:brand', need('manager'), humanOnly, (req, res) => {
    const b = brandOr404(req.params.brand); if (!b) return bad(res, 'Brand tidak ditemukan.', 404);
    const c = C.saveCatalogId(b.id, req.body?.catalog_id); A(req, 'catalog.id', { brand: b.id }); res.json(view(b) || c);
  });
  api.post('/catalog/:brand/preview', need('manager'), ah(async (req, res) => {
    const b = brandOr404(req.params.brand); if (!b) return bad(res, 'Brand tidak ditemukan.', 404);
    if (!storeReady()) return bad(res, 'API produk delova.id belum dikonfigurasi.', 409);
    try { const r = await C.buildItems(b); res.json({ total: r.total, bad: r.bad, sample: r.rows.slice(0, 8).map((x) => ({ ...x.item, issues: x.issues })), problems: r.rows.filter((x) => x.issues.length).slice(0, 20).map((x) => ({ id: x.item.id, title: x.item.title, issues: x.issues })) }); }
    catch (e) { bad(res, e.message, 502); }
  }));
  api.post('/catalog/:brand/sync', need('manager'), humanOnly, ah(async (req, res) => {
    const b = brandOr404(req.params.brand); if (!b) return bad(res, 'Brand tidak ditemukan.', 404);
    try { const r = await C.syncBrand(b); A(req, 'catalog.sync', { brand: b.id, sent: r.sent, simulated: r.simulated }); res.json(r); }
    catch (e) { bad(res, e.message, e instanceof C.CatalogError ? 409 : 502); }
  }));

  // oEmbed: hasil tidak disimpan (ketentuan Meta); hanya dikembalikan ke penelepon.
  api.get('/embed', need('editor'), ah(async (req, res) => {
    const p = parsePostUrl(req.query.url);
    if (!p) return bad(res, 'URL tidak dikenali. Gunakan tautan post Instagram (/p/, /reel/) atau Threads (/@akun/post/...).');
    try { res.set('cache-control', 'no-store'); res.json({ url: p.url, ...(await oembed(p)) }); } catch (e) { bad(res, e.message, 502); }
  }));
  api.get('/embed/own', need('editor'), (req, res) => {
    const brand = req.query.brand ? String(req.query.brand) : null;
    const w = brand ? ' AND brand_id=?' : ''; const a = brand ? [brand] : [];
    const ig = all(`SELECT brand_id, caption AS text, permalink, published_at FROM ig_posts WHERE status='published' AND permalink IS NOT NULL AND kind<>'story'${w} ORDER BY published_at DESC LIMIT 30`, ...a).map((x) => ({ ...x, platform: 'instagram' }));
    const th = all(`SELECT brand_id, text, permalink, published_at FROM posts WHERE status='published' AND permalink IS NOT NULL${w} ORDER BY published_at DESC LIMIT 30`, ...a).map((x) => ({ ...x, platform: 'threads' }));
    res.json([...ig, ...th].sort((x, y) => String(y.published_at).localeCompare(String(x.published_at))).slice(0, 40));
  });
}
