// Login Google (OAuth 2.0 Authorization Code + PKCE) dan sesi.
// Alur: /api/auth/google -> Google -> /api/auth/callback -> cookie sesi -> /
// Sesi: token acak 256 bit di cookie HttpOnly; hanya hash SHA-256 yang disimpan di tabel sessions (migrasi 0007).
// ID token TIDAK diverifikasi tanda tangannya: diterima langsung dari endpoint token Google lewat TLS, yang dibolehkan
// OIDC Core 3.1.3.7. Claim iss, aud, exp, nonce, sub, dan email_verified tetap diperiksa. Jangan pakai fungsi ini untuk
// token yang datang dari browser.
//
// Aturan penting:
//  - Email disimpan HURUF KECIL (undangan membandingkan lower(email), dan UNIQUE di SQLite peka huruf).
//  - Akun yang sudah ada dengan email sama hanya ditautkan ke Google bila emailnya sudah terverifikasi (tidak membuat akun ganda).
//  - Rahasia (client secret, token) tidak pernah masuk ke respons, URL, atau log.

import { newToken, sha256Hex } from './invitations.js';
import { newId, sqlTime } from './audit.js';

export const SESSION_COOKIE = '__Host-ft_session';
export const OAUTH_COOKIE = '__Host-ft_oauth';
export const SESSION_DAYS = 30; // [Menebak]
export const OAUTH_TTL = 600;
export const APP_PATH = '/app'; // tujuan setelah login = public/app.html (Workers Assets melayani file .html tanpa ekstensi; /app.html dialihkan 307 ke /app)
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const DAY = 86400000;

const HEAD = { 'cache-control': 'no-store' };
const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...HEAD, ...extra } });

export const configured = (env) => Boolean(env?.GOOGLE_CLIENT_ID && env?.GOOGLE_CLIENT_SECRET && typeof env.GOOGLE_CLIENT_ID === 'string' && typeof env.GOOGLE_CLIENT_SECRET === 'string');

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function b64urlDecode(s) {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(t + '='.repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0));
}
const challengeOf = async (verifier) => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
const same = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

function cookieOf(request, name) {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
const setCookie = (name, value, maxAge) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const redirect = (location, cookies = []) => {
  const h = new Headers({ location, ...HEAD });
  for (const c of cookies) h.append('set-cookie', c);
  return new Response(null, { status: 302, headers: h });
};
const failTo = (reason) => redirect(`${APP_PATH}?auth_error=${reason}`, [setCookie(OAUTH_COOKIE, '', 0)]);

// ---- mulai login ----
async function start(request, env) {
  if (!configured(env)) return json({ error: 'auth_not_configured' }, 503);
  const url = new URL(request.url);
  const state = newToken();
  const nonce = newToken();
  const verifier = newToken();
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${url.origin}/api/auth/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: await challengeOf(verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return redirect(`${AUTH_URL}?${q}`, [setCookie(OAUTH_COOKIE, `${state}.${nonce}.${verifier}`, OAUTH_TTL)]);
}

// ---- ID token ----
function readIdToken(idToken, { clientId, nonce, now }) {
  if (typeof idToken !== 'string') return null;
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  let c;
  try { c = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]))); } catch { return null; }
  if (c === null || typeof c !== 'object') return null;
  if (!ISSUERS.includes(c.iss)) return null;
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(clientId)) return null;
  if (typeof c.exp !== 'number' || c.exp <= now.getTime() / 1000) return null;
  if (!same(c.nonce, nonce)) return null;
  if (typeof c.sub !== 'string' || !c.sub || c.sub.length > 255) return null;
  if (typeof c.email !== 'string' || c.email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(c.email)) return null;
  const name = typeof c.name === 'string' ? c.name.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  return { sub: c.sub, email: c.email.trim().toLowerCase(), verified: c.email_verified === true || c.email_verified === 'true', name };
}

// ---- akun dan sesi ----
const ACC = 'SELECT id, email_verified, google_sub FROM accounts WHERE ';
async function login(db, g, now, attempt = 0) {
  let acc = await db.prepare(`${ACC}google_sub = ?1`).bind(g.sub).first();
  let link = false;
  if (!acc) {
    acc = await db.prepare(`${ACC}email = ?1`).bind(g.email).first();
    if (acc) {
      if (!acc.email_verified) return { ok: false, reason: 'account_unverified' };
      if (acc.google_sub && acc.google_sub !== g.sub) return { ok: false, reason: 'account_conflict' };
      link = true;
    }
  }
  const token = newToken();
  const accountId = acc?.id ?? newId();
  const at = sqlTime(now);
  const stmts = [];
  if (!acc) {
    stmts.push(db.prepare('INSERT INTO accounts (id, email, email_verified, google_sub, display_name) VALUES (?1, ?2, 1, ?3, ?4)')
      .bind(accountId, g.email, g.sub, g.name || g.email.split('@')[0]));
  } else if (link) {
    stmts.push(db.prepare('UPDATE accounts SET google_sub = ?2 WHERE id = ?1 AND google_sub IS NULL').bind(accountId, g.sub));
  }
  stmts.push(db.prepare('DELETE FROM sessions WHERE account_id = ?1 AND expires_at <= ?2').bind(accountId, at));
  // Sesi hanya dibuat bila akun itu benar-benar tertaut ke sub Google ini (menjaga dari balapan saat menautkan).
  stmts.push(db.prepare('INSERT INTO sessions (id, account_id, expires_at) SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ?2 AND google_sub = ?4)')
    .bind(await sha256Hex(token), accountId, sqlTime(new Date(now.getTime() + SESSION_DAYS * DAY)), g.sub));
  let res;
  try {
    res = await db.batch(stmts);
  } catch (e) {
    // dua login pertama yang berbalapan: yang kalah mencari ulang akun yang baru dibuat
    if (attempt < 1 && /UNIQUE/i.test(String(e?.message))) return login(db, g, now, attempt + 1);
    throw e;
  }
  if (res[res.length - 1].meta.changes !== 1) return { ok: false, reason: 'account_conflict' };
  return { ok: true, token };
}

async function callback(request, env, { now, fetchFn }) {
  if (!configured(env)) return json({ error: 'auth_not_configured' }, 503);
  const url = new URL(request.url);
  const saved = (cookieOf(request, OAUTH_COOKIE) ?? '').split('.');
  const state = url.searchParams.get('state');
  if (saved.length !== 3 || !same(saved[0], state)) return failTo('state_invalid');
  const err = url.searchParams.get('error');
  if (err) return failTo(err === 'access_denied' ? 'access_denied' : 'google_error');
  const code = url.searchParams.get('code');
  if (!code) return failTo('missing_code');

  let idToken;
  try {
    const res = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, code, code_verifier: saved[2],
        redirect_uri: `${url.origin}/api/auth/callback`, grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return failTo('token_exchange_failed');
    idToken = (await res.json())?.id_token;
  } catch {
    return failTo('token_exchange_failed');
  }
  const g = readIdToken(idToken, { clientId: env.GOOGLE_CLIENT_ID, nonce: saved[1], now });
  if (!g) return failTo('invalid_id_token');
  if (!g.verified) return failTo('email_not_verified');
  const r = await login(env.DB, g, now);
  if (!r.ok) return failTo(r.reason);
  return redirect(APP_PATH, [setCookie(OAUTH_COOKIE, '', 0), setCookie(SESSION_COOKIE, r.token, SESSION_DAYS * 86400)]);
}

// ---- sesi berjalan ----
export async function getSession(db, request, now = new Date()) {
  const token = cookieOf(request, SESSION_COOKIE);
  if (!token || token.length < 20 || token.length > 200) return null;
  const row = await db
    .prepare('SELECT a.id, a.email, a.display_name, a.language, a.text_size FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.id = ?1 AND s.expires_at > ?2')
    .bind(await sha256Hex(token), sqlTime(now))
    .first();
  return row ? { id: row.id, email: row.email, displayName: row.display_name, language: row.language, textSize: row.text_size } : null;
}

async function logout(request, env) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return json({ error: 'forbidden' }, 403);
  const token = cookieOf(request, SESSION_COOKIE);
  if (token && token.length >= 20 && token.length <= 200) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?1').bind(await sha256Hex(token)).run();
  }
  return json({ ok: true }, 200, { 'set-cookie': setCookie(SESSION_COOKIE, '', 0) });
}

// Mengembalikan Response bila path ini milik auth, null bila bukan.
export async function handleAuth(request, env, { now = new Date(), fetchFn = globalThis.fetch } = {}) {
  const { pathname } = new URL(request.url);
  const m = request.method;
  const only = (method, fn) => (m === method ? fn() : json({ error: 'method_not_allowed' }, 405, { allow: method }));
  switch (pathname) {
    case '/api/auth/config': return only('GET', () => json({ googleConfigured: configured(env) }));
    case '/api/auth/google': return only('GET', () => start(request, env));
    case '/api/auth/callback': return only('GET', () => callback(request, env, { now, fetchFn }));
    case '/api/auth/logout': return only('POST', () => logout(request, env));
    case '/api/me': return only('GET', async () => {
      const a = await getSession(env.DB, request, now);
      return a ? json({ account: a }) : json({ error: 'unauthorized' }, 401);
    });
    default: return null;
  }
}
