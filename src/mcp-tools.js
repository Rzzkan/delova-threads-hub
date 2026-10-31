/**
 * Definisi tool & prompt MCP bersama. Dipakai oleh:
 *  - mcp/server.js  (stdio: Claude Desktop / Claude Code, memakai API token)
 *  - endpoint /mcp  (HTTP: konektor claude.ai via OAuth, atau Bearer token)
 *
 * Semua tool memanggil REST API dashboard atas nama user yang login, jadi PERAN user tetap berlaku.
 * Di atas itu, admin mengatur di dashboard (Kontrol Claude) apa yang boleh dilakukan Claude:
 * buat draft, setujui, publish, balas. Default: hanya buat draft & ajukan approval.
 */
import { z } from 'zod';

const ok = (data) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: `Gagal: ${e.message}` }] });
const wrap = (fn) => async (args) => {
  try {
    return ok(await fn(args || {}));
  } catch (e) {
    return fail(e);
  }
};
const needConfirm = (v) => {
  if (v !== true) throw new Error('Minta konfirmasi eksplisit dari user dulu (tampilkan brand, isi lengkap, dan jadwal), lalu panggil ulang dengan user_confirmed=true.');
};

const brandIds = 'wardrobe | kids | scarf | daily';
const CONFIRM = z.boolean().describe('Harus true, hanya setelah user menyetujui secara eksplisit di percakapan ini');

export function registerTools(server, call, { role = 'editor' } = {}) {
  const isManager = ['manager', 'admin'].includes(role);

  /* ---------- Baca ---------- */
  server.registerTool(
    'get_overview',
    {
      title: 'Ringkasan hari ini',
      description:
        'MULAI DARI SINI. Antrean menunggu approval, post gagal, jadwal terdekat, jumlah draft, peran user, dan KEBIJAKAN Claude (apa yang diizinkan admin: buat draft / setujui / publish / balas). Jika sebuah aksi tidak diizinkan, jangan mencoba; arahkan user ke dashboard_url.',
    },
    wrap(() => call('GET', '/api/overview')),
  );

  server.registerTool(
    'list_brands',
    { title: 'Daftar akun brand', description: 'Empat akun Threads Delova, status koneksi, dan jumlah post per status.' },
    wrap(() => call('GET', '/api/dashboard')),
  );

  server.registerTool(
    'update_brand_profile',
    {
      title: 'Ubah profil brand',
      description:
        'Ubah brand voice, deskripsi, content pillars, hashtag, dos/donts satu brand. Memengaruhi SEMUA tulisan berikutnya, jadi: (1) baca dulu get_brand_voice, (2) tampilkan ke user perubahan yang diusulkan (sebelum & sesudah), (3) panggil dengan user_confirmed=true hanya setelah user setuju. Kirim hanya field yang berubah; pillars dikirim sebagai daftar lengkap (menggantikan yang lama). Nama brand & kredensial tidak bisa diubah. Hanya jalan jika admin mengaktifkan "Ubah profil brand" di Kontrol Claude. Setiap perubahan tersimpan di riwayat sehingga bisa dipulihkan dari dashboard.',
      inputSchema: {
        brand: z.string().describe(brandIds),
        description: z.string().max(500).optional(),
        voice: z.string().max(4000).optional().describe('Brand voice lengkap (menggantikan yang lama)'),
        pillars: z.array(z.string().max(120)).max(12).optional().describe('Daftar lengkap content pillar'),
        hashtags: z.string().max(500).optional(),
        dos: z.string().max(2000).optional(),
        donts: z.string().max(2000).optional(),
        user_confirmed: CONFIRM,
      },
    },
    wrap(({ brand, user_confirmed, ...fields }) => {
      needConfirm(user_confirmed);
      return call('PUT', `/api/brands/${brand}/profile`, fields);
    }),
  );

  server.registerTool(
    'list_brand_history',
    {
      title: 'Riwayat perubahan profil brand',
      description: 'Versi sebelumnya dari profil brand (30 terakhir): siapa, kapan, lewat apa, dan isi sebelum diubah. Berguna untuk membandingkan atau menjelaskan perubahan. Pemulihan dilakukan user di dashboard (Brand & Akun → Riwayat).',
      inputSchema: { brand: z.string().describe(brandIds) },
    },
    wrap(({ brand }) => call('GET', `/api/brands/${brand}/history`)),
  );

  server.registerTool(
    'get_brand_voice',
    {
      title: 'Brand voice',
      description: `Brand voice, content pillars, dos/donts satu brand (${brandIds}). WAJIB dibaca sebelum menulis post untuk brand itu.`,
      inputSchema: { brand: z.string().describe(brandIds) },
    },
    wrap(({ brand }) => call('GET', `/api/brands/${brand}`)),
  );

  server.registerTool(
    'list_posts',
    {
      title: 'Daftar post',
      description: 'Lihat draft/antrean/post terbit. Filter opsional per brand dan status. Cek dulu agar tidak membuat konten yang mirip dengan post terbaru.',
      inputSchema: {
        brand: z.string().optional(),
        status: z.enum(['draft', 'pending_approval', 'scheduled', 'published', 'failed']).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    wrap(({ brand, status, limit }) => {
      const q = new URLSearchParams();
      if (brand) q.set('brand', brand);
      if (status) q.set('status', status);
      q.set('limit', String(limit || 30));
      return call('GET', `/api/posts?${q}`);
    }),
  );

  server.registerTool(
    'get_account_insights',
    {
      title: 'Insight akun',
      description: 'Views, likes, replies, reposts, quotes, followers satu brand + performa post terbit terakhir.',
      inputSchema: { brand: z.string(), days: z.number().int().min(1).max(90).optional() },
    },
    wrap(({ brand, days }) => call('GET', `/api/brands/${brand}/insights?days=${days || 7}`)),
  );

  server.registerTool(
    'list_replies',
    {
      title: 'Reply masuk',
      description: 'Reply terbaru pada post terbit sebuah brand. Gunakan untuk menyiapkan draf balasan (5 opsi per pertanyaan), jangan kirim tanpa persetujuan user.',
      inputSchema: { brand: z.string() },
    },
    wrap(({ brand }) => call('GET', `/api/brands/${brand}/replies`)),
  );

  /* ---------- Riset, mention, kolaborasi (tidak memposting apa pun ke publik) ---------- */
  server.registerTool(
    'research_threads',
    {
      title: 'Riset post publik',
      description:
        'Cari post publik di Threads berdasarkan kata kunci atau topic tag (butuh izin tambahan aktif; di mode simulasi hasilnya contoh). Pakai untuk riset tren, pertanyaan audiens, dan ide konten. Jangan menyalin teks orang lain; ambil pola dan peluangnya.',
      inputSchema: {
        brand: z.string().describe(`${brandIds} (akun yang dipakai mencari)`),
        q: z.string().min(2).max(200),
        mode: z.enum(['KEYWORD', 'TAG']).optional(),
        urutan: z.enum(['TOP', 'RECENT']).optional(),
        media: z.enum(['TEXT', 'IMAGE', 'VIDEO']).optional(),
        hari: z.number().int().min(1).max(365).optional(),
        author: z.string().optional().describe('username tanpa @'),
      },
    },
    wrap(({ brand, q, mode, urutan, media, hari, author }) =>
      call('POST', '/api/research/search', { brand_id: brand, q, search_mode: mode, search_type: urutan, media_type: media, days: hari, author })),
  );

  server.registerTool(
    'list_mentions',
    {
      title: 'Mention masuk',
      description: 'Post publik yang menyebut akun brand (tersimpan di dashboard). collect=true mengambil yang terbaru dari Threads dulu.',
      inputSchema: { brand: z.string().describe(brandIds), status: z.enum(['baru', 'ditandai', 'dibalas', 'diabaikan']).optional(), collect: z.boolean().optional() },
    },
    wrap(async ({ brand, status, collect }) => {
      const c = collect ? await call('POST', '/api/mentions/collect', { brand_id: brand }) : null;
      const r = await call('GET', `/api/mentions?brand_id=${brand}${status ? `&status=${status}` : ''}`);
      return { collected: c, ...r };
    }),
  );

  server.registerTool(
    'list_creators',
    {
      title: 'Kandidat kolaborasi / endorse',
      description: 'Daftar kandidat endorser beserta tahap (prospek, dihubungi, negosiasi, deal, ditolak), pengikut, dan engagement.',
      inputSchema: { status: z.enum(['prospek', 'dihubungi', 'negosiasi', 'deal', 'ditolak']).optional() },
    },
    wrap(({ status }) => call('GET', `/api/creators${status ? `?status=${status}` : ''}`)),
  );

  server.registerTool(
    'add_creator',
    {
      title: 'Tambah kandidat endorse',
      description: 'Simpan satu akun Threads sebagai kandidat kolaborasi (hanya mencatat; tidak menghubungi siapa pun). lookup=true mencoba mengambil data profil.',
      inputSchema: {
        username: z.string(), brand: z.string().optional().describe(brandIds), niche: z.string().optional(), note: z.string().optional(),
        fee: z.string().optional(), sample_url: z.string().url().optional(), lookup: z.boolean().optional(),
      },
    },
    wrap(({ username, brand, niche, note, fee, sample_url, lookup }) =>
      call('POST', '/api/creators', { username, brand_id: brand, niche, note, fee, sample_url, lookup, lookup_brand_id: brand, source: 'manual' })),
  );

  server.registerTool(
    'update_creator',
    {
      title: 'Ubah tahap / catatan kandidat',
      description: 'Ubah tahap negosiasi, catatan, atau fee kandidat endorse. Hanya data internal.',
      inputSchema: { id: z.string(), status: z.enum(['prospek', 'dihubungi', 'negosiasi', 'deal', 'ditolak']).optional(), note: z.string().optional(), fee: z.string().optional() },
    },
    wrap(({ id, ...body }) => call('PUT', `/api/creators/${id}`, body)),
  );

  /* ---------- Tulis (draft & ajukan) ---------- */
  server.registerTool(
    'upload_media',
    {
      title: 'Unggah foto/video untuk post',
      description:
        'Simpan foto/video sementara di hub lalu kembalikan URL HTTPS publik untuk dipakai di media_urls pada create_post/update_post. Isi SALAH SATU: source_url (URL HTTPS publik, mis. foto produk Shopee; paling disarankan) atau base64 (gambar kecil, maks ~6 MB). Format: JPG, PNG, WEBP, GIF (maks 8 MB), MP4/MOV (maks 50 MB). Panggil sekali per file; 2+ file di media_urls = carousel. File dihapus otomatis 24 jam setelah post terbit (atau 48 jam bila tak dipakai).',
      inputSchema: {
        source_url: z.string().url().optional().describe('URL HTTPS publik gambar/video'),
        base64: z.string().optional().describe('Isi file base64 (boleh berawalan data:image/png;base64,)'),
        filename: z.string().max(120).optional(),
        brand: z.string().optional().describe(brandIds),
      },
    },
    wrap(({ source_url, base64, filename, brand }) => call('POST', '/api/media/import', { source_url, base64, filename, brand_id: brand })),
  );

  server.registerTool(
    'request_photo_upload',
    {
      title: 'Minta user mengunggah foto',
      description:
        'Gunakan ketika user melampirkan/menyebut foto di chat tetapi kamu TIDAK bisa mengirim isi file-nya (foto yang kamu lihat di chat tidak bisa kamu salin sebagai base64). Mengembalikan tautan unggah (berlaku 15 menit, tanpa login). Tampilkan tautan itu ke user, minta ia menjatuhkan foto di sana, lalu setelah user bilang sudah, panggil list_media untuk mengambil URL fotonya dan pakai di create_post.',
      inputSchema: { brand: z.string().optional().describe(brandIds) },
    },
    wrap(({ brand }) => call('POST', '/api/media/upload-link', { brand_id: brand })),
  );

  server.registerTool(
    'list_media',
    {
      title: 'Daftar foto/video tersimpan',
      description:
        'Foto/video yang sudah diunggah ke hub (terbaru dulu). free=true berarti belum dipakai post mana pun dan siap dipakai: salin url-nya ke media_urls pada create_post/update_post. Gunakan setelah user mengunggah lewat tautan dari request_photo_upload atau lewat dashboard. Cocokkan dengan original_name dan created_at; bila ragu, tanya user.',
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
    },
    wrap(({ limit }) => call('GET', `/api/media?limit=${limit || 20}`)),
  );

  server.registerTool(
    'search_products',
    {
      title: 'Cari produk & stok Delova',
      description:
        'Cari produk di katalog Delova Store (delova.id): nama, harga, stok total, tautan. Pakai SEBELUM menulis post atau balasan yang menyebut produk, harga, atau ketersediaan, jangan mengarang. Stok adalah perkiraan (sinkron dari Shopee berkala); cek synced_at. Gunakan get_product untuk varian (ukuran/warna) dan stok per SKU.',
      inputSchema: {
        q: z.string().optional().describe('Kata kunci nama produk, mis. "kebaya brokat"'),
        brand: z.string().optional().describe(brandIds),
        in_stock: z.boolean().optional().describe('true = hanya yang tersedia'),
        sort: z.enum(['terbaru', 'terlaris', 'termurah', 'termahal', 'nama']).optional(),
        limit: z.number().int().min(1).max(30).optional(),
      },
    },
    wrap(({ q, brand, in_stock, sort, limit }) => call('GET', `/api/store/search?${new URLSearchParams(Object.entries({ q, brand, in_stock, sort, limit }).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`)),
  );

  server.registerTool(
    'get_product',
    {
      title: 'Detail produk, varian & stok',
      description: 'Detail satu produk Delova: deskripsi, foto, dan semua varian (SKU, harga, stok per ukuran/warna). ref = id atau slug dari search_products.',
      inputSchema: { ref: z.string().describe('id atau slug produk') },
    },
    wrap(({ ref }) => call('GET', `/api/store/product/${encodeURIComponent(ref)}`)),
  );

  server.registerTool(
    'create_post',
    {
      title: 'Buat draft / ajukan post',
      description:
        'Buat post untuk satu brand (maks 500 karakter). submit=true mengirimnya ke antrean approval manajer; selain itu tersimpan sebagai draft. TIDAK pernah langsung terbit. scheduled_at = usulan jadwal ISO 8601 dengan zona WIB, mis. 2026-10-26T19:30:00+07:00. Tampilkan teks ke user dan minta persetujuan sebelum membuat banyak draft sekaligus.',
      inputSchema: {
        brand: z.string().describe(brandIds),
        text: z.string().min(1).max(500),
        media_urls: z.array(z.string().url()).max(20).optional().describe('URL HTTPS publik gambar/video; 2+ = carousel. Untuk foto dari luar, panggil upload_media dulu lalu pakai url hasilnya'),
        topic_tag: z.string().max(50).optional().describe('Tanpa #, tanpa titik atau &'),
        scheduled_at: z.string().optional(),
        submit: z.boolean().optional(),
      },
    },
    wrap(async ({ brand, text, media_urls, topic_tag, scheduled_at, submit }) => {
      const p = await call('POST', '/api/posts', { brand_id: brand, text, media_urls, topic_tag, scheduled_at });
      return submit ? call('POST', `/api/posts/${p.id}/submit`) : p;
    }),
  );

  server.registerTool(
    'update_post',
    {
      title: 'Edit post',
      description: 'Ubah teks/jadwal/media post yang masih draft atau menunggu approval (bukan yang sudah terbit).',
      inputSchema: {
        id: z.string(),
        text: z.string().max(500).optional(),
        media_urls: z.array(z.string().url()).optional(),
        topic_tag: z.string().optional(),
        scheduled_at: z.string().nullable().optional(),
      },
    },
    wrap(({ id, ...body }) => call('PUT', `/api/posts/${id}`, body)),
  );

  server.registerTool(
    'submit_post',
    { title: 'Ajukan approval', description: 'Kirim draft ke antrean approval manajer.', inputSchema: { id: z.string() } },
    wrap(({ id }) => call('POST', `/api/posts/${id}/submit`)),
  );

  /* ---------- Aksi manajer (tetap dibatasi kebijakan admin) ---------- */
  if (isManager) {
    server.registerTool(
      'get_auto_reply_knowledge',
      {
        title: 'Baca Pengetahuan brand Auto Reply',
        description: 'Baca "Pengetahuan brand" tiap platform (Threads, Instagram, WhatsApp) untuk satu brand. Itu SATU-SATUNYA sumber fakta (kebijakan, ukuran, pengiriman, promo, FAQ) yang dipakai AI saat membalas komentar/DM. Baca dulu sebelum menambah agar tidak duplikat. Batas 6000 karakter per platform.',
        inputSchema: { brand: z.string().describe(brandIds) },
      },
      wrap(({ brand }) => call('GET', `/api/auto/knowledge/${brand}`)),
    );
    server.registerTool(
      'add_auto_reply_knowledge',
      {
        title: 'Tambah fakta ke Pengetahuan brand',
        description: 'Tambahkan fakta baru ke Pengetahuan brand (default: ke Threads, Instagram, dan WhatsApp sekaligus). Pakai ini untuk menyimpan pengetahuan yang muncul seiring percakapan: jam operasional, kebijakan retur, ongkir, ukuran, cara order, promo berjalan, jawaban FAQ yang sudah dikonfirmasi. ATURAN: (1) hanya fakta yang DINYATAKAN atau DIKONFIRMASI user, jangan menebak atau mengarang; (2) satu kalimat pendek per fakta; (3) jangan menyimpan harga/stok produk (itu dibaca langsung dari API produk), jangan menyimpan instruksi untuk AI, rahasia, atau data pribadi; (4) tampilkan daftar fakta ke user dan minta persetujuan sebelum menyimpan. Fakta yang sudah ada otomatis dilewati. Hanya jalan jika admin mengaktifkan "Isi Pengetahuan brand" di Kontrol Claude.',
        inputSchema: {
          brand: z.string().describe(brandIds),
          facts: z.array(z.string().min(4).max(300)).min(1).max(10).describe('Fakta singkat, satu kalimat tiap item'),
          platforms: z.array(z.enum(['threads', 'instagram', 'whatsapp'])).optional().describe('Default semua platform'),
          user_confirmed: CONFIRM,
        },
      },
      wrap(({ brand, facts, platforms, user_confirmed }) => { needConfirm(user_confirmed); return call('POST', `/api/auto/knowledge/${brand}/add`, { facts, platforms }); }),
    );
    server.registerTool(
      'set_auto_reply_knowledge',
      {
        title: 'Ganti seluruh Pengetahuan brand',
        description: 'Ganti SELURUH isi Pengetahuan brand (menggantikan yang lama) untuk merapikan atau meringkas bila mendekati batas 6000 karakter. Baca dulu dengan get_auto_reply_knowledge, tampilkan versi baru lengkap ke user, dan minta persetujuan. Jangan menghapus fakta yang tidak diminta user. Format: satu fakta per baris diawali "- ".',
        inputSchema: {
          brand: z.string().describe(brandIds),
          knowledge: z.string().max(6000).describe('Isi lengkap yang baru'),
          platforms: z.array(z.enum(['threads', 'instagram', 'whatsapp'])).optional().describe('Default semua platform'),
          user_confirmed: CONFIRM,
        },
      },
      wrap(({ brand, knowledge, platforms, user_confirmed }) => { needConfirm(user_confirmed); return call('PUT', `/api/auto/knowledge/${brand}`, { knowledge, platforms }); }),
    );
    server.registerTool(
      'approve_post',
      {
        title: 'Setujui & jadwalkan',
        description:
          'Setujui post dan jadwalkan tayang. HANYA setelah user secara eksplisit menyetujui isi dan jadwalnya di percakapan ini. Hanya jalan jika admin mengaktifkan "Setujui & jadwalkan" di Kontrol Claude; jika ditolak server, arahkan user ke dashboard.',
        inputSchema: { id: z.string(), scheduled_at: z.string().optional().describe('ISO 8601; kosong = pakai jadwal yang sudah ada'), user_confirmed: CONFIRM },
      },
      wrap(({ id, scheduled_at, user_confirmed }) => {
        needConfirm(user_confirmed);
        return call('POST', `/api/posts/${id}/approve`, { scheduled_at });
      }),
    );

    server.registerTool(
      'reject_post',
      {
        title: 'Kembalikan ke draft',
        description: 'Kembalikan post (menunggu approval / terjadwal) ke draft dengan catatan revisi untuk penulis.',
        inputSchema: { id: z.string(), note: z.string().max(300).optional(), user_confirmed: CONFIRM },
      },
      wrap(({ id, note, user_confirmed }) => {
        needConfirm(user_confirmed);
        return call('POST', `/api/posts/${id}/reject`, { note });
      }),
    );

    server.registerTool(
      'publish_post_now',
      {
        title: 'Publish sekarang',
        description:
          'Terbitkan post ke Threads SEKARANG (tidak bisa ditarik dari dashboard). Hanya setelah user menyetujui eksplisit brand + isi final. Default DIMATIKAN admin; jika ditolak server, jangan mencoba cara lain.',
        inputSchema: { id: z.string(), user_confirmed: CONFIRM },
      },
      wrap(({ id, user_confirmed }) => {
        needConfirm(user_confirmed);
        return call('POST', `/api/posts/${id}/publish-now`);
      }),
    );

    server.registerTool(
      'send_reply',
      {
        title: 'Kirim balasan',
        description: 'Balas sebuah reply di Threads. Hanya setelah user memilih/menyetujui teks balasan. Default DIMATIKAN admin.',
        inputSchema: { brand: z.string(), reply_id: z.string(), text: z.string().min(1).max(500), user_confirmed: CONFIRM },
      },
      wrap(({ brand, reply_id, text, user_confirmed }) => {
        needConfirm(user_confirmed);
        return call('POST', `/api/brands/${brand}/replies/${reply_id}/reply`, { text });
      }),
    );

    server.registerTool(
      'hide_reply',
      {
        title: 'Sembunyikan reply',
        description: 'Sembunyikan reply (spam/kasar) pada post kita. Hanya setelah user setuju. Default DIMATIKAN admin.',
        inputSchema: { brand: z.string(), reply_id: z.string(), user_confirmed: CONFIRM },
      },
      wrap(({ brand, reply_id, user_confirmed }) => {
        needConfirm(user_confirmed);
        return call('POST', `/api/brands/${brand}/replies/${reply_id}/hide`, { hide: true });
      }),
    );
  }

  /* ---------- Prompt siap pakai (muncul sebagai perintah di Claude) ---------- */
  const msg = (text) => ({ messages: [{ role: 'user', content: { type: 'text', text } }] });

  server.registerPrompt(
    'rencana_mingguan',
    {
      title: 'Rencana konten mingguan',
      description: 'Susun naskah Threads 5-14 hari untuk satu brand, tinjau bersama, lalu simpan sebagai draft.',
      argsSchema: { brand: z.string().describe(brandIds), tujuan: z.string().optional(), hari: z.string().optional() },
    },
    ({ brand, tujuan, hari }) =>
      msg(`Susun rencana konten Threads ${hari || 7} hari untuk brand "${brand}". Tujuan: ${tujuan || 'menaikkan engagement dan traffic ke Shopee'}.
Langkah:
1. Panggil get_overview (cek kebijakan & antrean), get_brand_voice, list_posts (hindari duplikat), dan get_account_insights (lihat apa yang berhasil).
2. Tulis satu post per hari (maks 500 karakter, hook kuat di baris pertama, seimbang antar content pillar, jangan mengarang harga/diskon). Tampilkan semuanya padaku dalam tabel: hari, jam WIB, pillar, teks.
3. Setelah aku bilang OK (boleh dengan revisi), buat semuanya dengan create_post (submit=true) beserta scheduled_at WIB.
4. Tutup dengan ringkasan dan tautan dashboard untuk approval.`),
  );

  server.registerPrompt(
    'tinjau_antrean',
    { title: 'Tinjau antrean approval', description: 'Ringkas semua post yang menunggu approval dan beri rekomendasi.' },
    () =>
      msg(`Panggil get_overview lalu tinjau semua post yang menunggu approval. Untuk tiap post tampilkan brand, teks, jadwal, siapa pembuatnya, dan rekomendasimu (setujui / revisi + alasannya, cek brand voice & batas 500 karakter). Jangan menyetujui apa pun sebelum aku konfirmasi per post. Jika kebijakan belum mengizinkan Claude menyetujui, arahkan aku ke dashboard_url.`),
  );

  server.registerPrompt(
    'inbox_reply',
    {
      title: 'Siapkan balasan reply',
      description: 'Kelompokkan reply masuk dan siapkan 5 opsi balasan per pertanyaan.',
      argsSchema: { brand: z.string().describe(brandIds) },
    },
    ({ brand }) =>
      msg(`Ambil reply terbaru brand "${brand}" dengan list_replies dan baca brand voice-nya. Kelompokkan (pertanyaan produk, pujian, komplain, spam). Untuk tiap pertanyaan/komplain buat 5 opsi balasan singkat yang ramah dan jangan menjanjikan stok/harga/pengiriman yang tidak diketahui. Tampilkan dan tunggu aku memilih; kirim hanya dengan send_reply setelah aku konfirmasi.`),
  );

  server.registerPrompt(
    'review_performa',
    {
      title: 'Review performa akun',
      description: 'Analisis insight satu brand dan beri 5 tindakan + 5 ide post.',
      argsSchema: { brand: z.string().describe(brandIds), hari: z.string().optional() },
    },
    ({ brand, hari }) =>
      msg(`Ambil get_account_insights untuk "${brand}" (${hari || 7} hari) dan list_posts yang terbit. Jelaskan post mana yang paling bagus dan kenapa, apa yang kurang, lalu beri minimal 5 tindakan konkret minggu depan dan 5 ide post baru yang sesuai brand voice. Tawarkan untuk membuatnya sebagai draft.`),
  );
  server.registerPrompt(
    'riset_tren',
    {
      title: 'Riset tren & ide konten',
      description: 'Riset post publik untuk satu topik, lalu ubah menjadi 5+ ide post sesuai brand voice.',
      argsSchema: { brand: z.string().describe(brandIds), topik: z.string() },
    },
    ({ brand, topik }) =>
      msg(`Riset topik "${topik}" untuk brand "${brand}". Panggil get_brand_voice, lalu research_threads (coba urutan TOP dan RECENT, dan satu pencarian TAG bila relevan). Rangkum tema yang sering muncul, pertanyaan audiens, dan celah konten yang belum diisi siapa pun. Beri minimal 5 ide post berbeda sudut dengan naskah siap pakai (maks 500 karakter, jangan menyalin teks orang lain). Tawarkan membuatnya sebagai draft.`),
  );

  server.registerPrompt(
    'cari_endorse',
    {
      title: 'Cari kandidat endorse',
      description: 'Cari akun yang cocok diajak kolaborasi dari riset/mention, simpan sebagai kandidat, dan siapkan draf pesan.',
      argsSchema: { brand: z.string().describe(brandIds), niche: z.string().optional() },
    },
    ({ brand, niche }) =>
      msg(`Bantu cari kandidat endorse untuk brand "${brand}"${niche ? ` (niche: ${niche})` : ''}. Langkah: get_brand_voice; list_mentions (collect=true) untuk pelanggan yang sudah menyebut kita; research_threads untuk akun yang aktif membahas topik terkait; list_creators agar tidak duplikat. Pilih minimal 5 akun yang paling relevan dan jelaskan alasannya (jangan menilai dari asumsi; pakai isi post yang terlihat). Setelah aku setuju, simpan dengan add_creator, lalu tulis 5 draf pesan pembuka yang personal untuk tiap akun. Jangan menghubungi siapa pun; aku yang mengirimnya.`),
  );
}
