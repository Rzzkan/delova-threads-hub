/**
 * Halaman publik (tanpa login) yang diminta Meta saat mengisi pengaturan aplikasi Threads dan Instagram:
 *   /privacy  (Kebijakan Privasi)   /terms  (Ketentuan Layanan)   /data-deletion  (Penghapusan Data)
 * Juga callback Deauthorize & Data Deletion yang hanya membalas 200 (tanpa efek samping).
 * Teks bukan nasihat hukum: sebaiknya ditinjau pihak yang berwenang sebelum aplikasi dipublikasikan.
 */
import { randomBytes } from 'node:crypto';

const UPDATED = '30 Oktober 2026';
const UPDATED_EN = 'October 30, 2026';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ctx = () => ({
  mail: process.env.CONTACT_EMAIL || process.env.ADMIN_EMAIL || 'admin@delova.id',
  base: (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
});

/* ------------------------------ Teks ------------------------------ */
const PRIVACY = {
  id: (c) => ({
    title: 'Kebijakan Privasi',
    intro: `Terakhir diperbarui: ${UPDATED}. Social Hub ("Hub") adalah alat internal milik Delova Wardrobe (termasuk Delova Kids, Delova Scarf, dan Delova Daily) untuk mengelola akun Threads dan Instagram milik kami sendiri oleh tim pemasaran. Hub bukan layanan publik: hanya anggota tim yang diundang admin yang dapat masuk. Kebijakan ini menjelaskan data apa yang kami proses dan bagaimana kami melindunginya.`,
    sections: [
      ['1. Data yang kami proses', `<ul>
        <li><b>Dari Threads/Meta, setelah akun kami mengizinkan:</b> ID dan username Threads, token akses, konten post yang kami terbitkan lewat Hub, balasan (reply) pada post tersebut (username dan isi balasan yang bersifat publik), serta metrik insight (tayangan, suka, balasan, repost, kutipan, jumlah pengikut).</li>
        <li><b>Dari Instagram/Meta, setelah akun profesional kami mengizinkan:</b> ID dan username Instagram, jenis akun, jumlah pengikut, token akses, konten (feed, Reels, Story) yang kami terbitkan lewat Hub, komentar pada konten kami (username dan isi komentar), pesan langsung (DM) yang dikirim pelanggan ke akun kami beserta balasan kami, dan metrik insight akun serta konten.</li>
        <li><b>Event webhook:</b> bila fitur Auto Reply dipakai, Meta mengirim pemberitahuan real-time (reply, mention, komentar, DM). Kami menyimpan ID, username pengirim, isi pesan, draf balasan, dan status penanganannya.</li>
        <li><b>Foto/video sementara:</b> file yang diunggah tim untuk dilampirkan pada post disimpan sementara di server kami.</li>
        <li><b>Data tim:</b> nama, email, kata sandi (hanya disimpan dalam bentuk hash), peran, token API (hash), dan log audit (siapa melakukan apa, kapan, lewat dashboard atau Claude).</li>
        <li><b>Riset, mention, dan kolaborasi (fitur opsional):</b> hasil pencarian post publik (username, isi, tautan, waktu), post publik yang menyebut akun brand kami, serta profil publik calon kolaborator (username, nama, bio, jumlah pengikut, metrik publik) dan catatan tim tentang rencana kolaborasi.</li>
        <li><b>Konten kerja:</b> draf post, jadwal, catatan review, dan panduan brand voice.</li>
        <li><b>Data teknis:</b> cookie sesi untuk login dan alamat IP untuk membatasi percobaan login berulang.</li></ul>`],
      ['2. Tujuan penggunaan', `Data dipakai semata-mata untuk menyusun, menyetujui, menjadwalkan, dan menerbitkan konten di akun Threads dan Instagram kami, membalas reply, komentar, dan DM pelanggan, membaca performa, serta menjaga keamanan dan jejak audit. Data publik pengguna Threads lain hanya dipakai untuk riset konten, menjawab mention, komentar, atau pertanyaan pelanggan, dan menyeleksi calon kolaborasi bisnis. Kami tidak menjual data, tidak memakainya untuk iklan, dan tidak membuat profil sensitif tentang individu.`],
      ['3. Fitur AI (Claude / Anthropic)', `Saat fitur AI di dashboard atau konektor Claude dipakai, teks yang relevan (brand voice, draf, isi reply/komentar/DM yang akan dijawab beserta username pengirim, dan ringkasan metrik) dikirim ke Anthropic dan/atau penyedia model AI lain yang dipilih admin (misalnya gateway Kenari beserta model di baliknya) untuk diproses. Pada fitur Auto Reply, Claude hanya menyusun draf; balasan dikirim setelah disetujui tim, atau otomatis hanya bila admin mengaktifkan mode otomatis dan pesan lolos pemeriksaan keamanan kami. Pemrosesan tersebut tunduk pada ketentuan dan kebijakan privasi Anthropic. Admin dapat mematikan akses Claude kapan saja di menu Kontrol Claude.`],
      ['4. Berbagi data', `Data hanya dibagikan kepada penyedia yang diperlukan untuk menjalankan Hub: Meta (Threads API dan Instagram API), Anthropic dan penyedia model AI yang dikonfigurasi admin (fitur AI), dan penyedia server/hosting kami. Data juga dapat dibuka bila diwajibkan oleh hukum yang berlaku.`],
      ['5. Penyimpanan dan keamanan', `Data disimpan di server pribadi kami. Token akses Threads dan Instagram dienkripsi (AES-256-GCM), kata sandi di-hash, koneksi memakai HTTPS, dan akses dibatasi berdasarkan peran. Cadangan database dibuat berkala dan disimpan paling lama sekitar 14 hari. Tidak ada sistem yang sepenuhnya bebas risiko, tetapi kami berupaya menjaga data dengan wajar.`],
      ['6. Retensi', `Token akses dihapus saat akun diputuskan dari Hub. Draf dan post disimpan selama dibutuhkan untuk operasional dan arsip konten, dan dapat dihapus atas permintaan. Log audit disimpan untuk keamanan dan akuntabilitas tim. Event webhook (termasuk isi komentar/DM) dihapus otomatis setelah 30 hari, kecuali yang masih menunggu penanganan. Foto/video sementara dihapus sekitar 24 jam setelah post terbit, dan unggahan yang tidak dipakai juga dihapus otomatis.`],
      ['7. Hak Anda dan penghapusan data', `Pemilik akun Threads atau Instagram dapat mencabut akses Hub kapan saja di pengaturan Threads (Settings → Account → Website permissions) atau Instagram (Settings → Website permissions / Apps and websites) dan/atau meminta kami memutus akun serta menghapus datanya. Cara lengkap ada di halaman <a href="/data-deletion">Penghapusan Data</a>. Jika username Anda tercatat di Hub (misalnya sebagai pelanggan yang berkomentar, mengirim DM, menyebut kami, atau calon kolaborator), Anda dapat meminta akses, koreksi, atau penghapusan lewat kontak di bawah.`],
      ['8. Anak-anak', `Hub tidak ditujukan untuk anak-anak dan tidak dengan sengaja mengumpulkan data anak. "Delova Kids" adalah nama lini pakaian kami, bukan layanan untuk anak.`],
      ['9. Perubahan kebijakan', `Kami dapat memperbarui kebijakan ini. Tanggal pembaruan terbaru selalu tertera di bagian atas halaman.`],
      ['10. Kontak', `Pertanyaan atau permintaan terkait privasi: <a href="mailto:${esc(c.mail)}">${esc(c.mail)}</a>.`],
    ],
  }),
  en: (c) => ({
    title: 'Privacy Policy',
    intro: `Last updated: ${UPDATED_EN}. Social Hub ("the Hub") is an internal tool of Delova Wardrobe (including Delova Kids, Delova Scarf and Delova Daily) used by our marketing team to manage our own Threads and Instagram accounts. It is not a public service: only team members invited by an admin can sign in. This policy explains what data we process and how we protect it.`,
    sections: [
      ['1. Data we process', `<ul>
        <li><b>From Threads/Meta, after our accounts authorize the app:</b> Threads user ID and username, access token, content we publish through the Hub, replies to those posts (public usernames and reply text), and insight metrics (views, likes, replies, reposts, quotes, follower count).</li>
        <li><b>From Instagram/Meta, after our professional accounts authorize the app:</b> Instagram user ID and username, account type, follower count, access token, content (feed, Reels, Stories) we publish through the Hub, comments on our content (username and comment text), direct messages (DMs) customers send to our accounts and our replies, and account and content insight metrics.</li>
        <li><b>Webhook events:</b> when Auto Reply is used, Meta sends real-time notifications (replies, mentions, comments, DMs). We store the ID, sender username, message text, our draft reply and the handling status.</li>
        <li><b>Temporary photos/videos:</b> files our team uploads to attach to posts are stored temporarily on our server.</li>
        <li><b>Team data:</b> name, email, password (stored only as a hash), role, API token (hashed), and an audit log (who did what, when, via dashboard or Claude).</li>
        <li><b>Research, mentions and collaboration (optional features):</b> public post search results (username, text, link, time), public posts that mention our brand accounts, and public profiles of potential collaborators (username, name, bio, follower count, public metrics) with our team's notes about possible collaborations.</li>
        <li><b>Working content:</b> drafts, schedules, review notes and brand voice guidelines.</li>
        <li><b>Technical data:</b> session cookies for sign-in and IP addresses to limit repeated login attempts.</li></ul>`],
      ['2. How we use data', `Data is used solely to write, approve, schedule and publish content on our own Threads and Instagram accounts, reply to replies, comments and DMs from customers, read performance, and maintain security and an audit trail. Public data about other Threads users is used only for content research, answering mentions, comments or customer questions, and screening potential business collaborations. We do not sell data, use it for advertising, or build sensitive profiles of individuals.`],
      ['3. AI features (Claude / Anthropic)', `When the dashboard's AI features or the Claude connector are used, relevant text (brand voice, drafts, the reply/comment/DM text to be answered with the sender's username, and metric summaries) is sent to Anthropic and/or another AI model provider chosen by an admin (for example the Kenari gateway and the model behind it) for processing, subject to Anthropic's terms and privacy policy. In Auto Reply, Claude only drafts replies; they are sent after team approval, or automatically only when an admin enables automatic mode and the message passes our safety checks. Admins can switch off Claude access at any time under "Kontrol Claude".`],
      ['4. Sharing', `We share data only with providers needed to run the Hub: Meta (Threads and Instagram APIs), Anthropic and the AI model provider configured by an admin (AI features) and our server/hosting provider. Data may also be disclosed where required by applicable law.`],
      ['5. Storage and security', `Data is stored on our own server. Threads and Instagram access tokens are encrypted (AES-256-GCM), passwords are hashed, connections use HTTPS and access is role-based. Database backups are made periodically and kept for about 14 days. No system is entirely risk-free, but we take reasonable measures to protect data.`],
      ['6. Retention', `Access tokens are deleted when an account is disconnected from the Hub. Drafts and posts are kept as long as needed for operations and content archive and can be deleted on request. Audit logs are kept for security and accountability. Webhook events (including comment/DM text) are deleted automatically after 30 days, except those still awaiting handling. Temporary photos/videos are deleted about 24 hours after a post is published, and unused uploads are also removed automatically.`],
      ['7. Your rights and data deletion', `A Threads or Instagram account owner can revoke the Hub's access at any time in Threads settings (Settings → Account → Website permissions) or Instagram settings (Settings → Website permissions / Apps and websites) and/or ask us to disconnect the account and delete its data. See the <a href="/data-deletion">Data Deletion</a> page for the steps. If your username is recorded in the Hub (for example as a customer who commented, sent a DM, mentioned us, or a potential collaborator), you may request access, correction or deletion using the contact below.`],
      ['8. Children', `The Hub is not directed to children and does not knowingly collect children's data. "Delova Kids" is the name of our clothing line, not a service for children.`],
      ['9. Changes', `We may update this policy. The latest update date is always shown at the top of the page.`],
      ['10. Contact', `Privacy questions or requests: <a href="mailto:${esc(c.mail)}">${esc(c.mail)}</a>.`],
    ],
  }),
};

const TERMS = {
  id: (c) => ({
    title: 'Ketentuan Layanan',
    intro: `Terakhir diperbarui: ${UPDATED}. Ketentuan ini mengatur penggunaan Social Hub ("Hub"), alat internal Delova Wardrobe untuk mengelola akun Threads dan Instagram milik kami. Dengan masuk atau menggunakan Hub, Anda menyetujui ketentuan ini.`,
    sections: [
      ['1. Pengguna yang berwenang', `Hub hanya untuk anggota tim yang diundang oleh admin. Akses tidak boleh dibagikan atau dialihkan kepada pihak lain.`],
      ['2. Akun dan keamanan', `Anda bertanggung jawab menjaga kerahasiaan kata sandi dan token API Anda serta semua aktivitas yang dilakukan dengan akun Anda. Laporkan segera bila ada akses yang mencurigakan. Admin dapat menonaktifkan akun atau memutus sesi kapan saja.`],
      ['3. Penggunaan yang diperbolehkan', `Gunakan Hub hanya untuk mengelola akun Threads dan Instagram yang kami miliki atau yang pemiliknya telah mengizinkan. Anda wajib mematuhi hukum yang berlaku serta ketentuan dan kebijakan Meta (Threads dan Instagram), tidak mengirim spam, konten menyesatkan, atau konten yang melanggar hak pihak lain, dan tidak mencoba menembus, membebani, atau menyalahgunakan sistem.`],
      ['4. Konten dan persetujuan', `Tim bertanggung jawab atas isi post, balasan komentar, dan DM yang dibuat, disetujui, atau dikirim lewat Hub, termasuk balasan otomatis yang dihasilkan AI. Alur draf, approval, dan penjadwalan tersedia untuk membantu peninjauan, namun tidak menggantikan penilaian Anda.`],
      ['5. Fitur AI', `Hasil Claude dan fitur AI lain adalah saran yang dapat keliru. Tinjau sebelum diterbitkan. Claude hanya dapat bertindak sebatas kebijakan yang ditetapkan admin dan tercatat di log audit.`],
      ['6. Layanan "sebagaimana adanya"', `Hub disediakan apa adanya tanpa jaminan ketersediaan atau bebas gangguan. Fungsi tertentu bergantung pada layanan pihak ketiga (misalnya Threads API dan Instagram API) yang dapat berubah atau terganggu di luar kendali kami.`],
      ['7. Batasan tanggung jawab', `Sejauh diizinkan hukum, kami tidak bertanggung jawab atas kerugian tidak langsung atau konsekuensial yang timbul dari penggunaan Hub, termasuk post yang gagal terbit atau perubahan pada layanan pihak ketiga.`],
      ['8. Penghentian', `Kami dapat menghentikan atau membatasi akses pengguna kapan saja, terutama bila ada pelanggaran ketentuan ini. Pengguna dapat berhenti menggunakan Hub kapan saja.`],
      ['9. Privasi', `Pemrosesan data diatur dalam <a href="/privacy">Kebijakan Privasi</a>.`],
      ['10. Hukum yang berlaku dan perubahan', `Ketentuan ini tunduk pada hukum Republik Indonesia. Kami dapat memperbarui ketentuan ini; tanggal pembaruan terbaru tertera di bagian atas halaman.`],
      ['11. Kontak', `Pertanyaan tentang ketentuan ini: <a href="mailto:${esc(c.mail)}">${esc(c.mail)}</a>.`],
    ],
  }),
  en: (c) => ({
    title: 'Terms of Service',
    intro: `Last updated: ${UPDATED_EN}. These terms govern the use of Social Hub ("the Hub"), an internal Delova Wardrobe tool for managing our Threads and Instagram accounts. By signing in or using the Hub you agree to these terms.`,
    sections: [
      ['1. Authorized users', `The Hub is only for team members invited by an admin. Access must not be shared or transferred.`],
      ['2. Accounts and security', `You are responsible for keeping your password and API tokens confidential and for all activity under your account. Report suspicious access immediately. Admins may deactivate accounts or end sessions at any time.`],
      ['3. Acceptable use', `Use the Hub only to manage Threads and Instagram accounts we own or whose owners have authorized us. You must comply with applicable law and Meta (Threads and Instagram) terms and policies, must not send spam, misleading content or content that infringes others' rights, and must not attempt to breach, overload or abuse the system.`],
      ['4. Content and approvals', `The team is responsible for the content, comment replies and DMs created, approved or sent through the Hub, including AI-generated automatic replies. The draft, approval and scheduling workflow supports review but does not replace your own judgment.`],
      ['5. AI features', `Output from Claude and other AI features is a suggestion and may be wrong. Review it before publishing. Claude can only act within the policy set by an admin, and its actions are recorded in the audit log.`],
      ['6. Service "as is"', `The Hub is provided as is, without any guarantee of availability or uninterrupted operation. Some functions depend on third-party services (such as the Threads and Instagram APIs) that may change or fail beyond our control.`],
      ['7. Limitation of liability', `To the extent permitted by law, we are not liable for indirect or consequential loss arising from use of the Hub, including failed posts or changes to third-party services.`],
      ['8. Termination', `We may suspend or restrict a user's access at any time, particularly for breach of these terms. Users may stop using the Hub at any time.`],
      ['9. Privacy', `Data processing is described in the <a href="/privacy">Privacy Policy</a>.`],
      ['10. Governing law and changes', `These terms are governed by the laws of the Republic of Indonesia. We may update them; the latest update date is shown at the top of the page.`],
      ['11. Contact', `Questions about these terms: <a href="mailto:${esc(c.mail)}">${esc(c.mail)}</a>.`],
    ],
  }),
};

const DELETION = {
  id: (c) => ({
    title: 'Penghapusan Data',
    intro: `Terakhir diperbarui: ${UPDATED}. Halaman ini menjelaskan cara memutus akses Social Hub ke akun Threads atau Instagram Anda dan meminta penghapusan data.`,
    sections: [
      ['Opsi 1: Cabut akses dari Threads atau Instagram', `Threads: buka aplikasi atau situs Threads → <b>Settings → Account → Website permissions</b>. Instagram: buka <b>Settings → Website permissions</b> (Apps and websites). Pilih aplikasi Social Hub, lalu hapus/cabut aksesnya. Setelah itu token kami tidak lagi berlaku.`],
      ['Opsi 2: Putuskan dari Hub (admin)', `Admin membuka menu <b>Brand &amp; Akun</b>, memilih akun yang dimaksud, lalu menekan <b>Putuskan</b> (untuk Instagram: menu <b>Instagram → Akun → Putuskan</b>). Token akses, ID, dan username akun itu langsung dihapus dari database.`],
      ['Opsi 3: Minta penghapusan lewat email', `Kirim email ke <a href="mailto:${esc(c.mail)}">${esc(c.mail)}</a> dengan subjek "Hapus data Threads/Instagram", sebutkan username Anda. Kami memproses permintaan secepatnya, paling lambat 30 hari. Data yang dihapus meliputi token, identitas akun, draf, post, serta komentar/DM dan draf balasan yang tersimpan di Hub. Salinan cadangan terhapus otomatis dalam sekitar 14 hari. Konten yang sudah terbit di Threads atau Instagram tetap berada di sana dan dikelola di sana.`],
      ['Opsi 4: Username Anda tercatat sebagai mention, komentar, DM, atau kandidat kolaborasi', `Jika Anda bukan pengguna Hub tetapi username Anda tercatat (misalnya karena berkomentar, mengirim DM, menyebut akun kami, atau masuk daftar calon kolaborasi), kirim email ke <a href="mailto:${esc(c.mail)}">${esc(c.mail)}</a> dengan subjek "Hapus data username" dan sebutkan username Anda. Kami menghapus catatan terkait dalam waktu paling lama 30 hari.`],
    ],
  }),
  en: (c) => ({
    title: 'Data Deletion',
    intro: `Last updated: ${UPDATED_EN}. This page explains how to disconnect Social Hub from your Threads or Instagram account and request deletion of your data.`,
    sections: [
      ['Option 1: Revoke access in Threads or Instagram', `Threads: open Threads → <b>Settings → Account → Website permissions</b>. Instagram: open <b>Settings → Website permissions</b> (Apps and websites). Select Social Hub and remove its access. Our token then stops working.`],
      ['Option 2: Disconnect in the Hub (admin)', `An admin opens <b>Brand &amp; Akun</b>, selects the account and clicks <b>Putuskan</b> (Disconnect); for Instagram use <b>Instagram → Akun → Putuskan</b>. The access token, ID and username for that account are deleted from the database immediately.`],
      ['Option 3: Request deletion by email', `Email <a href="mailto:${esc(c.mail)}">${esc(c.mail)}</a> with the subject "Delete Threads/Instagram data" and include your username. We process requests as soon as possible and within 30 days. Deleted data includes the token, account identity, drafts, posts, and the comments/DMs and draft replies stored in the Hub. Backup copies expire automatically within about 14 days. Content already published on Threads or Instagram remains there and is managed there.`],
      ['Option 4: Your username is recorded as a mention, comment, DM or collaboration candidate', `If you are not a Hub user but your username is recorded (for example because you commented, sent a DM, mentioned our accounts or appear on a potential collaborator list), email <a href="mailto:${esc(c.mail)}">${esc(c.mail)}</a> with the subject "Delete username data" and include your username. We delete related records within 30 days.`],
    ],
  }),
};

/* ------------------------------ Render ------------------------------ */
const CSS = `:root{color-scheme:light dark;--bg:#faf7f4;--fg:#2b2320;--mut:#6f625b;--ac:#8a4b38;--card:#fff;--bd:#e7dfd8}
@media(prefers-color-scheme:dark){:root{--bg:#1c1816;--fg:#f1e9e3;--mut:#b4a79f;--ac:#e0a48f;--card:#26211e;--bd:#3a332f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:28px 16px 64px}header{display:flex;align-items:center;gap:10px;margin-bottom:6px}
.logo{width:34px;height:34px;border-radius:9px;background:var(--ac);color:#fff;display:grid;place-items:center;font:700 18px Georgia,serif}
nav{display:flex;flex-wrap:wrap;gap:6px 16px;margin:10px 0 22px;font-size:14px}a{color:var(--ac)}
h1{font-size:26px;margin:20px 0 6px}h2{font-size:18px;margin:26px 0 6px}p,li{color:var(--fg)}ul{padding-left:20px}
.lang{display:inline-block;font-size:13px;border:1px solid var(--bd);border-radius:999px;padding:2px 12px;text-decoration:none}
section{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:6px 20px 18px;margin-top:22px}
footer{margin-top:26px;color:var(--mut);font-size:13px}`;

const page = (kind, def) => {
  const c = ctx();
  const id = def.id(c), en = def.en(c);
  const block = (d, lang, id_) => `<section id="${id_}" lang="${lang}"><h1>${d.title}</h1><p>${d.intro}</p>${d.sections.map(([h, b]) => `<h2>${h}</h2><p>${b.startsWith('<ul>') ? '' : b}</p>${b.startsWith('<ul>') ? b : ''}`).join('')}</section>`;
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${id.title} · Social Hub</title><meta name="robots" content="index,follow"><style>${CSS}</style></head><body><main>
<header><span class="logo">D</span><b>Social Hub</b></header>
<nav><a href="/privacy">Kebijakan Privasi / Privacy</a><a href="/terms">Ketentuan / Terms</a><a href="/data-deletion">Penghapusan Data / Data Deletion</a></nav>
<a class="lang" href="#id">Bahasa Indonesia</a> <a class="lang" href="#en">English</a>
${block(id, 'id', 'id')}${block(en, 'en', 'en')}
<footer>© Delova Wardrobe · ${esc(c.base)}</footer></main></body></html>`;
};

export function mountLegal(app) {
  const pages = { privacy: PRIVACY, terms: TERMS, 'data-deletion': DELETION };
  const serve = (def) => (req, res) => res.type('html').set('Cache-Control', 'public, max-age=300').send(page('', def));
  for (const [p, def] of Object.entries(pages)) app.get(`/${p}`, serve(def));
  app.get('/privasi', (req, res) => res.redirect(301, '/privacy'));
  app.get('/ketentuan', (req, res) => res.redirect(301, '/terms'));
  app.get('/hapus-data', (req, res) => res.redirect(301, '/data-deletion'));

  // Callback Meta. Sengaja tanpa efek samping: penghapusan dilakukan lewat langkah di halaman /data-deletion.
  app.post('/auth/threads/deauthorize', (req, res) => res.json({ ok: true }));
  app.post('/auth/instagram/deauthorize', (req, res) => res.json({ ok: true }));
  app.post('/auth/instagram/delete', (req, res) =>
    res.json({ url: `${ctx().base}/data-deletion`, confirmation_code: randomBytes(8).toString('hex') }));
  app.post('/auth/threads/delete', (req, res) =>
    res.json({ url: `${ctx().base}/data-deletion`, confirmation_code: randomBytes(8).toString('hex') }));
}
