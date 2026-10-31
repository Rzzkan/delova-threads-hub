// Catalog API (Meta Commerce): sinkron produk delova.id → katalog Meta per brand lewat items_batch.
import { get, run, all, now, getSetting, setSetting } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { modeSetting } from './threads.js';
import { listAllProducts, storeReady } from './store-api.js';

const V = 'https://graph.facebook.com/v23.0';
export class CatalogError extends Error {}
/** Simulasi bila saklar mode = sim, atau mode auto dengan THREADS_DRY_RUN. Token yang kosong baru gagal saat dipakai. */
export const isDryRun = () => { const m = modeSetting(); return m === 'sim' || (m === 'auto' && process.env.THREADS_DRY_RUN === 'true'); };
const cut = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

export function token() {
  const enc = getSetting('catalog_token_enc'); if (!enc) return '';
  try { return decrypt(enc); } catch { return ''; }
}
export const hasToken = () => !!getSetting('catalog_token_enc');
export function setToken(t) { setSetting('catalog_token_enc', t ? encrypt(String(t).trim()) : ''); }
export const catalogOf = (brandId) => get('SELECT * FROM meta_catalogs WHERE brand_id=?', brandId);
export function saveCatalogId(brandId, id) {
  const cid = String(id || '').replace(/\D/g, '');
  if (!cid) { run('DELETE FROM meta_catalogs WHERE brand_id=?', brandId); return null; }
  run('INSERT INTO meta_catalogs(brand_id,catalog_id) VALUES(?,?) ON CONFLICT(brand_id) DO UPDATE SET catalog_id=excluded.catalog_id', brandId, cid);
  return catalogOf(brandId);
}

const idr = (n) => `${Math.round(Number(n))} IDR`;
/** Petakan produk delova.id ke item katalog Meta. Mengembalikan { item, issues[] }. */
export function toItem(p, brandName) {
  const issues = [];
  if (!p.image) issues.push('Gambar kosong');
  if (!p.url) issues.push('Tautan produk kosong');
  if (!(Number(p.price) > 0)) issues.push('Harga tidak valid');
  const sale = Number(p.original_price) > Number(p.price) && Number(p.price) > 0;
  const title = cut(p.name, 100);
  const description = cut(`${p.name}${p.category ? ` — kategori ${p.category}` : ''}. ${brandName}. Tersedia di Shopee dan delova.id.`, 5000);
  const item = {
    id: String(p.id).slice(0, 100), title, description,
    availability: p.in_stock ? 'in stock' : 'out of stock', condition: 'new',
    price: idr(sale ? p.original_price : p.price), ...(sale ? { sale_price: idr(p.price) } : {}),
    link: p.url || p.shopee_url || '', image_link: p.image || '', brand: brandName,
  };
  return { item, issues };
}
export const toRequest = (item) => ({ method: 'UPDATE', data: { ...item, image_link: item.image_link } });

export async function buildItems(brand) {
  const products = await listAllProducts(brand.id);
  const rows = products.map((p) => ({ p, ...toItem(p, `Delova ${brand.name.replace(/^delova\s*/i, '') || brand.name}`) }));
  return { rows, total: rows.length, bad: rows.filter((r) => r.issues.length).length };
}

async function postBatch(catalogId, tok, reqs) {
  const body = new URLSearchParams({ item_type: 'PRODUCT_ITEM', allow_upsert: 'true', requests: JSON.stringify(reqs) });
  const r = await fetch(`${V}/${catalogId}/items_batch`, { method: 'POST', headers: { authorization: `Bearer ${tok}` }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new CatalogError(j.error?.error_user_msg || j.error?.message || `Catalog API HTTP ${r.status}`);
  return j;
}

export async function syncBrand(brand) {
  const c = catalogOf(brand.id);
  if (!c?.catalog_id) throw new CatalogError('Catalog ID belum diisi untuk brand ini.');
  if (!storeReady()) throw new CatalogError('API produk delova.id belum dikonfigurasi (Auto Reply → Data produk).');
  const { rows, total, bad } = await buildItems(brand);
  const good = rows.filter((r) => !r.issues.length);
  const dry = isDryRun();
  if (!dry && !token()) throw new CatalogError('Token katalog belum diisi (Katalog Meta → Pengaturan).');
  let sent = 0; const handles = []; const errors = [];
  if (!dry) {
    for (let i = 0; i < good.length; i += 200) {
      const chunk = good.slice(i, i + 200);
      const j = await postBatch(c.catalog_id, token(), chunk.map((r) => ({ method: 'UPDATE', data: r.item })));
      sent += chunk.length; (j.handles || []).forEach((h) => handles.push(h));
      for (const v of j.validation_status || []) if (v.errors?.length) errors.push(`${v.retailer_id || '?'}: ${cut(v.errors.map((e) => e.message).join('; '), 120)}`);
    }
  } else sent = good.length;
  const result = { at: now(), simulated: dry, total, sent, skipped: bad, errors: errors.slice(0, 20), handles: handles.slice(0, 5) };
  run('UPDATE meta_catalogs SET last_sync_at=?, last_result=? WHERE brand_id=?', result.at, JSON.stringify(result), brand.id);
  return result;
}
export const autoOn = () => getSetting('catalog_auto') === '1';
export async function syncDue() {
  if (!autoOn() || !storeReady()) return;
  const cut6h = new Date(Date.now() - 6 * 3600e3).toISOString();
  for (const c of all('SELECT * FROM meta_catalogs WHERE catalog_id IS NOT NULL')) {
    if (c.last_sync_at && c.last_sync_at > cut6h) continue;
    const b = get('SELECT * FROM brands WHERE id=?', c.brand_id); if (!b) continue;
    try { await syncBrand(b); } catch (e) { run('UPDATE meta_catalogs SET last_sync_at=?, last_result=? WHERE brand_id=?', now(), JSON.stringify({ at: now(), error: e.message }), c.brand_id); }
  }
}
