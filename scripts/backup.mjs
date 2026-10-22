#!/usr/bin/env node
/**
 * Backup konsisten database SQLite (aman dijalankan saat aplikasi hidup, mendukung mode WAL).
 * Hasil: $DATA_DIR/backups/hub-YYYY-MM-DD.db, menyimpan 14 terakhir.
 *
 * Di Docker:  docker compose exec -T hub node scripts/backup.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.env.DATA_DIR || 'data');
const src = path.join(dir, 'hub.db');
if (!fs.existsSync(src)) {
  console.error(`Database tidak ditemukan: ${src}`);
  process.exit(1);
}
const out = path.join(dir, 'backups');
fs.mkdirSync(out, { recursive: true });

const file = path.join(out, `hub-${new Date().toISOString().slice(0, 10)}.db`);
if (fs.existsSync(file)) fs.rmSync(file); // VACUUM INTO butuh file tujuan yang belum ada

const db = new DatabaseSync(src);
db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
db.close();

const keep = 14;
const all = fs.readdirSync(out).filter((f) => /^hub-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
for (const old of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(path.join(out, old));

console.log(`Backup OK: ${file} (${(fs.statSync(file).size / 1024).toFixed(0)} KB), tersimpan ${Math.min(all.length, keep)} berkas`);
