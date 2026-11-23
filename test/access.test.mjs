import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/d1.mjs';
import { getMembership } from '../src/db.js';
import { sha256Hex } from '../src/invitations.js';
import {
  MAX_MESSAGE, MAX_PENDING_PER_ACCOUNT, MAX_PENDING_PER_TREE, accessCodeStatus, createAccessCode, decideJoinRequest,
  listJoinRequests, lookupAccessCode, myJoinRequests, requestJoin, revokeAccessCode,
} from '../src/access.js';

const T0 = new Date('2026-11-23T10:00:00Z');

function env() {
  const e = freshDb();
  e.sqlite.exec(`
    INSERT INTO accounts(id,email,email_verified,display_name) VALUES
      ('owner','o@x.com',1,'Ahmad Owner'),('admin','a@x.com',1,'Budi Admin'),('contrib','c@x.com',1,'Citra'),('viewer','v@x.com',1,'Vina'),
      ('ani','ani@x.com',1,'Ani'),('bima','bima@x.com',1,NULL),('unv','unv@x.com',0,'Belum Verif'),('oth','oth@x.com',1,'Orang Lain');
    INSERT INTO family_trees(id,name,created_by) VALUES ('t1','Keluarga Satu','owner'),('t2','Keluarga Dua','oth');
    INSERT INTO memberships(tree_id,account_id,role,status) VALUES
      ('t1','owner','owner','active'),('t1','admin','admin','active'),('t1','contrib','contributor','active'),('t1','viewer','viewer','active'),
      ('t2','oth','owner','active');
  `);
  e.mem = (tree, acc) => e.sqlite.prepare('SELECT role, status FROM memberships WHERE tree_id = ? AND account_id = ?').get(tree, acc);
  e.req = (id) => e.sqlite.prepare('SELECT * FROM join_requests WHERE id = ?').get(id);
  e.audits = (a) => e.count('SELECT COUNT(*) n FROM audit_events WHERE action = ?', a);
  return e;
}
const mkCode = async (e, over = {}) => { const r = await createAccessCode(e.db, { treeId: 't1', actorId: 'owner', now: T0, ...over }); assert.equal(r.ok, true, JSON.stringify(r)); return r.code; };
const join = (e, code, accountId = 'ani', message) => requestJoin(e.db, { code, accountId, message, now: T0 });
const decide = (e, rid, action = 'approve', role = 'viewer', who = 'owner', treeId = 't1') => decideJoinRequest(e.db, { treeId, requestId: rid, deciderId: who, action, role, now: T0 });
const pending = async (e, account = 'ani', code) => { const r = await join(e, code ?? (await mkCode(e)), account); assert.equal(r.ok, true, JSON.stringify(r)); return r.requestId; };

test('buat kode: hanya Owner; hanya hash yang disimpan; audit tanpa kode mentah', async () => {
  const e = env();
  for (const who of ['admin', 'contrib', 'viewer', 'ani', 'nope']) assert.deepEqual(await createAccessCode(e.db, { treeId: 't1', actorId: who, now: T0 }), { ok: false, code: 'forbidden' }, who);
  assert.equal(e.count('SELECT COUNT(*) n FROM tree_access_codes'), 0);
  const code = await mkCode(e);
  assert.ok(code.length >= 40 && /^[A-Za-z0-9_-]+$/.test(code));
  const row = e.sqlite.prepare('SELECT * FROM tree_access_codes').get();
  assert.deepEqual([row.tree_id, row.created_by, row.revoked_at, row.code_hash], ['t1', 'owner', null, await sha256Hex(code)]);
  const dump = JSON.stringify([e.sqlite.prepare('SELECT * FROM tree_access_codes').all(), e.sqlite.prepare('SELECT * FROM audit_events').all()]);
  assert.ok(!dump.includes(code), 'kode mentah tersimpan');
  assert.equal(e.audits('access_code.create'), 1);
});

test('kode baru mengganti yang lama: kode lama mati, hanya satu aktif', async () => {
  const e = env();
  const a = await mkCode(e);
  const b = await mkCode(e);
  assert.notEqual(a, b);
  assert.equal((await lookupAccessCode(e.db, { code: a })).code, 'invalid_code');
  assert.equal((await lookupAccessCode(e.db, { code: b })).ok, true);
  assert.equal(e.count('SELECT COUNT(*) n FROM tree_access_codes WHERE revoked_at IS NULL'), 1);
  assert.equal(e.count('SELECT COUNT(*) n FROM tree_access_codes'), 2);
});

test('status kode: hanya Owner; mencabut menutup, mencabut lagi 404, audit sekali', async () => {
  const e = env();
  assert.deepEqual(await accessCodeStatus(e.db, { treeId: 't1', actorId: 'owner' }), { ok: true, active: false, createdAt: null });
  const code = await mkCode(e);
  const st = await accessCodeStatus(e.db, { treeId: 't1', actorId: 'owner' });
  assert.deepEqual([st.ok, st.active, typeof st.createdAt], [true, true, 'string']);
  for (const who of ['admin', 'viewer', 'ani']) { assert.equal((await accessCodeStatus(e.db, { treeId: 't1', actorId: who })).code, 'forbidden', who); assert.equal((await revokeAccessCode(e.db, { treeId: 't1', actorId: who, now: T0 })).code, 'forbidden', who); }
  assert.deepEqual(await revokeAccessCode(e.db, { treeId: 't1', actorId: 'owner', now: T0 }), { ok: true });
  assert.equal((await lookupAccessCode(e.db, { code })).code, 'invalid_code');
  assert.equal((await accessCodeStatus(e.db, { treeId: 't1', actorId: 'owner' })).active, false);
  assert.equal((await revokeAccessCode(e.db, { treeId: 't1', actorId: 'owner', now: T0 })).code, 'not_found');
  assert.equal(e.audits('access_code.revoke'), 1);
});

test('isolasi pohon: Owner pohon lain tidak bisa membuat, melihat, atau mencabut kode pohon ini', async () => {
  const e = env();
  await mkCode(e);
  assert.equal((await createAccessCode(e.db, { treeId: 't1', actorId: 'oth', now: T0 })).code, 'forbidden');
  assert.equal((await accessCodeStatus(e.db, { treeId: 't1', actorId: 'oth' })).code, 'forbidden');
  assert.equal((await revokeAccessCode(e.db, { treeId: 't1', actorId: 'oth', now: T0 })).code, 'forbidden');
  assert.equal(e.count('SELECT COUNT(*) n FROM tree_access_codes WHERE revoked_at IS NULL'), 1);
});

test('lookup: hanya nama pohon dan nama tampilan pengelola, tanpa email; kode tidak dikenal ditolak', async () => {
  const e = env();
  const code = await mkCode(e);
  e.sqlite.exec("INSERT INTO accounts(id,email,email_verified,display_name) VALUES ('adm2','adm2@x.com',1,NULL); INSERT INTO memberships(tree_id,account_id,role,status) VALUES ('t1','adm2','admin','active')");
  e.sqlite.exec("UPDATE accounts SET created_at = '2026-01-01 00:00:00' WHERE id IN ('owner','admin'); UPDATE accounts SET created_at = '2026-02-01 00:00:00' WHERE id = 'adm2'");
  const r = await lookupAccessCode(e.db, { code });
  assert.deepEqual([r.ok, r.treeName], [true, 'Keluarga Satu']);
  assert.deepEqual(r.managers, ['Ahmad Owner', 'Budi Admin', 'Pengelola']);
  assert.deepEqual(Object.keys(r).sort(), ['managers', 'ok', 'treeName']); // tidak ada field lain yang ikut keluar
  const s = JSON.stringify(r);
  for (const leak of ['@x.com', 'Citra', 'Vina', 'owner']) assert.ok(!s.includes(leak), leak);
  for (const bad of ['', 'x', 'a'.repeat(43), undefined, null, 5, 'a'.repeat(500)]) assert.equal((await lookupAccessCode(e.db, { code: bad })).code, 'invalid_code', String(bad));
});

test('ajukan bergabung: pemohon BELUM anggota, tidak bisa membaca; audit tercatat; status menunggu', async () => {
  const e = env();
  const code = await mkCode(e);
  const r = await join(e, code, 'ani', '  Saya sepupunya Ahmad  ');
  assert.deepEqual([r.ok, r.treeId, r.treeName], [true, 't1', 'Keluarga Satu']);
  const row = e.req(r.requestId);
  assert.deepEqual([row.tree_id, row.account_id, row.message, row.status, row.role], ['t1', 'ani', 'Saya sepupunya Ahmad', 'pending', null]);
  assert.equal(e.mem('t1', 'ani'), undefined);
  assert.equal(await getMembership(e.db, 't1', 'ani'), null);
  assert.equal(e.audits('member.join_request'), 1);
  assert.deepEqual((await myJoinRequests(e.db, 'ani')).map((x) => [x.id, x.treeName]), [[r.requestId, 'Keluarga Satu']]);
  assert.deepEqual(await myJoinRequests(e.db, 'viewer'), []);
});

test('ajukan bergabung: pesan opsional, kosong jadi null, dihitung per karakter, tipe salah ditolak', async () => {
  const e = env();
  const code = await mkCode(e);
  assert.equal(e.req((await join(e, code, 'ani', '   ')).requestId).message, null);
  assert.equal((await join(e, code, 'bima', '😀'.repeat(MAX_MESSAGE))).ok, true);
  assert.equal((await join(e, code, 'oth', 'x'.repeat(MAX_MESSAGE + 1))).code, 'message_too_long');
  assert.equal((await join(e, code, 'oth', 5)).code, 'invalid_message');
  assert.equal(e.count('SELECT COUNT(*) n FROM join_requests'), 2);
});

test('ajukan bergabung: kode salah, akun tidak ada, email belum terverifikasi, sudah anggota, sudah menunggu', async () => {
  const e = env();
  const code = await mkCode(e);
  assert.equal((await join(e, 'a'.repeat(43))).code, 'invalid_code');
  assert.equal((await join(e, code, 'nope')).code, 'forbidden');
  assert.equal((await join(e, code, null)).code, 'forbidden');
  assert.equal((await join(e, code, 'unv')).code, 'email_not_verified');
  assert.equal((await join(e, code, 'viewer')).code, 'already_member');
  assert.equal((await join(e, code, 'ani')).ok, true);
  assert.equal((await join(e, code, 'ani')).code, 'already_pending');
  assert.equal(e.count('SELECT COUNT(*) n FROM join_requests'), 1);
  e.sqlite.exec("UPDATE memberships SET status='removed' WHERE account_id='viewer'");
  assert.equal((await join(e, code, 'viewer')).ok, true); // yang dikeluarkan boleh mengajukan lagi
});

test('batas permintaan menunggu: per pohon dan per akun', async () => {
  const e = env();
  const code = await mkCode(e);
  for (let i = 0; i < MAX_PENDING_PER_TREE; i++) {
    e.sqlite.exec(`INSERT INTO accounts(id,email,email_verified) VALUES ('p${i}','p${i}@x.com',1)`);
    assert.equal((await join(e, code, `p${i}`)).ok, true, `p${i}`);
  }
  assert.equal((await join(e, code, 'ani')).code, 'too_many_pending');
  assert.equal(e.count('SELECT COUNT(*) n FROM join_requests'), MAX_PENDING_PER_TREE);
  // per akun: satu akun mengajukan ke banyak pohon
  const f = env();
  for (let i = 0; i < MAX_PENDING_PER_ACCOUNT + 1; i++) {
    f.sqlite.exec(`INSERT INTO accounts(id,email,email_verified) VALUES ('o${i}','o${i}@x.com',1); INSERT INTO family_trees(id,name,created_by) VALUES ('x${i}','X${i}','o${i}'); INSERT INTO memberships(tree_id,account_id,role,status) VALUES ('x${i}','o${i}','owner','active')`);
  }
  const codes = [];
  for (let i = 0; i < MAX_PENDING_PER_ACCOUNT + 1; i++) codes.push(await mkCode(f, { treeId: `x${i}`, actorId: `o${i}` }));
  for (let i = 0; i < MAX_PENDING_PER_ACCOUNT; i++) assert.equal((await join(f, codes[i], 'ani')).ok, true, `kode ${i}`);
  assert.equal((await join(f, codes[MAX_PENDING_PER_ACCOUNT], 'ani')).code, 'request_limit');
});

test('balapan: kode dicabut tepat sebelum batch kita, tidak ada permintaan dan audit', async () => {
  const e = env();
  const code = await mkCode(e);
  const real = e.db.batch.bind(e.db);
  e.db.batch = async (stmts) => { e.sqlite.exec("UPDATE tree_access_codes SET revoked_at = '2026-11-23 10:00:00'"); return real(stmts); };
  assert.equal((await join(e, code)).code, 'join_failed');
  assert.deepEqual([e.count('SELECT COUNT(*) n FROM join_requests'), e.audits('member.join_request')], [0, 0]);
});

test('balapan: pemohon yang sama masuk dua kali tepat sebelum batch, ditolak indeks unik tanpa audit ganda', async () => {
  const e = env();
  const code = await mkCode(e);
  const real = e.db.batch.bind(e.db);
  e.db.batch = async (stmts) => { e.sqlite.exec("INSERT INTO join_requests(id,tree_id,account_id,status) VALUES ('dup','t1','ani','pending')"); return real(stmts); };
  assert.equal((await join(e, code)).code, 'already_pending');
  assert.equal(e.count('SELECT COUNT(*) n FROM join_requests'), 1);
  assert.equal(e.audits('member.join_request'), 0);
});

test('balapan: pemohon keburu menjadi anggota tepat sebelum batch, tidak ada permintaan', async () => {
  const e = env();
  const code = await mkCode(e);
  const real = e.db.batch.bind(e.db);
  e.db.batch = async (stmts) => { e.sqlite.exec("INSERT INTO memberships(tree_id,account_id,role,status) VALUES ('t1','ani','viewer','active')"); return real(stmts); };
  assert.equal((await join(e, code)).code, 'join_failed');
  assert.equal(e.count('SELECT COUNT(*) n FROM join_requests'), 0);
});

test('daftar permintaan: Owner/Admin melihat nama, email, pesan; Contributor, Viewer, orang luar, pohon lain tidak', async () => {
  const e = env();
  const code = await mkCode(e);
  await join(e, code, 'ani', 'halo');
  await join(e, code, 'bima');
  e.sqlite.exec("UPDATE join_requests SET created_at = '2026-11-23 09:00:00' WHERE account_id = 'ani'; UPDATE join_requests SET created_at = '2026-11-23 09:30:00' WHERE account_id = 'bima'");
  for (const who of ['owner', 'admin']) {
    const r = await listJoinRequests(e.db, { treeId: 't1', actorId: who });
    assert.deepEqual(r.requests.map((x) => [x.name, x.email, x.message]), [['Ani', 'ani@x.com', 'halo'], ['bima', 'bima@x.com', null]], who);
  }
  for (const who of ['contrib', 'viewer', 'ani', 'nope', 'oth']) assert.equal((await listJoinRequests(e.db, { treeId: 't1', actorId: who })).code, 'forbidden', who);
  assert.deepEqual((await listJoinRequests(e.db, { treeId: 't2', actorId: 'oth' })).requests, []);
});

test('setujui: keanggotaan aktif dengan peran pilihan, permintaan approved, pemohon bisa membaca; audit memuat peran', async () => {
  const e = env();
  const rid = await pending(e);
  for (const who of ['contrib', 'viewer', 'ani', 'nope']) assert.equal((await decide(e, rid, 'approve', 'viewer', who)).code, 'forbidden', who);
  assert.equal(e.mem('t1', 'ani'), undefined);
  assert.deepEqual(await decide(e, rid, 'approve', 'contributor', 'admin'), { ok: true, status: 'approved' });
  assert.deepEqual({ ...e.mem('t1', 'ani') }, { role: 'contributor', status: 'active' });
  assert.deepEqual([e.req(rid).status, e.req(rid).role, e.req(rid).decided_by], ['approved', 'contributor', 'admin']);
  assert.equal((await getMembership(e.db, 't1', 'ani')).role, 'contributor');
  assert.deepEqual(JSON.parse(e.sqlite.prepare("SELECT after_json a FROM audit_events WHERE action='member.join_approve'").get().a), { role: 'contributor' });
  assert.equal((await decide(e, rid, 'approve', 'viewer', 'owner')).code, 'not_pending');
  assert.equal(e.audits('member.join_approve'), 1);
});

test('setujui: peran hanya viewer atau contributor; admin dan owner tidak bisa diangkat lewat jalur ini', async () => {
  const e = env();
  const rid = await pending(e);
  for (const role of ['admin', 'owner', null, 'hacker', 'Viewer']) assert.equal((await decide(e, rid, 'approve', role)).code, 'invalid_role', String(role));
  assert.equal((await decideJoinRequest(e.db, { treeId: 't1', requestId: rid, deciderId: 'owner', action: 'approve', now: T0 })).code, 'invalid_role'); // tanpa peran sama sekali
  assert.equal((await decide(e, rid, 'maybe')).code, 'bad_action');
  assert.equal(e.req(rid).status, 'pending');
  assert.equal(e.mem('t1', 'ani'), undefined);
});

test('tolak: pemohon tetap bukan anggota, boleh mengajukan lagi dengan kode yang sama', async () => {
  const e = env();
  const code = await mkCode(e);
  const rid = await pending(e, 'ani', code);
  assert.deepEqual(await decide(e, rid, 'reject', null, 'owner'), { ok: true, status: 'rejected' });
  assert.equal(e.mem('t1', 'ani'), undefined);
  assert.equal(e.audits('member.join_reject'), 1);
  assert.equal((await myJoinRequests(e.db, 'ani')).length, 0);
  assert.equal((await join(e, code, 'ani')).ok, true);
});

test('setujui orang yang pernah dikeluarkan: keanggotaan lama diaktifkan kembali dengan peran baru; yang sudah aktif tidak diubah', async () => {
  const e = env();
  e.sqlite.exec("INSERT INTO memberships(tree_id,account_id,role,status) VALUES ('t1','ani','admin','removed')");
  const rid = await pending(e);
  assert.equal((await decide(e, rid, 'approve', 'viewer')).ok, true);
  assert.deepEqual({ ...e.mem('t1', 'ani') }, { role: 'viewer', status: 'active' }); // peran lama admin tidak ikut kembali
  const f = env();
  const r2 = await pending(f);
  f.sqlite.exec("INSERT INTO memberships(tree_id,account_id,role,status) VALUES ('t1','ani','admin','active')"); // keburu jadi anggota lewat jalur lain
  assert.equal((await decide(f, r2, 'approve', 'viewer')).ok, true);
  assert.equal(f.mem('t1', 'ani').role, 'admin');
});

test('isolasi pohon: Owner pohon lain tidak bisa memutuskan permintaan pohon ini', async () => {
  const e = env();
  const rid = await pending(e);
  assert.equal((await decide(e, rid, 'approve', 'viewer', 'oth', 't2')).code, 'not_found');
  assert.equal((await decide(e, rid, 'approve', 'viewer', 'oth', 't1')).code, 'forbidden');
  assert.equal((await decide(e, 'hantu')).code, 'not_found');
  assert.equal(e.req(rid).status, 'pending');
  assert.equal(e.count('SELECT COUNT(*) n FROM memberships WHERE tree_id = ?', 't2'), 1);
});

test('balapan keputusan: pengelola lain menolak tepat sebelum batch kita, tidak ada keanggotaan dan audit', async () => {
  const e = env();
  const rid = await pending(e);
  const real = e.db.batch.bind(e.db);
  e.db.batch = async (stmts) => { e.sqlite.prepare("UPDATE join_requests SET status='rejected', decided_by='admin', decided_at='2026-11-23 10:00:00' WHERE id=?").run(rid); return real(stmts); };
  assert.equal((await decide(e, rid)).code, 'not_pending');
  assert.equal(e.mem('t1', 'ani'), undefined);
  assert.deepEqual([e.audits('member.join_approve'), e.req(rid).status], [0, 'rejected']);
});

test('tidak ada akses lewat permintaan menunggu: membaca pohon tetap ditolak sampai disetujui', async () => {
  const e = env();
  const rid = await pending(e);
  const { readTree } = await import('../src/trees.js');
  assert.equal((await readTree(e.db, { treeId: 't1', accountId: 'ani', now: T0 })).code, 'forbidden');
  await decide(e, rid, 'approve', 'viewer');
  const t = await readTree(e.db, { treeId: 't1', accountId: 'ani', now: T0 });
  assert.deepEqual([t.ok, t.role], [true, 'viewer']);
});
