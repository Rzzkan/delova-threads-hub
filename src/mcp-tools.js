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

  /* ---------- Tulis (draft & ajukan) ---------- */
  server.registerTool(
    'create_post',
    {
      title: 'Buat draft / ajukan post',
      description:
        'Buat post untuk satu brand (maks 500 karakter). submit=true mengirimnya ke antrean approval manajer; selain itu tersimpan sebagai draft. TIDAK pernah langsung terbit. scheduled_at = usulan jadwal ISO 8601 dengan zona WIB, mis. 2026-10-26T19:30:00+07:00. Tampilkan teks ke user dan minta persetujuan sebelum membuat banyak draft sekaligus.',
      inputSchema: {
        brand: z.string().describe(brandIds),
        text: z.string().min(1).max(500),
        media_urls: z.array(z.string().url()).max(20).optional().describe('URL HTTPS publik gambar/video; 2+ = carousel'),
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
}
