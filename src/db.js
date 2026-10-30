import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const dir = path.resolve(process.env.DATA_DIR || 'data');
fs.mkdirSync(dir, { recursive: true });
export const db = new DatabaseSync(path.join(dir, 'hub.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS brands (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#8a5a44',
  description TEXT,
  voice TEXT,
  pillars TEXT NOT NULL DEFAULT '[]',
  hashtags TEXT,
  dos TEXT,
  donts TEXT,
  threads_user_id TEXT,
  username TEXT,
  token_enc TEXT,
  token_expires_at TEXT,
  token_refreshed_at TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('viewer','editor','manager','admin')),
  pass_hash TEXT,
  api_token_hash TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id),
  text TEXT NOT NULL,
  media_urls TEXT NOT NULL DEFAULT '[]',
  topic_tag TEXT,
  reply_control TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','pending_approval','scheduled','publishing','published','failed')),
  scheduled_at TEXT,
  published_at TEXT,
  threads_media_id TEXT,
  permalink TEXT,
  error TEXT,
  review_note TEXT,
  source TEXT NOT NULL DEFAULT 'dashboard',
  created_by TEXT,
  approved_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_posts_brand ON posts(brand_id);

CREATE TABLE IF NOT EXISTS insights_cache (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id TEXT PRIMARY KEY,
  access_hash TEXT NOT NULL,
  refresh_hash TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  access_expires INTEGER NOT NULL,
  refresh_expires INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_access ON oauth_tokens(access_hash);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh ON oauth_tokens(refresh_hash);

CREATE TABLE IF NOT EXISTS ig_accounts (
  brand_id TEXT PRIMARY KEY REFERENCES brands(id),
  ig_user_id TEXT,
  username TEXT,
  account_type TEXT,
  followers INTEGER,
  token_enc TEXT,
  token_expires_at TEXT,
  token_refreshed_at TEXT,
  granted_scopes TEXT,
  connected_at TEXT
);
CREATE TABLE IF NOT EXISTS ig_posts (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id),
  kind TEXT NOT NULL DEFAULT 'feed' CHECK (kind IN ('feed','reels','story')),
  caption TEXT NOT NULL DEFAULT '',
  media_urls TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','pending_approval','scheduled','publishing','published','failed')),
  scheduled_at TEXT,
  published_at TEXT,
  ig_media_id TEXT,
  permalink TEXT,
  error TEXT,
  review_note TEXT,
  created_by TEXT,
  approved_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ig_posts_due ON ig_posts(status, scheduled_at);
CREATE TABLE IF NOT EXISTS brand_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  changed_by TEXT,
  via TEXT,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS brand_history_brand ON brand_history(brand_id, id DESC);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  ts TEXT NOT NULL
);
`);

const clean = (a) => a.map((v) => (v === undefined ? null : v));
export const all = (sql, ...p) => db.prepare(sql).all(...clean(p));
export const get = (sql, ...p) => db.prepare(sql).get(...clean(p));
export const run = (sql, ...p) => db.prepare(sql).run(...clean(p));
export const now = () => new Date().toISOString();
export const uid = () => randomUUID();

/* ---------- Pengaturan / kebijakan Claude (diatur admin di dashboard) ---------- */
const SETTING_DEFAULTS = {
  claude_enabled: '1',   // saklar utama semua akses Claude (MCP / konektor / API token)
  claude_create: '1',    // boleh membuat & mengedit draft, mengajukan approval
  claude_approve: '0',   // boleh menyetujui/menjadwalkan/mengembalikan post
  claude_publish: '0',   // boleh publish langsung
  claude_reply: '0',     // boleh membalas / menyembunyikan reply
  claude_brand: '0',     // boleh mengubah profil brand (voice, pillar, hashtag, dos/donts, deskripsi)
  claude_daily_cap: '30', // maks draft baru dari Claude per 24 jam
  threads_mode: 'auto',  // auto = ikut THREADS_DRY_RUN di .env | live | sim
  meta_app_id: '',       // kredensial Meta global (App Secret disimpan terenkripsi)
  meta_app_secret_enc: '',
  threads_extra_scopes: '0', // 1 = minta izin riset/mention/profile discovery saat menghubungkan akun
  auto_enabled: '0',          // saklar utama webhook + auto reply (admin)
  webhook_verify_token: '',   // token verifikasi webhook Meta (dibuat otomatis)
  auto_llm_daily_cap: '300',  // maks draft LLM per 24 jam (kontrol biaya)
  mentions_auto: '1',        // kumpulkan mention otomatis tiap ±1 jam bila aktif & mode Live
};

// Webhook Meta + auto reply LLM
db.exec(`
CREATE TABLE IF NOT EXISTS auto_rules (
  brand_id TEXT NOT NULL REFERENCES brands(id),
  platform TEXT NOT NULL CHECK (platform IN ('threads','instagram')),
  enabled INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'draft' CHECK (mode IN ('draft','auto')),
  kinds TEXT NOT NULL DEFAULT '["reply","mention","comment"]',
  hourly_cap INTEGER NOT NULL DEFAULT 20,
  knowledge TEXT NOT NULL DEFAULT '',
  updated_at TEXT,
  PRIMARY KEY (brand_id, platform)
);
CREATE TABLE IF NOT EXISTS auto_events (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  brand_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reply','mention','comment','dm')),
  ext_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  media_id TEXT,
  author_id TEXT,
  author_username TEXT,
  text TEXT NOT NULL DEFAULT '',
  permalink TEXT,
  simulated INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'new',
  category TEXT,
  needs_human INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  draft TEXT,
  reply_text TEXT,
  sent_id TEXT,
  error TEXT,
  decided_by TEXT,
  drafted_at TEXT,
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (platform, ext_id)
);
CREATE INDEX IF NOT EXISTS auto_events_status ON auto_events(status, received_at);
CREATE INDEX IF NOT EXISTS auto_events_brand ON auto_events(brand_id, platform, received_at);
`);
// Riset, mention, dan kandidat kolaborasi (endorse)
db.exec(`
CREATE TABLE IF NOT EXISTS research_saves (
  id TEXT PRIMARY KEY,
  brand_id TEXT,
  query TEXT NOT NULL,
  mode TEXT,
  search_type TEXT,
  media_type TEXT,
  result TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mentions (
  id TEXT PRIMARY KEY,              -- brand_id:media_id (satu mention bisa menyebut beberapa brand)
  media_id TEXT NOT NULL,
  brand_id TEXT NOT NULL,
  username TEXT,
  text TEXT,
  permalink TEXT,
  media_type TEXT,
  posted_at TEXT,
  status TEXT NOT NULL DEFAULT 'baru' CHECK (status IN ('baru','ditandai','dibalas','diabaikan')),
  note TEXT,
  collected_at TEXT NOT NULL,
  handled_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_mentions_brand ON mentions(brand_id, posted_at DESC);
CREATE TABLE IF NOT EXISTS creators (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  name TEXT,
  bio TEXT,
  followers INTEGER,
  verified INTEGER NOT NULL DEFAULT 0,
  stats TEXT NOT NULL DEFAULT '{}',
  niche TEXT,
  status TEXT NOT NULL DEFAULT 'prospek' CHECK (status IN ('prospek','dihubungi','negosiasi','deal','ditolak')),
  brand_id TEXT,
  fee TEXT,
  note TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  sample_url TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  looked_up_at TEXT
);
`);

// Migrasi ringan: kredensial Meta opsional per brand (override kredensial global)
for (const col of ['app_id TEXT', 'app_secret_enc TEXT', 'granted_scopes TEXT']) {
  try { db.exec(`ALTER TABLE brands ADD COLUMN ${col}`); } catch { /* kolom sudah ada */ }
}
for (const [k, v] of Object.entries(SETTING_DEFAULTS)) {
  db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)').run(k, v);
}
export const getSetting = (key) => get('SELECT value FROM settings WHERE key=?', key)?.value ?? SETTING_DEFAULTS[key];
export const setSetting = (key, value) =>
  run('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value));
export const policy = () => ({
  claude_enabled: getSetting('claude_enabled') === '1',
  can_create: getSetting('claude_create') === '1',
  can_approve: getSetting('claude_approve') === '1',
  can_publish: getSetting('claude_publish') === '1',
  can_reply: getSetting('claude_reply') === '1',
  can_edit_brand: getSetting('claude_brand') === '1',
  daily_create_cap: Number(getSetting('claude_daily_cap')),
});

export function audit(userId, action, detail) {
  run(
    'INSERT INTO audit_log(user_id, action, detail, ts) VALUES (?,?,?,?)',
    userId || null,
    action,
    detail ? JSON.stringify(detail) : null,
    now(),
  );
}

/* ---------- Seed 4 brand Delova (bisa diedit dari dashboard) ---------- */
const SEED = [
  {
    id: 'wardrobe',
    name: 'Delova Wardrobe',
    color: '#8a4b38',
    description: 'Brand utama: modest fashion, kebaya, batik, dan wastra modern untuk perempuan.',
    voice:
      'Hangat, elegan, tetap membumi. Seperti teman yang jago styling. Sapaan "Kak". Bahasa Indonesia santai-sopan, sesekali emoji secukupnya (maks 2).',
    pillars: ['Styling & OOTD', 'Edukasi wastra (batik, kebaya)', 'Behind the scenes produksi', 'Testimoni & UGC pelanggan', 'Promo & restock'],
    hashtags: '#DelovaWardrobe #ModestFashion #KebayaModern',
    dos: 'Highlight bahan, potongan, dan kesempatan pakai (kondangan, kantor, lebaran). Ajak diskusi di akhir post.',
    donts: 'Jangan klaim diskon/harga/stok yang tidak ada di brief. Jangan menjelekkan brand lain. Jangan spam hashtag.',
  },
  {
    id: 'kids',
    name: 'Delova Kids',
    color: '#c2577a',
    description: 'Sister brand: baju anak perempuan.',
    voice:
      'Ceria, hangat, parenting-friendly. Menyapa orang tua ("Bunda/Ayah"). Ringan, lucu, tidak menggurui.',
    pillars: ['Outfit anak (kondangan, lebaran, sekolah)', 'Parenting ringan', 'Panduan ukuran', 'Testimoni orang tua', 'Promo & restock'],
    hashtags: '#DelovaKids #BajuAnakPerempuan #OOTDAnak',
    dos: 'Tekankan kenyamanan bahan dan keamanan untuk anak. Pakai bahasa yang relate dengan orang tua muda.',
    donts: 'Jangan memakai foto/identitas anak yang tidak punya izin. Jangan klaim medis. Jangan berlebihan menekan beli.',
  },
  {
    id: 'scarf',
    name: 'Delova Scarf',
    color: '#2f7a78',
    description: 'Sister brand: scarf dan hijab (viscose printed, dll).',
    voice:
      'Chic, praktis, ringan. Fokus tips pakai dan mix & match. Bahasa kasual, to the point, sedikit humor.',
    pillars: ['Tutorial & styling hijab', 'Mix & match outfit', 'Info bahan & perawatan', 'Campaign & kolaborasi', 'Promo & restock'],
    hashtags: '#DelovaScarf #HijabStyle #ScarfMotif',
    dos: 'Berikan tips yang bisa langsung dicoba. Sebut motif/bahan bila ada di brief.',
    donts: 'Jangan klaim "anti kusut/anti panas" dan sejenisnya tanpa dasar. Jangan mengarang harga.',
  },
  {
    id: 'daily',
    name: 'Delova Daily',
    color: '#c58a1f',
    description: 'Lini daily wear. (Profil ini draf awal, silakan sesuaikan di menu Brand.)',
    voice:
      'Santai, relatable, seperti curhat ringan ke teman. Boleh sedikit humor Gen Z, tetap sopan.',
    pillars: ['Daily outfit', 'Tips rutinitas & produktivitas', 'Humor relatable', 'Testimoni', 'Promo & restock'],
    hashtags: '#DelovaDaily #OOTD #DailyWear',
    dos: 'Buka dengan hook kuat di baris pertama. Pertanyaan ringan di akhir untuk memancing reply.',
    donts: 'Jangan klaim yang tidak ada di brief. Jangan terlalu jualan di setiap post (rasio 1 promo : 3 konten non-promo).',
  },
];

if (!get('SELECT 1 AS x FROM brands LIMIT 1')) {
  SEED.forEach((b, i) =>
    run(
      `INSERT INTO brands(id,name,color,description,voice,pillars,hashtags,dos,donts,sort)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      b.id, b.name, b.color, b.description, b.voice, JSON.stringify(b.pillars), b.hashtags, b.dos, b.donts, i,
    ),
  );
}
