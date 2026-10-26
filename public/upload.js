(() => {
  const token = location.pathname.split('/').filter(Boolean)[1];
  const $ = (s) => document.querySelector(s);
  const msg = (t, bad) => { const m = $('#msg'); m.textContent = t; m.style.color = bad ? 'var(--bad)' : 'var(--ok, inherit)'; };
  const send = async (files) => {
    $('#drop').classList.add('busy');
    let done = 0;
    for (const f of files) {
      try {
        const r = await fetch(`/upload/${encodeURIComponent(token)}/file`, { method: 'POST', headers: { 'content-type': f.type, 'x-filename': encodeURIComponent(f.name) }, body: f });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { msg(`${f.name}: ${j.error || 'gagal diunggah'}`, true); continue; }
        done++;
        const d = document.createElement('div'); d.className = 'thumb';
        const isV = /^video\//.test(j.mime); const el = document.createElement(isV ? 'video' : 'img');
        el.src = j.url; if (isV) { el.muted = true; el.preload = 'metadata'; } else el.alt = f.name;
        d.append(el); $('#thumbs').append(d);
      } catch { msg(`${f.name}: koneksi terputus`, true); }
    }
    $('#drop').classList.remove('busy'); $('#file').value = '';
    if (done) msg(`${done} file terunggah. Kembali ke Claude dan tulis "sudah diunggah".`);
  };
  $('#drop').onclick = (e) => { if (e.target.id !== 'file') $('#file').click(); };
  $('#drop').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file').click(); } };
  $('#file').onchange = (e) => send([...e.target.files]);
  ['dragenter', 'dragover'].forEach((ev) => $('#drop').addEventListener(ev, (e) => { e.preventDefault(); $('#drop').classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => $('#drop').addEventListener(ev, (e) => { e.preventDefault(); $('#drop').classList.remove('over'); }));
  $('#drop').addEventListener('drop', (e) => send([...e.dataTransfer.files]));
})();
