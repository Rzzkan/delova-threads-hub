/**
 * Klien API Delova Store (https://delova.id/api/v1): produk, stok, toko. Read-only, kunci API per pemakai.
 * Dipakai Auto Reply dan fitur AI pembuat post agar harga/stok/varian/tautan berasal dari data nyata, bukan karangan model.
 * Stok bukan realtime (disalin dari Shopee lewat sinkronisasi terjadwal): selalu sertakan usia datanya.
 */
import { getSetting } from './db.js';
import { decrypt } from './crypto.js';

export class StoreError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}
const isLocal = (h) => ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(h);
export function validateBaseUrl(u) {
  let x; try { x = new URL(u); } catch { return 'Base URL tidak valid.'; }
  if (x.username || x.password || x.search) return 'Base URL tidak boleh memuat kredensial atau query.';
  if (x.protocol !== 'https:' && !(x.protocol === 'http:' && isLocal(x.hostname))) return 'Base URL harus HTTPS.';
  return null;
}
export function storeConfig() {
  let key = '';
  try { const enc = getSetting('store_api_key_enc'); key = enc ? decrypt(enc) : ''; } catch { /* kunci tak terbaca */ }
  key ||= process.env.STORE_API_KEY || '';
  return {
    baseUrl: (getSetting('store_api_url') || 'https://delova.id/api/v1').replace(/\/+$/, ''),
    key, useReply: getSetting('store_use_reply') === '1', useDirect: getSetting('store_use_direct') === '1', usePosts: getSetting('store_use_posts') === '1',
  };
}
export const storeReady = () => !!storeConfig().key;

/* ---- permintaan dengan cache, batas laju lokal, dan jeda saat 429 ---- */
const cache = new Map();
const stamps = [];
let cooldownUntil = 0;
const TTL = 5 * 60_000;
const LOCAL_LIMIT = 40; // di bawah batas server (60/menit per kunci)

export async function storeGet(path, params = {}, { fresh = false } = {}) {
  const cfg = storeConfig();
  if (!cfg.key) throw new StoreError('API produk belum dikonfigurasi.', 503);
  const bad = validateBaseUrl(cfg.baseUrl); if (bad) throw new StoreError(bad, 400);
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)]));
  const url = `${cfg.baseUrl}${path}${qs.size ? `?${qs}` : ''}`;
  const hit = cache.get(url);
  if (!fresh && hit && Date.now() - hit.at < TTL) return hit.data;
  if (Date.now() < cooldownUntil) throw new StoreError('API produk sedang dibatasi (rate limit). Coba lagi sebentar.', 429);
  const nowMs = Date.now();
  while (stamps.length && nowMs - stamps[0] > 60_000) stamps.shift();
  if (stamps.length >= LOCAL_LIMIT) throw new StoreError('Terlalu banyak permintaan ke API produk. Coba lagi sebentar.', 429);
  stamps.push(nowMs);
  const r = await fetch(url, { headers: { 'x-api-key': cfg.key, accept: 'application/json' }, signal: AbortSignal.timeout(7000), redirect: 'error' }).catch((e) => { throw new StoreError(`API produk tidak terjangkau: ${e.message}`, 502); });
  const j = await r.json().catch(() => ({}));
  if (r.status === 429) { cooldownUntil = Date.now() + (Number(r.headers.get('retry-after')) || 30) * 1000; throw new StoreError('API produk terkena rate limit.', 429); }
  if (!r.ok) throw new StoreError(`API produk: ${j.error?.message || `HTTP ${r.status}`}`.slice(0, 200), r.status);
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  cache.set(url, { at: Date.now(), data: j });
  return j;
}
export const clearStoreCache = () => { cache.clear(); cooldownUntil = 0; };

export async function testStore() {
  const t = Date.now();
  const r = await storeGet('/shops', {}, { fresh: true });
  const shops = r.data || [];
  return { ms: Date.now() - t, shops: shops.length, products: shops.reduce((n, s) => n + (s.product_count || 0), 0), last_sync_at: shops.map((s) => s.last_sync_at).filter(Boolean).sort().pop() || null };
}

/* ---- pencarian produk dari teks bebas ---- */
const STOP = new Set(('yang dan di ke dari untuk dengan atau ini itu ada adalah apa apakah bisa dong deh nih sih kak kakak min admin mba mbak mas bang gan sis halo hai hi selamat pagi siang sore malam terima kasih makasih thanks tolong mohon minta boleh mau ingin pengen pingin beli pesan order checkout ready stok stock tersedia kosong habis restock harga berapa brp murah mahal diskon promo ukuran size warna model jenis tipe seri varian cod ongkir kirim pengiriman gratis dm chat wa whatsapp link tautan produk barang item kok ya yaa yah nggak ngga gak enggak tidak tak belum sudah udah masih lagi juga saja aja banget sangat sekali lebih paling kalau kalo jika agar supaya karena biar buat bagi pada dalam oleh saya aku kami kita anda kamu dia mereka nya lah kah pun cuma hanya semua beberapa banyak sedikit cantik bagus keren suka mantap').split(/\s+/));
export function keywords(text, max = 5) {
  const t = String(text || '').toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/@\w+/g, ' ').replace(/#/g, ' ').replace(/[^\p{L}\p{N}\s-]/gu, ' ');
  const out = [];
  for (const w of t.split(/\s+/)) {
    if (w.length < 3 || /^\d+$/.test(w) || STOP.has(w) || (w.endsWith('nya') && STOP.has(w.slice(0, -3))) || out.includes(w)) continue;
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}
const rp = (n) => (n == null ? null : `Rp${Number(n).toLocaleString('id-ID')}`);
const ago = (iso) => { if (!iso) return 'tidak diketahui'; const h = (Date.now() - Date.parse(iso)) / 3600e3; return h < 1 ? 'kurang dari 1 jam lalu' : h < 48 ? `${Math.round(h)} jam lalu` : `${Math.round(h / 24)} hari lalu`; };
const cut = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

function line(p, i) {
  const price = p.price != null ? `${rp(p.price)}${p.original_price && p.original_price > p.price ? ` (harga coret ${rp(p.original_price)})` : ''}` : 'harga tidak tersedia';
  return `${i}. ${cut(p.name, 120)} | brand: ${p.brand} | ${price} | stok total: ${p.stock ?? '?'} | ${p.in_stock ? 'tersedia' : 'HABIS'} | link: ${p.url || p.shopee_url || '-'} | id: ${p.id}`;
}
function variantLines(d) {
  const vs = (d.variants || []).slice(0, 14);
  if (!vs.length) return '';
  return `   Varian: ${vs.map((v) => `${cut(v.name, 40)} [SKU ${v.sku || '-'}] ${v.price != null && v.price !== d.price ? rp(v.price) + ' ' : ''}stok ${v.stock ?? '?'}`).join('; ')}`;
}

/**
 * Cari produk yang relevan dengan beberapa teks (pesan audiens, caption post, brief) lalu susun blok fakta untuk prompt.
 * Mengembalikan { facts, used[], ok } — facts kosong bila tidak ada kata kunci yang berarti.
 * Tidak pernah melempar: kegagalan API menjadi pesan agar model tidak mengarang harga/stok.
 */
export async function productFacts(brandId, texts, { detail = 2, featured = false } = {}) {
  const cfg = storeConfig();
  if (!cfg.key) return { facts: '', used: [], ok: false, reason: 'not_configured' };
  const kws = [...new Set(texts.flatMap((t) => keywords(t)))].slice(0, 6);
  if (!kws.length && !featured) return { facts: '', used: [], ok: true };
  try {
    const found = new Map();
    const scope = ['wardrobe', 'kids', 'scarf', 'daily'].includes(brandId) ? brandId : '';
    const run = async (brand) => {
      for (const kw of kws.slice(0, 4)) {
        const r = await storeGet('/products', { q: kw, brand, limit: 6 });
        for (const p of r.data || []) { const e = found.get(p.id) || { p, hits: 0 }; e.hits += 1; found.set(p.id, e); }
      }
    };
    if (kws.length) { await run(scope); if (!found.size && scope) await run(''); }
    let lastSync = null;
    if (!found.size && featured) {
      const r = await storeGet('/products', { brand: scope, in_stock: 'true', sort: 'terlaris', limit: 5 });
      for (const p of r.data || []) found.set(p.id, { p, hits: 0 }); lastSync = r.meta?.last_sync_at;
    }
    const ranked = [...found.values()].sort((a, b) => b.hits - a.hits || (b.p.sold || 0) - (a.p.sold || 0)).slice(0, 4).map((x) => x.p);
    if (!ranked.length) return { facts: `DATA PRODUK (delova.id): tidak ada produk di katalog yang cocok dengan kata kunci "${kws.join(', ')}". Jangan menyebut harga/stok/ketersediaan; arahkan ke katalog atau eskalasi.`, used: [], ok: true };
    const details = [];
    for (const p of ranked.slice(0, detail)) { try { details.push(await storeGet(`/products/${encodeURIComponent(p.id)}`)); } catch { details.push(null); } }
    lastSync ||= ranked.map((p) => p.synced_at).filter(Boolean).sort().pop();
    const body = ranked.map((p, i) => `${line(p, i + 1)}${details[i] ? `\n${variantLines(details[i])}` : ''}`).join('\n');
    const stale = lastSync && Date.now() - Date.parse(lastSync) > 24 * 3600e3 ? ' PERINGATAN: data lebih dari 24 jam, stok bisa sudah berubah.' : '';
    const facts = `DATA PRODUK TERKINI dari delova.id (sinkron terakhir: ${ago(lastSync)}; stok adalah PERKIRAAN, Shopee tetap sumber kebenaran saat pesanan masuk.${stale}):\n${body}`;
    return { facts, used: ranked.map((p) => p.name), ok: true };
  } catch (e) {
    return { facts: `DATA PRODUK (delova.id): TIDAK TERSEDIA saat ini (${cut(e.message, 80)}). Jangan menyebut harga, stok, atau ketersediaan; eskalasi bila ditanya.`, used: [], ok: false, reason: e.message };
  }
}

/** Pencarian untuk dashboard/MCP: hasil ringkas dan aman. */
export async function searchCatalog({ q, brand, in_stock, sort, limit = 10, page = 1 }) {
  const r = await storeGet('/products', { q: cut(q, 80), brand, in_stock, sort, page, limit: Math.min(30, Math.max(1, Number(limit) || 10)) });
  return { products: (r.data || []).map((p) => ({ id: p.id, slug: p.slug, name: p.name, brand: p.brand, price: p.price, original_price: p.original_price, stock: p.stock, in_stock: p.in_stock, sold: p.sold, rating: p.rating, url: p.url, shopee_url: p.shopee_url, image: p.image, synced_at: p.synced_at })), meta: r.meta };
}
export async function productDetail(ref) {
  const d = await storeGet(`/products/${encodeURIComponent(ref)}`);
  return { ...d, description: cut(d.description, 1500), images: (d.images || []).slice(0, 8) };
}

/** Seluruh produk satu brand (paginasi, maks 10 halaman x 100) untuk sinkron katalog. */
export async function listAllProducts(brand, { maxPages = 10 } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const r = await storeGet('/products', { brand, limit: 100, page }, { fresh: page === 1 });
    out.push(...(r.data || []));
    if (page >= (r.meta?.total_pages || 1)) break;
  }
  return out;
}
