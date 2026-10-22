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
const busy = async (btn, fn) => { btn.disabled = true; try { return await fn(); } catch (e) { toast(e.message, true); } finally { btn.disabled = false; } };
const params = () => new URLSearchParams((location.hash.split('?')[1] || ''));

/* ---------- auth ---------- */
function showLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); }
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); $('#loginErr').textContent = '';
  try { await api('POST', '/api/login', Object.fromEntries(new FormData(e.target))); await boot(); } catch (err) { $('#loginErr').textContent = err.message; }
});
$('#logout').addEventListener('click', async () => { await api('POST', '/api/logout'); showLogin(); });

/* ---------- routing ---------- */
const ROUTES = [
  ['dashboard', 'Dashboard', 'viewer'], ['compose', 'Tulis Post', 'editor'], ['queue', 'Antrean & Approval', 'viewer'],
  ['plan', 'Rencana Mingguan', 'editor'], ['inbox', 'Inbox Reply', 'editor'], ['insights', 'Insight', 'viewer'],
  ['brands', 'Brand & Akun', 'viewer'], ['claude', 'Hubungkan Claude', 'viewer'], ['control', 'Kontrol Claude', 'admin'], ['team', 'Tim', 'admin'],
];
const VIEWS = {};

async function boot() {
  try { me = await api('GET', '/api/me'); } catch { return showLogin(); }
  health = await fetch('/api/health').then((r) => r.json());
  brands = await api('GET', '/api/brands');
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#who').textContent = `${me.name} · ${me.role}`;
  $('#nav').innerHTML = ROUTES.filter((r) => can(r[2])).map((r) => `<a href="#/${r[0]}" data-r="${r[0]}">${r[1]}</a>`).join('');
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
  const v = $('#view'); v.onclick = v.onsubmit = v.onchange = null; v.innerHTML = '<p class="muted">Memuat…</p>';
  try { await VIEWS[r[0]](v); } catch (e) { v.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', route);

/* ---------- Dashboard ---------- */
VIEWS.dashboard = async (v) => {
  const d = await api('GET', '/api/dashboard');
  v.innerHTML = `<h1>Dashboard</h1><p class="muted">Ringkasan 4 akun Threads Delova.</p>
  <div class="grid g4">${d.brands.map((b) => {
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
      <label>Jadwal tayang (WIB)<input id="when" type="datetime-local" value="${toInput(post?.scheduled_at)}" /></label>
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
  $('#rc').value = post?.reply_control || '';
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
        <label>Tayang (WIB)<input type="datetime-local" class="w" value="${toInput(it.scheduled_at)}"></label>
        <textarea class="t">${esc(it.text)}</textarea><input class="tg" value="${esc(it.topic_tag || '')}" placeholder="topic tag"><span class="counter">${it.length}/500</span></div>`).join('') +
        `<div><button class="btn primary" id="saveall">Simpan yang dicentang sebagai draft</button></div>`;
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
VIEWS.brands = async (v) => {
  brands = await api('GET', '/api/brands');
  const cq = params().get('connect');
  if (cq) toast(cq === 'ok' ? 'Akun Threads berhasil terhubung.' : `Gagal menghubungkan: ${params().get('msg') || 'coba lagi'}`, cq !== 'ok');
  v.innerHTML = `<h1>Brand &amp; Akun</h1><p class="muted">Brand voice di sini dipakai Claude (di dashboard maupun via MCP) setiap menulis untuk akun tersebut.</p>
  <div class="grid g2">${brands.map((b) => `<form class="card stack bcard" style="--c:${b.color}" data-id="${b.id}">
    <div class="row between"><h2>${esc(b.name)}</h2>${b.connected ? `<span class="badge s-published">@${esc(b.username || '')}</span>` : '<span class="badge">Belum terhubung</span>'}</div>
    ${b.connected ? `<div class="small muted">Token berlaku s/d ${wib(b.token_expires_at)} (diperpanjang otomatis).</div>` : ''}
    <div class="row">${can('manager') && !b.connected ? `<a class="btn small primary" href="/auth/threads/start?brand=${b.id}">Hubungkan ke Threads</a>` : ''}${can('admin') && b.connected ? '<button type="button" class="btn small" data-x="refresh">Perpanjang token</button><button type="button" class="btn small danger" data-x="disc">Putuskan</button>' : ''}</div>
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
