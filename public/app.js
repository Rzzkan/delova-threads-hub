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
  check: '<path d="M20 6 9 17l-5-5"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>', send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
};
const ico = (n, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n] || ''}</svg>`;
// [id, label, peran minimal, grup]
const ROUTES = [
  ['dashboard', 'Dashboard', 'viewer', 'Menu'], ['compose', 'Tulis Post', 'editor', 'Menu'], ['queue', 'Antrean & Approval', 'viewer', 'Menu'],
  ['plan', 'Rencana Mingguan', 'editor', 'Menu'], ['inbox', 'Inbox Reply', 'editor', 'Menu'], ['insights', 'Insight', 'viewer', 'Menu'],
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
      <label>URL gambar/video (opsional, satu per baris, HTTPS publik; 2+ = carousel)<textarea id="media" style="min-height:64px">${esc((post?.media_urls || []).join('\n'))}</textarea></label>
      <div class="grid g2">
        <label>Topic tag (opsional)<input id="tag" value="${esc(post?.topic_tag || '')}" placeholder="mis. KebayaModern" /></label>
        <label>Siapa boleh reply<select id="rc"><option value="">Semua orang</option><option value="accounts_you_follow">Akun yang kami ikuti</option><option value="mentioned_only">Hanya yang di-mention</option><option value="followers_only">Followers</option></select></label>
      </div>
      <label>Jadwal tayang (WIB)<input id="when" class="dtp" value="${toInput(post?.scheduled_at)}" placeholder="Pilih tanggal &amp; jam" /></label>
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
      if (!confirm('Publish sekarang ke Threads?')) return;
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
  <div class="card" style="margin-top:12px"><table><thead><tr><th>Akun</th><th>Isi</th><th>Jadwal / Terbit</th><th>Status</th><th></th></tr></thead><tbody>
  ${rows.map((p) => `<tr data-id="${p.id}"><td><b style="color:${brandOf(p.brand_id).color}">${esc(brandOf(p.brand_id).name)}</b><div class="small muted">${esc(p.author || '')}${p.source === 'claude' ? ' · via Claude' : p.source === 'ai' ? ' · AI' : ''}</div></td>
    <td>${esc(p.text.slice(0, 140))}${p.text.length > 140 ? '…' : ''}${p.error ? `<div class="err small">${esc(p.error)}</div>` : ''}${p.review_note ? `<div class="small muted">Catatan: ${esc(p.review_note)}</div>` : ''}</td>
    <td class="small">${wib(p.published_at || p.scheduled_at)}</td><td>${badge(p.status)}</td>
    <td><div class="row">${actions(p)}</div></td></tr>`).join('') || '<tr><td colspan="5" class="muted">Belum ada post.</td></tr>'}
  </tbody></table></div>`;
  const go = () => { location.hash = `#/queue?brand=${$('#fb').value}&status=${$('#fs').value}`; };
  $('#fb').onchange = go; $('#fs').onchange = go;
  v.onclick = async (e) => {
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const id = btn.closest('tr').dataset.id; const act = btn.dataset.act;
    await busy(btn, async () => {
      if (act === 'edit') return (location.hash = `#/compose?edit=${id}`);
      if (act === 'delete' && !confirm('Hapus post ini?')) return;
      if (act === 'now' && !confirm('Publish sekarang ke Threads?')) return;
      let payload;
      if (act === 'reject') payload = { note: prompt('Catatan untuk penulis (opsional):') || '' };
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
        if (a === 'send') { const t = $('.rt', card).value.trim(); if (!t) throw new Error('Tulis balasan dulu.'); if (!confirm('Kirim balasan ini ke Threads?')) return; await api('POST', `/api/brands/${id}/replies/${x.reply.id}/reply`, { text: t }); toast('Balasan terkirim.'); $('.rt', card).value = ''; }
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
    ${can('manager') ? '<div><button class="btn primary" type="submit">Simpan brand</button></div>' : ''}</form>`).join('')}</div>`;
  v.onsubmit = (e) => { e.preventDefault(); const f = e.target; const d = Object.fromEntries(new FormData(f)); d.pillars = d.pillars.split('\n').map((s) => s.trim()).filter(Boolean);
    busy($('button[type=submit]', f), async () => { await api('PUT', `/api/brands/${f.dataset.id}`, d); toast('Brand tersimpan.'); }); };
  v.onclick = (e) => { const x = e.target.dataset.x; if (!x) return; const id = e.target.closest('form').dataset.id;
    if (x === 'perm') return checkPerm(e.target, id, brands.find((y) => y.id === id));
    busy(e.target, async () => { if (x === 'refresh') await api('POST', `/api/brands/${id}/refresh-token`); if (x === 'disc') { if (!confirm('Putuskan koneksi akun ini?')) return; await api('DELETE', `/api/brands/${id}/connection`); } toast('Berhasil.'); route(); }); };
};

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
      await api('PUT', '/api/settings/claude', { claude_enabled: g('claude_enabled'), can_create: g('can_create'), can_approve: g('can_approve'), can_publish: g('can_publish'), can_reply: g('can_reply'), daily_create_cap: f.elements.daily_create_cap.value });
      toast('Kontrol Claude disimpan.'); route();
    });
  };
  v.onclick = (e) => {
    if (e.target.id === 'revall') busy(e.target, async () => { if (!confirm('Putuskan semua sesi Claude?')) return; await api('DELETE', '/api/claude/sessions'); toast('Semua sesi diputus.'); route(); });
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
    if (e.target.id === 'gclear') busy(e.target, async () => { if (!confirm('Hapus kredensial global? Akun yang sudah terhubung tetap jalan, tetapi tidak bisa menghubungkan akun baru.')) return; await api('PUT', '/api/settings/meta', { clear: true, mode: 'sim' }); toast('Kredensial global dihapus.'); route(); });
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
    if (a === 'del') return busy(e.target, async () => { if (!confirm('Hapus riset tersimpan ini?')) return; await api('DELETE', `/api/research/saves/${e.target.closest('[data-sid]').dataset.sid}`); route(); });
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
    if (a === 'reply') return busy(e.target, async () => { const t = prompt(`Balasan untuk @${m.username} (maks 500 karakter):`); if (!t || !t.trim()) return; await api('POST', `/api/mentions/${encodeURIComponent(id)}/reply`, { text: t.trim() }); toast('Balasan terkirim.'); route(); });
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
    if (a === 'del') return busy(e.target, async () => { if (!confirm(`Hapus @${c.username} dari daftar?`)) return; await api('DELETE', `/api/creators/${id}`); route(); });
    if (a === 'ai') return busy(e.target, async () => {
      const offer = prompt('Tawaran yang boleh disebut dalam pesan (kosongkan untuk "produk gratis untuk dicoba"):') ?? '';
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
      if (x === 'token') { if (!confirm(`Buat API token baru untuk ${u.name}? Token lama (jika ada) tidak berlaku lagi.`)) return;
        const r = await api('POST', `/api/users/${u.id}/api-token`); $('#tok').innerHTML = `<div class="card stack" style="margin-top:14px"><h3>API token ${esc(u.name)}</h3><p class="small err">Salin sekarang, token tidak akan ditampilkan lagi.</p><pre>${esc(r.token)}</pre></div>`; }
    }); };
};

boot();
