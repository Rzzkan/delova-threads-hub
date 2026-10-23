# Deploy ke VPS Hostinger (berdampingan dengan delova.id dan wh.delova.id)

Hasil akhir: **https://threads.delova.id** (ganti nama subdomain jika mau; ubah juga di langkah 1, 4, dan 6).

Prinsip agar aman berdampingan dengan aplikasi lain di VPS yang sama:

- Hub berjalan di **container sendiri** dengan volume sendiri. Tidak menyentuh container, database MySQL, atau konfigurasi delova.id dan wh.delova.id.
- Hub **tidak memakai port 80/443**. Ia hanya mendengarkan `127.0.0.1:3100`; reverse proxy yang sudah ada meneruskan `threads.delova.id` ke sana.
- Dibatasi 384 MB RAM dan 0,5 CPU. Pemakaian normalnya sekitar 100-150 MB.
- Mematikannya tidak berdampak ke aplikasi lain: `docker compose down` di folder Hub saja.

Estimasi waktu: 20-30 menit.

---

## 0. Yang perlu disiapkan

- Akses SSH ke VPS (user root atau user dengan sudo).
- Akses DNS domain delova.id (hPanel Hostinger → Domains → DNS Zone).
- Server Hub sudah dicoba lokal (opsional tapi disarankan): `npm install && npm start`.

## 1. Arahkan subdomain ke VPS

Tambahkan record di DNS delova.id:

| Type | Name | Points to | TTL |
|---|---|---|---|
| A | `threads` | IP VPS (sama dengan record A milik `delova.id`) | 3600 |

Cek dari komputer Anda (tunggu beberapa menit jika belum muncul):

```bash
nslookup threads.delova.id
```

## 2. Periksa kondisi VPS (jangan lewati)

Masuk SSH, lalu jalankan:

```bash
docker ps --format 'table {{.Names}}\t{{.Ports}}'      # container apa saja yang jalan
sudo ss -tlnp | grep -E ':80 |:443 |:3100 '            # siapa yang memegang port 80/443, dan apakah 3100 kosong
free -h && df -h /                                      # sisa RAM dan disk
```

Dari hasilnya tentukan jalur di langkah 6:

| Yang memegang port 80/443 | Pakai |
|---|---|
| `nginx` di host (proses sistem) | **6A** nginx |
| `caddy` di host | **6B** Caddy |
| container Traefik / Nginx Proxy Manager / sejenis | **6C** varian Docker |
| tidak ada yang memegang | **6A** (nginx) atau **6B** (Caddy), pilih salah satu dan pasang dulu |

Jika port **3100 sudah terpakai**, pilih angka lain dan isi `HUB_PORT=3101` di file `.env` (langkah 4). Ingat angka itu untuk langkah 6.

Jika RAM bebas kurang dari 300 MB, buat swap dulu: `sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`.

## 3. Ambil kode ke VPS

**Opsi A, lewat GitHub (disarankan; update jadi mudah).** Buat repo **private**, misalnya `Rzzkan/delova-threads-hub`, lalu push dari komputer Anda (`.env`, `node_modules`, dan `data` sudah masuk `.gitignore`). Di VPS:

```bash
sudo mkdir -p /opt/delova-threads-hub && sudo chown $USER /opt/delova-threads-hub
git clone https://github.com/Rzzkan/delova-threads-hub.git /opt/delova-threads-hub
cd /opt/delova-threads-hub
```

Untuk repo private gunakan Personal Access Token (read-only) sebagai password, atau deploy key.

**Opsi B, langsung dari komputer (tanpa GitHub).** Dari PowerShell di folder `Delova Wardrobe`:

```powershell
scp -r delova-threads-hub root@IP_VPS:/opt/
```

(`node_modules` tidak perlu ikut; kalau sudah terlanjur ada, hapus di VPS: `rm -rf /opt/delova-threads-hub/node_modules`.)

## 4. Isi konfigurasi

```bash
cd /opt/delova-threads-hub
cp .env.example .env
nano .env
```

Isi minimal:

```
# hasil dari: openssl rand -hex 32
APP_SECRET=ISI_DI_SINI
ADMIN_EMAIL=admin@delova.id
ADMIN_PASSWORD=ISI_PASSWORD_KUAT
APP_BASE_URL=https://threads.delova.id
# tetap true dulu sampai semuanya jalan
THREADS_DRY_RUN=true
# opsional, untuk fitur Claude di dashboard
ANTHROPIC_API_KEY=
# hanya jika port 3100 sudah terpakai (hapus tanda # di depannya)
# HUB_PORT=3101
```

Tulis komentar di baris sendiri seperti di atas; jangan di belakang nilai.

Lalu kunci file-nya:

```bash
chmod 600 .env
```

> **Simpan `APP_SECRET` di tempat aman (password manager).** Jika hilang atau berubah, token Threads yang tersimpan tidak bisa dibaca dan semua akun harus dihubungkan ulang.

## 5. Jalankan container

```bash
docker compose up -d --build
docker compose ps                       # status harus "healthy" setelah ±30 detik
docker compose logs --tail 30 hub       # lihat "Delova Threads Hub berjalan..."
curl -s http://127.0.0.1:3100/api/health
```

Respons `{"ok":true,...}` berarti aplikasi sehat. Pada start pertama, admin dibuat otomatis dari `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

## 6. Pasang reverse proxy + HTTPS

### 6A. nginx di host

```bash
sudo cp deploy/nginx-threads.delova.id.conf /etc/nginx/sites-available/threads.delova.id
sudo ln -s /etc/nginx/sites-available/threads.delova.id /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d threads.delova.id
```

Jika memakai port selain 3100, ubah dua baris `proxy_pass` di file itu. Jika certbot belum terpasang: `sudo apt install certbot python3-certbot-nginx`.

### 6B. Caddy di host

Tambahkan isi `deploy/Caddyfile.snippet` ke `/etc/caddy/Caddyfile` (**tambahkan**, jangan menimpa blok yang sudah ada), lalu `sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy`.

### 6C. Reverse proxy di dalam Docker (Traefik / Nginx Proxy Manager)

1. Cari network proxy: `docker network ls`.
2. Di `docker-compose.yml`: hapus blok `ports`, aktifkan baris `networks`, `labels` (Traefik), dan blok `networks` di bawah (isi nama network yang benar).
3. Nginx Proxy Manager: tambah Proxy Host baru → domain `threads.delova.id`, forward ke `delova-threads-hub` port `3000` (container harus satu network dengan NPM), aktifkan SSL Let's Encrypt, **Websockets Support** boleh dinyalakan.
4. `docker compose up -d`

## 7. Verifikasi

```bash
curl -sI https://threads.delova.id | head -3
curl -s https://threads.delova.id/.well-known/oauth-protected-resource
curl -si -X POST https://threads.delova.id/mcp | grep -i www-authenticate
```

- Baris 1: harus `200` dengan HTTPS valid.
- Baris 2: `resource` harus berisi `https://threads.delova.id/mcp` (jika tertulis `http://` atau `localhost`, `APP_BASE_URL` salah).
- Baris 3: harus ada header `WWW-Authenticate` (itu tanda konektor OAuth siap).

Buka https://threads.delova.id, masuk sebagai admin, **ganti password admin** (menu Tim), lalu tambah akun anggota tim.

Pastikan juga **delova.id dan wh.delova.id tetap normal** (buka keduanya di browser).

## 8. Go-live Threads dan konektor Claude

Kredensial Meta diisi dari dashboard, tidak perlu mengedit `.env` atau me-restart container.

1. Di Meta for Developers, isi Redirect Callback URL: `https://threads.delova.id/auth/threads/callback` (detail langkah di `README.md`). Alamat ini juga tampil di menu **Pengaturan Meta**.
2. Masuk dashboard sebagai admin → **Pengaturan Meta**. Isi Threads App ID dan App Secret, pilih mode **Live**, Simpan. Satu aplikasi Meta cukup untuk keempat akun. Isi bagian "per brand" hanya jika sebuah brand memakai aplikasi Meta sendiri.
3. Menu **Brand & Akun** → **Hubungkan ke Threads** untuk tiap brand (login dengan akun Threads brand tersebut).
4. claude.ai → Settings → Connectors → Add custom connector → URL `https://threads.delova.id/mcp`.

Alamat untuk formulir Meta (Privacy Policy, Terms, Data Deletion, Deauthorize) tersedia di menu Pengaturan Meta dan sudah publik di `/privacy`, `/terms`, dan `/data-deletion`. Isi `CONTACT_EMAIL` di `.env` dengan email yang benar-benar Anda pantau, karena tampil di halaman itu.

Prioritas kredensial: milik brand → pengaturan dashboard → `.env` (`THREADS_APP_ID`/`THREADS_APP_SECRET`, masih didukung sebagai cadangan). Secret disimpan terenkripsi dengan `APP_SECRET` dan tidak bisa dibaca atau diubah lewat Claude/MCP.

## 9. Operasional

**Update versi baru**

```bash
cd /opt/delova-threads-hub && git pull && docker compose up -d --build
```

Data aman karena ada di volume `hub-data`, tidak ikut terhapus saat rebuild.

**Log dan status**

```bash
docker compose logs -f --tail 100 hub
docker stats --no-stream delova-threads-hub
```

**Backup harian (cron)**

```bash
sudo mkdir -p /root/backups/threads-hub
sudo crontab -e
```

Tambahkan satu baris:

```
15 3 * * * cd /opt/delova-threads-hub && docker compose exec -T hub node scripts/backup.mjs && docker cp delova-threads-hub:/data/backups/. /root/backups/threads-hub/ >> /var/log/threads-hub-backup.log 2>&1
```

Skrip membuat salinan konsisten setiap hari (14 terakhir disimpan). Sebaiknya salin folder `/root/backups/threads-hub` juga ke luar VPS (misalnya snapshot Hostinger atau unduh berkala).

**Restore**

```bash
docker compose down
docker run --rm -v delova-threads-hub_hub-data:/data -v /root/backups/threads-hub:/b alpine cp /b/hub-TANGGAL.db /data/hub.db
docker compose up -d
```

**Firewall.** Cukup buka 22, 80, 443. Jangan buka 3100. Catatan: port yang dipublikasikan Docker **melewati aturan ufw**; karena itu `docker-compose.yml` mengikatnya ke `127.0.0.1`. Jangan ubah menjadi `"3100:3000"`.

## 10. Jika ada masalah

| Gejala | Penyebab / solusi |
|---|---|
| 502 Bad Gateway | Container belum jalan atau port salah. `docker compose ps`, `curl http://127.0.0.1:3100/api/health` |
| Login berhasil tapi langsung keluar | `APP_BASE_URL` harus `https://...` (cookie bertanda Secure) dan akses lewat HTTPS |
| "Terlalu banyak percobaan" padahal baru sekali | `TRUST_PROXY` hilang; pastikan ada di `docker-compose.yml` dan proxy mengirim `X-Forwarded-For` |
| Konektor claude.ai gagal terhubung | Cek langkah 7 (metadata harus memakai alamat HTTPS publik), pastikan `/mcp` tidak diblokir WAF/basic auth |
| Port 3100 bentrok | Isi `HUB_PORT` di `.env`, sesuaikan `proxy_pass`/`reverse_proxy` |
| Setelah `APP_SECRET` berubah, akun Threads minta hubungkan ulang | Wajar; kembalikan nilai lama atau hubungkan ulang |
| Container sering restart | `docker compose logs hub`; cek RAM dengan `free -h` |

## Rollback

```bash
cd /opt/delova-threads-hub && docker compose down      # hanya menghentikan Hub
```

Hapus blok `threads.delova.id` dari nginx/Caddy bila ingin menghilangkan subdomainnya. Data tetap ada di volume `hub-data` sampai Anda menghapusnya sendiri.
