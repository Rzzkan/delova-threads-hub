/**
 * OAuth 2.1 (Authorization Code + PKCE S256, Dynamic Client Registration) untuk konektor MCP kustom
 * di claude.ai / Claude Desktop. Pengguna login dengan akun Hub yang sudah ada; peran (role) akun itu
 * menentukan apa yang boleh dilakukan Claude, dan admin bisa membatasinya lagi di "Kontrol Claude".
 */
import crypto from 'node:crypto';
import * as C from './crypto.js';
import { all, get, run, now, uid, audit } from './db.js';

export const baseUrl = () => (process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const SCOPE = 'mcp';
const ACCESS_TTL = 60 * 60 * 1000; // 1 jam
const REFRESH_TTL = 30 * 24 * 60 * 60 * 1000; // 30 hari

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeEq = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const okRedirect = (u) => {
  try {
    const x = new URL(u);
    if (x.hash) return false;
    if (x.protocol === 'https:') return true;
    if (x.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname);
    return !['javascript:', 'data:', 'file:', 'vbscript:', 'blob:'].includes(x.protocol); // skema kustom aplikasi desktop
  } catch {
    return false;
  }
};

const STYLE = `body{margin:0;min-height:100vh;display:grid;place-items:center;background:#faf6f1;color:#2b211d;font:15px/1.5 system-ui,sans-serif;padding:16px}
main{background:#fff;border:1px solid #eadfd6;border-radius:16px;padding:28px;width:min(440px,100%);display:grid;gap:12px}
.logo{width:48px;height:48px;border-radius:13px;background:#8a4b38;color:#fff;display:grid;place-items:center;font:700 26px Georgia,serif}
h1{margin:0;font-size:1.3rem}p{margin:0}.m{color:#7b6d66;font-size:.88rem}ul{margin:0;padding-left:1.2em}
label{display:grid;gap:4px;font-weight:600;font-size:.88rem}input{font:inherit;padding:9px 11px;border:1px solid #eadfd6;border-radius:10px}
.row{display:flex;gap:10px}button{flex:1;font:inherit;font-weight:600;padding:10px;border-radius:10px;border:1px solid #8a4b38;background:#fff;color:#8a4b38;cursor:pointer}
button.p{background:#8a4b38;color:#fff}.e{color:#b83a3a}`;

const page = (title, body) => `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main><div class="logo">D</div>${body}</main></body></html>`;

function sendPage(res, status, html) {
  res.status(status).set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" }).send(html);
}

const loginForm = (back, error = '') => `<h1>Masuk ke Social Hub</h1><p class="m">Masuk untuk menghubungkan Claude ke akun Hub Anda.</p>
<form method="post" action="/oauth/login" style="display:grid;gap:10px"><input type="hidden" name="back" value="${esc(back)}">
<label>Email<input name="email" type="email" required autocomplete="username"></label>
<label>Password<input name="password" type="password" required autocomplete="current-password"></label>
<p class="e">${esc(error)}</p><div class="row"><button class="p">Masuk</button></div></form>`;

const consentForm = (client, user, ticket) => `<h1>Izinkan akses Claude?</h1>
<p><b>${esc(client.name)}</b> ingin terhubung ke Social Hub sebagai <b>${esc(user.name)}</b> (peran: ${esc(user.role)}).</p>
<p class="m">Claude akan bisa:</p>
<ul><li>Membaca brand voice, antrean, insight, dan reply</li><li>Membuat draft dan mengajukan approval</li><li>Aksi lain (setujui, publish, balas komentar) hanya bila peran Anda mengizinkan <b>dan</b> admin mengaktifkannya di menu Kontrol Claude</li></ul>
<p class="m">Anda bisa mencabut akses kapan saja lewat admin (Kontrol Claude → Sesi).</p>
<form method="post" action="/oauth/consent"><input type="hidden" name="ticket" value="${esc(ticket)}">
<div class="row"><button name="action" value="deny" type="submit">Tolak</button><button class="p" name="action" value="allow" type="submit">Izinkan</button></div></form>`;

function redirectError(res, redirectUri, state, error, desc) {
  const u = new URL(redirectUri);
  u.searchParams.set('error', error);
  if (desc) u.searchParams.set('error_description', desc);
  if (state) u.searchParams.set('state', state);
  res.redirect(u.toString());
}

/**
 * @param app express app
 * @param ctx { sessionUser(req) -> user|null, login(req,email,password) -> {user}|{error,status}, setCookie(res,user) }
 */
export function mountOAuth(app, { sessionUser, login, setCookie }) {
  const cors = (req, res, next) => {
    res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, authorization, mcp-protocol-version', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  };
  app.use(['/.well-known', '/oauth/token', '/oauth/register'], cors);

  /* ----- Discovery ----- */
  const resourceMeta = (req, res) =>
    res.json({ resource: `${baseUrl()}/mcp`, authorization_servers: [baseUrl()], bearer_methods_supported: ['header'], scopes_supported: [SCOPE], resource_name: 'Social Hub' });
  app.get('/.well-known/oauth-protected-resource', resourceMeta);
  app.get('/.well-known/oauth-protected-resource/mcp', resourceMeta);
  app.get('/.well-known/oauth-authorization-server', (req, res) =>
    res.json({
      issuer: baseUrl(),
      authorization_endpoint: `${baseUrl()}/oauth/authorize`,
      token_endpoint: `${baseUrl()}/oauth/token`,
      registration_endpoint: `${baseUrl()}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [SCOPE],
    }),
  );

  /* ----- Dynamic Client Registration ----- */
  app.post('/oauth/register', (req, res) => {
    const b = req.body || {};
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
    if (!uris.length || uris.length > 10 || !uris.every(okRedirect)) {
      return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris tidak valid' });
    }
    if (get('SELECT COUNT(*) AS n FROM oauth_clients').n >= 500) {
      run(`DELETE FROM oauth_clients WHERE created_at < ? AND client_id NOT IN (SELECT client_id FROM oauth_tokens)`, new Date(Date.now() - 86_400_000).toISOString());
      if (get('SELECT COUNT(*) AS n FROM oauth_clients').n >= 500) return res.status(429).json({ error: 'temporarily_unavailable' });
    }
    const id = C.randomToken('dthc');
    const name = String(b.client_name || 'Aplikasi MCP').slice(0, 80);
    run('INSERT INTO oauth_clients(client_id,name,redirect_uris,created_at) VALUES (?,?,?,?)', id, name, JSON.stringify(uris), now());
    res.status(201).json({
      client_id: id, client_name: name, redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      token_endpoint_auth_method: 'none', client_id_issued_at: Math.floor(Date.now() / 1000),
    });
  });

  /* ----- Authorize (login + consent) ----- */
  app.get('/oauth/authorize', (req, res) => {
    const q = req.query;
    const client = get('SELECT * FROM oauth_clients WHERE client_id=?', String(q.client_id || ''));
    if (!client) return sendPage(res, 400, page('Error', '<h1>Aplikasi tidak dikenal</h1><p class="m">client_id tidak terdaftar.</p>'));
    const ru = String(q.redirect_uri || '');
    if (!JSON.parse(client.redirect_uris).includes(ru)) return sendPage(res, 400, page('Error', '<h1>Redirect URI tidak cocok</h1><p class="m">Permintaan ditolak demi keamanan.</p>'));
    const state = q.state ? String(q.state) : '';
    if (q.response_type !== 'code') return redirectError(res, ru, state, 'unsupported_response_type');
    if (!q.code_challenge || q.code_challenge_method !== 'S256') return redirectError(res, ru, state, 'invalid_request', 'PKCE S256 wajib');

    const user = sessionUser(req);
    if (!user) return sendPage(res, 200, page('Masuk', loginForm(req.originalUrl)));
    const ticket = C.sign({ k: 'oauth', cid: client.client_id, ru, ch: String(q.code_challenge), st: state, uid: user.id }, 600);
    sendPage(res, 200, page('Izinkan akses', consentForm(client, user, ticket)));
  });

  app.post('/oauth/login', (req, res) => {
    const back = String(req.body?.back || '');
    if (!back.startsWith('/oauth/authorize?')) return sendPage(res, 400, page('Error', '<h1>Permintaan tidak valid</h1>'));
    const r = login(req, String(req.body.email || ''), String(req.body.password || ''));
    if (r.error) return sendPage(res, r.status, page('Masuk', loginForm(back, r.error)));
    setCookie(res, r.user);
    res.redirect(back);
  });

  app.post('/oauth/consent', (req, res) => {
    const p = C.verify(String(req.body?.ticket || ''));
    const user = sessionUser(req);
    if (!p || p.k !== 'oauth') return sendPage(res, 400, page('Error', '<h1>Permintaan kedaluwarsa</h1><p class="m">Ulangi dari aplikasi Claude.</p>'));
    if (!user || user.id !== p.uid) return sendPage(res, 403, page('Error', '<h1>Sesi tidak cocok</h1><p class="m">Masuk ulang lalu coba lagi.</p>'));
    if (req.body.action !== 'allow') return redirectError(res, p.ru, p.st, 'access_denied', 'Pengguna menolak');
    const code = C.randomToken('dthcode');
    run('INSERT INTO oauth_codes(code_hash,client_id,user_id,redirect_uri,challenge,expires_at) VALUES (?,?,?,?,?,?)', C.sha256(code), p.cid, user.id, p.ru, p.ch, Date.now() + 5 * 60_000);
    audit(user.id, 'oauth.authorized', { client_id: p.cid });
    const u = new URL(p.ru);
    u.searchParams.set('code', code);
    if (p.st) u.searchParams.set('state', p.st);
    res.redirect(u.toString());
  });

  /* ----- Token ----- */
  function issue(res, userId, clientId, reuseId) {
    const access = C.randomToken('dtho');
    const refresh = C.randomToken('dthr');
    const t = Date.now();
    if (reuseId) {
      run('UPDATE oauth_tokens SET access_hash=?, refresh_hash=?, access_expires=?, refresh_expires=? WHERE id=?', C.sha256(access), C.sha256(refresh), t + ACCESS_TTL, t + REFRESH_TTL, reuseId);
    } else {
      run('INSERT INTO oauth_tokens(id,access_hash,refresh_hash,user_id,client_id,access_expires,refresh_expires,created_at) VALUES (?,?,?,?,?,?,?,?)', uid(), C.sha256(access), C.sha256(refresh), userId, clientId, t + ACCESS_TTL, t + REFRESH_TTL, now());
    }
    run('DELETE FROM oauth_tokens WHERE refresh_expires < ?', t);
    run('DELETE FROM oauth_codes WHERE expires_at < ?', t);
    res.json({ access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope: SCOPE });
  }

  app.post('/oauth/token', (req, res) => {
    res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
    const b = req.body || {};
    const fail = (error, error_description, status = 400) => res.status(status).json({ error, error_description });
    const client = get('SELECT * FROM oauth_clients WHERE client_id=?', String(b.client_id || ''));
    if (!client) return fail('invalid_client', 'client_id tidak dikenal', 401);

    if (b.grant_type === 'authorization_code') {
      const row = get('SELECT * FROM oauth_codes WHERE code_hash=?', C.sha256(String(b.code || '')));
      if (row) run('DELETE FROM oauth_codes WHERE code_hash=?', row.code_hash); // sekali pakai
      if (!row || row.expires_at < Date.now() || row.client_id !== client.client_id || row.redirect_uri !== b.redirect_uri) return fail('invalid_grant', 'Kode tidak valid atau kedaluwarsa');
      const verifier = String(b.code_verifier || '');
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      if (verifier.length < 43 || !safeEq(challenge, row.challenge)) return fail('invalid_grant', 'Verifikasi PKCE gagal');
      if (!get('SELECT 1 AS x FROM users WHERE id=? AND active=1', row.user_id)) return fail('invalid_grant', 'Akun nonaktif');
      return issue(res, row.user_id, client.client_id);
    }

    if (b.grant_type === 'refresh_token') {
      const t = get('SELECT * FROM oauth_tokens WHERE refresh_hash=?', C.sha256(String(b.refresh_token || '')));
      if (!t || t.client_id !== client.client_id || t.refresh_expires < Date.now()) return fail('invalid_grant', 'Refresh token tidak valid');
      if (!get('SELECT 1 AS x FROM users WHERE id=? AND active=1', t.user_id)) {
        run('DELETE FROM oauth_tokens WHERE id=?', t.id);
        return fail('invalid_grant', 'Akun nonaktif');
      }
      return issue(res, t.user_id, t.client_id, t.id); // rotasi: refresh lama langsung tidak berlaku
    }
    fail('unsupported_grant_type', 'Gunakan authorization_code atau refresh_token');
  });
}
