import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/d1.mjs';
import { SESSION_COOKIE } from '../src/auth.js';
import { sha256Hex } from '../src/invitations.js';
import { MAX_BODY, handleApi, statusOf } from '../src/api.js';
import worker from '../src/index.js';

const NOW = new Date('2026-11-22T10:00:00Z');
const BASE = 'https://family-tree.test';
const TOK = { u1: 'a'.repeat(43), u2: 'b'.repeat(43), c1: 'c'.repeat(43), adm: 'd'.repeat(43) };

async function env() {
  const e = freshDb();
  e.sqlite.exec(`INSERT INTO accounts(id,email,email_verified,display_name) VALUES ('u1','u1@x.com',1,'U Satu'),('u2','u2@x.com',1,'U Dua'),('c1','c1@x.com',1,'Kontributor'),('adm','adm@x.com',1,'Admin')`);
  for (const [id, t] of Object.entries(TOK)) e.sqlite.prepare('INSERT INTO sessions(id,account_id,expires_at) VALUES (?,?,?)').run(await sha256Hex(t), id, '2099-01-01 00:00:00');
  e.cfg = { DB: e.db };
  return e;
}
const call = (e, path, { who = 'u1', method = 'GET', body, origin = BASE, type = 'application/json', raw } = {}) =>
  handleApi(new Request(`${BASE}${path}`, {
    method,
    headers: { ...(who ? { cookie: `${SESSION_COOKIE}=${TOK[who]}` } : {}), ...(origin ? { origin } : {}), ...(type ? { 'content-type': type } : {}) },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  }), e.cfg, { now: NOW });
const J = async (r) => ({ status: r.status, ...(await r.json()) });
const mkTree = async (e, who = 'u1') => (await J(await call(e, '/api/trees', { who, method: 'POST', body: { name: 'Keluarga Ahmad', selfName: 'Ahmad', selfGender: 'male' } })));
const change = (e, tid, body, who = 'u1') => call(e, `/api/trees/${tid}/changes`, { who, method: 'POST', body });

test('statusOf memetakan kode ke status HTTP', () => {
  assert.deepEqual(['forbidden', 'not_found', 'person_not_found', 'tree_limit', 'needs_proposal', 'would_create_cycle', 'name_required', 'invalid_payload'].map(statusOf), [403, 404, 404, 409, 409, 409, 400, 400]);
});

test('bukan jalur pohon: mengembalikan null; metode salah: 405 dengan Allow; semua butuh sesi', async () => {
  const e = await env();
  assert.equal(await call(e, '/api/me'), null);
  assert.equal(await call(e, '/api/treesx'), null);
  assert.equal((await call(e, '/api/trees', { method: 'DELETE' })).status, 405);
  assert.equal((await call(e, '/api/trees/x/changes', { method: 'GET' })).headers.get('allow'), 'POST');
  assert.equal((await call(e, '/api/trees/x/export', { method: 'POST' })).status, 405);
  for (const [p, m] of [['/api/trees', 'GET'], ['/api/trees', 'POST'], ['/api/trees/x', 'GET'], ['/api/trees/x/changes', 'POST'], ['/api/trees/x/export', 'GET']]) {
    const r = await call(e, p, { who: null, method: m, body: m === 'POST' ? {} : undefined });
    assert.deepEqual([r.status, (await r.json()).error], [401, 'unauthorized'], p);
  }
  const bad = await call(e, '/api/trees', { who: 'zzz' });
  assert.equal(bad.status, 401);
});

test('semua respons no-store; id bukan UUID tidak menyentuh database', async () => {
  const e = await env();
  for (const r of [await call(e, '/api/trees'), await call(e, '/api/trees/bukan-uuid'), await call(e, '/api/trees', { who: null })]) assert.equal(r.headers.get('cache-control'), 'no-store');
  const real = e.db.prepare;
  const log = [];
  e.db.prepare = (sql) => { log.push(sql); return real(sql); };
  const r = await J(await call(e, '/api/trees/..%2F..'));
  assert.deepEqual([r.status, r.code], [404, 'not_found']);
  assert.ok(log.every((s) => /sessions/.test(s)), 'hanya pencarian sesi yang boleh jalan');
});

test('CSRF: metode yang mengubah data wajib Origin sama dan isi JSON', async () => {
  const e = await env();
  const ok = { name: 'P', selfName: 'S' };
  for (const origin of ['https://evil.example', null, 'null']) assert.equal((await call(e, '/api/trees', { method: 'POST', body: ok, origin })).status, 403, String(origin));
  assert.equal((await call(e, '/api/trees', { method: 'POST', body: ok, type: 'text/plain' })).status, 415);
  assert.equal((await call(e, '/api/trees', { method: 'POST', body: ok, type: null })).status, 415);
  assert.equal(e.count('SELECT COUNT(*) n FROM family_trees'), 0);
  assert.equal((await call(e, '/api/trees', { method: 'POST', body: ok })).status, 201);
});

test('isi JSON: rusak, bukan objek, terlalu besar', async () => {
  const e = await env();
  for (const raw of ['{', '', 'null', '5', '[]', '"x"']) assert.deepEqual((await J(await call(e, '/api/trees', { method: 'POST', raw }))).code, 'invalid_json', JSON.stringify(raw));
  const big = JSON.stringify({ name: 'x'.repeat(MAX_BODY) });
  assert.equal((await call(e, '/api/trees', { method: 'POST', raw: big })).status, 413);
  assert.equal(e.count('SELECT COUNT(*) n FROM family_trees'), 0);
});

test('buat pohon lewat API: 201, lalu muncul di daftar; kedua kali 409 tree_limit; masukan salah 400', async () => {
  const e = await env();
  const r = await mkTree(e);
  assert.equal(r.status, 201);
  assert.deepEqual([r.ok, r.tree.name], [true, 'Keluarga Ahmad']);
  const l = await J(await call(e, '/api/trees'));
  assert.deepEqual(l.trees, [{ id: r.tree.id, name: 'Keluarga Ahmad', role: 'owner' }]);
  assert.deepEqual(await J(await call(e, '/api/trees', { method: 'POST', body: { name: 'Lagi', selfName: 'X' } })), { status: 409, ok: false, code: 'tree_limit' });
  assert.deepEqual(await J(await call(e, '/api/trees', { who: 'u2', method: 'POST', body: { name: '', selfName: 'X' } })), { status: 400, ok: false, code: 'name_required' });
  assert.deepEqual(await J(await call(e, '/api/trees', { who: 'u2' })), { status: 200, trees: [] });
});

test('isi pohon: anggota boleh, orang luar 403, id tidak ada 403, tidak ada data pohon lain', async () => {
  const e = await env();
  const a = await mkTree(e);
  const b = await mkTree(e, 'u2');
  const t = await J(await call(e, `/api/trees/${a.tree.id}`));
  assert.deepEqual([t.status, t.role, t.bootstrap, t.me], [200, 'owner', true, a.personId]);
  assert.equal(JSON.stringify(t).includes(b.tree.id), false);
  assert.equal((await call(e, `/api/trees/${a.tree.id}`, { who: 'u2' })).status, 403);
  assert.equal((await call(e, '/api/trees/00000000-0000-4000-8000-000000000000')).status, 403);
  assert.equal((await call(e, `/api/trees/${b.tree.id}`, { who: 'u1' })).status, 403);
});

test('mengisi pohon: orang baru, pasangan, orang tua placeholder, anak; semuanya muncul di pembacaan', async () => {
  const e = await env();
  const a = await mkTree(e);
  const tid = a.tree.id;
  const sp = await J(await change(e, tid, { kind: 'person_create', after: { display_name: 'Siti', gender: 'female', birth_date: '1965', birth_precision: 'year' } }));
  assert.deepEqual([sp.status, sp.ok], [200, true]);
  const pa = await J(await change(e, tid, { kind: 'partnership', after: { action: 'create', person_a: a.personId, person_b: sp.personId, status: 'married', start_year: 1986 } }));
  assert.equal(pa.ok, true);
  const ph = await J(await change(e, tid, { kind: 'parent_child', after: { action: 'create', child_id: a.personId, relation_type: 'biological', parent_role: 'father', new_person: { display_name: 'Ayah dari Ahmad', gender: 'male', is_placeholder: true } } }));
  assert.equal(ph.ok, true);
  const kid = await J(await change(e, tid, { kind: 'parent_child', after: { action: 'create', parent_id: a.personId, relation_type: 'biological', parent_role: 'father', new_person: { display_name: 'Rina' } } }));
  assert.equal(kid.ok, true);
  const t = await J(await call(e, `/api/trees/${tid}`));
  assert.deepEqual(t.people.map((p) => p.name).sort(), ['Ahmad', 'Ayah dari Ahmad', 'Rina', 'Siti']);
  assert.deepEqual(t.parentChild.map((x) => [x.parent, x.child, x.type, x.role]).sort(), [[a.personId, kid.personId, 'biological', 'father'], [ph.personId, a.personId, 'biological', 'father']].sort());
  assert.deepEqual(t.partnerships.map((x) => [x.a, x.b, x.status, x.startYear]), [[a.personId, sp.personId, 'married', 1986]]);
  assert.equal(t.people.find((p) => p.id === ph.personId).isPlaceholder, true);
  // isi identitas: nama placeholder diganti, penanda lepas, relasi tetap
  const fill = await J(await change(e, tid, { kind: 'person_edit', targetPersonId: ph.personId, after: { display_name: 'Slamet' } }));
  assert.deepEqual([fill.ok, fill.identityFilled], [true, true]);
  const t2 = await J(await call(e, `/api/trees/${tid}`));
  assert.equal(t2.people.find((p) => p.id === ph.personId).isPlaceholder, false);
  assert.equal(t2.parentChild.length, 2);
});

test('perubahan: kode galat dipetakan ke status (siklus 409, orang tidak ada 404, isi salah 400)', async () => {
  const e = await env();
  const a = await mkTree(e);
  const tid = a.tree.id;
  const k = await J(await change(e, tid, { kind: 'parent_child', after: { action: 'create', parent_id: a.personId, relation_type: 'biological', parent_role: 'father', new_person: { display_name: 'Anak' } } }));
  const cyc = await J(await change(e, tid, { kind: 'parent_child', after: { action: 'create', parent_id: k.personId, child_id: a.personId, relation_type: 'biological', parent_role: 'father' } }));
  assert.deepEqual([cyc.status, cyc.code], [409, 'would_create_cycle']);
  const dup = await J(await change(e, tid, { kind: 'parent_child', after: { action: 'create', parent_id: a.personId, child_id: k.personId, relation_type: 'adoptive', parent_role: 'father' } }));
  assert.deepEqual([dup.status, dup.code], [409, 'duplicate_edge']);
  const nf = await J(await change(e, tid, { kind: 'person_edit', targetPersonId: 'hantu', after: { nickname: 'x' } }));
  assert.deepEqual([nf.status, nf.code], [404, 'target_not_found']);
  const noRole = await J(await change(e, tid, { kind: 'parent_child', after: { action: 'create', parent_id: a.personId, child_id: k.personId, relation_type: 'biological' } }));
  assert.deepEqual([noRole.status, noRole.code], [400, 'invalid_parent_role']);
  const bad = await J(await change(e, tid, { kind: 'person_edit', targetPersonId: a.personId, after: { birth_visibility: 'full' } }));
  assert.deepEqual([bad.status, bad.code], [400, 'unknown_field']);
  assert.equal((await J(await change(e, tid, { kind: 'merge', after: {} }))).code, 'kind_not_supported');
  for (const body of [{}, { kind: 5 }, { kind: 'person_edit', targetPersonId: 5, after: {} }]) assert.equal((await J(await change(e, tid, body))).code, 'invalid_payload', JSON.stringify(body));
  assert.equal(e.count('SELECT COUNT(*) n FROM parent_child_edges'), 1);
});

test('perubahan: Contributor dan Viewer tidak bisa langsung; relasi setelah ada Admin kedua butuh usulan; orang luar 403', async () => {
  const e = await env();
  const a = await mkTree(e);
  const tid = a.tree.id;
  e.sqlite.exec(`INSERT INTO memberships(tree_id,account_id,role,status) VALUES ('${tid}','c1','contributor','active')`);
  assert.deepEqual(await J(await change(e, tid, { kind: 'person_create', after: { display_name: 'X' } }, 'c1')), { status: 409, ok: false, code: 'needs_proposal' });
  e.sqlite.exec(`UPDATE memberships SET role = 'viewer' WHERE account_id = 'c1'`);
  assert.equal((await J(await change(e, tid, { kind: 'person_create', after: { display_name: 'X' } }, 'c1'))).status, 403);
  assert.equal((await J(await change(e, tid, { kind: 'person_create', after: { display_name: 'X' } }, 'u2'))).status, 403);
  assert.equal(e.count("SELECT COUNT(*) n FROM people WHERE display_name = 'X'"), 0);
  const rel = { kind: 'parent_child', after: { action: 'create', parent_id: a.personId, relation_type: 'biological', parent_role: 'father', new_person: { display_name: 'Anak' } } };
  assert.equal((await J(await change(e, tid, rel))).ok, true); // Mode Penyusunan Awal
  e.sqlite.exec(`INSERT INTO memberships(tree_id,account_id,role,status) VALUES ('${tid}','adm','admin','active')`);
  assert.equal((await J(await change(e, tid, rel))).code, 'needs_proposal'); // sudah ada Admin kedua
  assert.equal((await J(await change(e, tid, { kind: 'person_create', after: { display_name: 'Langsung' } }))).ok, true); // orang tetap langsung
});

test('duplikat: kandidat mengikuti nama, Viewer ditolak, tahun tidak valid 400', async () => {
  const e = await env();
  const a = await mkTree(e);
  const tid = a.tree.id;
  const d = await J(await call(e, `/api/trees/${tid}/duplicates?name=ahmad`));
  assert.deepEqual([d.status, d.candidates.map((c) => c.id)], [200, [a.personId]]);
  assert.equal((await J(await call(e, `/api/trees/${tid}/duplicates?name=Zzz`))).total, 0);
  assert.equal((await J(await call(e, `/api/trees/${tid}/duplicates?name=ahmad&birth_year=abc`))).code, 'invalid_birth_year');
  assert.equal((await J(await call(e, `/api/trees/${tid}/duplicates`))).total, 0);
  e.sqlite.exec(`INSERT INTO memberships(tree_id,account_id,role,status) VALUES ('${tid}','c1','viewer','active')`);
  assert.equal((await call(e, `/api/trees/${tid}/duplicates?name=ahmad`, { who: 'c1' })).status, 403);
  assert.equal((await call(e, `/api/trees/${tid}/duplicates?name=ahmad`, { who: 'u2' })).status, 403);
});

test('ekspor: Owner mengunduh berkas, tercatat di audit; Contributor dan orang luar 403', async () => {
  const e = await env();
  const a = await mkTree(e);
  const tid = a.tree.id;
  const r = await call(e, `/api/trees/${tid}/export`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /^attachment; filename="family-tree-[0-9a-f]{8}\.json"$/);
  const doc = await r.json();
  assert.deepEqual([doc.format, doc.tree.name, doc.people.length], ['family-tree-export', 'Keluarga Ahmad', 1]);
  assert.equal(e.count("SELECT COUNT(*) n FROM audit_events WHERE action = 'export.run'"), 1);
  e.sqlite.exec(`INSERT INTO memberships(tree_id,account_id,role,status) VALUES ('${tid}','c1','contributor','active')`);
  assert.equal((await call(e, `/api/trees/${tid}/export`, { who: 'c1' })).status, 403);
  assert.equal((await call(e, `/api/trees/${tid}/export`, { who: 'u2' })).status, 403);
  assert.equal(e.count("SELECT COUNT(*) n FROM audit_events WHERE action = 'export.run'"), 1);
});

test('router utama: jalur pohon terpasang, health tetap jalan, jalur lain 404', async () => {
  const e = await env();
  const w = (path, init) => worker.fetch(new Request(`${BASE}${path}`, init), e.cfg);
  assert.equal((await w('/api/trees')).status, 401);
  assert.deepEqual(await (await w('/api/health')).json(), { ok: true, trees: 0 });
  assert.equal((await w('/api/lain')).status, 404);
  const r = await w('/api/trees', { headers: { cookie: `${SESSION_COOKIE}=${TOK.u1}` } });
  assert.deepEqual(await r.json(), { trees: [] });
});
