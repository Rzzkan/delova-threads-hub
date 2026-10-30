# Delova Threads Hub

Dashboard tim marketing untuk mengelola **4 akun Threads**: Delova Wardrobe, Delova Kids, Delova Scarf, dan Delova Daily. Terintegrasi dengan Claude dengan dua cara: asisten AI di dalam dashboard, dan server MCP agar tim bisa menyuruh Claude Desktop / Claude Code langsung.

## Fitur

| Area | Isi |
|---|---|
| Multi-akun | 4 brand, tiap brand punya token Threads sendiri (dienkripsi), brand voice, pillars, dos/donts |
| Alur kerja tim | Draft → Ajukan → **Setujui & jadwalkan** → Terbit. Peran: viewer, editor, manager, admin |
| Penjadwalan | Antrean otomatis (cek tiap 30 detik, zona WIB), publish teks / gambar / video / carousel |
| Claude di dashboard | Ide post (min. 5 opsi), perbaiki teks, rencana mingguan, saran balasan, analisis performa |
| Claude sebagai antarmuka utama | Tim ngobrol dengan Claude (claude.ai web/HP, Desktop, Code): ringkasan harian, rencana mingguan, tinjau antrean, siapkan balasan, review performa. Tersambung lewat **konektor MCP + OAuth** |
| Kontrol Claude (dashboard) | Admin mengatur apa yang boleh dilakukan Claude: saklar utama, buat draft, setujui, publish, balas, batas draft harian. Ada daftar sesi, tombol putus akses, dan riwayat aktivitas Claude |
| Inbox | Lihat reply, minta saran balasan Claude, kirim balasan, sembunyikan reply |
| Insight | Views, like, reply, repost, followers per akun + per post |
| Keamanan | Token Threads AES-256-GCM, password scrypt, cookie HttpOnly + CSRF header, audit log, batas 250 post/24 jam |

## Mulai cepat (Windows / Mac / Linux)

Butuh **Node.js 22.13 atau lebih baru**.

```bash
cd delova-threads-hub
npm install
copy .env.example .env      # Mac/Linux: cp .env.example .env
```

Isi minimal `.env`: `APP_SECRET` (acak, min 32 karakter) dan `ADMIN_PASSWORD`. Lalu:

```bash
npm start
```

Buka http://localhost:3000 dan masuk dengan `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

Selama `THREADS_DRY_RUN=true`, aplikasi berjalan dalam **mode simulasi**: semua fitur bisa dicoba (termasuk publish, reply, insight dengan data contoh) tanpa menyentuh akun Threads asli. Cocok untuk melatih tim.

## Peran tim

| Peran | Boleh |
|---|---|
| viewer | Lihat dashboard, antrean, insight |
| editor | + tulis draft, ajukan approval, pakai Claude. Hanya bisa edit/hapus post buatannya sendiri |
| manager | + setujui/kembalikan, publish sekarang, balas & sembunyikan reply, edit brand voice, analisis Claude |
| admin | + kelola user, API token, hubungkan/putuskan akun, audit log |

Saran: tim konten = **editor**, kamu atau kepala marketing = **manager/admin**. Buat user khusus (mis. "Claude Bot") berperan **editor** untuk token MCP.

## Go-live ke Threads asli

1. Buka <https://developers.facebook.com/apps> → **Create app** → pilih use case **Access the Threads API**.
2. Di app tersebut tambahkan permission: `threads_basic`, `threads_content_publish`, `threads_read_replies`, `threads_manage_replies`, `threads_manage_insights`.
3. Isi **Redirect Callback URL** dengan `https://DOMAIN-ANDA/auth/threads/callback`. Harus HTTPS. Untuk uji dari laptop pakai tunnel (Cloudflare Tunnel / ngrok) atau deploy dulu ke server.
4. Selama app mode Development, tambahkan tiap akun Threads (Wardrobe, Kids, Scarf, Daily) di **App roles → Roles → Threads Testers**, lalu terima undangannya di aplikasi Threads masing-masing akun (Settings → Account → Website permissions → Invites). Untuk akun milik sendiri ini cukup, tanpa App Review.
5. Salin **Threads App ID** dan **App Secret** ke `.env`:
   ```
   THREADS_APP_ID=...
   THREADS_APP_SECRET=...
   THREADS_DRY_RUN=false
   APP_BASE_URL=https://DOMAIN-ANDA
   ```
6. Restart. Buka menu **Brand & Akun** → klik **Hubungkan ke Threads** di tiap brand. Penting: saat halaman izin Threads muncul, pastikan yang sedang login adalah akun brand yang benar (gunakan jendela/profil browser terpisah per akun).
7. Token berlaku ±60 hari dan diperpanjang otomatis oleh server saat tinggal 10 hari.

Catatan Threads API: teks maksimal 500 karakter, 250 post per 24 jam per akun, media harus URL **HTTPS publik** (dashboard belum punya fitur upload file; pakai link dari Drive publik/CDN/Shopee image), carousel 2 sampai 20 item.

## Claude

### 1) Di dalam dashboard

Isi di `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_MODEL=claude-sonnet-5-5
```

Semua prompt otomatis memuat **brand voice akun yang dipilih** (edit di menu Brand & Akun). Untuk Delova Daily, profil awalnya hanya draf umum, silakan disesuaikan dulu.

### 2) Claude sebagai antarmuka utama (konektor MCP)

Tim bekerja dari Claude, dashboard dipakai untuk **kontrol dan approval**. Claude memanggil Hub atas nama user yang login, jadi **peran user tetap berlaku**, dan di atasnya admin membatasi lagi lewat menu **Kontrol Claude**.

**A. Konektor di claude.ai (disarankan, web & HP)**
1. Hub harus online dengan **HTTPS**, dan `APP_BASE_URL` di `.env` sama persis dengan alamat publiknya (dipakai sebagai alamat OAuth).
2. claude.ai → **Settings → Connectors → Add custom connector**. Nama bebas, URL: `https://DOMAIN-ANDA/mcp`.
3. **Connect** → masuk dengan akun Hub → **Izinkan**. Tiap anggota tim connect dengan akunnya sendiri, sehingga peran dan jejak audit per orang.

Pada paket Team/Enterprise, penambahan konektor kustom bisa dibatasi ke Owner organisasi. Cek pengaturan Connectors akun Anda.

**B. Claude Desktop / Claude Code dengan API token**
1. Admin buat token: menu **Tim → API token** pada user tertentu (hanya tampil sekali).
2. Claude Desktop, tambahkan ke `claude_desktop_config.json` (Settings → Developer → Edit Config):

   ```json
   {
     "mcpServers": {
       "delova-threads": {
         "command": "node",
         "args": ["C:\\Users\\NAMA\\Delova\\Delova Wardrobe\\delova-threads-hub\\mcp\\server.js"],
         "env": { "DELOVA_HUB_URL": "https://DOMAIN-ANDA", "DELOVA_HUB_TOKEN": "dth_..." }
       }
     }
   }
   ```
3. Claude Code:
   ```bash
   claude mcp add --transport http delova-threads https://DOMAIN-ANDA/mcp --header "Authorization: Bearer dth_..."
   ```

**Apa yang bisa Claude lakukan (tool MCP)**

| Tool | Fungsi | Izin |
|---|---|---|
| `get_overview` | Antrean approval, post gagal, jadwal terdekat, kebijakan aktif | selalu |
| `list_brands`, `get_brand_voice`, `list_posts`, `get_account_insights`, `list_replies` | Membaca | selalu |
| `create_post`, `update_post`, `submit_post` | Buat/edit draft, ajukan approval | Kontrol Claude: "Buat & edit draft" (default **aktif**) |
| `approve_post`, `reject_post` | Setujui & jadwalkan / kembalikan | peran manager+ **dan** Kontrol Claude: "Setujui" (default **mati**) |
| `publish_post_now` | Terbitkan sekarang | peran manager+ **dan** "Publish langsung" (default **mati**) |
| `send_reply`, `hide_reply` | Balas / sembunyikan komentar | peran manager+ **dan** "Balas komentar" (default **mati**) |

Aksi yang tayang ke publik (setujui/publish/balas) mewajibkan `user_confirmed=true`, yang hanya boleh diisi Claude setelah Anda menyetujui isi final di percakapan.

**Prompt siap pakai** (ketik `/` di Claude): `rencana_mingguan`, `tinjau_antrean`, `inbox_reply`, `review_performa`.

Contoh: *"Ada apa hari ini?"*, *"Buat rencana konten Delova Scarf 7 hari, tunjukkan dulu sebelum disimpan."*, *"Siapkan 5 opsi balasan untuk reply terbaru Delova Kids."*

**Kontrol Claude (khusus admin, di dashboard)**
- Saklar utama: matikan semua akses Claude seketika (darurat).
- Saklar per kemampuan + batas draft baru dari Claude per 24 jam (default 30).
- Daftar sesi konektor, putuskan satu atau semuanya. Token yang diputus langsung tidak berlaku.
- Riwayat aktivitas Claude (tercatat dengan jalur `oauth` / `token`).
- Hal yang **selalu tertutup untuk Claude** (hanya lewat dashboard oleh manusia): kelola user & token, edit brand voice, hubungkan/putuskan akun Threads, hapus post, fitur AI di dashboard.

Rekomendasi rollout: mulai dengan default (Claude hanya membuat draft), biarkan manajer menyetujui di dashboard selama 1-2 minggu, baru aktifkan "Setujui" bila sudah nyaman.

## Deploy

Aplikasi ini satu proses Node + SQLite (file `data/hub.db`), jadi butuh **disk yang persisten**. Paket Docker untuk VPS Hostinger yang juga menjalankan delova.id dan wh.delova.id sudah disiapkan: ikuti **[deploy/DEPLOY.md](deploy/DEPLOY.md)** (Dockerfile, docker-compose, konfigurasi nginx/Caddy/Traefik, backup harian, update, rollback).

Ringkasnya:
- Set `APP_SECRET` tetap. Jika berubah, token Threads yang tersimpan tidak bisa dibaca dan semua akun harus dihubungkan ulang.
- Pasang di belakang HTTPS dan set `APP_BASE_URL=https://...` serta `TRUST_PROXY=1` (sudah otomatis di docker-compose).
- Backup rutin: `node scripts/backup.mjs` (konsisten saat aplikasi hidup).

## Struktur

```
src/server.js      API, auth, peran, OAuth callback, endpoint /mcp
src/threads.js     Klien Threads API (publish, replies, insights, token) + mode simulasi
src/claude.js      Prompt Claude per brand (ide, perbaikan, balasan, rencana, analisis)
src/mcp-tools.js   Tool & prompt MCP (dipakai stdio dan HTTP)
src/oauth.js       OAuth 2.1 + PKCE + registrasi klien untuk konektor claude.ai
src/scheduler.js   Publisher terjadwal + perpanjangan token otomatis
src/db.js          Skema SQLite + seed 4 brand + pengaturan Kontrol Claude
scripts/backup.mjs Backup konsisten database SQLite (14 hari terakhir)
Dockerfile, docker-compose.yml, deploy/   Paket deploy VPS (lihat deploy/DEPLOY.md)
mcp/server.js      MCP server stdio untuk Claude Desktop / Code
public/            Dashboard (HTML/CSS/JS tanpa build step)
test/              Tes otomatis: npm test
```

## Tes

`npm test` menjalankan 29 tes: login/CSRF, alur approval, pembatasan peran, mode simulasi, MCP (stdio dan HTTP), alur OAuth lengkap (PKCE, rotasi token, putus sesi), kebijakan Kontrol Claude, pembatas login di balik proxy, backup, dan fitur Claude memakai server Anthropic tiruan. Yang belum bisa diuji otomatis: koneksi ke Meta/Threads asli, panggilan ke Claude API sungguhan, dan pendaftaran konektor dari claude.ai itu sendiri (butuh domain HTTPS dan akun Anda). Lakukan satu post uji di akun asli setelah langkah go-live.

## Kredensial Meta di dashboard

Admin mengisi Threads App ID/Secret di menu **Pengaturan Meta** (global untuk semua akun, dengan override opsional per brand) dan memilih mode Otomatis / Live / Simulasi. Secret disimpan terenkripsi (AES-256-GCM), tidak pernah dikembalikan oleh API, dan endpoint-nya khusus manusia (tidak bisa dipakai Claude/MCP). Prioritas: brand → dashboard → `.env`.

## Riset, Mention, dan Kolaborasi

Tiga menu tambahan (butuh izin `threads_keyword_search`, `threads_manage_mentions`, `threads_profile_discovery`):

- **Riset**: cari post publik berdasarkan kata kunci atau topic tag, simpan hasilnya, minta Claude merangkum tema, pertanyaan audiens, celah konten, dan 5+ ide post.
- **Mention**: kumpulkan post yang menyebut akun brand (otomatis ±1 jam di mode Live), beri status dan catatan, balas (manager), ekspor CSV.
- **Kolaborasi**: pipeline kandidat endorse (prospek → dihubungi → negosiasi → deal/ditolak) lengkap dengan pengikut dan engagement, plus 5+ draf pesan penawaran dari Claude.

Izin ini **tidak diminta** sampai admin mencentang "Izin riset, mention & kolaborasi" di Pengaturan Meta (setelah izinnya ditambahkan di Use cases aplikasi Meta), lalu akun dihubungkan ulang. Sebelum Meta menyetujui Advanced Access, pencarian hanya menjangkau post akun sendiri, mention hanya dari tester, dan lookup profil hanya akun resmi Meta. Claude (MCP) mendapat tool `research_threads`, `list_mentions`, `list_creators`, `add_creator`, `update_creator` serta prompt `riset_tren` dan `cari_endorse`; semuanya hanya membaca/mencatat dan tidak memposting apa pun ke publik.

## Mengubah tampilan (Tailwind)

Dashboard memakai Tailwind CSS v4 yang **dibangun saat pengembangan** (CSP melarang skrip CDN). Sumber gaya ada di `tailwind/input.css`; hasilnya `public/app.css` ikut di-commit sehingga Docker/VPS tidak perlu build.

```bash
npm install          # sekali, memasang Tailwind (devDependency)
npm run css          # bangun ulang public/app.css setelah mengubah tailwind/input.css, public/app.js, atau public/index.html
npm run css:watch    # otomatis saat mengedit
```

## Foto & video sementara

Di **Tulis Post** foto/video bisa diunggah langsung (klik atau seret). File disimpan di volume data (`/data/media`),
dicatat di tabel `media`, dan disajikan publik di `https://<domain>/media/<nama-acak>` karena Threads harus bisa mengunduhnya.

- Dihapus otomatis **24 jam setelah post terbit** (pembersih berjalan tiap 30 menit).
- Unggahan yang tak pernah dipakai dihapus setelah 48 jam; post yang dihapus ikut membersihkan filenya.
- Batas: gambar 8 MB, video 50 MB, total penyimpanan `MEDIA_MAX_TOTAL_MB` (default 500).
- Isi file diperiksa (bukan hanya ekstensi); hanya JPG, PNG, WEBP, GIF, MP4, MOV.

### Foto lewat Claude (MCP)

Tool `upload_media` memungkinkan Claude mengambil foto dari URL HTTPS publik (mis. foto produk Shopee) atau base64,
menyimpannya sementara, lalu memakai URL hasilnya di `media_urls` pada `create_post` (2+ foto = carousel).
Pengamanan: hanya HTTPS, alamat internal/loopback/link-local ditolak (anti-SSRF, dicek pada koneksi sebenarnya),
maks 3 pengalihan, timeout 20 detik, batas ukuran, isi file diperiksa. Tunduk pada saklar "Buat & edit draft" di Kontrol Claude.
`MEDIA_IMPORT_ALLOW_LOCAL=1` hanya untuk tes/dev lokal — jangan diset di produksi.

### Foto yang hanya "terlihat" Claude di chat

Gambar yang dilampirkan di chat tidak bisa disalin Claude menjadi base64 (ia hanya melihatnya). Jalurnya:
Claude memanggil `request_photo_upload` → user membuka tautan (15 menit, tanpa login, maks 20 file) dan menjatuhkan foto →
Claude memanggil `list_media` untuk mengambil URL-nya → dipakai di `create_post`. Foto juga bisa diunggah dulu dari
Tulis Post, lalu Claude tinggal memakai `list_media`.

### Claude mengubah profil brand

Saklar baru **"Ubah profil brand"** di Kontrol Claude (default **mati**). Bila aktif, Claude (konektor/MCP) dapat memakai
`update_brand_profile` untuk mengubah deskripsi, brand voice, content pillars, hashtag, dos/donts — wajib `user_confirmed=true`
setelah user setuju di percakapan. Nama brand, token, dan kredensial tidak bisa diubah Claude. Setiap perubahan (dari dashboard
maupun Claude) menyimpan versi sebelumnya; lihat/pulihkan di **Brand & Akun → Riwayat perubahan** (pemulihan hanya manusia).

## Instagram (menu baru)

Menu **Instagram** memakai *Instagram API with Instagram Login* (host `graph.instagram.com`) dan punya lima tab per brand:
**Konten & Jadwal** (draft → ajukan → setujui → terbit otomatis, Feed/Reels/Story, foto wajib JPG), **Komentar** (balas/sembunyikan), **Pesan (DM)** (balas dalam jendela 24 jam), **Insight** (akun 7/14/30 hari + insight per konten dengan pencarian caption/hashtag, filter jenis, urutan), dan **Akun** (hubungkan akun, token diperpanjang otomatis tiap 6 jam).

Setup live: di Meta for Developers tambahkan produk Instagram → *API setup with Instagram login*, salin **Instagram App ID/Secret** ke tab Akun (admin), dan daftarkan redirect URL `<APP_BASE_URL>/auth/instagram/callback`. Akun harus Instagram Professional. Izin: `instagram_business_basic`, `_content_publish`, `_manage_comments`, `_manage_messages`, `_manage_insights` (Advanced Access lewat App Review untuk akun di luar tester). Tanpa kredensial / dalam mode simulasi, semua data adalah contoh dan tidak ada yang dikirim.

## Webhook & Auto Reply (Threads + Instagram)

Menu **Auto Reply** menerima event real-time dari Meta di `POST /webhooks/threads` dan `POST /webhooks/instagram` (verifikasi `GET` memakai *verify token* di tab Webhook & setup; tiap `POST` wajib lolos tanda tangan HMAC `X-Hub-Signature-256` dengan App Secret). Event yang ditangani: reply & mention Threads; komentar, mention, dan DM Instagram. Event disimpan (dedupe per ID, dibersihkan setelah 30 hari), lalu Claude menyusun balasan memakai brand voice + *Pengetahuan brand* per akun.

- **Mode Draft** (default): semua balasan menunggu persetujuan di Kotak masuk (bisa diedit, draf ulang, tolak).
- **Mode Auto** (khusus admin): terkirim sendiri hanya bila kategori aman, keyakinan ≥ 75%, tanpa kata sensitif (refund/komplain/kerja sama), tanpa tautan/nomor di luar pengetahuan brand, panjang sesuai batas, belum melewati batas per jam, dan bukan dari akun brand sendiri. Selain itu otomatis jadi "Perlu manusia".
- Saklar utama + batas draf LLM per 24 jam (kontrol biaya) ada di tab Webhook & setup. Pesan audiens diperlakukan sebagai data (anti prompt-injection).
- Setup Meta: Threads → Webhooks objek *Threads*, field `replies` & `mentions`. Instagram → *Configure webhooks*, field `comments`, `messages`, `mentions`, lalu klik *Daftarkan webhook akun ini* per brand. DM hanya bisa dibalas dalam 24 jam.
