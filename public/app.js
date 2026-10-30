const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const RANK = { viewer: 0, editor: 1, manager: 2, admin: 3 };
const STATUS = { draft: 'Draft', pending_approval: 'Menunggu approval', scheduled: 'Terjadwal', publishing: 'Memposting…', published: 'Terbit', failed: 'Gagal' };
const ROLE_LABEL = { viewer: 'Viewer (lihat saja)', editor: 'Editor (tulis & ajukan)', manager: 'Manager (setujui & publish)', admin: 'Admin (semua)' };

let me, brands = [], health = {};
const can = (min) => RANK[me.role] >= RANK[min];

/* ---------- util ---------- */
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'hub' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && url !== '/api/login') { showLogin(); throw new Error('Sesi berakhir, silakan masuk lagi.'); }
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
function toast(msg, bad = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), bad ? 6000 : 3000);
}
const len = (t) => { let n = 0; for (const ch of t) n += ch.codePointAt(0) > 0xffff ? 4 : 1; return n; };
const wib = (iso) => (iso ? new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short' }) + ' WIB' : '-');
const toInput = (iso) => (iso ? new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' }).replace(' ', 'T').slice(0, 16) : '');
const fromInput = (v) => (v ? new Date(v + ':00+07:00').toISOString() : null);
const brandOf = (id) => brands.find((b) => b.id === id) || { name: id, color: '#888' };
const brandPick = (id, name = 'brand') => `<select name="${name}">${brands.map((b) => `<option value="${b.id}" ${b.id === id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>`;
const badge = (s) => `<span class="badge s-${s}">${STATUS[s] || s}</span>`;
/* Date-time picker (flatpickr, disajikan dari server sendiri karena CSP). Nilai input asli tetap 'YYYY-MM-DDTHH:mm' (WIB). */
const pickers = (root = document) => {
  if (!window.flatpickr) return;
  $$('.dtp', root).forEach((el) => {
    if (el._flatpickr) return;
    flatpickr(el, {
      enableTime: true, time_24hr: true, minuteIncrement: 5, dateFormat: 'Y-m-d\\TH:i', altInput: true, altFormat: 'D, d M Y · H:i', altInputClass: 'dtp-alt',
      locale: 'id', disableMobile: true, minDate: el.value ? undefined : 'today', allowInput: false,
      onReady: (_, __, fp) => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'fp-clear'; b.textContent = 'Kosongkan';
        b.onclick = () => { fp.clear(); fp.close(); }; fp.calendarContainer.appendChild(b);
      },
    });
  });
};
const busy = async (btn, fn) => { btn.disabled = true; try { return await fn(); } catch (e) { toast(e.message, true); } finally { btn.disabled = false; } };
const params = () => new URLSearchParams((location.hash.split('?')[1] || ''));

/* ---------- Modal (pengganti alert/confirm/prompt bawaan browser) ---------- */
const ui = (() => {
  let seq = 0;
  function open({ title, intro = '', quote = '', quoteLabel = 'Post asli', field = null, ok = 'OK', cancel = 'Batal', danger = false, hint = '', extra = null }) {
    return new Promise((resolve) => {
      const id = `m${++seq}`; const prev = document.activeElement; const root = document.createElement('div');
      root.className = 'modal-back'; root.setAttribute('role', 'presentation');
      const f = field;
      root.innerHTML = `<form class="modal" role="dialog" aria-modal="true" aria-labelledby="${id}t" novalidate>
        <div class="modal-head"><h3 id="${id}t">${esc(title)}</h3><button type="button" class="icon-btn modal-x" data-m="cancel" aria-label="Tutup">${ico('close')}</button></div>
        <div class="modal-body">
          ${intro ? `<p class="muted" style="margin:0">${esc(intro)}</p>` : ''}
          ${quote ? `<div class="modal-quote"><span class="small muted">${esc(quoteLabel)}</span><div>${esc(quote)}</div></div>` : ''}
          ${extra ? extra.html : ''}
          ${f ? `<label>${esc(f.label)}<textarea name="v" rows="${f.rows || 5}" placeholder="${esc(f.placeholder || '')}" ${f.max ? `data-max="${f.max}"` : ''}>${esc(f.value || '')}</textarea></label>
            <div class="row between small"><span class="muted">${esc(hint)}</span>${f.max ? `<span class="counter" data-cnt>0/${f.max}</span>` : ''}</div>` : ''}
          <p class="err small" data-err></p>
        </div>
        <div class="modal-foot"><button type="button" class="btn" data-m="cancel">${esc(cancel)}</button><button type="submit" class="btn ${danger ? 'danger-solid' : 'primary'}">${esc(ok)}</button></div></form>`;
      document.body.appendChild(root); document.body.classList.add('modal-open');
      const form = $('form', root); const ta = $('textarea', form); const err = $('[data-err]', form);
      const close = (val) => { root.remove(); if (!$('.modal-back')) document.body.classList.remove('modal-open'); document.removeEventListener('keydown', onKey, true); try { prev?.focus?.(); } catch { /* abaikan */ } resolve(val); };
      const count = () => { if (!ta?.dataset.max) return; const n = len(ta.value); const c = $('[data-cnt]', form); c.textContent = `${n}/${ta.dataset.max}`; c.className = 'counter' + (n > Number(ta.dataset.max) ? ' over' : ''); };
      const submit = () => {
        if (!f) { if (!extra?.collect) return close(true); const r = extra.collect(form); return r === undefined ? undefined : close(r); }
        const v = ta.value.trim();
        if (!v && !f.optional) { err.textContent = 'Kolom ini wajib diisi.'; return ta.focus(); }
        if (f.max && len(v) > f.max) { err.textContent = `Terlalu panjang: maksimal ${f.max} karakter.`; return ta.focus(); }
        close(v);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(f ? null : false); }
        else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && f) { e.preventDefault(); submit(); }
        else if (e.key === 'Tab') { const els = $$('button, textarea, input, [href]', form).filter((x) => !x.disabled); if (!els.length) return; const first = els[0]; const last = els[els.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } }
      };
      document.addEventListener('keydown', onKey, true);
      if (extra?.init) extra.init(form, (m) => { err.textContent = m; });
      form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
      root.addEventListener('mousedown', (e) => { if (e.target === root) close(f ? null : false); });
      $$('[data-m=cancel]', form).forEach((b) => b.addEventListener('click', () => close(f ? null : false)));
      if (ta) { ta.addEventListener('input', () => { err.textContent = ''; count(); }); count(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } else $('button[type=submit]', form).focus();
    });
  }
  return {
    /** true bila dikonfirmasi, false bila dibatalkan */
    confirm: (o) => open({ ...o, title: o.title || 'Konfirmasi', intro: o.message || '' }),
    /** teks yang diisi (string, boleh kosong bila optional) atau null bila dibatalkan */
    /** modal berisi HTML sendiri: extra = { html, init(form, setError), collect(form) -> nilai | undefined (tahan modal) } */
    form: (o) => open({ ...o, title: o.title, intro: o.message || '' }),
    ask: (o) => open({ ...o, field: { label: o.label, placeholder: o.placeholder, max: o.max, value: o.value, rows: o.rows, optional: o.optional }, intro: o.intro || '' }),
  };
})();

/* ---------- auth ---------- */
function showLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); }
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); $('#loginErr').textContent = '';
  try { await api('POST', '/api/login', Object.fromEntries(new FormData(e.target))); await boot(); } catch (err) { $('#loginErr').textContent = err.message; }
});
$('#logout').addEventListener('click', async () => { await api('POST', '/api/logout'); showLogin(); });

/* ---------- kerangka: drawer mobile & tema ---------- */
const closeDrawer = () => { $('#side').classList.remove('open'); $('#backdrop').classList.add('hidden'); };
$('#burger').addEventListener('click', () => { $('#side').classList.add('open'); $('#backdrop').classList.remove('hidden'); });
$('#backdrop').addEventListener('click', closeDrawer);
const paintTheme = () => { const dark = document.documentElement.classList.contains('dark'); $('#theme').innerHTML = ico(dark ? 'sun' : 'moon'); $('#theme').title = dark ? 'Mode terang' : 'Mode gelap'; };
$('#theme').addEventListener('click', () => {
  const dark = document.documentElement.classList.toggle('dark');
  try { localStorage.setItem('hub-theme', dark ? 'dark' : 'light'); } catch { /* abaikan */ }
  paintTheme();
});

/* ---------- routing ---------- */
const ICON = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  compose: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  queue: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
  plan: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  autoreply: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M9 11h6M9 14h3"/>',
  instagram: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r=".6"/>',
  media: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>', chevl: '<path d="m15 18-6-6 6-6"/>', chevr: '<path d="m9 18 6-6-6-6"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13l3.5 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6Z"/>',
  insights: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
  research: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  mentions: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
  creators: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  brands: '<path d="M3 9l9-6 9 6v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/><path d="M9 21V12h6v9"/>',
  claude: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z"/><path d="M19 17v4M17 19h4"/>',
  control: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
  meta: '<path d="M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8Zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
  team: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>', check: '<path d="M20 6 9 17l-5-5"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>', send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
};
const ico = (n, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n] || ''}</svg>`;
// [id, label, peran minimal, grup]
const ROUTES = [
  ['dashboard', 'Dashboard', 'viewer', 'Menu'], ['compose', 'Tulis Post', 'editor', 'Menu'], ['media', 'Foto Sementara', 'viewer', 'Menu'], ['queue', 'Antrean & Approval', 'viewer', 'Menu'],
  ['calendar', 'Kalender', 'viewer', 'Menu'], ['instagram', 'Instagram', 'viewer', 'Menu'], ['autoreply', 'Auto Reply', 'viewer', 'Menu'], ['plan', 'Rencana Mingguan', 'editor', 'Menu'], ['inbox', 'Inbox Reply', 'editor', 'Menu'], ['insights', 'Insight', 'viewer', 'Menu'],
  ['research', 'Riset', 'viewer', 'Riset & Kolaborasi'], ['mentions', 'Mention', 'viewer', 'Riset & Kolaborasi'], ['creators', 'Kolaborasi', 'viewer', 'Riset & Kolaborasi'],
  ['brands', 'Brand & Akun', 'viewer', 'Pengaturan'], ['claude', 'Hubungkan Claude', 'viewer', 'Pengaturan'], ['control', 'Kontrol Claude', 'admin', 'Pengaturan'],
  ['meta', 'Pengaturan Meta', 'admin', 'Pengaturan'], ['team', 'Tim', 'admin', 'Pengaturan'],
];
const VIEWS = {};

async function boot() {
  try { me = await api('GET', '/api/me'); } catch { return showLogin(); }
  health = await fetch('/api/health').then((r) => r.json());
  brands = await api('GET', '/api/brands');
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#whoName').textContent = me.name; $('#whoRole').textContent = me.role; $('#avatar').textContent = (me.name || '?').trim().charAt(0).toUpperCase();
  paintTheme();
  let grp = '';
  $('#nav').innerHTML = ROUTES.filter((r) => can(r[2])).map((r) => {
    const head = r[3] !== grp ? `<div class="nav-group">${r[3]}</div>` : ''; grp = r[3];
    return `${head}<a href="#/${r[0]}" data-r="${r[0]}">${ico(r[0])}<span>${r[1]}</span></a>`;
  }).join('');
  $('#banner').innerHTML = [
    health.simulated ? '<div class="banner"><b>Mode simulasi:</b> post tidak dikirim ke Threads asli. Isi kredensial Meta di <code>.env</code> dan set <code>THREADS_DRY_RUN=false</code> untuk go-live (lihat README).</div>' : '',
    !health.ai ? '<div class="banner">Fitur Claude di dalam dashboard belum aktif: isi <code>ANTHROPIC_API_KEY</code> di <code>.env</code>.</div>' : '',
  ].join('');
  route();
}
async function route() {
  if (!me) return;
  const name = (location.hash.slice(2).split('?')[0]) || 'dashboard';
  const r = ROUTES.find((x) => x[0] === name && can(x[2])) || ROUTES[0];
  $$('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.r === r[0]));
  $('#crumb').textContent = r[1]; closeDrawer(); window.scrollTo(0, 0);
  const v = $('#view'); v.onclick = v.onsubmit = v.onchange = null; v.innerHTML = '<p class="muted">Memuat…</p>';
  try { await VIEWS[r[0]](v); } catch (e) { v.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', route);

/* ---------- Dashboard ---------- */
VIEWS.dashboard = async (v) => {
  const d = await api('GET', '/api/dashboard');
  const sum = (k) => d.brands.reduce((n, b) => n + ((b.counts || {})[k] || 0), 0);
  const kpi = (cls, ic, n, l) => `<div class="kpi ${cls}"><div class="ic">${ico(ic)}</div><div><b>${n}</b><span>${l}</span></div></div>`;
  v.innerHTML = `<div class="page-head"><h1>Dashboard</h1><p class="muted">Ringkasan 4 akun Threads Delova.</p></div>
  <div class="grid g4" style="margin-bottom:16px">${kpi('ok', 'check', sum('published'), 'Post terbit')}${kpi('', 'clock', sum('scheduled'), 'Terjadwal')}${kpi('warn', 'send', sum('pending_approval'), 'Menunggu approval')}${kpi('bad', 'alert', sum('failed'), 'Gagal')}</div>
  <div class="grid g2w">${d.brands.map((b) => {
    const c = b.counts || {};
    return `<div class="card bcard" style="--c:${b.color}">
      <div class="row between"><h2>${esc(b.name)}</h2>${b.connected ? `<span class="badge s-published">@${esc(b.username || 'terhubung')}</span>` : b.simulated ? '<span class="badge">Simulasi</span>' : '<span class="badge s-failed">Belum terhubung</span>'}</div>
      <div class="stats"><div><b>${c.draft || 0}</b><span>Draft</span></div><div><b>${c.pending_approval || 0}</b><span>Review</span></div><div><b>${c.scheduled || 0}</b><span>Terjadwal</span></div><div><b>${c.published || 0}</b><span>Terbit</span></div></div>
      <div class="small muted">${b.next_post ? `Berikutnya: ${wib(b.next_post.scheduled_at)}<br>“${esc(b.next_post.text.slice(0, 80))}…”` : 'Belum ada post terjadwal.'}</div>
      ${c.failed ? `<div class="err small">${c.failed} post gagal, cek Antrean.</div>` : ''}
      <div class="row">${can('editor') ? `<a class="btn small primary" href="#/compose?brand=${b.id}">Tulis post</a>` : ''}<a class="btn small" href="#/queue?brand=${b.id}">Antrean</a></div></div>`;
  }).join('')}</div>`;
};

/* ---------- Compose ---------- */
function variantsHtml(list, label = 'Pakai ini') {
  return list.map((x, i) => `<div class="variant"><div class="row between"><b>#${i + 1} ${esc(x.angle || '')}</b><span class="counter ${x.too_long ? 'over' : ''}">${x.length}/500</span></div>
    <p>${esc(x.text)}</p><div class="row"><button class="btn small primary" data-use="${i}">${label}</button></div></div>`).join('');
}
VIEWS.compose = async (v) => {
  const q = params();
  let post = q.get('edit') ? await api('GET', `/api/posts/${q.get('edit')}`) : null;
  const brandId = post?.brand_id || q.get('brand') || brands[0].id;
  v.innerHTML = `<h1>${post ? 'Edit post' : 'Tulis post'}</h1>
  <div class="grid g2">
    <div class="card stack">
      <label>Akun ${brandPick(brandId)}</label>
      ${post?.review_note ? `<div class="banner">Catatan reviewer: ${esc(post.review_note)}</div>` : ''}
      <label>Isi post <textarea id="text" placeholder="Tulis atau minta ide dari Claude →">${esc(post?.text || '')}</textarea></label>
      <div class="counter" id="cnt">0/500</div>
      <div class="stack" style="gap:8px"><span class="lbl">Foto / video (opsional; 2+ = carousel)</span>
        <div id="drop" class="dropzone" tabindex="0"><input id="file" type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime" hidden />
          <b>Klik atau seret file ke sini</b><span class="small muted">JPG, PNG, WEBP, GIF (maks 8 MB) · MP4/MOV (maks 50 MB). File disimpan sementara dan <b>dihapus otomatis 24 jam setelah post terbit</b>.</span></div>
        <div id="thumbs" class="thumbs"></div>
        <details><summary class="small muted">Atau tempel URL gambar/video sendiri (HTTPS publik, satu per baris)</summary><textarea id="media" style="min-height:64px">${esc((post?.media_urls || []).join('\n'))}</textarea></details></div>
      <div class="grid g2">
        <label>Topic tag (opsional)<input id="tag" value="${esc(post?.topic_tag || '')}" placeholder="mis. KebayaModern" /></label>
        <label>Siapa boleh reply<select id="rc"><option value="">Semua orang</option><option value="accounts_you_follow">Akun yang kami ikuti</option><option value="mentioned_only">Hanya yang di-mention</option><option value="followers_only">Followers</option></select></label>
      </div>
      <label>Jadwal tayang (WIB)<input id="when" class="dtp" value="${toInput(post?.scheduled_at) || (/^\d{4}-\d{2}-\d{2}$/.test(q.get('date') || '') ? `${q.get('date')}T09:00` : '')}" placeholder="Pilih tanggal &amp; jam" /></label>
      <div class="row">
        <button class="btn" id="save">Simpan draft</button>
        <button class="btn primary" id="submit">Ajukan approval</button>
        ${can('manager') ? '<button class="btn primary" id="approve">Setujui &amp; jadwalkan</button><button class="btn danger" id="now">Publish sekarang</button>' : ''}
      </div>
    </div>
    <div class="card stack"><h2>Asisten Claude</h2>
      ${health.ai ? `<label>Brief / topik<textarea id="brief" style="min-height:80px" placeholder="mis. Kebaya brokat warna sage baru restock, cocok untuk kondangan siang"></textarea></label>
      <div class="row"><select id="n" style="width:auto"><option>5</option><option>7</option><option>10</option></select> opsi
      <button class="btn primary" id="gen">Minta ide dari Claude</button></div>
      <div class="row"><input id="instr" placeholder="Instruksi perbaikan (opsional), mis. lebih singkat & lebih lucu" /><button class="btn" id="imp">Perbaiki teks di kiri</button></div>
      <div id="vars" class="stack"></div>` : '<p class="muted">Aktifkan dengan mengisi <code>ANTHROPIC_API_KEY</code> di <code>.env</code>. Sementara itu Anda tetap bisa menulis manual, atau minta Claude lewat MCP (menu Hubungkan Claude).</p>'}
    </div></div>`;
  $('#rc').value = post?.reply_control || ''; pickers(v);
  const text = $('#text'); const upd = () => { const n = len(text.value); const c = $('#cnt'); c.textContent = `${n}/500`; c.className = 'counter' + (n > 500 ? ' over' : ''); };
  text.addEventListener('input', upd); upd();
  // ---- unggah foto/video (disimpan sementara di server) ----
  const mediaLines = () => $('#media').value.split('\n').map((x) => x.trim()).filter(Boolean);
  const isVid = (u) => /\.(mp4|mov)(\?|$)/i.test(u);
  const paintThumbs = () => {
    $('#thumbs').innerHTML = mediaLines().map((u, i) => `<div class="thumb">${isVid(u) ? `<video src="${esc(u)}" muted preload="metadata"></video>` : `<img src="${esc(u)}" alt="Media ${i + 1}" loading="lazy" />`}<button type="button" class="thumb-x" data-i="${i}" aria-label="Hapus media ${i + 1}">×</button><span class="thumb-n">${i + 1}</span></div>`).join('');
  };
  $('#thumbs').onclick = (e) => {
    const b = e.target.closest('[data-i]'); if (!b) return;
    const l = mediaLines(); const [u] = l.splice(Number(b.dataset.i), 1); $('#media').value = l.join('\n'); paintThumbs();
    const m = /\/media\/([a-f0-9]{32}\.[a-z0-9]+)/.exec(u || ''); if (m && !post) fetch(`/api/media/${m[1]}`, { method: 'DELETE', headers: { 'x-requested-with': 'hub' } }).catch(() => {});
  };
  $('#media').addEventListener('input', paintThumbs);
  const sendFiles = async (files) => {
    const box = $('#drop'); box.classList.add('busy');
    try {
      for (const f of files) {
        if (mediaLines().length >= 20) { toast('Maksimal 20 media per post.'); break; }
        const r = await fetch(`/api/media?brand=${encodeURIComponent($('[name=brand]').value)}`, { method: 'POST', headers: { 'content-type': f.type, 'x-requested-with': 'hub', 'x-filename': encodeURIComponent(f.name) }, body: f });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { toast(`${f.name}: ${j.error || 'gagal diunggah'}`); continue; }
        $('#media').value = [...mediaLines(), j.url].join('\n'); paintThumbs();
      }
    } finally { box.classList.remove('busy'); $('#file').value = ''; }
  };
  $('#drop').onclick = (e) => { if (e.target.id !== 'file') $('#file').click(); };
  $('#drop').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file').click(); } };
  $('#file').onchange = (e) => sendFiles([...e.target.files]);
  ['dragenter', 'dragover'].forEach((ev) => $('#drop').addEventListener(ev, (e) => { e.preventDefault(); $('#drop').classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => $('#drop').addEventListener(ev, (e) => { e.preventDefault(); $('#drop').classList.remove('over'); }));
  $('#drop').addEventListener('drop', (e) => sendFiles([...e.dataTransfer.files]));
  paintThumbs();
  const body = () => ({
    brand_id: $('[name=brand]').value, text: text.value, topic_tag: $('#tag').value.trim() || null, reply_control: $('#rc').value || null,
    media_urls: $('#media').value.split('\n').map((s) => s.trim()).filter(Boolean), scheduled_at: fromInput($('#when').value),
  });
  const save = async () => {
    const b = body();
    if (post) { const { brand_id, ...rest } = b; post = await api('PUT', `/api/posts/${post.id}`, rest); } else post = await api('POST', '/api/posts', b);
    return post;
  };
  $('#save').onclick = (e) => busy(e.target, async () => { await save(); toast('Draft tersimpan.'); });
  $('#submit').onclick = (e) => busy(e.target, async () => { await save(); await api('POST', `/api/posts/${post.id}/submit`); toast('Diajukan ke manajer.'); location.hash = '#/queue'; });
  if (can('manager')) {
    $('#approve').onclick = (e) => busy(e.target, async () => {
      if (!$('#when').value) throw new Error('Isi jadwal tayang dulu.');
      await save(); await api('POST', `/api/posts/${post.id}/approve`, { scheduled_at: fromInput($('#when').value) }); toast('Dijadwalkan.'); location.hash = '#/queue';
    });
    $('#now').onclick = (e) => busy(e.target, async () => {
      if (!(await ui.confirm({ title: 'Publish sekarang?', message: 'Post langsung tayang di Threads untuk akun yang dipilih, tanpa menunggu jadwal atau approval.', ok: 'Publish sekarang' }))) return;
      await save(); const p = await api('POST', `/api/posts/${post.id}/publish-now`);
      if (p.status === 'failed') throw new Error(p.error); toast('Terbit!'); location.hash = '#/queue';
    });
  }
  if (health.ai) {
    let last = [];
    const show = (vs) => { last = vs; $('#vars').innerHTML = variantsHtml(vs); };
    $('#vars').addEventListener('click', (e) => { const i = e.target.dataset.use; if (i !== undefined) { text.value = last[i].text; if (last[i].topic_tag) $('#tag').value = last[i].topic_tag; upd(); toast('Teks dipakai. Silakan edit bila perlu.'); } });
    $('#gen').onclick = (e) => busy(e.target, async () => {
      e.target.textContent = 'Claude sedang menulis…';
      try { show((await api('POST', '/api/ai/generate', { brand_id: $('[name=brand]').value, brief: $('#brief').value, count: $('#n').value })).variants); } finally { e.target.textContent = 'Minta ide dari Claude'; }
    });
    $('#imp').onclick = (e) => busy(e.target, async () => show((await api('POST', '/api/ai/improve', { brand_id: $('[name=brand]').value, text: text.value, instruction: $('#instr').value })).variants));
  }
};

/* ---------- Antrean ---------- */
VIEWS.queue = async (v) => {
  const q = params(); const fb = q.get('brand') || ''; const fs = q.get('status') || '';
  const rows = await api('GET', `/api/posts?${new URLSearchParams({ ...(fb && { brand: fb }), ...(fs && { status: fs }) })}`);
  v.innerHTML = `<h1>Antrean &amp; Approval</h1>
  <div class="row"><select id="fb" style="width:auto"><option value="">Semua akun</option>${brands.map((b) => `<option value="${b.id}" ${b.id === fb ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>
  <select id="fs" style="width:auto"><option value="">Semua status</option>${Object.entries(STATUS).map(([k, l]) => `<option value="${k}" ${k === fs ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
  <div id="bulk" class="bulkbar hidden"><b id="bn">0 dipilih</b><span class="row">${can('manager') ? '<button type="button" class="btn small primary" data-bulk="approve">Setujui terpilih</button><button type="button" class="btn small" data-bulk="reject">Kembalikan</button>' : ''}${can('editor') ? '<button type="button" class="btn small" data-bulk="submit">Ajukan approval</button>' : ''}<button type="button" class="btn small ghost" data-bulk="clear">Batal pilih</button></span></div>
  <div class="card" style="margin-top:12px"><table><thead><tr><th style="width:34px">${can('editor') ? `<input type="checkbox" id="all" aria-label="Pilih semua" title="Pilih semua yang bisa diproses" />` : ''}</th><th>Akun</th><th>Isi</th><th>Jadwal / Terbit</th><th>Status</th><th></th></tr></thead><tbody>
  ${rows.map((p) => `<tr data-id="${p.id}"><td>${can('editor') && ['pending_approval', 'draft', 'failed', 'scheduled'].includes(p.status) ? `<input type="checkbox" class="pick" aria-label="Pilih post" />` : ''}</td><td><b style="color:${brandOf(p.brand_id).color}">${esc(brandOf(p.brand_id).name)}</b><div class="small muted">${esc(p.author || '')}${p.source === 'claude' ? ' · via Claude' : p.source === 'ai' ? ' · AI' : ''}</div></td>
    <td>${esc(p.text.slice(0, 140))}${p.text.length > 140 ? '…' : ''}${p.error ? `<div class="err small">${esc(p.error)}</div>` : ''}${p.review_note ? `<div class="small muted">Catatan: ${esc(p.review_note)}</div>` : ''}</td>
    <td class="small">${wib(p.published_at || p.scheduled_at)}</td><td>${badge(p.status)}</td>
    <td><div class="row">${actions(p)}</div></td></tr>`).join('') || '<tr><td colspan="6" class="muted">Belum ada post.</td></tr>'}
  </tbody></table></div>`;
  const go = () => { location.hash = `#/queue?brand=${$('#fb').value}&status=${$('#fs').value}`; };
  $('#fb').onchange = go; $('#fs').onchange = go;
  // ---- persetujuan massal ----
  const picked = () => $$('.pick:checked', v).map((c) => rows.find((r) => r.id === c.closest('tr').dataset.id));
  const refreshBulk = () => {
    const n = picked().length; $('#bulk').classList.toggle('hidden', !n); $('#bn').textContent = `${n} post dipilih`;
    const all = $('#all'); if (all) { const t = $$('.pick', v).length; all.checked = n > 0 && n === t; all.indeterminate = n > 0 && n < t; }
  };
  v.addEventListener('change', (e) => {
    if (e.target.id === 'all') $$('.pick', v).forEach((c) => { c.checked = e.target.checked; });
    if (e.target.id === 'all' || e.target.classList.contains('pick')) refreshBulk();
  });
  const bulkCall = async (action, ids, extra = {}) => {
    const r = await api('POST', '/api/posts/bulk', { action, ids, ...extra });
    const label = { approve: 'disetujui & dijadwalkan', reject: 'dikembalikan ke draft', submit: 'diajukan' }[action];
    toast(`${r.done.length} post ${label}${r.skipped.length ? `, ${r.skipped.length} dilewati` : ''}.`, !r.done.length);
    if (r.skipped.length) await ui.confirm({ title: `${r.skipped.length} post dilewati`, message: 'Post berikut tidak diproses:', extra: { html: `<ul class="skiplist">${r.skipped.map((s) => { const p = rows.find((x) => x.id === s.id); return `<li><b>${esc(p ? brandOf(p.brand_id).name : s.id)}</b> — ${esc((p?.text || '').slice(0, 60))}<div class="small err">${esc(s.reason)}</div></li>`; }).join('')}</ul>` }, ok: 'Mengerti', cancel: 'Tutup' });
    route();
  };
  $('#bulk').onclick = (e) => {
    const act = e.target.dataset.bulk; if (!act) return;
    if (act === 'clear') { $$('.pick:checked', v).forEach((c) => { c.checked = false; }); return refreshBulk(); }
    busy(e.target, async () => {
      const sel = picked(); const ids = sel.map((p) => p.id);
      if (act === 'reject') { const note = await ui.ask({ title: `Kembalikan ${ids.length} post ke penulis`, label: 'Catatan untuk penulis (opsional)', optional: true, max: 300, rows: 3, ok: 'Kembalikan' }); if (note === null) return; return bulkCall('reject', ids, { note }); }
      if (act === 'submit') { if (!(await ui.confirm({ title: `Ajukan ${ids.length} post?`, message: 'Post draft/gagal yang dipilih dikirim ke antrean approval manajer.', ok: 'Ajukan' }))) return; return bulkCall('submit', ids); }
      // approve: ringkasan, jadwal otomatis untuk yang kosong, izin untuk jadwal lampau
      const now = Date.now(); const ok = sel.filter((p) => ['pending_approval', 'draft', 'failed'].includes(p.status));
      const missing = ok.filter((p) => !p.scheduled_at); const past = ok.filter((p) => p.scheduled_at && Date.parse(p.scheduled_at) < now - 60_000);
      const byBrand = Object.entries(ok.reduce((a, p) => ((a[brandOf(p.brand_id).name] = (a[brandOf(p.brand_id).name] || 0) + 1), a), {})).map(([k, n]) => `${esc(k)} ${n}`).join(' · ');
      if (!ok.length) return toast('Tidak ada post yang bisa disetujui di pilihan ini (hanya Draft / Menunggu approval / Gagal).', true);
      const first = new Date(now + 3600e3); first.setMinutes(Math.ceil(first.getMinutes() / 5) * 5, 0, 0);
      const html = `<div class="bulksum"><b>${ok.length} post akan disetujui</b><div class="small muted">${byBrand}</div></div>
        <div class="skiplist plist">${ok.map((p) => `<div class="prow"><span style="color:${brandOf(p.brand_id).color}">●</span><span class="trunc">${esc(p.text.slice(0, 70))}</span><span class="small ${!p.scheduled_at ? 'err' : Date.parse(p.scheduled_at) < now - 60000 ? 'err' : 'muted'}">${p.scheduled_at ? esc(wib(p.scheduled_at).replace(' WIB', '')) : 'belum ada jadwal'}</span></div>`).join('')}</div>
        ${missing.length ? `<div class="stack" style="gap:8px"><b>${missing.length} post belum punya jadwal — atur otomatis</b><label>Mulai (WIB)<input name="start" class="dtp" value="${toInput(first.toISOString())}" /></label>
          <label>Jarak antar post<select name="gap"><option value="30">30 menit</option><option value="60" selected>1 jam</option><option value="120">2 jam</option><option value="180">3 jam</option><option value="720">12 jam</option><option value="1440">1 hari</option></select></label></div>` : ''}
        ${past.length ? `<label class="row" style="gap:8px"><input type="checkbox" name="past" style="width:auto" /> Izinkan ${past.length} post berjadwal lampau tayang segera</label>` : ''}`;
      const out = await ui.form({ title: 'Setujui & jadwalkan massal', message: 'Periksa daftar sebelum menyetujui. Yang sudah punya jadwal tidak diubah.', ok: `Setujui ${ok.length} post`, extra: { html, init: (f) => pickers(f), collect: (f) => { const o = { fill_missing: null, allow_past: !!f.elements.past?.checked }; if (missing.length) { const st = fromInput(f.elements.start.value); if (!st) { return void (f.querySelector('[data-err]').textContent = 'Pilih waktu mulai.'); } o.fill_missing = { start: st, interval_minutes: Number(f.elements.gap.value) }; } return o; } } });
      if (!out) return;
      await bulkCall('approve', ok.map((p) => p.id), { fill_missing: out.fill_missing || undefined, allow_past: out.allow_past });
    });
  };
  v.onclick = async (e) => {
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const id = btn.closest('tr').dataset.id; const act = btn.dataset.act;
    await busy(btn, async () => {
      if (act === 'edit') return (location.hash = `#/compose?edit=${id}`);
      if (act === 'delete' && !(await ui.confirm({ title: 'Hapus post ini?', message: 'Post dihapus dari antrean dan tidak bisa dikembalikan. Post yang sudah terbit di Threads tidak ikut terhapus.', ok: 'Hapus', danger: true }))) return;
      if (act === 'now' && !(await ui.confirm({ title: 'Publish sekarang?', message: 'Post langsung tayang di Threads tanpa menunggu jadwal.', ok: 'Publish sekarang' }))) return;
      let payload;
      if (act === 'reject') { const note = await ui.ask({ title: 'Kembalikan post ke penulis', label: 'Catatan untuk penulis (opsional)', placeholder: 'mis. Tolong ganti foto dan tambah info ukuran', optional: true, max: 500, rows: 4, ok: 'Kembalikan' }); if (note === null) return; payload = { note }; }
      if (act === 'approve') { const p = rows.find((r) => r.id === id); if (!p.scheduled_at) { toast('Tentukan jadwal dulu.', true); return (location.hash = `#/compose?edit=${id}`); } }
      if (act === 'delete') await api('DELETE', `/api/posts/${id}`);
      else { const r = await api('POST', `/api/posts/${id}/${act === 'now' ? 'publish-now' : act}`, payload); if (r.status === 'failed') throw new Error(r.error); }
      toast('Berhasil.'); route();
    });
  };
};
function actions(p) {
  const b = (act, label, cls = '') => `<button class="btn small ${cls}" data-act="${act}">${label}</button>`;
  const out = [];
  if (p.status === 'published') return p.permalink ? `<a class="btn small" target="_blank" rel="noopener" href="${esc(p.permalink)}">Buka</a>` : '';
  if (p.status === 'publishing') return '';
  if (can('editor')) out.push(b('edit', 'Edit'));
  if (can('editor') && ['draft', 'failed'].includes(p.status)) out.push(b('submit', 'Ajukan'));
  if (can('manager') && ['pending_approval', 'draft', 'failed'].includes(p.status)) out.push(b('approve', 'Setujui', 'primary'));
  if (can('manager') && ['pending_approval', 'scheduled'].includes(p.status)) out.push(b('reject', 'Kembalikan'));
  if (can('manager')) out.push(b('now', 'Publish', ''));
  if (can('editor')) out.push(b('delete', 'Hapus', 'danger'));
  return out.join('');
}


/* ---------- Instagram ---------- */
const IG_TABS = [['konten', 'Konten & Jadwal', 'viewer'], ['komentar', 'Komentar', 'editor'], ['dm', 'Pesan (DM)', 'editor'], ['insight', 'Insight', 'viewer'], ['akun', 'Akun', 'viewer']];
const IG_KIND = { feed: 'Feed', reels: 'Reels', story: 'Story' };
const igTime = (iso) => new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).replace('.', ':');

VIEWS.instagram = async (v) => {
  const q = params(); const st = await api('GET', '/api/ig/status');
  const tab = IG_TABS.some((t) => t[0] === q.get('tab') && can(t[2])) ? q.get('tab') : 'konten';
  const bid = st.brands.some((b) => b.id === q.get('brand')) ? q.get('brand') : (st.brands.find((b) => b.connected) || st.brands[0]).id;
  const cur = st.brands.find((b) => b.id === bid);
  const nav = (t, b = bid) => `#/instagram?tab=${t}&brand=${b}`;
  if (q.get('connect')) toast(q.get('connect') === 'ok' ? 'Akun Instagram berhasil terhubung.' : `Gagal menghubungkan: ${q.get('msg') || 'coba lagi'}`, q.get('connect') !== 'ok');
  v.innerHTML = `<div class="page-head"><h1>Instagram</h1><p class="muted">Kelola konten & jadwal, balas komentar dan DM, serta pantau insight untuk akun Instagram brand.</p></div>
  ${st.simulated ? '<div class="banner"><b>Mode simulasi:</b> data di halaman ini adalah contoh dan tidak ada yang dikirim ke Instagram asli. Admin: isi kredensial di tab Akun dan set mode Live di Pengaturan Meta.</div>' : ''}
  <div class="chips" style="margin-bottom:10px">${st.brands.map((b) => `<a class="chip" href="${nav(tab, b.id)}" ${b.id === bid ? 'style="border-color:var(--accent);color:var(--accent)"' : ''}><i class="cal-dot ${b.connected || st.simulated ? 'on' : 'off'}" style="--c:${b.color}"></i> ${esc(b.name.replace('Delova ', ''))}${b.username ? ` <span class="muted small">@${esc(b.username)}</span>` : ''}</a>`).join('')}</div>
  <div class="tabs">${IG_TABS.filter((t) => can(t[2])).map((t) => `<a class="tab ${t[0] === tab ? 'on' : ''}" href="${nav(t[0])}">${t[1]}</a>`).join('')}</div>
  ${!cur.connected && !st.simulated && tab !== 'akun' ? `<div class="banner">Akun Instagram ${esc(cur.name)} belum terhubung. ${can('manager') ? `<a href="${nav('akun')}">Hubungkan di tab Akun</a>.` : 'Minta manajer menghubungkannya.'}</div>` : ''}
  <div id="igbody" class="stack" style="margin-top:14px"><span class="muted">Memuat…</span></div>`;
  const ctx = { v, st, bid, cur, tab, nav, body: $('#igbody') };
  try { await IGV[tab](ctx); } catch (e) { ctx.body.innerHTML = `<div class="banner err">${esc(e.message)}</div>`; }
};

const IGV = {};

/* ---- Konten & jadwal ---- */
IGV.konten = async ({ v, bid, cur, body }) => {
  const [rows, lib] = await Promise.all([api('GET', `/api/ig/posts?brand=${bid}`), can('editor') ? api('GET', '/api/media?limit=40').catch(() => []) : []]);
  const libOk = lib.filter((m) => m.free && (m.mime === 'image/jpeg' || m.mime.startsWith('video/')));
  let editing = null;
  const isVid = (u) => /\.(mp4|mov)(\?|$)/i.test(u);
  body.innerHTML = `${can('editor') ? `<div class="row between"><b>${rows.length} konten · ${esc(cur.name)}</b><button class="btn primary" id="newc" type="button">Buat konten</button></div>
  <div id="comp" class="card stack hidden">
    <h3 id="ctitle">Konten baru</h3>
    <div class="grid g2"><label>Jenis<select id="kind"><option value="feed">Feed (foto / carousel)</option><option value="reels">Reels (video)</option><option value="story">Story (foto / video)</option></select></label>
      <label>Jadwal tayang (WIB)<input id="iwhen" class="dtp" placeholder="Pilih tanggal &amp; jam" /></label></div>
    <label>Caption <textarea id="cap" style="min-height:110px" placeholder="Tulis caption. Maks 2200 karakter dan 30 hashtag."></textarea></label>
    <div class="counter" id="ccnt">0/2200 · 0/30 hashtag</div>
    <div class="stack" style="gap:8px"><span class="lbl">Foto / video <span class="muted small">(Instagram hanya menerima foto JPG; video MP4/MOV)</span></span>
      <div id="idrop" class="dropzone" tabindex="0"><input id="ifile" type="file" multiple accept="image/jpeg,video/mp4,video/quicktime" hidden /><b>Klik atau seret file ke sini</b><span class="small muted">Disimpan sementara, dihapus 24 jam setelah terbit</span></div>
      ${libOk.length ? `<div class="small muted">Atau pilih dari Foto Sementara:</div><div class="thumbs lib">${libOk.slice(0, 12).map((m) => `<button type="button" class="thumb pick-lib" data-url="${esc(m.url)}" title="${esc(m.original_name || m.name)}">${m.mime.startsWith('video/') ? `<video src="${esc(m.url)}" muted preload="metadata"></video>` : `<img src="${esc(m.url)}" alt="" loading="lazy" />`}</button>`).join('')}</div>` : ''}
      <div id="ithumbs" class="thumbs"></div>
      <details><summary class="small muted">Tempel URL sendiri (HTTPS publik, satu per baris)</summary><textarea id="imedia" style="min-height:64px"></textarea></details></div>
    <div class="row"><button class="btn" id="isave" type="button">Simpan draft</button><button class="btn primary" id="isubmit" type="button">Ajukan approval</button>${can('manager') ? '<button class="btn primary" id="iapprove" type="button">Setujui &amp; jadwalkan</button><button class="btn danger" id="inow" type="button">Terbitkan sekarang</button>' : ''}<button class="btn ghost" id="icancel" type="button">Batal</button></div>
  </div>` : ''}
  <div class="card"><table><thead><tr><th>Konten</th><th>Jenis</th><th>Jadwal / Terbit</th><th>Status</th><th></th></tr></thead><tbody>
  ${rows.map((p) => `<tr data-id="${p.id}"><td><div class="row" style="flex-wrap:nowrap"><span class="mini">${isVid(p.media_urls[0]) ? `<video src="${esc(p.media_urls[0])}" muted preload="metadata"></video>` : `<img src="${esc(p.media_urls[0])}" alt="" loading="lazy" />`}${p.media_urls.length > 1 ? `<i>${p.media_urls.length}</i>` : ''}</span><span>${esc((p.caption || '(tanpa caption)').slice(0, 110))}${p.error ? `<div class="err small">${esc(p.error)}</div>` : ''}${p.review_note ? `<div class="small muted">Catatan: ${esc(p.review_note)}</div>` : ''}<div class="small muted">${esc(p.author || '')}</div></span></div></td>
    <td><span class="badge">${IG_KIND[p.kind]}</span></td><td class="small">${wib(p.published_at || p.scheduled_at)}</td><td>${badge(p.status)}</td>
    <td><div class="row">${igActions(p)}</div></td></tr>`).join('') || '<tr><td colspan="5" class="muted">Belum ada konten untuk akun ini.</td></tr>'}</tbody></table></div>`;
  if (!can('editor')) return;
  pickers(body);
  const $c = (s) => $(s, body); const lines = () => $c('#imedia').value.split('\n').map((x) => x.trim()).filter(Boolean);
  const paint = () => { $c('#ithumbs').innerHTML = lines().map((u, i) => `<div class="thumb">${isVid(u) ? `<video src="${esc(u)}" muted preload="metadata"></video>` : `<img src="${esc(u)}" alt="" loading="lazy" />`}<button type="button" class="thumb-x" data-i="${i}" aria-label="Hapus media ${i + 1}">×</button><span class="thumb-n">${i + 1}</span></div>`).join(''); };
  const cnt = () => { const c = $c('#cap').value; const h = (c.match(/#[\p{L}\p{N}_]+/gu) || []).length; const el = $c('#ccnt'); el.textContent = `${len(c)}/2200 · ${h}/30 hashtag`; el.className = 'counter' + (len(c) > 2200 || h > 30 ? ' over' : ''); };
  const open = (p) => {
    editing = p || null; $c('#comp').classList.remove('hidden'); $c('#ctitle').textContent = p ? 'Edit konten' : 'Konten baru';
    $c('#kind').value = p?.kind || 'feed'; $c('#cap').value = p?.caption || ''; $c('#imedia').value = (p?.media_urls || []).join('\n');
    const w = $c('#iwhen')._flatpickr; if (w) w.setDate(p?.scheduled_at ? toInput(p.scheduled_at) : null, false); paint(); cnt(); $c('#comp').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  $c('#newc').onclick = () => open(null); $c('#icancel').onclick = () => $c('#comp').classList.add('hidden');
  $c('#cap').addEventListener('input', cnt); $c('#imedia').addEventListener('input', paint);
  body.addEventListener('click', (e) => {
    const lb = e.target.closest('.pick-lib'); if (lb) { $c('#imedia').value = [...lines(), lb.dataset.url].join('\n'); paint(); }
    const x = e.target.closest('.thumb-x'); if (x) { const l = lines(); l.splice(Number(x.dataset.i), 1); $c('#imedia').value = l.join('\n'); paint(); }
  });
  const send = async (files) => {
    const box = $c('#idrop'); box.classList.add('busy');
    for (const f of files) {
      const r = await fetch(`/api/media?brand=${bid}`, { method: 'POST', headers: { 'content-type': f.type, 'x-requested-with': 'hub', 'x-filename': encodeURIComponent(f.name) }, body: f });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { toast(`${f.name}: ${j.error || 'gagal diunggah'}`, true); continue; }
      if (!/\.(jpg|mp4|mov)$/.test(j.name)) { toast(`${f.name}: Instagram hanya menerima JPG, MP4, atau MOV.`, true); continue; }
      $c('#imedia').value = [...lines(), j.url].join('\n'); paint();
    }
    box.classList.remove('busy'); $c('#ifile').value = '';
  };
  $c('#idrop').onclick = (e) => { if (e.target.id !== 'ifile') $c('#ifile').click(); };
  $c('#ifile').onchange = (e) => send([...e.target.files]);
  ['dragenter', 'dragover'].forEach((ev) => $c('#idrop').addEventListener(ev, (e) => { e.preventDefault(); $c('#idrop').classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => $c('#idrop').addEventListener(ev, (e) => { e.preventDefault(); $c('#idrop').classList.remove('over'); }));
  $c('#idrop').addEventListener('drop', (e) => send([...e.dataTransfer.files]));
  const payload = () => ({ brand_id: bid, kind: $c('#kind').value, caption: $c('#cap').value, media_urls: lines(), scheduled_at: fromInput($c('#iwhen').value) });
  const saveIt = async () => { const b = payload(); if (editing) { const { brand_id, ...rest } = b; editing = await api('PUT', `/api/ig/posts/${editing.id}`, rest); } else editing = await api('POST', '/api/ig/posts', b); return editing; };
  $c('#isave').onclick = (e) => busy(e.target, async () => { await saveIt(); toast('Draft tersimpan.'); route(); });
  $c('#isubmit').onclick = (e) => busy(e.target, async () => { await saveIt(); await api('POST', `/api/ig/posts/${editing.id}/submit`); toast('Diajukan ke manajer.'); route(); });
  if (can('manager')) {
    $c('#iapprove').onclick = (e) => busy(e.target, async () => { const w = fromInput($c('#iwhen').value); if (!w) throw new Error('Pilih jadwal tayang dulu.'); await saveIt(); await api('POST', `/api/ig/posts/${editing.id}/approve`, { scheduled_at: w }); toast('Disetujui dan dijadwalkan.'); route(); });
    $c('#inow').onclick = (e) => busy(e.target, async () => {
      if (!(await ui.confirm({ title: 'Terbitkan ke Instagram sekarang?', message: 'Konten langsung tayang di akun Instagram tanpa menunggu jadwal.', quote: $c('#cap').value.slice(0, 200), quoteLabel: cur.name, ok: 'Terbitkan sekarang' }))) return;
      await saveIt(); const r = await api('POST', `/api/ig/posts/${editing.id}/publish-now`); if (r.status === 'failed') throw new Error(r.error); toast('Terbit.'); route();
    });
  }
  body.onclick = async (e) => {
    const btn = e.target.closest('[data-iact]'); if (!btn) return;
    const id = btn.closest('tr').dataset.id; const act = btn.dataset.iact; const p = rows.find((r) => r.id === id);
    await busy(btn, async () => {
      if (act === 'edit') return open(p);
      if (act === 'delete' && !(await ui.confirm({ title: 'Hapus konten ini?', message: 'Konten dihapus dari antrean. Yang sudah terbit di Instagram tidak ikut terhapus.', ok: 'Hapus', danger: true }))) return;
      if (act === 'now' && !(await ui.confirm({ title: 'Terbitkan sekarang?', message: 'Konten langsung tayang di Instagram.', ok: 'Terbitkan sekarang' }))) return;
      let b; if (act === 'reject') { const note = await ui.ask({ title: 'Kembalikan konten ke penulis', label: 'Catatan (opsional)', optional: true, max: 300, rows: 3, ok: 'Kembalikan' }); if (note === null) return; b = { note }; }
      if (act === 'approve' && !p.scheduled_at) { toast('Tentukan jadwal dulu (Edit → pilih jadwal).', true); return open(p); }
      if (act === 'delete') await api('DELETE', `/api/ig/posts/${id}`);
      else { const r = await api('POST', `/api/ig/posts/${id}/${act === 'now' ? 'publish-now' : act}`, b); if (r.status === 'failed') throw new Error(r.error); }
      toast('Berhasil.'); route();
    });
  };
};
function igActions(p) {
  const b = (a, l, c = '') => `<button class="btn small ${c}" data-iact="${a}" type="button">${l}</button>`;
  if (p.status === 'published') return p.permalink ? `<a class="btn small" target="_blank" rel="noopener" href="${esc(p.permalink)}">Buka</a>` : '';
  if (p.status === 'publishing') return '';
  const o = [];
  if (can('editor')) o.push(b('edit', 'Edit'));
  if (can('editor') && ['draft', 'failed'].includes(p.status)) o.push(b('submit', 'Ajukan'));
  if (can('manager') && ['pending_approval', 'draft', 'failed'].includes(p.status)) o.push(b('approve', 'Setujui', 'primary'));
  if (can('manager') && ['pending_approval', 'scheduled'].includes(p.status)) o.push(b('reject', 'Kembalikan'));
  if (can('manager')) o.push(b('now', 'Terbitkan'));
  if (can('editor')) o.push(b('delete', 'Hapus', 'danger'));
  return o.join('');
}

/* ---- Komentar ---- */
IGV.komentar = async ({ bid, body }) => {
  const groups = await api('GET', `/api/ig/${bid}/comments`);
  const one = (c, sub = false) => `<div class="cmt ${sub ? 'sub' : ''}" data-cid="${esc(c.id)}"><div class="row between"><span><b>@${esc(c.username || '-')}</b> <span class="small muted">${esc(igTime(c.timestamp))}</span>${c.hidden ? ' <span class="badge">Disembunyikan</span>' : ''}</span>
    ${!sub ? `<span class="row"><button type="button" class="btn small" data-c="reply">Balas</button><button type="button" class="btn small" data-c="${c.hidden ? 'unhide' : 'hide'}">${c.hidden ? 'Tampilkan' : 'Sembunyikan'}</button></span>` : ''}</div>
    <div style="white-space:pre-wrap">${esc(c.text)}</div>${(c.replies || []).map((r) => one(r, true)).join('')}</div>`;
  body.innerHTML = groups.length ? groups.map((g) => `<div class="card stack"><div class="row between"><b class="trunc" style="max-width:70%">${esc(g.media.caption || '(tanpa caption)')}</b><a class="btn small" target="_blank" rel="noopener" href="${esc(g.media.permalink)}">Buka post</a></div>${g.comments.map((c) => one(c)).join('')}</div>`).join('') : '<div class="card muted">Belum ada komentar pada post terbaru.</div>';
  body.onclick = (e) => {
    const a = e.target.dataset.c; if (!a) return; const el = e.target.closest('[data-cid]'); const id = el.dataset.cid;
    busy(e.target, async () => {
      if (a === 'reply') {
        const quote = $('div[style]', el).textContent; const who = $('b', el).textContent;
        const text = await ui.ask({ title: `Balas komentar ${who}`, label: 'Balasan (tampil publik atas nama brand)', placeholder: 'mis. Halo Kak, ready ya 😊', max: 2200, rows: 5, ok: 'Kirim balasan', quote, quoteLabel: 'Komentar' });
        if (text === null) return; await api('POST', `/api/ig/${bid}/comments/${id}/reply`, { text }); toast('Balasan terkirim.'); return route();
      }
      await api('POST', `/api/ig/${bid}/comments/${id}/hide`, { hide: a === 'hide' }); toast(a === 'hide' ? 'Komentar disembunyikan.' : 'Komentar ditampilkan lagi.'); route();
    });
  };
};

/* ---- DM ---- */
IGV.dm = async ({ bid, body }) => {
  const convs = await api('GET', `/api/ig/${bid}/conversations`);
  body.innerHTML = `<div class="dmgrid"><div class="card dmlist">${convs.map((c) => `<button type="button" class="dmitem" data-conv="${esc(c.id)}"><b>@${esc(c.participant.username || c.participant.id)}</b><span class="small muted trunc">${esc(c.last_message)}</span><span class="small muted">${esc(igTime(c.updated_time))}${c.can_reply ? '' : ' · jendela 24 jam habis'}</span></button>`).join('') || '<span class="muted">Belum ada percakapan.</span>'}</div>
    <div class="card dmthread" id="thread"><span class="muted">Pilih percakapan di kiri.</span></div></div>
    <p class="small muted">Instagram hanya mengizinkan membalas dalam 24 jam sejak pesan terakhir pelanggan. Pesan tampil atas nama brand.</p>`;
  const open = async (id) => {
    const c = convs.find((x) => x.id === id); $$('.dmitem', body).forEach((b) => b.classList.toggle('on', b.dataset.conv === id));
    const th = $('#thread'); th.innerHTML = '<span class="muted">Memuat…</span>';
    const msgs = await api('GET', `/api/ig/${bid}/conversations/${encodeURIComponent(id)}`);
    th.innerHTML = `<div class="row between"><b>@${esc(c.participant.username || '')}</b></div><div class="msgs">${msgs.map((m) => { const mine = String(m.from?.id) !== String(c.participant.id); return `<div class="bubble ${mine ? 'me' : ''}"><div>${esc(m.message || '(lampiran)')}</div><span class="small">${esc(igTime(m.created_time))}</span></div>`; }).join('')}</div>
      ${c.can_reply ? `<form id="dmf" class="stack"><label>Balas<textarea name="text" maxlength="1000" style="min-height:70px" placeholder="Tulis balasan…"></textarea></label><div><button class="btn primary" type="submit">Kirim</button></div></form>` : '<div class="banner">Jendela balasan 24 jam sudah habis atau pesan terakhir berasal dari brand. Tunggu pelanggan membalas.</div>'}`;
    const box = $('.msgs', th); box.scrollTop = box.scrollHeight;
    const f = $('#dmf', th); if (f) f.onsubmit = (e) => { e.preventDefault(); const text = f.elements.text.value.trim(); if (!text) return; busy($('button', f), async () => {
      if (!(await ui.confirm({ title: 'Kirim pesan ini?', message: `Dikirim ke @${c.participant.username} atas nama brand.`, quote: text, quoteLabel: 'Pesan', ok: 'Kirim' }))) return;
      await api('POST', `/api/ig/${bid}/conversations/${encodeURIComponent(id)}/send`, { recipient_id: c.participant.id, text }); toast('Pesan terkirim.'); open(id);
    }); };
  };
  body.onclick = (e) => { const b = e.target.closest('[data-conv]'); if (b) open(b.dataset.conv).catch((err) => toast(err.message, true)); };
  if (convs[0]) open(convs[0].id).catch((err) => toast(err.message, true));
};

/* ---- Insight ---- */
IGV.insight = async ({ bid, body }) => {
  const days = Number(params().get('days')) || 7;
  const [acc, media] = await Promise.all([api('GET', `/api/ig/${bid}/insights?days=${days}`), api('GET', `/api/ig/${bid}/media-insights`)]);
  const K = [['followers', 'Followers', acc.followers], ['reach', 'Jangkauan', acc.metrics.reach], ['views', 'Tayangan', acc.metrics.views], ['accounts_engaged', 'Akun berinteraksi', acc.metrics.accounts_engaged], ['total_interactions', 'Interaksi', acc.metrics.total_interactions], ['likes', 'Suka', acc.metrics.likes], ['comments', 'Komentar', acc.metrics.comments], ['shares', 'Dibagikan', acc.metrics.shares], ['saves', 'Disimpan', acc.metrics.saves]];
  body.innerHTML = `<div class="row between"><b>Ringkasan akun</b><select id="days" style="width:auto">${[7, 14, 30].map((d) => `<option value="${d}" ${d === days ? 'selected' : ''}>${d} hari terakhir</option>`).join('')}</select></div>
  <div class="stats">${K.map(([k, l, val]) => `<div class="card kpi2"><span class="small muted">${l}</span><b>${num(val)}</b></div>`).join('')}</div>
  <div class="card stack"><div class="row between"><b>Insight per konten</b><button type="button" class="btn small" id="fresh">Segarkan</button></div>
    <div class="grid g4"><label>Cari caption / hashtag<input id="qs" placeholder="mis. kebaya, #batikmodern"></label>
    <label>Jenis<select id="qt"><option value="">Semua</option><option value="IMAGE">Foto</option><option value="VIDEO">Video / Reels</option><option value="CAROUSEL_ALBUM">Carousel</option></select></label>
    <label>Urutkan<select id="qo"><option value="timestamp">Terbaru</option><option value="reach">Jangkauan</option><option value="views">Tayangan</option><option value="likes">Suka</option><option value="comments">Komentar</option><option value="saved">Disimpan</option><option value="er">Engagement rate</option></select></label>
    <div class="small muted" id="qc" style="align-self:end"></div></div>
    <div style="overflow-x:auto"><table><thead><tr><th>Konten</th><th>Terbit</th><th>Jangkauan</th><th>Tayangan</th><th>Suka</th><th>Komentar</th><th>Dibagikan</th><th>Disimpan</th><th>ER</th></tr></thead><tbody id="qrows"></tbody></table></div></div>`;
  const er = (m) => (m.insights.reach ? ((m.insights.total_interactions ?? 0) / m.insights.reach) * 100 : null);
  const draw = () => {
    const qs = $('#qs').value.trim().toLowerCase(); const qt = $('#qt').value; const qo = $('#qo').value;
    const rows = media.filter((m) => (!qt || m.media_type === qt) && (!qs || (m.caption || '').toLowerCase().includes(qs))).sort((a, b) => qo === 'timestamp' ? Date.parse(b.timestamp) - Date.parse(a.timestamp) : (qo === 'er' ? (er(b) ?? -1) - (er(a) ?? -1) : (b.insights[qo] ?? -1) - (a.insights[qo] ?? -1)));
    $('#qc').textContent = `${rows.length} dari ${media.length} konten`;
    $('#qrows').innerHTML = rows.map((m) => `<tr><td style="max-width:340px"><a href="${esc(m.permalink)}" target="_blank" rel="noopener">${esc((m.caption || '(tanpa caption)').slice(0, 90))}</a> <span class="badge">${esc(({ IMAGE: 'Foto', VIDEO: 'Video', CAROUSEL_ALBUM: 'Carousel' })[m.media_type] || m.media_type)}</span></td><td class="small">${esc(igTime(m.timestamp))}</td>${['reach', 'views', 'likes', 'comments', 'shares', 'saved'].map((k) => `<td>${num(m.insights[k])}</td>`).join('')}<td>${er(m) === null ? '–' : `${er(m).toFixed(1)}%`}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">Tidak ada konten yang cocok.</td></tr>';
  };
  ['qs', 'qt', 'qo'].forEach((i) => $(`#${i}`).addEventListener('input', draw)); draw();
  $('#days').onchange = (e) => { location.hash = `#/instagram?tab=insight&brand=${bid}&days=${e.target.value}`; };
  $('#fresh').onclick = (e) => busy(e.target, async () => { await api('GET', `/api/ig/${bid}/media-insights?fresh=1`); toast('Insight disegarkan.'); route(); });
};

/* ---- Akun ---- */
IGV.akun = async ({ st, body }) => {
  body.innerHTML = `<div class="grid g2">${st.brands.map((b) => `<div class="card stack bcard" style="--c:${b.color}" data-b="${b.id}"><div class="row between"><h3>${esc(b.name)}</h3>${b.connected ? `<span class="badge s-published">@${esc(b.username || '')}</span>` : '<span class="badge">Belum terhubung</span>'}</div>
    ${b.connected ? `<div class="small muted">${esc(b.account_type || '')}${b.followers !== null ? ` · ${num(b.followers)} followers` : ''} · token berlaku s/d ${wib(b.token_expires_at)} (diperpanjang otomatis)</div>` : '<div class="small muted">Butuh akun Instagram Professional (Business/Creator).</div>'}
    <div class="row">${can('manager') && !st.simulated ? `<a class="btn small primary" href="/auth/instagram/start?brand=${b.id}">${b.connected ? 'Hubungkan ulang' : 'Hubungkan ke Instagram'}</a>` : ''}${can('admin') && b.connected ? '<button type="button" class="btn small" data-x="refresh">Perpanjang token</button><button type="button" class="btn small danger" data-x="disc">Putuskan</button>' : ''}</div></div>`).join('')}</div>
  <div class="card stack"><h3>Izin yang diminta</h3><div class="chips">${st.scopes.map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</div>
    <p class="small muted">Konten &amp; jadwal memakai <code>content_publish</code>; komentar memakai <code>manage_comments</code>; DM memakai <code>manage_messages</code>; insight memakai <code>manage_insights</code>. Izin ini perlu Advanced Access lewat App Review Meta bila dipakai untuk akun di luar tester.</p></div>
  ${can('admin') ? `<form id="igf" class="card stack"><h3>Aplikasi Instagram (Meta for Developers)</h3>
    <p class="small muted">Di aplikasi Meta Anda, tambahkan produk <b>Instagram</b> → <i>API setup with Instagram login</i>. Pakai <b>Instagram App ID</b> dan <b>Instagram App Secret</b> dari halaman itu (berbeda dari App ID Threads). Sumber aktif: <b>${esc({ dashboard: 'Dashboard', env: '.env server', none: 'Belum diisi' }[st.source])}</b>.</p>
    <div class="grid g2"><label>Instagram App ID<input name="app_id" value="${esc(st.app_id || '')}" autocomplete="off"></label>
    <label>Instagram App Secret<input name="app_secret" type="password" autocomplete="new-password" placeholder="${st.has_secret ? 'tersimpan; kosongkan jika tidak diubah' : 'tempel App Secret'}"></label></div>
    <label>Redirect URL OAuth (salin ke Meta)<span class="row"><input id="igru" value="${esc(st.redirect_uri)}" readonly><button type="button" class="btn small" id="igcp">Salin</button></span></label>
    <div class="row"><button class="btn primary">Simpan</button>${st.app_id || st.has_secret ? '<button type="button" class="btn small danger" id="igclear">Hapus kredensial</button>' : ''}</div></form>` : ''}`;
  const f = $('#igf', body);
  if (f) {
    f.onsubmit = (e) => { e.preventDefault(); busy($('button', f), async () => { await api('PUT', '/api/ig/credentials', { app_id: f.elements.app_id.value, app_secret: f.elements.app_secret.value }); toast('Kredensial Instagram disimpan.'); route(); }); };
    $('#igcp').onclick = () => copyText($('#igru').value);
    const c = $('#igclear'); if (c) c.onclick = (e) => busy(e.target, async () => { if (!(await ui.confirm({ title: 'Hapus kredensial Instagram?', message: 'Akun yang terhubung tetap tersimpan, tetapi koneksi baru dan perpanjangan token tidak bisa dilakukan sampai kredensial diisi lagi.', ok: 'Hapus', danger: true }))) return; await api('PUT', '/api/ig/credentials', { clear: true }); toast('Kredensial dihapus.'); route(); });
  }
  body.onclick = (e) => { const x = e.target.dataset.x; if (!x) return; const id = e.target.closest('[data-b]').dataset.b;
    busy(e.target, async () => { if (x === 'refresh') await api('POST', `/api/ig/accounts/${id}/refresh`); if (x === 'disc') { if (!(await ui.confirm({ title: 'Putuskan akun Instagram ini?', message: 'Token dihapus dari Hub. Konten terjadwal untuk akun ini akan gagal sampai dihubungkan lagi.', ok: 'Putuskan', danger: true }))) return; await api('DELETE', `/api/ig/accounts/${id}`); } toast('Berhasil.'); route(); }); };
};

/* ---------- Auto Reply & Webhook ---------- */
const AR_TABS = [['inbox', 'Kotak masuk', 'viewer'], ['aturan', 'Aturan per akun', 'viewer'], ['webhook', 'Webhook & setup', 'viewer']];
const AR_STATUS = { new: 'Baru', processing: 'Diproses', pending: 'Menunggu', sending: 'Mengirim', sent: 'Terkirim', skipped: 'Dilewati', ignored: 'Diabaikan', rejected: 'Ditolak', failed: 'Gagal', approved: 'Disetujui' };
const AR_KIND = { reply: 'Reply', mention: 'Mention', comment: 'Komentar', dm: 'DM' };
const PLAT = { threads: 'Threads', instagram: 'Instagram' };

VIEWS.autoreply = async (v) => {
  const q = params(); const cfg = await api('GET', '/api/auto/config');
  const tab = AR_TABS.some((t) => t[0] === q.get('tab')) ? q.get('tab') : 'inbox';
  const nav = (t) => `#/autoreply?tab=${t}`;
  const open = (cfg.stats.pending || 0) + (cfg.stats.failed || 0);
  v.innerHTML = `<div class="page-head"><h1>Auto Reply</h1><p class="muted">Webhook Meta menangkap reply, mention, komentar, dan DM secara real-time; Claude menyusun balasan sesuai brand voice. Anda memilih: tinjau dulu, atau kirim otomatis dengan pagar pengaman.</p></div>
  ${!cfg.enabled ? '<div class="banner"><b>Auto reply sedang mati.</b> Event yang masuk tetap dicatat tetapi tidak dibalas. ' + (can('admin') ? 'Nyalakan di tab Webhook &amp; setup.' : 'Minta admin menyalakannya.') + '</div>' : ''}
  ${!cfg.ai ? '<div class="banner">Model AI untuk balasan belum dikonfigurasi. ' + (can('admin') ? 'Atur di tab Webhook &amp; setup (mis. Kenari), atau isi <code>ANTHROPIC_API_KEY</code> di <code>.env</code>.' : 'Minta admin mengaturnya.') + ' Event akan menunggu balasan manual.</div>' : ''}
  <div class="tabs">${AR_TABS.map((t) => `<a class="tab ${t[0] === tab ? 'on' : ''}" href="${nav(t[0])}">${t[1]}${t[0] === 'inbox' && open ? ` <span class="badge s-pending_approval">${open}</span>` : ''}</a>`).join('')}</div>
  <div id="arbody" class="stack" style="margin-top:14px"></div>`;
  const body = $('#arbody'); const ctx = { cfg, body, q };
  try { await ARV[tab](ctx); } catch (e) { body.innerHTML = `<div class="banner err">${esc(e.message)}</div>`; }
};
const ARV = {};

ARV.inbox = async ({ cfg, body, q }) => {
  const f = q.get('f') || 'open'; const bf = q.get('brand') || ''; const pf = q.get('p') || '';
  const qs = new URLSearchParams({ status: f === 'all' ? '' : f, brand: bf, platform: pf, limit: 80 });
  const rows = await api('GET', `/api/auto/events?${qs}`);
  const link = (k, val) => { const n = new URLSearchParams({ tab: 'inbox', f, brand: bf, p: pf, [k]: val }); return `#/autoreply?${n}`; };
  body.innerHTML = `<div class="chips">${[['open', 'Perlu tindakan'], ['sent', 'Terkirim'], ['skipped', 'Dilewati'], ['ignored', 'Diabaikan'], ['rejected', 'Ditolak'], ['all', 'Semua']].map(([k, l]) => `<a class="chip" href="${link('f', k)}" ${k === f ? 'style="border-color:var(--accent);color:var(--accent)"' : ''}>${l}</a>`).join('')}</div>
  <div class="row"><select id="fb" style="width:auto"><option value="">Semua brand</option>${cfg.brands.map((b) => `<option value="${b.id}" ${b.id === bf ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>
  <select id="fp" style="width:auto"><option value="">Semua platform</option>${Object.entries(PLAT).map(([k, l]) => `<option value="${k}" ${k === pf ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
  ${rows.length ? rows.map((e) => { const b = cfg.brands.find((x) => x.id === e.brand_id); const act = ['pending', 'failed'].includes(e.status);
    return `<div class="card stack ev" data-id="${e.id}"><div class="row between"><span class="row"><span class="badge">${PLAT[e.platform]}</span><span class="badge">${AR_KIND[e.kind]}</span><b>${esc(b?.name.replace('Delova ', '') || '')}</b><span class="muted small">dari @${esc(e.author_username || e.author_id || '-')} · ${esc(igTime(e.received_at))}</span>${e.simulated ? '<span class="badge">Simulasi</span>' : ''}</span>
      <span class="row">${e.needs_human ? '<span class="badge s-failed">Perlu manusia</span>' : ''}<span class="badge s-${e.status === 'sent' ? 'published' : e.status === 'failed' ? 'failed' : 'pending_approval'}">${AR_STATUS[e.status] || e.status}</span></span></div>
      <div class="quote">${esc(e.text)}</div>
      ${act ? `<label class="lbl">Balasan <span class="muted small">(edit bila perlu)</span><textarea class="dtxt" style="min-height:70px" placeholder="${e.draft ? '' : 'Tulis balasan manual…'}">${esc(e.draft || '')}</textarea></label>` : e.reply_text ? `<div class="quote me"><span class="small muted">Balasan terkirim:</span><br>${esc(e.reply_text)}</div>` : e.draft ? `<div class="small muted">Draf: ${esc(e.draft)}</div>` : ''}
      ${e.note || e.error ? `<div class="small ${e.status === 'failed' ? 'err' : 'muted'}">${esc(e.error || e.note)}</div>` : ''}
      <div class="row">${act && can('editor') ? '<button class="btn primary small" data-a="approve" type="button">Kirim balasan</button>' : ''}${can('editor') && ['pending', 'failed', 'skipped', 'rejected'].includes(e.status) && cfg.ai ? '<button class="btn small" data-a="redraft" type="button">Draf ulang dengan Claude</button>' : ''}${can('editor') && ['pending', 'failed', 'skipped'].includes(e.status) ? '<button class="btn small" data-a="reject" type="button">Tolak</button>' : ''}${e.permalink ? `<a class="btn small ghost" target="_blank" rel="noopener" href="${esc(e.permalink)}">Buka</a>` : ''}</div></div>`; }).join('')
    : '<div class="card muted">Belum ada event di sini. Setelah webhook terpasang, reply/komentar/DM baru muncul otomatis. Mode simulasi: pakai kotak uji di tab Aturan.</div>'}`;
  $('#fb').onchange = (e) => { location.hash = link('brand', e.target.value); }; $('#fp').onchange = (e) => { location.hash = link('p', e.target.value); };
  body.onclick = (e) => {
    const btn = e.target.closest('[data-a]'); if (!btn) return; const card = btn.closest('.ev'); const id = card.dataset.id; const a = btn.dataset.a;
    busy(btn, async () => {
      if (a === 'approve') {
        const text = $('.dtxt', card).value.trim(); const ev = rows.find((r) => r.id === id);
        if (!text) throw new Error('Tulis balasan dulu.');
        if (!(await ui.confirm({ title: `Kirim balasan ke @${ev.author_username || 'pengguna'}?`, message: `Dikirim ke ${PLAT[ev.platform]} atas nama brand dan terlihat ${ev.kind === 'dm' ? 'oleh penerima' : 'publik'}.`, quote: text, quoteLabel: 'Balasan', ok: 'Kirim' }))) return;
        await api('POST', `/api/auto/events/${id}/approve`, { text }); toast('Balasan terkirim.');
      } else if (a === 'reject') { await api('POST', `/api/auto/events/${id}/reject`); toast('Ditolak.'); }
      else { const r = await api('POST', `/api/auto/events/${id}/redraft`); toast(r.draft ? 'Draf baru siap.' : 'Tidak ada draf baru.'); }
      route();
    });
  };
};

ARV.aturan = async ({ cfg, body }) => {
  body.innerHTML = `<div class="banner"><b>Cara kerja pagar pengaman.</b> Mode <b>Draft</b>: semua balasan menunggu persetujuan Anda. Mode <b>Auto</b> (khusus admin): Claude hanya mengirim sendiri bila pesan tergolong aman (sapaan, pujian, pertanyaan yang jawabannya ada di <i>Pengetahuan brand</i>), keyakinan ≥ 75%, tidak memuat kata sensitif (komplain, refund, kerja sama), tidak ada tautan/nomor di luar pengetahuan, dan belum melewati batas per jam. Sisanya tetap masuk Kotak masuk sebagai "Perlu manusia".</div>
  <div class="grid g2">${cfg.brands.map((b) => ['threads', 'instagram'].map((p) => { const r = b.rules[p]; const ok = b.connected[p];
    return `<form class="card stack rule" data-b="${b.id}" data-p="${p}" style="border-top:3px solid ${b.color}"><div class="row between"><h3>${esc(b.name)} · ${PLAT[p]}</h3>${ok ? '<span class="badge s-published">Terhubung</span>' : '<span class="badge">Belum terhubung</span>'}</div>
      <label class="row"><input type="checkbox" name="enabled" ${r.enabled ? 'checked' : ''} ${can('manager') ? '' : 'disabled'}> <b>Aktifkan auto reply</b></label>
      <label>Mode<select name="mode" ${can('manager') ? '' : 'disabled'}><option value="draft" ${r.mode === 'draft' ? 'selected' : ''}>Draft: tinjau dulu (disarankan)</option><option value="auto" ${r.mode === 'auto' ? 'selected' : ''} ${can('admin') || r.mode === 'auto' ? '' : 'disabled'}>Auto: kirim sendiri bila aman ${can('admin') ? '' : '(admin)'}</option></select></label>
      <div class="chips">${(p === 'threads' ? ['reply', 'mention'] : ['comment', 'mention', 'dm']).map((k) => `<label class="chip"><input type="checkbox" name="k_${k}" ${r.kinds.includes(k) ? 'checked' : ''} ${can('manager') ? '' : 'disabled'}> ${AR_KIND[k]}</label>`).join('')}</div>
      <label>Maks balasan otomatis per jam<input type="number" name="hourly_cap" min="1" max="200" value="${r.hourly_cap}" ${can('manager') ? '' : 'disabled'}></label>
      <label>Pengetahuan brand <span class="muted small">(satu-satunya sumber fakta untuk Claude)</span><textarea name="knowledge" style="min-height:140px" maxlength="6000" placeholder="Contoh:&#10;- Order resmi lewat Shopee: https://shopee.co.id/delovawardrobe&#10;- Ukuran kebaya S-XXL, size chart ada di deskripsi produk&#10;- Pengiriman dari Yogyakarta, resi dikirim maks 2 hari kerja&#10;- Kerja sama/reseller: arahkan ke DM" ${can('manager') ? '' : 'disabled'}>${esc(r.knowledge)}</textarea></label>
      ${can('manager') ? `<div class="row"><button class="btn primary small">Simpan</button>${p === 'instagram' && ok ? '<button type="button" class="btn small" data-sub="1">Daftarkan webhook akun ini</button>' : ''}</div>` : ''}</form>`; }).join('')).join('')}</div>
  ${can('manager') ? `<form id="tf" class="card stack"><h3>Uji coba (mode simulasi)</h3><p class="small muted">Menyuntik event palsu lewat jalur yang sama dengan webhook asli, tanpa mengirim apa pun ke Threads/Instagram. Hanya tersedia saat mode simulasi.</p>
    <div class="grid g4"><label>Brand<select name="brand_id">${cfg.brands.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select></label>
    <label>Platform &amp; jenis<select name="pk"><option value="threads:reply">Threads · Reply</option><option value="threads:mention">Threads · Mention</option><option value="instagram:comment">Instagram · Komentar</option><option value="instagram:dm">Instagram · DM</option></select></label>
    <label>Pesan<input name="text" value="Kak, kebaya sage ini ready ukuran M?"></label><div style="align-self:end"><button class="btn primary">Kirim event uji</button></div></div></form>` : ''}`;
  $$('.rule', body).forEach((f) => {
    f.onsubmit = (e) => { e.preventDefault(); busy($('button', f), async () => {
      const fd = f.elements; const kinds = ['reply', 'mention', 'comment', 'dm'].filter((k) => fd[`k_${k}`]?.checked);
      await api('PUT', `/api/auto/rules/${f.dataset.b}/${f.dataset.p}`, { enabled: fd.enabled.checked, mode: fd.mode.value, kinds, hourly_cap: Number(fd.hourly_cap.value), knowledge: fd.knowledge.value });
      toast('Aturan tersimpan.'); route(); }); };
    const sb = $('[data-sub]', f); if (sb) sb.onclick = () => busy(sb, async () => { const r = await api('POST', `/api/auto/instagram/${f.dataset.b}/subscribe`); toast(r.dryRun ? 'Simulasi: webhook dianggap terdaftar.' : `Webhook terdaftar untuk: ${r.fields.join(', ')}.`); });
  });
  const tf = $('#tf', body);
  if (tf) tf.onsubmit = (e) => { e.preventDefault(); busy($('button', tf), async () => {
    const [platform, kind] = tf.elements.pk.value.split(':');
    const r = await api('POST', '/api/auto/test-event', { brand_id: tf.elements.brand_id.value, platform, kind, text: tf.elements.text.value });
    toast(`Hasil: ${AR_STATUS[r.status] || r.status}${r.note ? ` (${r.note})` : ''}`); location.hash = '#/autoreply?tab=inbox&f=all'; route(); }); };
};

ARV.webhook = async ({ cfg, body }) => {
  const copy = (id) => `<span class="row"><input id="${id}" readonly value="" style="flex:1"><button type="button" class="btn small" data-cp="${id}">Salin</button></span>`;
  body.innerHTML = `${can('admin') ? `<div class="card stack"><h3>Saklar utama</h3><label class="row"><input type="checkbox" id="gon" ${cfg.enabled ? 'checked' : ''}> <b>Aktifkan webhook &amp; auto reply</b></label>
    <label>Batas draf Claude per 24 jam (kontrol biaya)<input id="gcap" type="number" min="0" max="5000" value="${cfg.llm_cap}" style="max-width:160px"></label><div><button class="btn primary small" id="gsave" type="button">Simpan</button></div></div>` : ''}
${can('admin') ? `<form id="llmf" class="card stack"><h3>Model AI untuk balasan</h3>
    <p class="small muted">Pilih Claude, atau API apa pun yang kompatibel dengan OpenAI (Kenari, OpenRouter, Gemini, Groq, Ollama). Aktif: <b>${esc(cfg.model)}</b>. Isi pesan audiens akan dikirim ke penyedia yang dipilih.</p>
    <div class="grid g2"><label>Penyedia<select name="provider"><option value="claude" ${cfg.llm.provider === 'claude' ? 'selected' : ''}>Claude (Anthropic)${cfg.llm.claude_ready ? '' : ' - API key belum diisi'}</option><option value="openai" ${cfg.llm.provider === 'openai' ? 'selected' : ''}>API kompatibel OpenAI (Kenari dll)</option></select></label>
    <label>Preset<select id="llmpreset"><option value="">Pilih preset…</option><option value="https://kenari.id/v1">Kenari (kenari.id)</option><option value="https://openrouter.ai/api/v1">OpenRouter</option><option value="https://generativelanguage.googleapis.com/v1beta/openai">Google Gemini</option><option value="https://api.groq.com/openai/v1">Groq</option><option value="http://host.docker.internal:11434/v1">Ollama (VPS sendiri)</option></select></label>
    <label>Base URL<input name="base_url" value="${esc(cfg.llm.base_url)}" autocomplete="off"></label>
    <label>Nama model<input name="model" value="${esc(cfg.llm.model)}" placeholder="mis. qwen3-7-plus" autocomplete="off"></label>
    <label>API key<input name="api_key" type="password" autocomplete="new-password" placeholder="${cfg.llm.has_key ? 'tersimpan; kosongkan jika tidak diubah' : 'tempel API key'}"></label>
    <label class="row" style="align-self:end"><input type="checkbox" name="fallback" ${cfg.llm.fallback ? 'checked' : ''}> Jika gagal, coba Claude (bila API key Claude ada)</label></div>
    <div class="row"><button class="btn primary small">Simpan</button><button type="button" class="btn small" id="llmtest">Uji koneksi</button>${cfg.llm.has_key ? '<button type="button" class="btn small danger" id="llmclear">Hapus API key</button>' : ''}</div></form>` : ''}
  <div class="card stack"><h3>Data untuk Meta for Developers</h3>
    ${cfg.webhooks.map((w) => `<div class="stack" style="gap:4px"><b>${PLAT[w.platform]}</b> ${w.has_secret ? '<span class="badge s-published">App Secret terisi</span>' : '<span class="badge s-failed">App Secret belum diisi</span>'}<label>Callback URL${copy('u_' + w.platform)}</label></div>`).join('')}
    ${cfg.verify_token ? `<label>Verify token (sama untuk keduanya)${copy('vt')}</label>${can('admin') ? '<div><button type="button" class="btn small danger" id="regen">Buat ulang token</button></div>' : ''}` : '<p class="small muted">Verify token hanya terlihat oleh admin.</p>'}</div>
  <div class="card stack"><h3>Langkah pemasangan</h3><ol class="small" style="padding-left:18px;display:grid;gap:6px">
    <li><b>Threads:</b> Meta for Developers → aplikasi Threads → <i>Webhooks</i> → objek <b>Threads</b> → isi Callback URL &amp; Verify token di atas → <i>Verify and save</i> → subscribe ke field <code>replies</code> dan <code>mentions</code>. Izin <code>threads_read_replies</code>, <code>threads_manage_replies</code>, dan <code>threads_manage_mentions</code> harus aktif (Advanced Access untuk akun non-tester).</li>
    <li><b>Instagram:</b> aplikasi Instagram → <i>API setup with Instagram login</i> → <i>Configure webhooks</i> → isi Callback URL &amp; Verify token → subscribe ke <code>comments</code>, <code>messages</code>, <code>mentions</code>. Lalu di tab <i>Aturan per akun</i> klik <i>Daftarkan webhook akun ini</i> untuk tiap brand.</li>
    <li>Pastikan <b>App Secret</b> aplikasi sudah diisi (menu Brand &amp; Akun untuk Threads, menu Instagram → Akun untuk Instagram). Permintaan tanpa tanda tangan HMAC yang cocok ditolak.</li>
    <li>Isi <b>Pengetahuan brand</b> tiap akun, nyalakan saklar utama, aktifkan aturan dengan mode <b>Draft</b>, lalu pantau Kotak masuk beberapa hari sebelum mempertimbangkan mode Auto.</li></ol>
    <p class="small muted">Webhook Threads dan Instagram memakai tanda tangan <code>X-Hub-Signature-256</code>. Event dicatat 30 hari lalu dibersihkan otomatis (kecuali yang masih menunggu).</p></div>`;
  for (const w of cfg.webhooks) { const el = $('#u_' + w.platform, body); if (el) el.value = w.url; }
  if ($('#vt', body)) $('#vt', body).value = cfg.verify_token;
  body.onclick = (e) => { const c = e.target.closest('[data-cp]'); if (c) copyText($('#' + c.dataset.cp, body).value); };
  const lf = $('#llmf', body);
  if (lf) {
    $('#llmpreset', lf).onchange = (e) => { if (e.target.value) { lf.elements.base_url.value = e.target.value; lf.elements.provider.value = 'openai'; } };
    lf.onsubmit = (e) => { e.preventDefault(); busy($('button', lf), async () => {
      await api('PUT', '/api/auto/llm', { provider: lf.elements.provider.value, base_url: lf.elements.base_url.value, model: lf.elements.model.value, api_key: lf.elements.api_key.value, fallback: lf.elements.fallback.checked });
      toast('Pengaturan model tersimpan.'); route(); }); };
    $('#llmtest', lf).onclick = (e) => busy(e.target, async () => {
      await api('PUT', '/api/auto/llm', { provider: lf.elements.provider.value, base_url: lf.elements.base_url.value, model: lf.elements.model.value, api_key: lf.elements.api_key.value, fallback: lf.elements.fallback.checked });
      try { const r = await api('POST', '/api/auto/llm/test'); toast(`Terhubung (${r.ms} ms).`); } catch (err) { toast(err.message, true); } });
    const lc = $('#llmclear', lf); if (lc) lc.onclick = (e) => busy(e.target, async () => { if (!(await ui.confirm({ title: 'Hapus API key model?', message: 'Auto Reply berhenti membuat draf lewat penyedia ini sampai key diisi lagi.', ok: 'Hapus', danger: true }))) return; await api('PUT', '/api/auto/llm', { clear_key: true }); toast('API key dihapus.'); route(); });
  }
  const gs = $('#gsave', body);
  if (gs) {
    gs.onclick = () => busy(gs, async () => { await api('PUT', '/api/auto/global', { enabled: $('#gon').checked, llm_cap: Number($('#gcap').value) }); toast('Tersimpan.'); route(); });
    $('#regen').onclick = (e) => busy(e.target, async () => { if (!(await ui.confirm({ title: 'Buat ulang verify token?', message: 'Token lama tidak berlaku. Anda perlu memasukkan token baru di Meta for Developers saat verifikasi ulang webhook.', ok: 'Buat ulang', danger: true }))) return; await api('PUT', '/api/auto/global', { regenerate_token: true }); toast('Token baru dibuat.'); route(); });
  }
};

/* ---------- Foto sementara ---------- */
const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const leftText = (iso) => {
  if (!iso) return 'Dihapus 24 jam setelah post terbit';
  const ms = Date.parse(iso) - Date.now(); if (ms <= 0) return 'Segera dihapus';
  const h = Math.floor(ms / 3600e3); const m = Math.floor((ms % 3600e3) / 60e3);
  return `Terhapus ${h >= 1 ? `${h} jam ${m} mnt` : `${m} mnt`} lagi`;
};
VIEWS.media = async (v) => {
  const [list, usage] = await Promise.all([api('GET', '/api/media?limit=200'), api('GET', '/api/media/usage')]);
  const pct = Math.min(100, Math.round((usage.bytes / usage.max_bytes) * 100));
  const brandName = (id) => brands.find((b) => b.id === id)?.name.replace('Delova ', '') || '';
  v.innerHTML = `<div class="page-head"><h1>Foto Sementara</h1><p class="muted">Unggah foto/video, dapatkan URL publik untuk post. File dihapus otomatis <b>24 jam setelah post terbit</b> (atau 48 jam jika tak dipakai).</p></div>
  ${can('editor') ? `<div class="card stack"><div id="drop" class="dropzone" tabindex="0"><input id="file" type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime" hidden />
    <b>Klik atau seret foto/video ke sini</b><span class="small muted">JPG, PNG, WEBP, GIF (maks 8 MB) · MP4/MOV (maks 50 MB)</span></div>
    <div class="row"><span class="small muted">Akun (opsional)</span><select id="mb" style="width:auto"><option value="">Tanpa akun</option>${brands.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select>
    <button type="button" class="btn small" id="lnk">Buat tautan unggah dari HP (15 mnt)</button></div></div>` : ''}
  <div class="row between" style="margin:14px 0 8px"><b>${list.length} file tersimpan</b><span class="small muted">${fmtBytes(usage.bytes)} dari ${fmtBytes(usage.max_bytes)}</span></div>
  <div class="meter"><i style="width:${pct}%"></i></div>
  <div class="mgrid">${list.length ? list.map((m) => `<div class="card mcard" data-n="${m.name}">
    <div class="mthumb">${m.mime.startsWith('video/') ? `<video src="${esc(m.url)}" muted preload="metadata"></video>` : `<img src="${esc(m.url)}" alt="${esc(m.original_name || m.name)}" loading="lazy" />`}</div>
    <div class="stack" style="gap:6px"><b class="trunc" title="${esc(m.original_name || m.name)}">${esc(m.original_name || m.name)}</b>
      <div class="small muted">${fmtBytes(m.bytes)} · ${esc(wib(m.created_at).replace(' WIB', ''))}${m.brand_id ? ` · ${esc(brandName(m.brand_id))}` : ''}</div>
      <div class="row"><span class="badge ${m.free ? 's-draft' : 's-scheduled'}">${m.free ? 'Belum dipakai' : 'Dipakai post'}</span><span class="small muted">${esc(leftText(m.expires_at))}</span></div>
      <input readonly value="${esc(m.url)}" aria-label="URL publik" />
      <div class="row"><button type="button" class="btn small primary" data-a="copy">Salin URL</button><a class="btn small" href="${esc(m.url)}" target="_blank" rel="noopener">Buka</a>${can('editor') && m.free ? '<button type="button" class="btn small danger" data-a="del">Hapus</button>' : ''}</div></div></div>`).join('') : '<div class="card muted">Belum ada file. Unggah foto di atas untuk mendapatkan URL publik.</div>'}</div>`;
  const send = async (files) => {
    const box = $('#drop'); box.classList.add('busy'); let ok = 0;
    for (const f of files) {
      const r = await fetch(`/api/media${$('#mb').value ? `?brand=${$('#mb').value}` : ''}`, { method: 'POST', headers: { 'content-type': f.type, 'x-requested-with': 'hub', 'x-filename': encodeURIComponent(f.name) }, body: f });
      const j = await r.json().catch(() => ({}));
      if (r.ok) ok++; else toast(`${f.name}: ${j.error || 'gagal diunggah'}`, true);
    }
    box.classList.remove('busy');
    if (ok) { toast(`${ok} file terunggah.`); route(); }
  };
  if (can('editor')) {
    $('#drop').onclick = (e) => { if (e.target.id !== 'file') $('#file').click(); };
    $('#drop').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file').click(); } };
    $('#file').onchange = (e) => send([...e.target.files]);
    ['dragenter', 'dragover'].forEach((ev) => $('#drop').addEventListener(ev, (e) => { e.preventDefault(); $('#drop').classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => $('#drop').addEventListener(ev, (e) => { e.preventDefault(); $('#drop').classList.remove('over'); }));
    $('#drop').addEventListener('drop', (e) => send([...e.dataTransfer.files]));
    $('#lnk').onclick = (e) => busy(e.target, async () => { const r = await api('POST', '/api/media/upload-link', { brand_id: $('#mb').value || undefined }); await copyText(r.url); toast('Tautan unggah disalin (berlaku 15 menit). Buka di HP Anda.'); });
  }
  v.onclick = (e) => {
    const a = e.target.dataset.a; if (!a) return; const card = e.target.closest('[data-n]'); const m = list.find((x) => x.name === card.dataset.n);
    if (a === 'copy') copyText(m.url);
    if (a === 'del') ui.confirm({ title: 'Hapus file ini?', message: 'File akan dihapus permanen dan URL-nya tidak bisa dibuka lagi.', quote: m.original_name || m.name, ok: 'Hapus', danger: true }).then(async (yes) => { if (yes) { await api('DELETE', `/api/media/${m.name}`); toast('File dihapus.'); route(); } });
  };
};

/* ---------- Kalender ---------- */
const wibKey = (d) => new Date(d).toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' });
const pad2 = (n) => String(n).padStart(2, '0');
const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const SET_STATUS = ['scheduled', 'publishing', 'published'];
const PLAN_STATUS = ['pending_approval', 'draft'];
VIEWS.calendar = async (v) => {
  const q = params(); const todayKey = wibKey(new Date());
  const [Y, M] = (/^\d{4}-\d{2}$/.test(q.get('m') || '') ? q.get('m') : todayKey.slice(0, 7)).split('-').map(Number);
  const bid = brands.some((b) => b.id === q.get('brand')) ? q.get('brand') : '';
  const monthKey = `${Y}-${pad2(M)}`;
  const nextM = M === 12 ? `${Y + 1}-01` : `${Y}-${pad2(M + 1)}`; const prevM = M === 1 ? `${Y - 1}-12` : `${Y}-${pad2(M - 1)}`;
  const from = new Date(`${monthKey}-01T00:00:00+07:00`).toISOString(); const to = new Date(`${nextM}-01T00:00:00+07:00`).toISOString();
  const items = await api('GET', `/api/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${bid ? `&brand=${bid}` : ''}`);
  const days = new Date(Date.UTC(Y, M, 0)).getUTCDate(); const lead = (new Date(Date.UTC(Y, M - 1, 1)).getUTCDay() + 6) % 7;
  const shown = bid ? brands.filter((b) => b.id === bid) : brands;
  const byDay = {}; // 'YYYY-MM-DD' -> posts
  for (const it of items) (byDay[wibKey(it.published_at || it.scheduled_at)] ||= []).push(it);
  const key = (d) => `${monthKey}-${pad2(d)}`;
  const stateOf = (d, b) => { const ps = (byDay[key(d)] || []).filter((p) => p.brand_id === b); return ps.some((p) => SET_STATUS.includes(p.status)) ? 'set' : ps.some((p) => PLAN_STATUS.includes(p.status)) ? 'plan' : ps.length ? 'failed' : 'none'; };
  const nav = (m, b = bid) => `#/calendar?m=${m}${b ? `&brand=${b}` : ''}`;
  // ringkasan per akun: hari mulai hari ini yang sudah/belum terisi
  const summary = shown.map((b) => {
    let set = 0, plan = 0, empty = 0;
    for (let d = 1; d <= days; d++) { if (key(d) < todayKey) continue; const st = stateOf(d, b.id); if (st === 'set') set++; else if (st === 'plan') plan++; else empty++; }
    return `<div class="cal-sum" style="--c:${b.color}"><b>${esc(b.name)}</b><span><i class="cal-dot on" style="--c:${b.color}"></i>${set} terjadwal</span><span><i class="cal-dot half" style="--c:${b.color}"></i>${plan} menunggu</span><span><i class="cal-dot off"></i>${empty} kosong</span></div>`;
  }).join('');
  const dot = (b, st) => `<i class="cal-dot ${st === 'set' ? 'on' : st === 'plan' ? 'half' : st === 'failed' ? 'bad' : 'off'}" style="--c:${b.color}" title="${esc(b.name)}"></i>`;
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<div class="cal-cell void"></div>');
  for (let d = 1; d <= days; d++) {
    const k = key(d); const past = k < todayKey; const ps = byDay[k] || [];
    let inner;
    if (bid) {
      const b = shown[0]; const st = stateOf(d, b.id);
      inner = ps.slice(0, 2).map((p) => `<span class="cal-chip ${SET_STATUS.includes(p.status) ? 'on' : p.status === 'failed' ? 'bad' : 'half'}" style="--c:${b.color}">${new Date(p.published_at || p.scheduled_at).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' }).replace('.', ':')} ${esc(p.text.slice(0, 22))}</span>`).join('') + (ps.length > 2 ? `<span class="cal-more">+${ps.length - 2} lagi</span>` : '') + (!ps.length && !past ? '<span class="cal-empty">Kosong</span>' : '');
      void st;
    } else inner = `<span class="cal-dots">${shown.map((b) => dot(b, stateOf(d, b.id))).join('')}</span>`;
    cells.push(`<button type="button" class="cal-cell ${k === todayKey ? 'today' : ''} ${past ? 'past' : ''} ${!ps.length && !past && bid ? 'free' : ''}" data-day="${k}"><span class="cal-num">${d}</span>${inner}</button>`);
  }
  v.innerHTML = `<div class="page-head row between"><div><h1>Kalender</h1><p class="muted">Tanggal yang sudah dan belum punya jadwal post untuk tiap akun (WIB). Klik tanggal untuk melihat detail atau menjadwalkan.</p></div></div>
  <div class="row between" style="margin-bottom:12px"><div class="chips"><a class="chip" href="${nav(monthKey, '')}" ${bid ? '' : 'style="border-color:var(--accent);color:var(--accent)"'}>Semua akun</a>${brands.map((b) => `<a class="chip" href="${nav(monthKey, b.id)}" ${bid === b.id ? 'style="border-color:var(--accent);color:var(--accent)"' : ''}><i class="cal-dot on" style="--c:${b.color}"></i> ${esc(b.name.replace('Delova ', ''))}</a>`).join('')}</div>
    <div class="row"><a class="btn small" href="${nav(prevM)}" aria-label="Bulan sebelumnya">${ico('chevl')}</a><b style="min-width:9.5rem;text-align:center">${MONTHS[M - 1]} ${Y}</b><a class="btn small" href="${nav(nextM)}" aria-label="Bulan berikutnya">${ico('chevr')}</a><a class="btn small" href="${nav(todayKey.slice(0, 7))}">Hari ini</a></div></div>
  <div class="cal-sums">${summary}</div>
  <div class="card cal"><div class="cal-grid">${['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'].map((x) => `<div class="cal-dow">${x}</div>`).join('')}${cells.join('')}</div>
    <div class="cal-legend small muted"><span><i class="cal-dot on" style="--c:var(--accent)"></i> Terjadwal / terbit</span><span><i class="cal-dot half" style="--c:var(--accent)"></i> Menunggu approval / draft bertanggal</span><span><i class="cal-dot bad" style="--c:var(--bad)"></i> Gagal</span><span><i class="cal-dot off"></i> Belum ada jadwal</span></div></div>
  <div id="day" class="card stack" style="margin-top:14px"><span class="muted">Pilih tanggal di kalender untuk melihat detailnya.</span></div>`;
  const showDay = (k) => {
    const d = Number(k.slice(8)); const ps = byDay[k] || []; const label = new Date(`${k}T12:00:00+07:00`).toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const rowFor = (b) => {
      const mine = ps.filter((p) => p.brand_id === b.id); const past = k < todayKey;
      return `<div class="cal-day-brand" style="--c:${b.color}"><div class="row between"><b>${esc(b.name)}</b>${can('editor') && !past ? `<a class="btn small primary" href="#/compose?brand=${b.id}&date=${k}">${mine.length ? 'Tambah post' : 'Jadwalkan post'}</a>` : ''}</div>
        ${mine.length ? mine.map((p) => `<div class="row between cal-post"><span><span class="small muted">${wib(p.published_at || p.scheduled_at).replace(' WIB', '')}</span> ${esc(p.text)}</span><span class="row">${badge(p.status)}${can('editor') && p.status !== 'published' ? `<a class="btn small" href="#/compose?edit=${p.id}">Edit</a>` : ''}</span></div>`).join('') : `<span class="muted small">${past ? 'Tidak ada post pada tanggal ini.' : 'Belum ada jadwal pada tanggal ini.'}</span>`}</div>`;
    };
    $('#day').innerHTML = `<h3>${esc(label)}</h3>${(bid ? shown : brands).map(rowFor).join('')}`; void d;
    $$('.cal-cell.sel', v).forEach((c) => c.classList.remove('sel')); $(`.cal-cell[data-day="${k}"]`, v)?.classList.add('sel');
  };
  v.onclick = (e) => { const c = e.target.closest('[data-day]'); if (c) showDay(c.dataset.day); };
  showDay(todayKey.startsWith(monthKey) ? todayKey : `${monthKey}-01`);
};

/* ---------- Rencana mingguan ---------- */
VIEWS.plan = async (v) => {
  v.innerHTML = `<h1>Rencana Mingguan</h1><p class="muted">Claude menyusun naskah 1 post/hari sesuai brand voice. Edit, lalu simpan semuanya sebagai draft.</p>
  <div class="card stack"><div class="grid g2"><label>Akun ${brandPick(brands[0].id)}</label><label>Jumlah hari<select id="days"><option>5</option><option selected>7</option><option>10</option><option>14</option></select></label></div>
  <label>Tujuan minggu ini<input id="goal" placeholder="mis. naikkan traffic ke Shopee untuk koleksi lebaran" /></label>
  <label>Info promo yang boleh disebut (opsional)<input id="promo" placeholder="mis. gratis ongkir min. belanja 200rb s/d Minggu" /></label>
  <div><button class="btn primary" id="go" ${health.ai ? '' : 'disabled'}>Susun rencana dengan Claude</button> ${health.ai ? '' : '<span class="muted small">Butuh ANTHROPIC_API_KEY.</span>'}</div></div><div id="out" class="stack" style="margin-top:14px"></div>`;
  $('#go').onclick = (e) => busy(e.target, async () => {
    e.target.textContent = 'Claude sedang menyusun…';
    try {
      const brand = $('[name=brand]').value;
      const { items } = await api('POST', '/api/ai/weekly-plan', { brand_id: brand, goal: $('#goal').value, promo: $('#promo').value, days: $('#days').value });
      $('#out').innerHTML = items.map((it, i) => `<div class="card stack" data-i="${i}"><div class="row between"><b>Hari ${i + 1} · ${esc(it.pillar || '')}</b><label class="row" style="font-weight:400"><input type="checkbox" checked style="width:auto" class="inc"> Simpan</label></div>
        <label>Tayang (WIB)<input class="w dtp" value="${toInput(it.scheduled_at)}" placeholder="Pilih tanggal &amp; jam"></label>
        <textarea class="t">${esc(it.text)}</textarea><input class="tg" value="${esc(it.topic_tag || '')}" placeholder="topic tag"><span class="counter">${it.length}/500</span></div>`).join('') +
        `<div><button class="btn primary" id="saveall">Simpan yang dicentang sebagai draft</button></div>`;
      pickers($('#out'));
      $('#saveall').onclick = (e2) => busy(e2.target, async () => {
        let n = 0;
        for (const c of $$('#out [data-i]')) {
          if (!$('.inc', c).checked) continue;
          await api('POST', '/api/posts', { brand_id: brand, text: $('.t', c).value, topic_tag: $('.tg', c).value || null, scheduled_at: fromInput($('.w', c).value), source: 'ai' }); n++;
        }
        toast(`${n} draft tersimpan.`); location.hash = `#/queue?brand=${brand}&status=draft`;
      });
    } finally { e.target.textContent = 'Susun rencana dengan Claude'; }
  });
};

/* ---------- Inbox ---------- */
VIEWS.inbox = async (v) => {
  v.innerHTML = `<h1>Inbox Reply</h1><p class="muted">Reply terbaru pada 5 post terakhir tiap akun. Claude menyiapkan balasan, Anda yang mengirim.</p>
  <div class="row">${brandPick(brands[0].id)}<button class="btn primary" id="load">Muat reply</button></div><div id="out" class="stack" style="margin-top:14px"></div>`;
  $('#load').onclick = (e) => busy(e.target, async () => {
    const id = $('[name=brand]').value;
    const items = await api('GET', `/api/brands/${id}/replies`);
    $('#out').innerHTML = items.map((x, i) => `<div class="card stack" data-i="${i}"><div class="small muted">Pada post: “${esc(x.post_text.slice(0, 90))}…”</div>
      <div><b>@${esc(x.reply.username)}</b> ${x.reply.hide_status === 'HIDDEN' ? '<span class="badge">disembunyikan</span>' : ''}<p style="margin:.3em 0">${esc(x.reply.text)}</p></div>
      <div class="row">${health.ai ? '<button class="btn small" data-a="sug">Saran balasan Claude</button>' : ''}${can('manager') ? '<button class="btn small" data-a="hide">Sembunyikan</button>' : ''}</div>
      <div class="opts stack"></div><div class="row"><textarea style="min-height:56px" class="rt" placeholder="Tulis balasan…"></textarea>${can('manager') ? '<button class="btn small primary" data-a="send">Kirim</button>' : ''}</div></div>`).join('') || '<p class="muted">Belum ada reply.</p>';
    $('#out').onclick = async (ev) => {
      const a = ev.target.dataset.a; const card = ev.target.closest('[data-i]'); if (!card && !ev.target.dataset.o) return;
      if (ev.target.dataset.o) { $('.rt', ev.target.closest('[data-i]')).value = ev.target.textContent; return; }
      const x = items[card.dataset.i];
      await busy(ev.target, async () => {
        if (a === 'sug') {
          const r = await api('POST', '/api/ai/reply-suggestions', { brand_id: id, post_text: x.post_text, replies: [x.reply], count: 5 });
          $('.opts', card).innerHTML = (r.suggestions[0]?.options || []).map((o) => `<button class="btn small" style="text-align:left" data-o="1">${esc(o)}</button>`).join('');
        }
        if (a === 'hide') { await api('POST', `/api/brands/${id}/replies/${x.reply.id}/hide`, { hide: true }); toast('Disembunyikan.'); }
        if (a === 'send') { const t = $('.rt', card).value.trim(); if (!t) throw new Error('Tulis balasan dulu.'); if (!(await ui.confirm({ title: 'Kirim balasan?', message: 'Balasan tampil publik atas nama brand.', quote: t, quoteLabel: 'Balasan Anda', ok: 'Kirim balasan' }))) return; await api('POST', `/api/brands/${id}/replies/${x.reply.id}/reply`, { text: t }); toast('Balasan terkirim.'); $('.rt', card).value = ''; }
      });
    };
  });
};

/* ---------- Insights ---------- */
VIEWS.insights = async (v) => {
  v.innerHTML = `<h1>Insight</h1><div class="row">${brandPick(brands[0].id)}<select id="days" style="width:auto"><option value="7">7 hari</option><option value="14">14 hari</option><option value="30">30 hari</option></select><button class="btn primary" id="load">Tampilkan</button>${can('manager') && health.ai ? '<button class="btn" id="an">Analisis Claude</button>' : ''}</div><div id="out" class="stack" style="margin-top:14px"></div>`;
  const q = () => ({ id: $('[name=brand]').value, days: $('#days').value });
  $('#load').onclick = (e) => busy(e.target, async () => {
    const { id, days } = q(); const d = await api('GET', `/api/brands/${id}/insights?days=${days}`); const a = d.account;
    const kpi = [['Views', a.views], ['Like', a.likes], ['Reply', a.replies], ['Repost', a.reposts], ['Followers', a.followers_count]];
    $('#out').innerHTML = `<div class="grid g4">${kpi.map(([k, n]) => `<div class="card"><div class="muted small">${k}</div><h1>${n == null ? '-' : Number(n).toLocaleString('id-ID')}</h1></div>`).join('')}</div>
      <div class="card"><h3>Post terbit terakhir</h3><table><thead><tr><th>Post</th><th>Views</th><th>Like</th><th>Reply</th><th>Repost</th></tr></thead><tbody>${d.posts.map((p) => `<tr><td>${esc(p.text.slice(0, 100))}</td><td>${p.metrics.views ?? '-'}</td><td>${p.metrics.likes ?? 0}</td><td>${p.metrics.replies ?? 0}</td><td>${p.metrics.reposts ?? 0}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Belum ada post terbit.</td></tr>'}</tbody></table></div><div id="ana"></div>`;
  });
  const an = $('#an');
  if (an) an.onclick = (e) => busy(e.target, async () => {
    const { id, days } = q(); if (!$('#ana')) await $('#load').onclick({ target: $('#load') });
    const { analysis: a } = await api('POST', '/api/ai/analyze', { brand_id: id, days });
    const ul = (l) => `<ul>${(l || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
    $('#ana').innerHTML = `<div class="card"><h3>Analisis Claude</h3><p>${esc(a.summary)}</p><div class="grid g2"><div><b>Yang jalan</b>${ul(a.whats_working)}<b>Yang belum</b>${ul(a.whats_not)}</div><div><b>Tindakan minggu depan</b>${ul(a.next_actions)}<b>Ide post</b>${ul(a.post_ideas)}</div></div></div>`;
  });
  $('#load').click();
};

/* ---------- Brand ---------- */
const PERM_LABEL = {
  threads_basic: 'Profil dasar', threads_content_publish: 'Publish post', threads_read_replies: 'Baca balasan', threads_manage_replies: 'Kelola balasan',
  threads_manage_insights: 'Insight', threads_keyword_search: 'Cari kata kunci', threads_manage_mentions: 'Mention', threads_profile_discovery: 'Profil publik',
};
const permChip = (sc, state, tip = '') => {
  const ic = { ok: '✓', granted: '✓', no: '✕', bad: '⚠', na: '–' }[state];
  return `<span class="perm ${state}" data-scope="${sc}" title="${esc(tip || sc)}">${ic} ${esc(PERM_LABEL[sc] || sc)}</span>`;
};
const permBlock = (b) => {
  if (!b.connected) return '';
  const missing = b.all_scopes.filter((x) => !b.granted_scopes.includes(x));
  return `<div class="permbox stack" data-perm><div class="row between"><b>Izin Threads</b>${can('manager') ? '<button type="button" class="btn small" data-x="perm">Cek izin sekarang</button>' : ''}</div>
    <div class="chips">${b.all_scopes.map((sc) => permChip(sc, b.granted_scopes.includes(sc) ? 'granted' : 'no', b.granted_scopes.includes(sc) ? `${sc}: diminta dan disetujui saat akun dihubungkan` : `${sc}: belum diminta saat akun dihubungkan`)).join('')}</div>
    <div class="small muted" data-pnote>${missing.length ? `Belum diotorisasi: ${missing.map((x) => PERM_LABEL[x]).join(', ')}. ${can('admin') ? 'Aktifkan "Izin riset, mention & kolaborasi" di Pengaturan Meta, lalu putuskan dan hubungkan ulang akun ini.' : 'Minta admin mengaktifkan izin tambahan, lalu hubungkan ulang akun ini.'}` : 'Semua izin sudah diotorisasi saat akun dihubungkan.'}</div>
    <div class="small muted">✓ diberikan · ✕ belum diminta · ⚠ ditolak Meta (biasanya belum disetujui App Review). Publish dan Kelola balasan hanya bisa dibuktikan dengan memposting/membalas. Tekan "Cek izin sekarang" untuk menguji ke Threads.</div></div>`;
};
const checkPerm = (btn, id, brand) => busy(btn, async () => {
  const r = await api('POST', `/api/brands/${id}/permission-check`);
  const box = btn.closest('[data-perm]'); const bad_ = [];
  for (const [sc, v] of Object.entries(r.results)) {
    const granted = brand.granted_scopes.includes(sc);
    const state = v.status === 'ok' ? 'ok' : v.status === 'gagal' ? 'bad' : v.status === 'belum_diminta' ? 'no' : granted ? 'granted' : 'no';
    const chip = $(`[data-scope="${sc}"]`, box); if (chip) chip.outerHTML = permChip(sc, state, `${sc}: ${v.detail || v.status}`);
    if (v.status === 'gagal') bad_.push(`${PERM_LABEL[sc]}: ${v.detail}`);
  }
  $('[data-pnote]', box).innerHTML = bad_.length ? `Ditolak/gagal:<br>${bad_.map(esc).join('<br>')}` : 'Semua izin yang bisa diuji berhasil dipakai (✓ hijau).';
  toast(bad_.length ? `${bad_.length} izin bermasalah, lihat detail.` : 'Cek izin selesai.', bad_.length > 0);
});
VIEWS.brands = async (v) => {
  brands = await api('GET', '/api/brands');
  const cq = params().get('connect');
  if (cq) toast(cq === 'ok' ? 'Akun Threads berhasil terhubung.' : `Gagal menghubungkan: ${params().get('msg') || 'coba lagi'}`, cq !== 'ok');
  v.innerHTML = `<h1>Brand &amp; Akun</h1><p class="muted">Brand voice di sini dipakai Claude (di dashboard maupun via MCP) setiap menulis untuk akun tersebut.</p>
  <div class="grid g2">${brands.map((b) => `<form class="card stack bcard" style="--c:${b.color}" data-id="${b.id}">
    <div class="row between"><h2>${esc(b.name)}</h2>${b.connected ? `<span class="badge s-published">@${esc(b.username || '')}</span>` : '<span class="badge">Belum terhubung</span>'}</div>
    ${b.connected ? `<div class="small muted">Token berlaku s/d ${wib(b.token_expires_at)} (diperpanjang otomatis).</div>` : ''}
    <div class="row">${can('manager') && !b.connected ? `<a class="btn small primary" href="/auth/threads/start?brand=${b.id}">Hubungkan ke Threads</a>` : ''}${can('admin') && b.connected ? '<button type="button" class="btn small" data-x="refresh">Perpanjang token</button><button type="button" class="btn small danger" data-x="disc">Putuskan</button>' : ''}</div>
    ${permBlock(b)}
    <label>Deskripsi<input name="description" value="${esc(b.description)}" ${can('manager') ? '' : 'disabled'}></label>
    <label>Brand voice<textarea name="voice" ${can('manager') ? '' : 'disabled'}>${esc(b.voice)}</textarea></label>
    <label>Content pillars (satu per baris)<textarea name="pillars" ${can('manager') ? '' : 'disabled'}>${esc(b.pillars.join('\n'))}</textarea></label>
    <label>Hashtag / topic lazim<input name="hashtags" value="${esc(b.hashtags)}" ${can('manager') ? '' : 'disabled'}></label>
    <label>Lakukan<textarea name="dos" style="min-height:64px" ${can('manager') ? '' : 'disabled'}>${esc(b.dos)}</textarea></label>
    <label>Hindari<textarea name="donts" style="min-height:64px" ${can('manager') ? '' : 'disabled'}>${esc(b.donts)}</textarea></label>
    ${can('manager') ? '<div class="row"><button class="btn primary" type="submit">Simpan brand</button><button type="button" class="btn" data-x="hist">Riwayat perubahan</button></div>' : ''}</form>`).join('')}</div>`;
  v.onsubmit = (e) => { e.preventDefault(); const f = e.target; const d = Object.fromEntries(new FormData(f)); d.pillars = d.pillars.split('\n').map((s) => s.trim()).filter(Boolean);
    busy($('button[type=submit]', f), async () => { await api('PUT', `/api/brands/${f.dataset.id}`, d); toast('Brand tersimpan.'); }); };
  v.onclick = (e) => { const x = e.target.dataset.x; if (!x) return; const id = e.target.closest('form').dataset.id;
    if (x === 'perm') return checkPerm(e.target, id, brands.find((y) => y.id === id));
    if (x === 'hist') return busy(e.target, () => showHistory(id));
    busy(e.target, async () => { if (x === 'refresh') await api('POST', `/api/brands/${id}/refresh-token`); if (x === 'disc') { if (!(await ui.confirm({ title: 'Putuskan akun ini?', message: 'Token Threads dihapus dari Hub. Posting terjadwal untuk akun ini akan gagal sampai Anda menghubungkannya lagi.', ok: 'Putuskan', danger: true }))) return; await api('DELETE', `/api/brands/${id}/connection`); } toast('Berhasil.'); route(); }); };
};

const VIA = { cookie: 'Dashboard', oauth: 'Claude (konektor)', token: 'Claude (token API)' };
const FIELD_LABEL = { description: 'Deskripsi', voice: 'Brand voice', pillars: 'Content pillars', hashtags: 'Hashtag', dos: 'Lakukan', donts: 'Hindari', name: 'Nama' };
async function showHistory(brandId) {
  const [list, fresh] = await Promise.all([api('GET', `/api/brands/${brandId}/history`), api('GET', '/api/brands')]);
  const cur = fresh.find((b) => b.id === brandId);
  const diff = (snap) => Object.keys(FIELD_LABEL).filter((k) => k !== 'name' && JSON.stringify(snap[k] ?? '') !== JSON.stringify(cur[k] ?? '')).map((k) => FIELD_LABEL[k]);
  const html = list.length ? `<div class="skiplist hist">${list.map((h) => { const d = diff(h.snapshot); return `<div class="hrow" data-h="${h.id}"><div class="row between"><b>${esc(wib(h.ts))}</b><span class="badge">${esc(VIA[h.via] || h.via || '-')}</span></div>
    <div class="small muted">oleh ${esc(h.user_name || '-')} · berbeda dari sekarang: ${d.length ? esc(d.join(', ')) : 'tidak ada'}</div>
    <details><summary class="small">Lihat isi versi ini</summary><div class="small" style="white-space:pre-wrap"><b>Voice:</b> ${esc(h.snapshot.voice || '-')}\n<b>Pillars:</b> ${esc((h.snapshot.pillars || []).join(' · ') || '-')}\n<b>Hashtag:</b> ${esc(h.snapshot.hashtags || '-')}\n<b>Lakukan:</b> ${esc(h.snapshot.dos || '-')}\n<b>Hindari:</b> ${esc(h.snapshot.donts || '-')}</div></details>
    ${d.length ? '<button type="button" class="btn small" data-restore>Pulihkan versi ini</button>' : ''}</div>`; }).join('')}</div>` : '<p class="muted">Belum ada perubahan tercatat.</p>';
  await ui.form({ title: `Riwayat ${cur.name}`, message: 'Versi sebelum setiap perubahan. Memulihkan akan menjadikan versi itu profil aktif (versi saat ini ikut tersimpan di riwayat).', ok: 'Tutup', cancel: 'Batal', extra: { html, init: (form) => form.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-restore]'); if (!b) return;
    b.disabled = true;
    try { await api('POST', `/api/brands/${brandId}/history/${b.closest('[data-h]').dataset.h}/restore`); toast('Versi dipulihkan.'); form.querySelector('[data-m=cancel]').click(); route(); } catch (err) { toast(err.message, true); b.disabled = false; }
  }) } });
}

/* ---------- Hubungkan Claude ---------- */
VIEWS.claude = async (v) => {
  const url = location.origin;
  const desktop = JSON.stringify({ mcpServers: { 'delova-threads': { command: 'node', args: ['C:\\Users\\NAMA\\Delova\\Delova Wardrobe\\delova-threads-hub\\mcp\\server.js'], env: { DELOVA_HUB_URL: url, DELOVA_HUB_TOKEN: 'dth_ISI_TOKEN_DARI_MENU_TIM' } } } }, null, 2);
  const ov = await api('GET', '/api/overview');
  const pol = ov.claude_policy;
  const yn = (x) => (x ? '<span class="badge s-published">Diizinkan</span>' : '<span class="badge">Dimatikan admin</span>');
  v.innerHTML = `<h1>Hubungkan Claude</h1>
  <p class="muted">Cara utama kerja tim: <b>ngobrol dengan Claude</b>. Claude membaca brand voice, menulis dan menjadwalkan, meninjau antrean, menyiapkan balasan. Dashboard ini untuk kontrol dan approval.</p>
  ${pol.claude_enabled ? '' : '<div class="banner">Akses Claude sedang <b>dimatikan</b> oleh admin (Kontrol Claude).</div>'}
  <div class="grid g2">
    <div class="card stack"><h2>Yang boleh dilakukan Claude sekarang</h2>
      <div class="row between"><span>Membaca brand voice, antrean, insight, reply</span><span class="badge s-published">Selalu</span></div>
      <div class="row between"><span>Membuat &amp; mengajukan draft</span>${yn(pol.can_create)}</div>
      <div class="row between"><span>Menyetujui &amp; menjadwalkan</span>${yn(pol.can_approve)}</div>
      <div class="row between"><span>Publish langsung</span>${yn(pol.can_publish)}</div>
      <div class="row between"><span>Membalas / menyembunyikan komentar</span>${yn(pol.can_reply)}</div>
      <div class="row between"><span>Mengubah profil brand (voice, pillar, dll)</span>${yn(pol.can_edit_brand)}</div>
      <p class="small muted">Setiap aksi tulis tetap mengikuti peran akun yang Anda pakai (${esc(me.role)}). Admin mengubah izin di menu Kontrol Claude.</p></div>
    <div class="card stack"><h2>Contoh perintah</h2><ul>
      <li>“Ada apa hari ini?” (ringkasan antrean &amp; jadwal)</li>
      <li>“Buat rencana konten Delova Scarf 7 hari, tunjukkan dulu sebelum disimpan.”</li>
      <li>“Tinjau antrean approval dan beri rekomendasi.”</li>
      <li>“Siapkan 5 opsi balasan untuk reply terbaru Delova Kids.”</li>
      <li>“Review performa Delova Wardrobe 14 hari terakhir.”</li></ul>
      <p class="small muted">Ketik <b>/</b> di Claude untuk melihat prompt siap pakai: rencana_mingguan, tinjau_antrean, inbox_reply, review_performa.</p></div></div>

  <div class="card stack" style="margin-top:14px"><h2>A) Konektor di claude.ai (disarankan, bisa dari web &amp; HP)</h2>
    <ol><li>Pastikan Hub ini online dengan <b>HTTPS</b> dan <code>APP_BASE_URL</code> di <code>.env</code> sama dengan alamatnya.</li>
    <li>Di claude.ai buka <b>Settings → Connectors → Add custom connector</b>. Nama: <i>Delova Threads</i>. URL:</li></ol>
    <pre>${esc(url)}/mcp</pre>
    <ol start="3"><li>Klik <b>Connect</b>, masuk dengan akun Hub Anda, lalu <b>Izinkan</b>. Selesai; tiap anggota tim connect dengan akunnya sendiri sehingga peran dan jejak audit per orang.</li></ol>
    <p class="small muted">Pada paket Team/Enterprise, penambahan konektor kustom bisa dibatasi untuk Owner organisasi; cek pengaturan Connectors Anda. Jika URL masih <code>localhost</code>, konektor tidak bisa menjangkaunya: gunakan domain/tunnel HTTPS.</p></div>

  <div class="card stack" style="margin-top:14px"><h2>B) Claude Desktop / Claude Code (token)</h2>
    <p class="small">Admin buat API token di menu Tim → API token (disarankan satu token per orang).</p>
    <h3>Claude Desktop (<code>claude_desktop_config.json</code>)</h3><pre>${esc(desktop)}</pre>
    <h3>Claude Code</h3><pre>claude mcp add --transport http delova-threads ${esc(url)}/mcp --header "Authorization: Bearer dth_xxx"</pre></div>`;
};

/* ---------- Kontrol Claude (admin) ---------- */
VIEWS.control = async (v) => {
  const [p, sess, act] = await Promise.all([api('GET', '/api/settings/claude'), api('GET', '/api/claude/sessions'), api('GET', '/api/claude/activity')]);
  const sw = (name, title, desc, on) => `<label class="row" style="align-items:flex-start;font-weight:400"><input type="checkbox" name="${name}" ${on ? 'checked' : ''} style="width:auto;margin-top:4px"><span><b>${title}</b><br><span class="muted small">${desc}</span></span></label>`;
  v.innerHTML = `<h1>Kontrol Claude</h1>
  <p class="muted">Atur apa yang boleh dilakukan Claude atas nama tim (lewat konektor / MCP). Perubahan berlaku seketika. Dashboard ini tetap bisa melakukan semuanya sesuai peran tiap user.</p>
  <form id="pf" class="card stack">
    ${sw('claude_enabled', 'Akses Claude aktif', 'Saklar utama. Matikan untuk memutus SEMUA akses Claude dalam sekejap (darurat).', p.claude_enabled)}
    ${sw('can_create', 'Buat &amp; edit draft, ajukan approval', 'Aman: tidak pernah langsung terbit.', p.can_create)}
    ${sw('can_approve', 'Setujui &amp; jadwalkan post', 'Claude boleh menyetujui hanya setelah user yang login memberi konfirmasi di percakapan. Hanya efektif jika akun yang dipakai berperan manager/admin.', p.can_approve)}
    ${sw('can_publish', 'Publish langsung ke Threads', 'Risiko tertinggi: post langsung tayang. Disarankan tetap mati.', p.can_publish)}
    ${sw('can_reply', 'Balas &amp; sembunyikan komentar', 'Balasan tampil publik atas nama brand.', p.can_reply)}
    ${sw('can_edit_brand', 'Ubah profil brand (voice, pillar, hashtag, dos/donts)', 'Claude boleh mengubah isi profil brand setelah konfirmasi user di percakapan. Memengaruhi semua tulisan berikutnya; setiap perubahan tersimpan di riwayat dan bisa dipulihkan. Nama brand &amp; kredensial tidak bisa diubah Claude.', p.can_edit_brand)}
    <label>Batas draft baru dari Claude per 24 jam<input type="number" name="daily_create_cap" min="0" max="500" value="${p.daily_create_cap}" style="max-width:140px"></label>
    <div><button class="btn primary">Simpan kontrol</button></div>
  </form>
  <div class="card" style="margin-top:14px"><div class="row between"><h3>Sesi konektor claude.ai</h3>${sess.length ? '<button class="btn small danger" id="revall">Putuskan semua</button>' : ''}</div>
    <table><thead><tr><th>User</th><th>Aplikasi</th><th>Terhubung</th><th>Berlaku s/d</th><th></th></tr></thead><tbody>
    ${sess.map((x) => `<tr data-id="${x.id}"><td>${esc(x.user_name)} <span class="muted small">${esc(x.role)}</span></td><td>${esc(x.client_name)}</td><td class="small">${wib(x.created_at)}</td><td class="small">${wib(new Date(x.refresh_expires).toISOString())}</td><td><button class="btn small danger" data-rev="1">Putuskan</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">Belum ada yang menghubungkan konektor. (Token API dikelola di menu Tim.)</td></tr>'}</tbody></table></div>
  <div class="card" style="margin-top:14px"><h3>Aktivitas Claude terakhir</h3><table><tbody>
    ${act.map((a) => { let d = {}; try { d = JSON.parse(a.detail || '{}'); } catch {} return `<tr><td class="small muted">${wib(a.ts)}</td><td>${esc(a.user_name || '-')}</td><td>${esc(a.action)}</td><td class="small muted">${esc(d.via || '')}</td></tr>`; }).join('') || '<tr><td class="muted">Belum ada aktivitas.</td></tr>'}</tbody></table></div>`;
  $('#pf').onsubmit = (e) => {
    e.preventDefault(); const f = e.target; const g = (n) => f.elements[n].checked;
    busy($('button', f), async () => {
      await api('PUT', '/api/settings/claude', { claude_enabled: g('claude_enabled'), can_create: g('can_create'), can_approve: g('can_approve'), can_publish: g('can_publish'), can_reply: g('can_reply'), can_edit_brand: g('can_edit_brand'), daily_create_cap: f.elements.daily_create_cap.value });
      toast('Kontrol Claude disimpan.'); route();
    });
  };
  v.onclick = (e) => {
    if (e.target.id === 'revall') busy(e.target, async () => { if (!(await ui.confirm({ title: 'Putuskan semua sesi Claude?', message: 'Semua konektor claude.ai yang terhubung langsung terputus dan harus menghubungkan ulang.', ok: 'Putuskan semua', danger: true }))) return; await api('DELETE', '/api/claude/sessions'); toast('Semua sesi diputus.'); route(); });
    if (e.target.dataset.rev) busy(e.target, async () => { await api('DELETE', `/api/claude/sessions/${e.target.closest('tr').dataset.id}`); toast('Sesi diputus.'); route(); });
  };
};

/* ---------- Pengaturan Meta (admin) ---------- */
VIEWS.meta = async (v) => {
  const m = await api('GET', '/api/settings/meta');
  const SRC = { brand: 'Kredensial brand ini', dashboard: 'Kredensial global (dashboard)', env: 'Kredensial dari .env server', none: 'Belum diisi' };
  const modeNow = m.simulated ? '<span class="badge">SIMULASI: tidak memposting ke Threads asli</span>' : '<span class="badge s-published">LIVE: memposting ke Threads asli</span>';
  v.innerHTML = `<h1>Pengaturan Meta</h1>
  <p class="muted">Kredensial aplikasi Meta (Threads API) disimpan terenkripsi di server. App Secret tidak pernah ditampilkan lagi setelah disimpan dan tidak bisa diubah lewat Claude/MCP. Status saat ini: ${modeNow}</p>
  <form id="gf" class="card stack">
    <h3>Aplikasi Meta (berlaku untuk semua akun)</h3>
    <p class="small muted">Satu aplikasi Meta cukup untuk keempat akun: tiap akun tetap login sendiri lewat tombol <i>Hubungkan ke Threads</i> sehingga token-nya terpisah. Sumber aktif: <b>${esc(SRC[m.global_source])}</b>${m.env_has_creds && m.global_source !== 'env' ? ' (nilai di .env tertimpa oleh yang diisi di sini)' : ''}.</p>
    <div class="grid g2">
      <label>Threads App ID<input name="app_id" value="${esc(m.app_id)}" autocomplete="off" placeholder="mis. 1234567890123456"></label>
      <label>Threads App Secret<input name="app_secret" type="password" autocomplete="new-password" placeholder="${m.has_secret ? 'tersimpan; kosongkan jika tidak diubah' : 'tempel App Secret'}"></label>
    </div>
    <label>Redirect Callback URL (salin ke Meta for Developers)
      <span class="row"><input id="ru" value="${esc(m.redirect_uri)}" readonly><button type="button" class="btn small" id="cp">Salin</button></span></label>
    <label>Mode
      <select name="mode">
        <option value="auto" ${m.mode === 'auto' ? 'selected' : ''}>Otomatis (ikut .env: THREADS_DRY_RUN=${m.env_dry_run ? 'true' : 'false'})</option>
        <option value="live" ${m.mode === 'live' ? 'selected' : ''}>Live (posting ke Threads asli)</option>
        <option value="sim" ${m.mode === 'sim' ? 'selected' : ''}>Simulasi (aman untuk uji coba)</option>
      </select></label>
    <label class="row" style="align-items:flex-start;font-weight:400"><input type="checkbox" name="extra_scopes" ${m.extra_scopes ? 'checked' : ''} style="width:auto;margin-top:4px"><span><b>Izin riset, mention &amp; kolaborasi</b><br><span class="muted small">Aktifkan hanya setelah <code>threads_keyword_search</code>, <code>threads_manage_mentions</code>, dan <code>threads_profile_discovery</code> ditambahkan di Use cases aplikasi Meta. Setelah diaktifkan, hubungkan ulang tiap akun agar izin barunya diminta.</span></span></label>
    <label class="row" style="align-items:flex-start;font-weight:400"><input type="checkbox" name="mentions_auto" ${m.mentions_auto ? 'checked' : ''} style="width:auto;margin-top:4px"><span><b>Kumpulkan mention otomatis</b> <span class="muted small">(sekitar tiap jam, hanya saat mode Live)</span></span></label>
    <div class="row"><button class="btn primary">Simpan</button>${m.app_id || m.has_secret ? '<button type="button" class="btn small danger" id="gclear">Hapus kredensial global</button>' : ''}</div>
  </form>
  <div class="card stack" style="margin-top:14px">
    <h3>Kredensial per brand (opsional)</h3>
    <p class="small muted">Isi hanya jika sebuah brand memakai aplikasi Meta sendiri. Kosong berarti brand memakai kredensial global di atas.</p>
    <div class="grid g2">${m.brands.map((b) => `<form class="card stack bf" data-id="${b.id}">
      <div class="row between"><b>${esc(b.name)}</b>${b.connected ? `<span class="badge s-published">@${esc(b.username || 'terhubung')}</span>` : '<span class="badge">Belum terhubung</span>'}</div>
      <div class="small muted">Sumber aktif: ${esc(SRC[b.source])}${b.simulated ? ' · simulasi' : ''}</div>
      <label>App ID<input name="app_id" value="${esc(b.app_id)}" autocomplete="off"></label>
      <label>App Secret<input name="app_secret" type="password" autocomplete="new-password" placeholder="${b.has_secret ? 'tersimpan; kosongkan jika tidak diubah' : 'tempel App Secret'}"></label>
      <div class="row"><button class="btn small primary">Simpan</button>${b.source === 'brand' ? '<button type="button" class="btn small" data-x="bclear">Pakai kredensial global</button>' : ''}</div>
    </form>`).join('')}</div>
  </div>
  <div class="card stack" style="margin-top:14px"><h3>Alamat untuk formulir Meta</h3>
    <p class="small muted">Tempel alamat ini di Meta for Developers (Settings aplikasi Threads dan form Publish). Halaman-halaman ini publik dan sudah tersedia dalam Bahasa Indonesia dan Inggris.</p>
    ${[['Privacy Policy URL', m.legal.privacy], ['Terms of Service URL', m.legal.terms], ['Data Deletion Requests URL', m.legal.delete_cb], ['Deauthorize Callback URL', m.legal.deauthorize], ['Halaman petunjuk penghapusan data', m.legal.deletion]].map(([l, u]) => `<label>${l}<span class="row"><input value="${esc(u)}" readonly><a class="btn small" href="${esc(u)}" target="_blank" rel="noopener">${u.includes('/auth/') ? '' : 'Buka'}</a></span></label>`).join('')}
  </div>
  <div class="card" style="margin-top:14px"><h3>Cara mendapatkan kredensial</h3>
    <ol class="small"><li>Buka <b>developers.facebook.com</b> → My Apps → buat aplikasi dengan use case <b>Access the Threads API</b>.</li>
    <li>Di pengaturan use case Threads, salin <b>Threads App ID</b> dan <b>Threads App Secret</b> (bukan App ID Facebook utama).</li>
    <li>Isi <b>Redirect Callback URLs</b> (juga Uninstall dan Delete callback bila diminta) dengan alamat di atas.</li>
    <li>Tambahkan tiap akun Threads sebagai <b>Threads Tester</b> selama aplikasi belum Live, lalu terima undangannya di pengaturan akun Threads masing-masing.</li>
    <li>Kembali ke sini, simpan, ubah mode ke <b>Live</b>, lalu buka menu <b>Brand &amp; Akun</b> dan klik <b>Hubungkan ke Threads</b> untuk tiap akun.</li></ol>
    <p class="small muted">Izin yang diminta: ${m.scopes.map((x) => `<code>${esc(x)}</code>`).join(', ')}.</p></div>`;
  v.onsubmit = (e) => {
    e.preventDefault(); const f = e.target;
    busy($('button', f), async () => {
      if (f.id === 'gf') {
        const d = { app_id: f.elements.app_id.value.trim(), mode: f.elements.mode.value, extra_scopes: f.elements.extra_scopes.checked, mentions_auto: f.elements.mentions_auto.checked };
        if (f.elements.app_secret.value.trim()) d.app_secret = f.elements.app_secret.value.trim();
        await api('PUT', '/api/settings/meta', d);
      } else {
        const d = { app_id: f.elements.app_id.value.trim() };
        if (f.elements.app_secret.value.trim()) d.app_secret = f.elements.app_secret.value.trim();
        await api('PUT', `/api/brands/${f.dataset.id}/credentials`, d);
      }
      toast('Tersimpan.'); route();
    });
  };
  v.onclick = (e) => {
    if (e.target.id === 'cp') busy(e.target, async () => { await navigator.clipboard.writeText($('#ru').value); toast('Alamat disalin.'); });
    if (e.target.id === 'gclear') busy(e.target, async () => { if (!(await ui.confirm({ title: 'Hapus kredensial global?', message: 'Akun yang sudah terhubung tetap jalan, tetapi Anda tidak bisa menghubungkan akun baru sampai kredensial diisi lagi.', ok: 'Hapus kredensial', danger: true }))) return; await api('PUT', '/api/settings/meta', { clear: true, mode: 'sim' }); toast('Kredensial global dihapus.'); route(); });
    if (e.target.dataset.x === 'bclear') busy(e.target, async () => { await api('PUT', `/api/brands/${e.target.closest('form').dataset.id}/credentials`, { clear: true }); toast('Brand kembali memakai kredensial global.'); route(); });
  };
};

/* ---------- Riset, Mention, Kolaborasi ---------- */
const copyText = async (t) => { try { await navigator.clipboard.writeText(t); toast('Disalin.'); } catch { toast('Gagal menyalin.', true); } };
const num = (n) => (n == null ? '-' : Number(n).toLocaleString('id-ID'));
const accessBanner = (st, list) => {
  const live = list.some((b) => !b.simulated);
  if (!live) return '<div class="banner"><b>Mode simulasi:</b> data di halaman ini adalah contoh, bukan dari Threads asli.</div>';
  if (!st.extra_scopes) return `<div class="banner"><b>Izin tambahan belum aktif.</b> ${can('admin') ? 'Aktifkan "Izin riset, mention &amp; kolaborasi" di menu Pengaturan Meta, lalu hubungkan ulang akun.' : 'Minta admin mengaktifkannya di Pengaturan Meta.'}</div>`;
  return '<div class="banner">Selama izin tambahan belum disetujui Meta (Advanced Access), pencarian hanya menjangkau post akun kita sendiri, mention hanya dari akun tester, dan lookup profil hanya akun resmi Meta.</div>';
};

VIEWS.research = async (v) => {
  const [st, saves] = await Promise.all([api('GET', '/api/research/status'), api('GET', '/api/research/saves')]);
  if (!brands.length) brands = await api('GET', '/api/brands');
  let last = null;
  const postCard = (p, i) => `<div class="card stack" data-i="${i}">
    <div class="row between"><b>@${esc(p.username)}</b><span class="small muted">${wib(p.timestamp)}</span></div>
    <div style="white-space:pre-wrap">${esc(p.text) || '<span class="muted">(tanpa teks)</span>'}</div>
    <div class="row"><span class="badge">${esc(p.media_type)}</span>${p.permalink ? `<a class="btn small" href="${esc(p.permalink)}" target="_blank" rel="noopener">Buka di Threads</a>` : ''}${can('editor') ? '<button type="button" class="btn small" data-a="cand">Jadikan kandidat endorse</button>' : ''}</div></div>`;
  const insightsHtml = (a) => {
    const ul = (l) => `<ul>${(l || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
    return `<div class="card stack"><h3>Analisis Claude</h3><p>${esc(a.summary)}</p>
      <div class="grid g2"><div><b>Tema yang sering muncul</b>${ul(a.themes)}<b>Pertanyaan audiens</b>${ul(a.audience_questions)}</div><div><b>Celah konten</b>${ul(a.content_gaps)}<b>Ciri kreator yang cocok</b>${ul(a.creator_signals)}</div></div>
      <b>Ide post (${(a.post_ideas || []).length})</b>
      ${(a.post_ideas || []).map((x, i) => `<div class="card stack" data-idea="${i}"><div class="small muted">${esc(x.angle || '')} · ${x.length ?? ''} karakter</div><div style="white-space:pre-wrap">${esc(x.text)}</div><div class="row"><button type="button" class="btn small" data-a="copy">Salin</button>${can('editor') ? '<button type="button" class="btn small primary" data-a="draft">Jadikan draft</button>' : ''}</div></div>`).join('')}</div>`;
  };
  v.innerHTML = `<h1>Riset</h1><p class="muted">Cari post publik di Threads berdasarkan kata kunci atau topic tag untuk melihat tren, pertanyaan audiens, dan ide konten. Hasil yang sama disimpan 10 menit agar kuota pencarian Meta (2.200 per 24 jam) tidak terbuang.</p>
  ${accessBanner(st, brands)}
  <form id="sf" class="card stack"><div class="grid g2">
    <label>Akun yang dipakai mencari${brandPick(brands[0]?.id, 'brand')}</label>
    <label>Kata kunci / topic tag<input name="q" required minlength="2" maxlength="200" placeholder="mis. kebaya modern, batik anak"></label>
    <label>Mode<select name="search_mode"><option value="KEYWORD">Kata kunci</option><option value="TAG">Topic tag</option></select></label>
    <label>Urutan<select name="search_type"><option value="TOP">Teratas</option><option value="RECENT">Terbaru</option></select></label>
    <label>Jenis post<select name="media_type"><option value="">Semua</option><option value="TEXT">Teks</option><option value="IMAGE">Gambar</option><option value="VIDEO">Video</option></select></label>
    <label>Rentang waktu<select name="days"><option value="1">24 jam</option><option value="7" selected>7 hari</option><option value="30">30 hari</option><option value="90">90 hari</option></select></label>
    <label>Hanya dari username (opsional)<input name="author" placeholder="tanpa @"></label></div>
    <div class="row"><button class="btn primary" id="go">Cari</button></div></form>
  <div id="res" class="stack" style="margin-top:14px"></div>
  <div class="card stack" style="margin-top:14px"><h3>Riset tersimpan</h3>
    ${saves.map((r) => `<div class="row between" data-sid="${r.id}"><span><b>${esc(r.query)}</b> <span class="small muted">${r.result.length} post · ${wib(r.created_at)}</span></span><span class="row"><button type="button" class="btn small" data-a="open">Buka</button>${can('editor') ? '<button type="button" class="btn small danger" data-a="del">Hapus</button>' : ''}</span></div>`).join('') || '<span class="muted">Belum ada riset yang disimpan.</span>'}</div>`;
  const show = () => {
    $('#res').innerHTML = `<div class="row between"><b>${last.posts.length} post untuk "${esc(last.q)}"</b><span class="row">${can('editor') && last.posts.length ? '<button type="button" class="btn small" data-a="save">Simpan hasil</button>' : ''}${can('editor') && health.ai && last.posts.length ? '<button type="button" class="btn small primary" data-a="ai">Analisis dengan Claude</button>' : ''}</span></div>
      ${last.posts.map(postCard).join('') || '<div class="card muted">Tidak ada hasil. Coba kata kunci lain atau perluas rentang waktu.</div>'}<div id="ai"></div>`;
  };
  $('#sf').onsubmit = (e) => {
    e.preventDefault(); const f = e.target; const d = Object.fromEntries(new FormData(f));
    busy($('#go'), async () => {
      const r = await api('POST', '/api/research/search', { brand_id: d.brand, q: d.q, search_mode: d.search_mode, search_type: d.search_type, media_type: d.media_type, days: Number(d.days), author: d.author });
      last = { q: d.q.trim(), posts: r.posts, brand_id: d.brand, d }; show();
    });
  };
  v.onclick = (e) => {
    const a = e.target.dataset.a; if (!a) return;
    if (a === 'cand') return busy(e.target, async () => {
      const p = last.posts[e.target.closest('[data-i]').dataset.i];
      const r = await api('POST', '/api/creators', { username: p.username, source: 'riset', sample_url: p.permalink, niche: last.q, lookup: true, lookup_brand_id: last.brand_id });
      toast(r.existed ? 'Sudah ada di daftar kandidat.' : r.lookup_error ? `Ditambahkan. Data profil belum terambil: ${r.lookup_error}` : 'Ditambahkan ke Kolaborasi.', !!r.lookup_error);
    });
    if (a === 'save') return busy(e.target, async () => { await api('POST', '/api/research/saves', { brand_id: last.brand_id, q: last.q, search_mode: last.d.search_mode, search_type: last.d.search_type, media_type: last.d.media_type, posts: last.posts }); toast('Riset disimpan.'); route(); });
    if (a === 'ai') return busy(e.target, async () => { const r = await api('POST', '/api/ai/research', { brand_id: last.brand_id, q: last.q, posts: last.posts }); last.ins = r.insights; $('#ai').innerHTML = insightsHtml(r.insights); });
    if (a === 'copy') return copyText(last.ins.post_ideas[e.target.closest('[data-idea]').dataset.idea].text);
    if (a === 'draft') return busy(e.target, async () => { await api('POST', '/api/posts', { brand_id: last.brand_id, text: last.ins.post_ideas[e.target.closest('[data-idea]').dataset.idea].text }); toast('Draft dibuat di Antrean.'); });
    if (a === 'open') { const r = saves.find((x) => x.id === e.target.closest('[data-sid]').dataset.sid); last = { q: r.query, posts: r.result, brand_id: r.brand_id || brands[0].id, d: { search_mode: r.mode, search_type: r.search_type, media_type: r.media_type } }; show(); return $('#res').scrollIntoView(); }
    if (a === 'del') return busy(e.target, async () => { if (!(await ui.confirm({ title: 'Hapus riset tersimpan?', message: 'Hasil riset ini dihapus dari Hub.', ok: 'Hapus', danger: true }))) return; await api('DELETE', `/api/research/saves/${e.target.closest('[data-sid]').dataset.sid}`); route(); });
  };
};

const M_STATUS = { baru: 'Baru', ditandai: 'Ditandai', dibalas: 'Dibalas', diabaikan: 'Diabaikan' };
VIEWS.mentions = async (v) => {
  const st = await api('GET', '/api/research/status');
  if (!brands.length) brands = await api('GET', '/api/brands');
  const q = params(); const bid = q.get('brand') || brands[0].id; const status = q.get('status') || '';
  const data = await api('GET', `/api/mentions?brand_id=${bid}${status ? `&status=${status}` : ''}`);
  const sel = brands.find((b) => b.id === bid);
  v.innerHTML = `<h1>Mention</h1><p class="muted">Post publik yang menyebut akun brand kita. Dikumpulkan otomatis sekitar tiap jam (mode Live), atau klik Kumpulkan sekarang. Status dan catatan tim tidak tertimpa saat pengumpulan ulang.</p>
  ${accessBanner(st, [sel])}
  <div class="row">${brandPick(bid, 'brand')}${can('editor') ? '<button type="button" class="btn primary" id="col">Kumpulkan sekarang</button>' : ''}<a class="btn" href="/api/mentions.csv?brand_id=${bid}">Ekspor CSV</a>${data.last_collected ? `<span class="small muted">Terakhir dikumpulkan ${wib(new Date(data.last_collected).toISOString())}</span>` : ''}</div>
  <div class="chips" style="margin:12px 0"><a class="chip" href="#/mentions?brand=${bid}">Semua</a>${Object.entries(M_STATUS).map(([k, l]) => `<a class="chip" href="#/mentions?brand=${bid}&status=${k}">${l} (${data.counts[k] || 0})</a>`).join('')}</div>
  <div class="stack">${data.items.map((m) => `<div class="card stack" data-id="${esc(m.id)}">
    <div class="row between"><b>@${esc(m.username)}</b><span class="small muted">${wib(m.posted_at)}</span></div>
    <div style="white-space:pre-wrap">${esc(m.text)}</div>
    <div class="row"><select data-f="status" ${can('editor') ? '' : 'disabled'}>${Object.entries(M_STATUS).map(([k, l]) => `<option value="${k}" ${k === m.status ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <input data-f="note" value="${esc(m.note)}" placeholder="Catatan tim" maxlength="1000" ${can('editor') ? '' : 'disabled'} style="flex:1;min-width:140px">
      ${m.permalink ? `<a class="btn small" href="${esc(m.permalink)}" target="_blank" rel="noopener">Buka</a>` : ''}
      ${can('manager') ? '<button type="button" class="btn small" data-a="reply">Balas</button>' : ''}
      ${can('editor') ? '<button type="button" class="btn small" data-a="cand">Kandidat endorse</button>' : ''}</div></div>`).join('') || '<div class="card muted">Belum ada mention. Klik "Kumpulkan sekarang".</div>'}</div>`;
  v.onchange = (e) => {
    const f = e.target.dataset.f; if (!f) return; const id = e.target.closest('[data-id]').dataset.id;
    busy(e.target, async () => { await api('PUT', `/api/mentions/${encodeURIComponent(id)}`, { [f]: e.target.value }); toast('Tersimpan.'); if (f === 'status') route(); });
  };
  v.onclick = (e) => {
    if (e.target.id === 'col') return busy(e.target, async () => { const r = await api('POST', '/api/mentions/collect', { brand_id: bid }); toast(`${r.added} mention baru dari ${r.total} yang ditemukan.`); route(); });
    const a = e.target.dataset.a; if (!a) return; const id = e.target.closest('[data-id]').dataset.id; const m = data.items.find((x) => x.id === id);
    if (a === 'reply') return busy(e.target, async () => { const t = await ui.ask({ title: `Balas @${m.username}`, quote: m.text, quoteLabel: 'Mention', label: 'Balasan Anda', placeholder: 'Tulis balasan…', max: 500, rows: 5, ok: 'Kirim balasan', hint: 'Balasan tampil publik atas nama brand. Ctrl+Enter untuk kirim.' }); if (!t) return; await api('POST', `/api/mentions/${encodeURIComponent(id)}/reply`, { text: t }); toast('Balasan terkirim.'); route(); });
    if (a === 'cand') return busy(e.target, async () => { const r = await api('POST', '/api/creators', { username: m.username, source: 'mention', sample_url: m.permalink, brand_id: bid, lookup: true, lookup_brand_id: bid }); toast(r.existed ? 'Sudah ada di daftar kandidat.' : r.lookup_error ? `Ditambahkan. Data profil belum terambil: ${r.lookup_error}` : 'Ditambahkan ke Kolaborasi.', !!r.lookup_error); });
  };
  const bs = $('[name=brand]', v); if (bs) bs.onchange = () => { location.hash = `#/mentions?brand=${bs.value}`; };
};

const C_STATUS = { prospek: 'Prospek', dihubungi: 'Dihubungi', negosiasi: 'Negosiasi', deal: 'Deal', ditolak: 'Ditolak' };
VIEWS.creators = async (v) => {
  const st = await api('GET', '/api/research/status');
  if (!brands.length) brands = await api('GET', '/api/brands');
  const filter = params().get('status') || '';
  const all_ = await api('GET', '/api/creators');
  const list = filter ? all_.filter((c) => c.status === filter) : all_;
  const cnt = (k) => all_.filter((c) => c.status === k).length;
  v.innerHTML = `<h1>Kolaborasi &amp; Endorse</h1><p class="muted">Kandidat kreator/endorser dan tahap negosiasinya. Tambahkan dari menu Riset atau Mention, atau manual di bawah. Data profil (pengikut dan engagement 7 hari) diambil lewat Threads bila izin Profile Discovery aktif; selain itu isi manual.</p>
  ${accessBanner(st, brands)}
  ${can('editor') ? `<form id="nf" class="card stack"><h3>Tambah kandidat</h3><div class="grid g2">
    <label>Username Threads<input name="username" required placeholder="@username atau link profil"></label>
    <label>Untuk brand${brandPick('', 'brand')}</label>
    <label>Niche / catatan<input name="niche" placeholder="mis. ibu muda, batik, hijab"></label>
    <label>Perkiraan fee / barter<input name="fee" placeholder="mis. produk gratis + Rp300 rb"></label></div>
    <label class="row" style="font-weight:400"><input type="checkbox" name="lookup" checked style="width:auto"> Ambil data profil dari Threads (pakai akun brand di atas)</label>
    <div><button class="btn primary">Tambah</button></div></form>` : ''}
  <div class="chips" style="margin:12px 0"><a class="chip" href="#/creators">Semua (${all_.length})</a>${Object.entries(C_STATUS).map(([k, l]) => `<a class="chip" href="#/creators?status=${k}">${l} (${cnt(k)})</a>`).join('')}</div>
  <div class="stack">${list.map((c) => `<div class="card stack" data-id="${c.id}">
    <div class="row between"><b>@${esc(c.username)} ${c.verified ? '✔' : ''}</b><span class="small muted">${esc(c.name || '')} · sumber: ${esc(c.source)}</span></div>
    ${c.bio ? `<div class="small">${esc(c.bio)}</div>` : ''}
    <div class="row"><span class="badge">Pengikut ${num(c.followers)}</span><span class="badge">Views 7 hari ${num(c.stats.views_count)}</span><span class="badge">Engagement ${c.engagement_rate == null ? '-' : c.engagement_rate + '%'}</span>${c.looked_up_at ? `<span class="small muted">profil diperbarui ${wib(c.looked_up_at)}</span>` : '<span class="small muted">profil belum diambil</span>'}</div>
    <div class="grid g2">
      <label>Tahap<select data-f="status" ${can('editor') ? '' : 'disabled'}>${Object.entries(C_STATUS).map(([k, l]) => `<option value="${k}" ${k === c.status ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>Untuk brand<select data-f="brand_id" ${can('editor') ? '' : 'disabled'}><option value="">-</option>${brands.map((b) => `<option value="${b.id}" ${b.id === c.brand_id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>
      <label>Niche<input data-f="niche" value="${esc(c.niche)}" ${can('editor') ? '' : 'disabled'}></label>
      <label>Fee / barter<input data-f="fee" value="${esc(c.fee)}" ${can('editor') ? '' : 'disabled'}></label></div>
    <label>Catatan<textarea data-f="note" style="min-height:56px" ${can('editor') ? '' : 'disabled'}>${esc(c.note)}</textarea></label>
    <div class="row"><a class="btn small" href="https://www.threads.com/@${esc(c.username)}" target="_blank" rel="noopener">Buka profil</a>
      ${c.sample_url ? `<a class="btn small" href="${esc(c.sample_url)}" target="_blank" rel="noopener">Post contoh</a>` : ''}
      ${can('editor') ? '<button type="button" class="btn small" data-a="lookup">Perbarui profil</button>' : ''}
      ${can('editor') && health.ai ? '<button type="button" class="btn small primary" data-a="ai">Draf pesan penawaran</button>' : ''}
      ${can('manager') ? '<button type="button" class="btn small danger" data-a="del">Hapus</button>' : ''}</div>
    <div class="stack" data-out></div></div>`).join('') || '<div class="card muted">Belum ada kandidat di tahap ini.</div>'}</div>`;
  const nf = $('#nf');
  if (nf) nf.onsubmit = (e) => {
    e.preventDefault(); const d = Object.fromEntries(new FormData(nf));
    busy($('button', nf), async () => {
      const r = await api('POST', '/api/creators', { username: d.username, niche: d.niche, fee: d.fee, brand_id: d.brand, lookup: !!d.lookup, lookup_brand_id: d.brand, source: 'manual' });
      toast(r.existed ? 'Username ini sudah ada di daftar.' : r.lookup_error ? `Ditambahkan. Data profil belum terambil: ${r.lookup_error}` : 'Kandidat ditambahkan.', !!r.lookup_error); route();
    });
  };
  v.onchange = (e) => {
    const f = e.target.dataset.f; if (!f) return; const id = e.target.closest('[data-id]').dataset.id;
    busy(e.target, async () => { await api('PUT', `/api/creators/${id}`, { [f]: e.target.value }); toast('Tersimpan.'); if (f === 'status') route(); });
  };
  v.onclick = (e) => {
    const a = e.target.dataset.a; if (!a) return; const card = e.target.closest('[data-id]'); const id = card.dataset.id; const c = all_.find((x) => x.id === id);
    const lb = c.brand_id || brands[0].id;
    if (a === 'lookup') return busy(e.target, async () => { await api('POST', `/api/creators/${id}/lookup`, { brand_id: lb }); toast('Profil diperbarui.'); route(); });
    if (a === 'del') return busy(e.target, async () => { if (!(await ui.confirm({ title: `Hapus @${c.username}?`, message: 'Kandidat dan catatan negosiasinya dihapus dari daftar Kolaborasi.', ok: 'Hapus', danger: true }))) return; await api('DELETE', `/api/creators/${id}`); route(); });
    if (a === 'ai') return busy(e.target, async () => {
      const offer = await ui.ask({ title: `Draf pesan untuk @${c.username}`, label: 'Tawaran yang boleh disebut (opsional)', placeholder: 'Kosongkan untuk "produk gratis untuk dicoba"', optional: true, max: 300, rows: 3, ok: 'Buat draf' }); if (offer === null) return;
      const r = await api('POST', '/api/ai/outreach', { brand_id: lb, creator_id: id, offer });
      $('[data-out]', card).innerHTML = r.drafts.map((d, i) => `<div class="card stack" data-d="${i}"><div class="small muted">${esc(d.label)}</div><div style="white-space:pre-wrap">${esc(d.message)}</div><div><button type="button" class="btn small" data-a="copy">Salin</button></div></div>`).join('');
      $('[data-out]', card).onclick = (ev) => { if (ev.target.dataset.a === 'copy') copyText(r.drafts[ev.target.closest('[data-d]').dataset.d].message); ev.stopPropagation(); };
    });
  };
};

/* ---------- Tim ---------- */
VIEWS.team = async (v) => {
  const [users, audit] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/audit')]);
  v.innerHTML = `<h1>Tim</h1><div class="card"><table><thead><tr><th>Nama</th><th>Email</th><th>Peran</th><th>Status</th><th></th></tr></thead><tbody>
  ${users.map((u) => `<tr data-id="${u.id}"><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td><select data-f="role" ${u.id === me.id ? 'disabled' : ''}>${Object.entries(ROLE_LABEL).map(([k, l]) => `<option value="${k}" ${k === u.role ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
  <td>${u.active ? 'Aktif' : 'Nonaktif'}</td><td class="row"><button class="btn small" data-x="token">API token</button>${u.id !== me.id ? `<button class="btn small" data-x="toggle">${u.active ? 'Nonaktifkan' : 'Aktifkan'}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
  <form id="nu" class="card stack" style="margin-top:14px"><h3>Tambah anggota</h3><div class="grid g2"><label>Nama<input name="name" required></label><label>Email<input name="email" type="email" required></label><label>Password (min 8)<input name="password" type="password" minlength="8" required></label><label>Peran<select name="role">${Object.entries(ROLE_LABEL).map(([k, l]) => `<option value="${k}" ${k === 'editor' ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div><div><button class="btn primary">Tambah</button></div></form>
  <div id="tok"></div>
  <div class="card" style="margin-top:14px"><h3>Aktivitas terakhir</h3><table><tbody>${audit.slice(0, 25).map((a) => `<tr><td class="small muted">${wib(a.ts)}</td><td>${esc(a.user_name || 'sistem')}</td><td>${esc(a.action)}</td></tr>`).join('')}</tbody></table></div>`;
  $('#nu').onsubmit = (e) => { e.preventDefault(); busy($('button', e.target), async () => { await api('POST', '/api/users', Object.fromEntries(new FormData(e.target))); toast('Anggota ditambahkan.'); route(); }); };
  v.onchange = (e) => { if (e.target.dataset.f === 'role') busy(e.target, async () => { await api('PUT', `/api/users/${e.target.closest('tr').dataset.id}`, { role: e.target.value }); toast('Peran diubah.'); }); };
  v.onclick = (e) => { const x = e.target.dataset.x; if (!x) return; const u = users.find((y) => y.id === e.target.closest('tr').dataset.id);
    busy(e.target, async () => {
      if (x === 'toggle') { await api('PUT', `/api/users/${u.id}`, { active: !u.active }); return route(); }
      if (x === 'token') { if (!(await ui.confirm({ title: `Buat API token untuk ${u.name}?`, message: 'Token lama (jika ada) langsung tidak berlaku. Token baru hanya ditampilkan sekali.', ok: 'Buat token' }))) return;
        const r = await api('POST', `/api/users/${u.id}/api-token`); $('#tok').innerHTML = `<div class="card stack" style="margin-top:14px"><h3>API token ${esc(u.name)}</h3><p class="small err">Salin sekarang, token tidak akan ditampilkan lagi.</p><pre>${esc(r.token)}</pre></div>`; }
    }); };
};

boot();
