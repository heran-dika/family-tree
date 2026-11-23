import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/d1.mjs';
import { SESSION_COOKIE } from '../src/auth.js';
import { sha256Hex } from '../src/invitations.js';
import { handleApi, statusOf } from '../src/api.js';

const NOW = new Date('2026-11-23T10:00:00Z');
const BASE = 'https://family-tree.test';
const TOK = { own: 'a'.repeat(43), ani: 'b'.repeat(43), vin: 'c'.repeat(43), oth: 'd'.repeat(43) };

async function env() {
  const e = freshDb();
  e.sqlite.exec(`INSERT INTO accounts(id,email,email_verified,display_name) VALUES ('own','own@x.com',1,'Pemilik'),('ani','ani@x.com',1,'Ani'),('vin','vin@x.com',1,'Vina'),('oth','oth@x.com',1,'Lain')`);
  for (const [id, t] of Object.entries(TOK)) e.sqlite.prepare('INSERT INTO sessions(id,account_id,expires_at) VALUES (?,?,?)').run(await sha256Hex(t), id, '2099-01-01 00:00:00');
  e.cfg = { DB: e.db };
  return e;
}
const call = (e, path, { who = 'own', method = 'GET', body, origin = BASE } = {}) =>
  handleApi(new Request(`${BASE}${path}`, {
    method,
    headers: { ...(who ? { cookie: `${SESSION_COOKIE}=${TOK[who]}` } : {}), ...(origin ? { origin } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), e.cfg, { now: NOW });
const J = async (r) => ({ status: r.status, ...(await r.json()) });
const mkTree = async (e) => (await J(await call(e, '/api/trees', { method: 'POST', body: { name: 'Keluarga Ahmad', selfName: 'Ahmad' } }))).tree.id;
const mkCode = async (e, tid) => (await J(await call(e, `/api/trees/${tid}/access-code`, { method: 'POST', body: undefined }))).code;

test('statusOf: kode jalur bergabung', () => {
  assert.deepEqual(['invalid_code', 'already_member', 'already_pending', 'too_many_pending', 'request_limit', 'join_failed', 'not_pending', 'invalid_role', 'message_too_long', 'forbidden'].map(statusOf), [404, 409, 409, 409, 409, 409, 409, 400, 400, 403]);
});

test('semua rute baru butuh sesi, metode benar, dan Origin sama untuk POST', async () => {
  const e = await env();
  const tid = await mkTree(e);
  const paths = [['GET', `/api/trees/${tid}/access-code`], ['POST', `/api/trees/${tid}/access-code`], ['POST', `/api/trees/${tid}/access-code/revoke`], ['GET', `/api/trees/${tid}/join-requests`], ['POST', `/api/trees/${tid}/join-requests/${tid}`], ['POST', '/api/join/lookup'], ['POST', '/api/join'], ['GET', '/api/join/mine']];
  for (const [m, p] of paths) {
    const r = await call(e, p, { who: null, method: m, body: m === 'POST' ? {} : undefined });
    assert.deepEqual([r.status, (await r.json()).error], [401, 'unauthorized'], `${m} ${p}`);
  }
  for (const [m, p] of paths.filter(([m]) => m === 'POST')) {
    for (const origin of ['https://evil.example', null]) assert.equal((await call(e, p, { method: m, body: {}, origin })).status, 403, `${p} ${origin}`);
  }
  const wrong = [['POST', `/api/trees/${tid}/join-requests`], ['GET', '/api/join'], ['GET', '/api/join/lookup'], ['POST', '/api/join/mine'], ['GET', `/api/trees/${tid}/access-code/revoke`], ['DELETE', `/api/trees/${tid}/access-code`]];
  for (const [m, p] of wrong) assert.equal((await call(e, p, { method: m })).status, 405, `${m} ${p}`);
  assert.equal(await call(e, '/api/join/lain'), null);
  assert.equal(await call(e, `/api/trees/${tid}/access-code/lain`), null);
  assert.equal((await call(e, `/api/trees/bukan-uuid/access-code`)).status, 404);
  assert.equal((await call(e, `/api/trees/${tid}/join-requests/bukan-uuid`, { method: 'POST', body: { action: 'reject' } })).status, 404);
});

test('alur lengkap: Owner membuat tautan, Ani melihat nama pohon, mengajukan, Owner menyetujui, Ani membaca pohon', async () => {
  const e = await env();
  const tid = await mkTree(e);
  assert.deepEqual(await J(await call(e, `/api/trees/${tid}/access-code`)), { status: 200, ok: true, active: false, createdAt: null });
  const made = await J(await call(e, `/api/trees/${tid}/access-code`, { method: 'POST' }));
  assert.deepEqual([made.status, made.ok, typeof made.code], [201, true, 'string']);
  assert.deepEqual(Object.keys(made).sort(), ['code', 'ok', 'status']);
  const st = await J(await call(e, `/api/trees/${tid}/access-code`));
  assert.deepEqual([st.active, typeof st.createdAt], [true, 'string']);
  assert.deepEqual(Object.keys(st).sort(), ['active', 'createdAt', 'ok', 'status']);
  assert.ok(!JSON.stringify(st).includes(made.code), 'status tidak boleh membawa kode mentah');

  const look = await J(await call(e, '/api/join/lookup', { who: 'ani', method: 'POST', body: { code: made.code } }));
  assert.deepEqual(look, { status: 200, ok: true, treeName: 'Keluarga Ahmad', managers: ['Pemilik'] });
  const req = await J(await call(e, '/api/join', { who: 'ani', method: 'POST', body: { code: made.code, message: 'Saya sepupu Ahmad' } }));
  assert.deepEqual([req.status, req.ok, req.treeName], [201, true, 'Keluarga Ahmad']);
  assert.equal((await call(e, `/api/trees/${tid}`, { who: 'ani' })).status, 403); // belum anggota

  const mine = await J(await call(e, '/api/trees', { who: 'ani' }));
  assert.deepEqual([mine.trees, mine.pending.map((p) => p.treeName)], [[], ['Keluarga Ahmad']]);
  assert.deepEqual((await J(await call(e, '/api/join/mine', { who: 'ani' }))).requests.map((p) => p.treeName), ['Keluarga Ahmad']);

  const list = await J(await call(e, `/api/trees/${tid}/join-requests`));
  assert.deepEqual(list.requests.map((r) => [r.name, r.email, r.message]), [['Ani', 'ani@x.com', 'Saya sepupu Ahmad']]);
  const okr = await call(e, `/api/trees/${tid}/join-requests/${list.requests[0].id}`, { method: 'POST', body: { action: 'approve', role: 'contributor' } });
  assert.equal(okr.status, 200);
  assert.deepEqual(await okr.json(), { ok: true, status: 'approved' });

  const t = await J(await call(e, `/api/trees/${tid}`, { who: 'ani' }));
  assert.deepEqual([t.status, t.role, t.bootstrap], [200, 'contributor', true]);
  const home = await J(await call(e, '/api/trees', { who: 'ani' }));
  assert.deepEqual([home.trees.map((x) => [x.name, x.role]), home.pending], [[['Keluarga Ahmad', 'contributor']], []]);
});

test('hak: hanya Owner mengelola kode; Owner/Admin menangani permintaan; Contributor/Viewer/orang luar ditolak', async () => {
  const e = await env();
  const tid = await mkTree(e);
  const code = await mkCode(e, tid);
  e.sqlite.exec(`INSERT INTO memberships(tree_id,account_id,role,status) VALUES ('${tid}','vin','viewer','active')`);
  for (const who of ['vin', 'ani', 'oth']) {
    assert.equal((await call(e, `/api/trees/${tid}/access-code`, { who })).status, 403, who);
    assert.equal((await call(e, `/api/trees/${tid}/access-code`, { who, method: 'POST' })).status, 403, who);
    assert.equal((await call(e, `/api/trees/${tid}/access-code/revoke`, { who, method: 'POST' })).status, 403, who);
    assert.equal((await call(e, `/api/trees/${tid}/join-requests`, { who })).status, 403, who);
  }
  await call(e, '/api/join', { who: 'ani', method: 'POST', body: { code } });
  const rid = (await J(await call(e, `/api/trees/${tid}/join-requests`))).requests[0].id;
  for (const who of ['vin', 'oth']) assert.equal((await call(e, `/api/trees/${tid}/join-requests/${rid}`, { who, method: 'POST', body: { action: 'approve', role: 'viewer' } })).status, 403, who);
  assert.equal(e.count("SELECT COUNT(*) n FROM memberships WHERE account_id = 'ani'"), 0);
});

test('mencabut tautan: lookup dan ajukan sesudahnya 404; permintaan yang sudah masuk tetap menunggu', async () => {
  const e = await env();
  const tid = await mkTree(e);
  const code = await mkCode(e, tid);
  await call(e, '/api/join', { who: 'ani', method: 'POST', body: { code } });
  assert.deepEqual(await J(await call(e, `/api/trees/${tid}/access-code/revoke`, { method: 'POST' })), { status: 200, ok: true });
  assert.deepEqual(await J(await call(e, '/api/join/lookup', { who: 'vin', method: 'POST', body: { code } })), { status: 404, ok: false, code: 'invalid_code' });
  assert.equal((await call(e, '/api/join', { who: 'vin', method: 'POST', body: { code } })).status, 404);
  assert.equal((await J(await call(e, `/api/trees/${tid}/join-requests`))).requests.length, 1);
  assert.equal((await call(e, `/api/trees/${tid}/access-code/revoke`, { method: 'POST' })).status, 404);
});

test('kode baru mengganti: tautan lama langsung mati', async () => {
  const e = await env();
  const tid = await mkTree(e);
  const a = await mkCode(e, tid);
  const b = await mkCode(e, tid);
  assert.equal((await call(e, '/api/join/lookup', { who: 'ani', method: 'POST', body: { code: a } })).status, 404);
  assert.equal((await call(e, '/api/join/lookup', { who: 'ani', method: 'POST', body: { code: b } })).status, 200);
});

test('galat jalur bergabung: kode kosong 404, pesan terlalu panjang 400, ganda 409, sudah anggota 409', async () => {
  const e = await env();
  const tid = await mkTree(e);
  const code = await mkCode(e, tid);
  assert.equal((await call(e, '/api/join/lookup', { who: 'ani', method: 'POST', body: {} })).status, 404);
  assert.equal((await call(e, '/api/join', { who: 'ani', method: 'POST', body: { code, message: 'x'.repeat(201) } })).status, 400);
  assert.equal((await call(e, '/api/join', { who: 'own', method: 'POST', body: { code } })).status, 409); // Owner sudah anggota
  assert.equal((await call(e, '/api/join', { who: 'ani', method: 'POST', body: { code } })).status, 201);
  assert.deepEqual(await J(await call(e, '/api/join', { who: 'ani', method: 'POST', body: { code } })), { status: 409, ok: false, code: 'already_pending' });
  const rid = (await J(await call(e, `/api/trees/${tid}/join-requests`))).requests[0].id;
  assert.equal((await J(await call(e, `/api/trees/${tid}/join-requests/${rid}`, { method: 'POST', body: { action: 'approve', role: 'admin' } }))).code, 'invalid_role');
  assert.equal((await J(await call(e, `/api/trees/${tid}/join-requests/${rid}`, { method: 'POST', body: { action: 'approve', role: 'viewer' } }))).ok, true);
  assert.equal((await J(await call(e, `/api/trees/${tid}/join-requests/${rid}`, { method: 'POST', body: { action: 'reject' } }))).code, 'not_pending');
  assert.equal((await call(e, '/api/join', { who: 'ani', method: 'POST', body: { code } })).status, 409); // sekarang anggota
});

test('setelah disetujui sebagai Viewer: bisa membaca tetapi tidak bisa mengubah; ekspor dan kode tertutup', async () => {
  const e = await env();
  const tid = await mkTree(e);
  const code = await mkCode(e, tid);
  await call(e, '/api/join', { who: 'ani', method: 'POST', body: { code } });
  const rid = (await J(await call(e, `/api/trees/${tid}/join-requests`))).requests[0].id;
  await call(e, `/api/trees/${tid}/join-requests/${rid}`, { method: 'POST', body: { action: 'approve', role: 'viewer' } });
  assert.equal((await call(e, `/api/trees/${tid}`, { who: 'ani' })).status, 200);
  assert.equal((await call(e, `/api/trees/${tid}/changes`, { who: 'ani', method: 'POST', body: { kind: 'person_create', after: { display_name: 'X' } } })).status, 403);
  assert.equal((await call(e, `/api/trees/${tid}/export`, { who: 'ani' })).status, 403);
  assert.equal((await call(e, `/api/trees/${tid}/access-code`, { who: 'ani', method: 'POST' })).status, 403);
  assert.equal(e.count("SELECT COUNT(*) n FROM people WHERE display_name = 'X'"), 0);
});
