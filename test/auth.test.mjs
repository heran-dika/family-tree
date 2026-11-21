import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/d1.mjs';
import { OAUTH_COOKIE, SESSION_COOKIE, SESSION_DAYS, getSession, handleAuth } from '../src/auth.js';
import { sha256Hex } from '../src/invitations.js';
import worker from '../src/index.js';

const NOW = new Date('2026-11-21T10:00:00Z');
const BASE = 'https://family-tree.test';
const CID = 'cid-123.apps.googleusercontent.com';
const SECRET = 'GOCSPX-super-secret-value';
const EXP = Math.floor(NOW.getTime() / 1000) + 3600;

function env(over = {}) {
  const e = freshDb();
  e.cfg = { DB: e.db, GOOGLE_CLIENT_ID: CID, GOOGLE_CLIENT_SECRET: SECRET, ...over };
  e.accounts = () => e.sqlite.prepare('SELECT * FROM accounts').all().map((r) => ({ ...r }));
  e.sessions = () => e.sqlite.prepare('SELECT * FROM sessions').all().map((r) => ({ ...r }));
  return e;
}
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const idToken = (c) => `${b64({ alg: 'RS256' })}.${b64(c)}.sig`;
const claims = (nonce, over = {}) => ({
  iss: 'https://accounts.google.com', aud: CID, exp: EXP, nonce, sub: 'g-1', email: 'Budi@X.com', email_verified: true, name: 'Budi Santoso', ...over,
});
const req = (path, { method = 'GET', cookie, origin } = {}) =>
  new Request(`${BASE}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) } });
const cookiesOf = (res) => res.headers.getSetCookie();
const find = (res, name) => cookiesOf(res).find((c) => c.startsWith(`${name}=`));
const val = (c) => c.split(';')[0].split('=').slice(1).join('=');
const blob = async (res) => JSON.stringify([...res.headers]) + (await res.clone().text());

// jalankan /api/auth/google, kembalikan state/nonce/verifier dan cookie yang dikirim browser
async function begin(e) {
  const res = await handleAuth(req('/api/auth/google'), e.cfg, { now: NOW });
  const loc = new URL(res.headers.get('location'));
  const ck = find(res, OAUTH_COOKIE);
  const [state, nonce, verifier] = val(ck).split('.');
  return { res, loc, state, nonce, verifier, cookie: `${OAUTH_COOKIE}=${val(ck)}` };
}
const mockFetch = (handler) => {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
  fn.calls = calls;
  return fn;
};
const okToken = (tokenFor) => mockFetch(async () => new Response(JSON.stringify({ id_token: tokenFor() }), { status: 200 }));
// login penuh: begin -> callback; over.claims mengubah isi token
async function login(e, over = {}) {
  const b = await begin(e);
  const f = over.fetchFn ?? okToken(() => idToken(claims(b.nonce, over.claims)));
  const q = over.query ?? `code=abc&state=${b.state}`;
  const res = await handleAuth(req(`/api/auth/callback?${q}`, { cookie: over.cookie === undefined ? b.cookie : over.cookie }), e.cfg, { now: NOW, fetchFn: f });
  return { res, b, f };
}
const reason = (res) => new URL(res.headers.get('location'), BASE).searchParams.get('auth_error');
const untouched = (e) => assert.deepEqual([e.accounts().length, e.sessions().length], [0, 0]);

test('config: hanya true/false, tidak pernah memuat nilai; tanpa konfigurasi login menolak dengan 503', async () => {
  const e = env();
  const r = await handleAuth(req('/api/auth/config'), e.cfg);
  assert.deepEqual(await r.clone().json(), { googleConfigured: true });
  assert.ok(!(await blob(r)).includes(SECRET));
  for (const cfg of [{ GOOGLE_CLIENT_SECRET: undefined }, { GOOGLE_CLIENT_ID: '' }, { GOOGLE_CLIENT_ID: 5 }]) {
    const x = env(cfg);
    assert.deepEqual(await (await handleAuth(req('/api/auth/config'), x.cfg)).json(), { googleConfigured: false });
    const s = await handleAuth(req('/api/auth/google'), x.cfg);
    assert.equal(s.status, 503);
    assert.equal((await s.json()).error, 'auth_not_configured');
    assert.equal((await handleAuth(req('/api/auth/callback?code=a&state=b'), x.cfg)).status, 503);
  }
});

test('mulai login: pengalihan ke Google dengan state, nonce, PKCE S256, dan redirect_uri sesuai alamat situs', async () => {
  const e = env();
  const b = await begin(e);
  assert.equal(b.res.status, 302);
  assert.equal(b.loc.origin + b.loc.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const p = b.loc.searchParams;
  assert.deepEqual(
    { c: p.get('client_id'), r: p.get('redirect_uri'), t: p.get('response_type'), s: p.get('scope'), m: p.get('code_challenge_method'), pr: p.get('prompt') },
    { c: CID, r: `${BASE}/api/auth/callback`, t: 'code', s: 'openid email profile', m: 'S256', pr: 'select_account' }
  );
  assert.equal(p.get('state'), b.state);
  assert.equal(p.get('nonce'), b.nonce);
  const want = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(b.verifier))).toString('base64url');
  assert.equal(p.get('code_challenge'), want);
  assert.ok(!b.loc.href.includes(b.verifier) && !b.loc.href.includes(SECRET));
  const ck = find(b.res, OAUTH_COOKIE);
  assert.match(ck, /; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/);
  const b2 = await begin(e);
  assert.notEqual(b2.state, b.state);
  assert.notEqual(b2.verifier, b.verifier);
  assert.equal(b.verifier.length, 43);
  assert.equal((await handleAuth(req('/api/auth/google', { method: 'POST' }), e.cfg)).status, 405);
});

test('callback sukses (akun baru): akun dibuat huruf kecil, sesi tersimpan sebagai hash, cookie aman, tukar kode memakai PKCE', async () => {
  const e = env();
  const { res, b, f } = await login(e);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/');
  const [a] = e.accounts();
  assert.deepEqual({ email: a.email, v: a.email_verified, sub: a.google_sub, n: a.display_name, lang: a.language }, { email: 'budi@x.com', v: 1, sub: 'g-1', n: 'Budi Santoso', lang: 'id' });
  const token = val(find(res, SESSION_COOKIE));
  assert.match(find(res, SESSION_COOKIE), new RegExp(`; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}$`));
  assert.match(find(res, OAUTH_COOKIE), /Max-Age=0$/);
  const [s] = e.sessions();
  assert.deepEqual([s.id, s.account_id, s.expires_at], [await sha256Hex(token), a.id, '2026-12-21 10:00:00']);
  assert.ok(!JSON.stringify([e.accounts(), e.sessions()]).includes(token), 'token mentah tersimpan');
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.equal(call.url, 'https://oauth2.googleapis.com/token');
  assert.equal(call.init.method, 'POST');
  const body = Object.fromEntries(call.init.body);
  assert.deepEqual(body, { client_id: CID, client_secret: SECRET, code: 'abc', code_verifier: b.verifier, redirect_uri: `${BASE}/api/auth/callback`, grant_type: 'authorization_code' });
  const out = await blob(res);
  for (const leak of [SECRET, token, b.verifier]) assert.ok(!out.replace(find(res, SESSION_COOKIE), '').includes(leak), 'bocor');
});

test('login berikutnya memakai akun yang sama (cocok lewat sub, walau email di Google berubah)', async () => {
  const e = env();
  await login(e);
  await login(e);
  assert.equal(e.accounts().length, 1);
  assert.equal(e.sessions().length, 2);
  await login(e, { claims: { email: 'baru@x.com' } });
  assert.equal(e.accounts().length, 1);
  assert.equal(e.accounts()[0].email, 'budi@x.com');
});

test('menaut ke akun yang sudah ada: hanya bila emailnya terverifikasi, tanpa akun ganda; email huruf besar cocok', async () => {
  const e = env();
  e.sqlite.exec("INSERT INTO accounts(id,email,email_verified) VALUES ('u1','budi@x.com',1)");
  const r = await login(e);
  assert.equal(r.res.headers.get('location'), '/');
  assert.deepEqual(e.accounts().map((a) => [a.id, a.google_sub]), [['u1', 'g-1']]);
  assert.equal(e.sessions()[0].account_id, 'u1');

  const u = env();
  u.sqlite.exec("INSERT INTO accounts(id,email,email_verified) VALUES ('u2','budi@x.com',0)");
  const r2 = await login(u);
  assert.equal(reason(r2.res), 'account_unverified');
  assert.deepEqual([u.accounts()[0].google_sub, u.sessions().length], [null, 0]);
  assert.equal(find(r2.res, SESSION_COOKIE), undefined);

  const c = env();
  c.sqlite.exec("INSERT INTO accounts(id,email,email_verified,google_sub) VALUES ('u3','budi@x.com',1,'orang-lain')");
  const r3 = await login(c);
  assert.equal(reason(r3.res), 'account_conflict');
  assert.deepEqual([c.accounts()[0].google_sub, c.sessions().length], ['orang-lain', 0]);
});

test('state atau cookie tidak cocok: ditolak sebelum menghubungi Google, tidak ada akun dan sesi', async () => {
  const e = env();
  const cases = [
    { cookie: '' },
    { cookie: `${OAUTH_COOKIE}=a.b` },
    { cookie: `${OAUTH_COOKIE}=a.b.c.d` },
    { query: 'code=abc&state=salah' },
    { query: 'code=abc' },
    { query: 'code=abc&state=' },
  ];
  for (const c of cases) {
    const f = mockFetch(async () => { throw new Error('tidak boleh dipanggil'); });
    const { res } = await login(e, { ...c, fetchFn: f });
    assert.equal(reason(res), 'state_invalid', JSON.stringify(c));
    assert.equal(f.calls.length, 0);
    assert.match(find(res, OAUTH_COOKIE), /Max-Age=0$/);
  }
  untouched(e);
});

test('Google mengembalikan error atau tanpa kode', async () => {
  const e = env();
  const b = await begin(e);
  const go = (q) => handleAuth(req(`/api/auth/callback?${q}`, { cookie: b.cookie }), e.cfg, { now: NOW, fetchFn: okToken(() => 'x') });
  assert.equal(reason(await go(`error=access_denied&state=${b.state}`)), 'access_denied');
  assert.equal(reason(await go(`error=server_error&state=${b.state}`)), 'google_error');
  assert.equal(reason(await go(`state=${b.state}`)), 'missing_code');
  untouched(e);
});

test('ID token yang tidak valid ditolak: aud, iss, kedaluwarsa, nonce, sub, email, bentuk rusak', async () => {
  const bad = [
    ['aud salah', { aud: 'lain' }],
    ['aud larik tanpa kita', { aud: ['lain', 'x'] }],
    ['iss salah', { iss: 'https://evil.example' }],
    ['kedaluwarsa', { exp: EXP - 7200 }],
    ['exp persis sekarang', { exp: Math.floor(NOW.getTime() / 1000) }],
    ['exp bukan angka', { exp: String(EXP) }],
    ['nonce salah', { nonce: 'nonce-lain' }],
    ['tanpa sub', { sub: undefined }],
    ['sub kosong', { sub: '' }],
    ['tanpa email', { email: undefined }],
    ['email rusak', { email: 'bukan-email' }],
    ['email terlalu panjang', { email: `${'x'.repeat(250)}@x.com` }],
  ];
  for (const [label, over] of bad) {
    const e = env();
    const r = await login(e, { claims: over });
    assert.equal(reason(r.res), 'invalid_id_token', label);
    untouched(e);
  }
  for (const [label, over] of [['aud larik berisi kita', { aud: ['lain', CID] }], ['iss tanpa skema', { iss: 'accounts.google.com' }], ['verified teks "true"', { email_verified: 'true' }]]) {
    const e = env();
    assert.equal((await login(e, { claims: over })).res.headers.get('location'), '/', label);
  }
  const e = env();
  const un = await login(e, { claims: { email_verified: false } });
  assert.equal(reason(un.res), 'email_not_verified');
  assert.equal((await login(e, { claims: { email_verified: undefined } })).res.status, 302);
  assert.equal(reason((await login(e, { claims: { email_verified: undefined } })).res), 'email_not_verified');
  untouched(e);
  for (const raw of ['', 'a.b', 'a.b.c.d', `x.${b64('bukan json')}.s`, `x.${b64('null')}.s`, `x.${b64('5')}.s`, 'x.@@@.s']) {
    const x = env();
    const r = await login(x, { fetchFn: okToken(() => raw) });
    assert.equal(reason(r.res), 'invalid_id_token', JSON.stringify(raw));
    untouched(x);
  }
});

test('tukar kode gagal: status bukan 2xx, jaringan error, atau tanpa id_token', async () => {
  for (const f of [
    mockFetch(async () => new Response('{"error":"invalid_grant"}', { status: 400 })),
    mockFetch(async () => { throw new Error('jaringan putus'); }),
    mockFetch(async () => new Response('bukan json', { status: 200 })),
  ]) {
    const e = env();
    const r = await login(e, { fetchFn: f });
    assert.equal(reason(r.res), 'token_exchange_failed');
    assert.ok(!(await blob(r.res)).includes(SECRET));
    untouched(e);
  }
  const e = env();
  assert.equal(reason((await login(e, { fetchFn: mockFetch(async () => new Response('{}', { status: 200 })) })).res), 'invalid_id_token');
  untouched(e);
});

test('nama tampilan: dibersihkan, dipotong 200 karakter, cadangan dari awalan email', async () => {
  const e = env();
  await login(e, { claims: { name: '  Budi    Santoso  ' } });
  assert.equal(e.accounts()[0].display_name, 'Budi Santoso');
  const f = env();
  await login(f, { claims: { name: 'x'.repeat(300) } });
  assert.equal(f.accounts()[0].display_name.length, 200);
  for (const name of [undefined, '   ', 5]) {
    const g = env();
    await login(g, { claims: { name } });
    assert.equal(g.accounts()[0].display_name, 'budi', String(name));
  }
});

test('/api/me: tanpa cookie, token acak, token diubah, dan sesi kedaluwarsa ditolak; sesi sah mengembalikan akun tanpa field internal', async () => {
  const e = env();
  const { res } = await login(e);
  const token = val(find(res, SESSION_COOKIE));
  const me = (cookie, now = NOW, method = 'GET') => handleAuth(req('/api/me', { cookie, method }), e.cfg, { now });
  assert.equal((await me()).status, 401);
  assert.equal((await me(`${SESSION_COOKIE}=${'a'.repeat(43)}`)).status, 401);
  assert.equal((await me(`${SESSION_COOKIE}=${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`)).status, 401);
  assert.equal((await me(`${SESSION_COOKIE}=`)).status, 401);
  assert.equal((await me(`lain=${token}`)).status, 401);
  assert.equal((await me(`${SESSION_COOKIE}=${'a'.repeat(300)}`)).status, 401);
  const ok = await me(`a=1; ${SESSION_COOKIE}=${token}; b=2`);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.deepEqual(Object.keys(body.account).sort(), ['displayName', 'email', 'id', 'language', 'textSize']);
  assert.deepEqual([body.account.email, body.account.displayName, body.account.textSize], ['budi@x.com', 'Budi Santoso', 100]);
  assert.equal((await me(`${SESSION_COOKIE}=${token}`, new Date('2026-12-21T10:00:00Z'))).status, 401); // tepat 30 hari
  assert.equal((await me(`${SESSION_COOKIE}=${token}`, new Date('2026-12-21T09:59:59Z'))).status, 200);
  assert.equal((await me(`${SESSION_COOKIE}=${token}`, NOW, 'POST')).status, 405);
  assert.equal(await getSession(e.db, req('/x'), NOW), null);
});

test('logout: sesi itu dihapus dan cookie dibersihkan, sesi lain tetap; GET dan lintas-origin ditolak', async () => {
  const e = env();
  const t1 = val(find((await login(e)).res, SESSION_COOKIE));
  const t2 = val(find((await login(e)).res, SESSION_COOKIE));
  const out = (cookie, o) => handleAuth(req('/api/auth/logout', { method: 'POST', cookie, origin: o }), e.cfg, { now: NOW });
  assert.equal((await handleAuth(req('/api/auth/logout', { cookie: `${SESSION_COOKIE}=${t1}` }), e.cfg)).status, 405);
  assert.equal((await out(`${SESSION_COOKIE}=${t1}`, 'https://evil.example')).status, 403);
  assert.equal(e.sessions().length, 2);
  const r = await out(`${SESSION_COOKIE}=${t1}`, BASE);
  assert.equal(r.status, 200);
  assert.match(find(r, SESSION_COOKIE), /Max-Age=0$/);
  assert.equal(e.sessions().length, 1);
  const me = (t) => handleAuth(req('/api/me', { cookie: `${SESSION_COOKIE}=${t}` }), e.cfg, { now: NOW });
  assert.equal((await me(t1)).status, 401);
  assert.equal((await me(t2)).status, 200);
  assert.equal((await out(undefined)).status, 200); // tanpa cookie tidak error
  assert.equal(e.sessions().length, 1);
});

test('login membersihkan sesi kedaluwarsa milik akun itu saja', async () => {
  const e = env();
  e.sqlite.exec(`
    INSERT INTO accounts(id,email,email_verified,google_sub) VALUES ('u1','budi@x.com',1,'g-1'),('u2','lain@x.com',1,'g-2');
    INSERT INTO sessions(id,account_id,expires_at) VALUES ('old1','u1','2026-11-01 00:00:00'),('live1','u1','2027-01-01 00:00:00'),('old2','u2','2026-11-01 00:00:00');
  `);
  await login(e);
  assert.deepEqual(e.sessions().map((s) => s.id).filter((i) => ['old1', 'live1', 'old2'].includes(i)).sort(), ['live1', 'old2']);
  assert.equal(e.sessions().length, 3);
});

test('balapan dua login pertama: yang kalah mencari ulang akun yang baru dibuat, tanpa akun ganda', async () => {
  const e = env();
  const real = e.db.prepare;
  let done = false;
  e.db.prepare = (sql) => {
    if (!done && /^INSERT INTO accounts/.test(sql)) {
      done = true;
      e.sqlite.exec("INSERT INTO accounts(id,email,email_verified,google_sub) VALUES ('menang','budi@x.com',1,'g-1')");
    }
    return real(sql);
  };
  const r = await login(e);
  assert.equal(r.res.headers.get('location'), '/');
  assert.deepEqual(e.accounts().map((a) => a.id), ['menang']);
  assert.deepEqual(e.sessions().map((s) => s.account_id), ['menang']);
});

test('cookie OAuth dengan jumlah bagian salah ditolak walau state-nya cocok', async () => {
  const e = env();
  const b = await begin(e);
  for (const ck of [`${b.state}.${b.nonce}`, `${b.state}.${b.nonce}.${b.verifier}.x`, `${b.state}`]) {
    const f = mockFetch(async () => { throw new Error('tidak boleh dipanggil'); });
    const { res } = await login(e, { cookie: `${OAUTH_COOKIE}=${ck}`, query: `code=abc&state=${b.state}`, fetchFn: f });
    assert.equal(reason(res), 'state_invalid', ck);
    assert.equal(f.calls.length, 0);
  }
  untouched(e);
});

test('balapan saat menautkan: bila akun keburu ditautkan ke Google lain, tidak ada sesi dan tautan tidak ditimpa', async () => {
  const e = env();
  e.sqlite.exec("INSERT INTO accounts(id,email,email_verified) VALUES ('u1','budi@x.com',1)");
  const real = e.db.prepare;
  e.db.prepare = (sql) => {
    if (/^UPDATE accounts SET google_sub/.test(sql)) e.sqlite.exec("UPDATE accounts SET google_sub = 'orang-lain' WHERE id = 'u1'");
    return real(sql);
  };
  const r = await login(e);
  assert.equal(reason(r.res), 'account_conflict');
  assert.equal(find(r.res, SESSION_COOKIE), undefined);
  assert.deepEqual([e.accounts()[0].google_sub, e.sessions().length], ['orang-lain', 0]);
});

test('rahasia tidak pernah muncul di respons mana pun, termasuk yang gagal', async () => {
  const e = env();
  const outs = [];
  outs.push(await handleAuth(req('/api/auth/config'), e.cfg));
  outs.push((await begin(e)).res);
  outs.push((await login(e)).res);
  outs.push((await login(e, { claims: { aud: 'x' } })).res);
  outs.push((await login(e, { fetchFn: mockFetch(async () => new Response('x', { status: 500 })) })).res);
  outs.push((await login(e, { cookie: '' })).res);
  for (const r of outs) assert.ok(!(await blob(r)).includes(SECRET));
});

test('router: kesehatan tetap jalan, auth terpasang, jalur lain 404, tanpa cache', async () => {
  const e = env();
  const call = (path, method = 'GET') => worker.fetch(new Request(`${BASE}${path}`, { method }), e.cfg);
  assert.deepEqual(await (await call('/api/health')).json(), { ok: true, trees: 0 });
  assert.deepEqual(await (await call('/api/auth/config')).json(), { googleConfigured: true });
  const me = await call('/api/me');
  assert.equal(me.status, 401);
  assert.equal(me.headers.get('cache-control'), 'no-store');
  assert.equal((await call('/api/auth/google')).status, 302);
  assert.equal((await call('/api/auth/google')).headers.get('cache-control'), 'no-store');
  const nf = await call('/api/tidak-ada');
  assert.equal(nf.status, 404);
  assert.deepEqual(await nf.json(), { error: 'not_found' });
  assert.equal((await call('/api/auth/logout')).status, 405);
});
