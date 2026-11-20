import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/d1.mjs';
import { getMembership } from '../src/db.js';
import {
  INVITE_DAYS, acceptInvitation, cancelInvitation, createInvitation, decideJoin,
  expireInvitations, lookupInvitation, normEmail, sha256Hex,
} from '../src/invitations.js';

const T0 = new Date('2026-11-19T10:00:00Z');

function env() {
  const e = freshDb();
  e.sqlite.exec(`
    INSERT INTO accounts(id,email,email_verified) VALUES
      ('owner','o@x.com',1),('admin','a@x.com',1),('contrib','c@x.com',1),('viewer','v@x.com',1),('out','z@x.com',1),
      ('budi','Budi@X.com',1),('ani','ani@x.com',0),('oth','oth@x.com',1);
    INSERT INTO family_trees(id,name,created_by) VALUES ('t1','Keluarga Satu','owner'),('t2','Keluarga Dua','owner');
    INSERT INTO memberships(tree_id,account_id,role,status) VALUES
      ('t1','owner','owner','active'),('t1','admin','admin','active'),('t1','contrib','contributor','active'),
      ('t1','viewer','viewer','active'),('t2','owner','owner','active');
  `);
  e.inv = (id) => e.sqlite.prepare('SELECT * FROM invitations WHERE id = ?').get(id);
  e.mem = (tree, acc) => e.sqlite.prepare('SELECT * FROM memberships WHERE tree_id = ? AND account_id = ?').get(tree, acc);
  e.audits = (action) => e.count('SELECT COUNT(*) n FROM audit_events WHERE action = ?', action);
  return e;
}
const invite = (e, over = {}) =>
  createInvitation(e.db, { treeId: 't1', inviterId: 'admin', email: 'budi@x.com', role: 'contributor', now: T0, ...over });
const accept = (e, token, accountId = 'budi', now = T0) => acceptInvitation(e.db, { token, accountId, now });
const decide = (e, id, action = 'approve', who = 'admin', treeId = 't1') =>
  decideJoin(e.db, { treeId, invitationId: id, deciderId: who, action, now: T0 });
const requested = async (e, over = {}) => {
  const inv = await invite(e, over);
  assert.equal(inv.ok, true, JSON.stringify(inv));
  const a = await accept(e, inv.token);
  assert.equal(a.ok, true, JSON.stringify(a));
  return inv;
};

test('buat undangan: token acak, hanya hash yang disimpan, berlaku 7 hari, email dinormalkan, audit tanpa token', async () => {
  const e = env();
  const r = await invite(e, { email: '  Budi@X.COM ' });
  assert.equal(r.ok, true);
  assert.equal(INVITE_DAYS, 7);
  assert.equal(r.expiresAt, '2026-11-26 10:00:00');
  const row = e.inv(r.id);
  assert.equal(row.email, 'budi@x.com');
  assert.equal(row.status, 'pending');
  assert.equal(row.role, 'contributor');
  assert.equal(row.invited_by, 'admin');
  assert.equal(row.token_hash, await sha256Hex(r.token));
  assert.notEqual(row.token_hash, r.token);
  assert.ok(r.token.length >= 40 && /^[A-Za-z0-9_-]+$/.test(r.token));
  const dump = JSON.stringify([
    e.sqlite.prepare('SELECT * FROM invitations').all(),
    e.sqlite.prepare('SELECT * FROM audit_events').all(),
  ]);
  assert.ok(!dump.includes(r.token), 'token mentah tersimpan');
  assert.equal(e.audits('invitation.create'), 1);
  const other = await invite(e, { email: 'lain@x.com' });
  assert.notEqual(other.token, r.token);
});

test('buat undangan: hanya Owner/Admin, hanya Contributor atau Viewer, email valid', async () => {
  const e = env();
  for (const who of ['contrib', 'viewer', 'out']) assert.equal((await invite(e, { inviterId: who })).code, 'forbidden', who);
  assert.equal((await invite(e, { inviterId: 'owner' })).ok, true);
  for (const role of ['admin', 'owner', 'viewer ', undefined, 'hacker']) {
    const r = await invite(e, { role, email: `r${String(role)}@x.com` });
    assert.equal(r.code ?? 'ok', role === 'viewer ' || role === undefined || role === 'hacker' || role === 'admin' || role === 'owner' ? 'invalid_role' : 'ok', String(role));
  }
  for (const email of ['', 'tanpa-at', 'a@b', '@x.com', 'a b@x.com', null, 5, `${'x'.repeat(250)}@x.com`]) {
    assert.equal((await invite(e, { email })).code, 'invalid_email', String(email));
  }
  assert.equal((await invite(e, { role: 'viewer', email: 'v2@x.com' })).ok, true);
});

test('kirim ulang: undangan lama yang menunggu dibatalkan, token lama mati, hanya satu yang aktif', async () => {
  const e = env();
  const a = await invite(e);
  const b = await invite(e);
  assert.equal(e.inv(a.id).status, 'cancelled');
  assert.equal(e.inv(b.id).status, 'pending');
  assert.equal((await lookupInvitation(e.db, a.token, T0)).code, 'invalid_invitation');
  assert.equal((await lookupInvitation(e.db, b.token, T0)).ok, true);
  assert.equal((await accept(e, a.token)).code, 'invalid_invitation');
  assert.equal(e.count("SELECT COUNT(*) n FROM invitations WHERE status = 'pending'"), 1);
  const c = await invite(e, { email: 'BUDI@x.com', role: 'viewer' }); // huruf besar sama dengan email yang sama
  assert.equal(e.inv(b.id).status, 'cancelled');
  assert.equal(e.inv(c.id).role, 'viewer');
});

test('undangan yang menunggu persetujuan tidak bisa ditimpa kirim ulang dan tidak berubah', async () => {
  const e = env();
  const a = await requested(e);
  assert.equal((await invite(e)).code, 'already_pending'); // keanggotaan menunggu sudah menghalangi
  e.sqlite.exec("DELETE FROM memberships WHERE account_id = 'budi'"); // paksa jalur indeks unik
  const r = await invite(e);
  assert.equal(r.code, 'invite_awaiting_approval');
  assert.equal(e.inv(a.id).status, 'awaiting_approval');
  assert.equal(e.count('SELECT COUNT(*) n FROM invitations'), 1);
});

test('mengundang orang yang sudah anggota atau sedang menunggu ditolak; yang dikeluarkan boleh', async () => {
  const e = env();
  assert.equal((await invite(e, { email: 'V@x.com' })).code, 'already_member'); // viewer aktif, huruf beda
  await requested(e);
  assert.equal((await invite(e)).code, 'already_pending');
  e.sqlite.exec("UPDATE invitations SET status = 'cancelled'");
  assert.equal((await invite(e)).code, 'already_pending'); // keanggotaan menunggu tetap menghalangi
  e.sqlite.exec("UPDATE memberships SET status = 'removed' WHERE account_id = 'budi'");
  assert.equal((await invite(e)).ok, true);
});

test('lookup: tanpa login hanya nama pohon dan peran; kedaluwarsa, dibatalkan, dan tidak dikenal ditolak', async () => {
  const e = env();
  const a = await invite(e);
  assert.deepEqual(await lookupInvitation(e.db, a.token, T0), { ok: true, treeName: 'Keluarga Satu', role: 'contributor' });
  assert.equal((await lookupInvitation(e.db, a.token, new Date('2026-11-26T10:00:00Z'))).code, 'invitation_expired');
  assert.equal((await lookupInvitation(e.db, a.token, new Date('2026-11-26T09:59:59Z'))).ok, true);
  for (const bad of ['', 'x', 'a'.repeat(43), undefined, null, 123, 'a'.repeat(500)]) {
    assert.equal((await lookupInvitation(e.db, bad, T0)).code, 'invalid_invitation', String(bad));
  }
  e.sqlite.exec("UPDATE invitations SET status = 'expired'");
  assert.equal((await lookupInvitation(e.db, a.token, T0)).code, 'invitation_expired');
  e.sqlite.exec("UPDATE invitations SET status = 'cancelled'");
  assert.equal((await lookupInvitation(e.db, a.token, T0)).code, 'invalid_invitation');
});

test('terima: mengajukan bergabung, belum menjadi anggota dan belum bisa membaca pohon', async () => {
  const e = env();
  const inv = await invite(e, { role: 'viewer' });
  const r = await accept(e, inv.token);
  assert.deepEqual(r, { ok: true, invitationId: inv.id, treeId: 't1', status: 'awaiting_approval' });
  assert.equal(e.inv(inv.id).status, 'awaiting_approval');
  assert.equal(e.inv(inv.id).accepted_by, 'budi');
  assert.deepEqual({ role: e.mem('t1', 'budi').role, status: e.mem('t1', 'budi').status }, { role: 'viewer', status: 'pending' });
  assert.equal(await getMembership(e.db, 't1', 'budi'), null);
  assert.equal(e.audits('member.join_request'), 1);
  const a = e.sqlite.prepare("SELECT * FROM audit_events WHERE action = 'member.join_request'").get();
  assert.equal(a.actor_id, 'budi');
  assert.equal(a.target_id, inv.id);
});

test('terima: email dicocokkan tanpa peka huruf besar', async () => {
  const e = env(); // akun 'budi' bertanda 'Budi@X.com'
  assert.equal(normEmail('Budi@X.com'), 'budi@x.com');
  assert.equal((await accept(e, (await invite(e)).token)).ok, true);
});

test('terima: akun salah, email belum terverifikasi, akun tidak ada ditolak dan undangan tetap pending', async () => {
  const e = env();
  const inv = await invite(e);
  assert.equal((await accept(e, inv.token, 'oth')).code, 'wrong_account');
  assert.equal((await accept(e, inv.token, 'nope')).code, 'forbidden');
  assert.equal((await accept(e, inv.token, null)).code, 'forbidden');
  const ani = await invite(e, { email: 'ani@x.com' });
  assert.equal((await accept(e, ani.token, 'ani')).code, 'email_not_verified');
  assert.equal(e.inv(inv.id).status, 'pending');
  assert.equal(e.inv(ani.id).status, 'pending');
  assert.equal(e.count('SELECT COUNT(*) n FROM memberships WHERE tree_id = ?', 't1'), 4);
});

test('terima: sekali pakai, oleh akun yang sama maupun lain; kedaluwarsa dan dibatalkan ditolak', async () => {
  const e = env();
  const inv = await invite(e);
  assert.equal((await accept(e, inv.token)).ok, true);
  assert.equal((await accept(e, inv.token)).code, 'invalid_invitation');
  assert.equal((await accept(e, inv.token, 'oth')).code, 'invalid_invitation');
  assert.equal(e.audits('member.join_request'), 1);
  const old = await invite(e, { email: 'oth@x.com' });
  assert.equal((await accept(e, old.token, 'oth', new Date('2026-12-01T00:00:00Z'))).code, 'invitation_expired');
  assert.equal(e.mem('t1', 'oth'), undefined);
  const c = await invite(e, { email: 'ani2@x.com' });
  await cancelInvitation(e.db, { treeId: 't1', invitationId: c.id, actorId: 'admin' });
  e.sqlite.exec("INSERT INTO accounts(id,email,email_verified) VALUES ('ani2','ani2@x.com',1)");
  assert.equal((await accept(e, c.token, 'ani2')).code, 'invalid_invitation');
});

test('terima: yang sudah anggota aktif atau sudah menunggu tidak memakai undangan', async () => {
  const e = env();
  e.sqlite.exec("INSERT INTO memberships(tree_id,account_id,role,status) VALUES ('t1','budi','viewer','active')");
  const inv = await invite(e).then((r) => r, () => null);
  assert.equal(inv.code, 'already_member'); // dicegah sejak pembuatan
  // undangan yang dibuat sebelum akunnya menjadi anggota
  const e2 = env();
  const i2 = await invite(e2);
  e2.sqlite.exec("INSERT INTO memberships(tree_id,account_id,role,status) VALUES ('t1','budi','viewer','active')");
  assert.equal((await accept(e2, i2.token)).code, 'already_member');
  assert.equal(e2.inv(i2.id).status, 'pending');
  e2.sqlite.exec("UPDATE memberships SET status = 'pending' WHERE account_id = 'budi'");
  assert.equal((await accept(e2, i2.token)).code, 'already_pending');
  assert.equal(e2.inv(i2.id).status, 'pending');
});

test('balapan terima: undangan dipakai pihak lain tepat sebelum batch kita, tidak ada keanggotaan dan audit', async () => {
  const e = env();
  const inv = await invite(e);
  const real = e.db.batch.bind(e.db);
  e.db.batch = async (stmts) => {
    e.sqlite.prepare("UPDATE invitations SET status = 'awaiting_approval', accepted_by = 'oth' WHERE id = ?").run(inv.id);
    return real(stmts);
  };
  const r = await accept(e, inv.token);
  assert.equal(r.code, 'invalid_invitation');
  assert.equal(e.mem('t1', 'budi'), undefined);
  assert.equal(e.audits('member.join_request'), 0);
  assert.equal(e.inv(inv.id).accepted_by, 'oth');
});

test('setujui: keanggotaan aktif dengan peran undangan, undangan accepted, anggota baru bisa membaca', async () => {
  const e = env();
  const inv = await requested(e, { role: 'viewer' });
  for (const who of ['contrib', 'viewer', 'out', 'budi']) assert.equal((await decide(e, inv.id, 'approve', who)).code, 'forbidden', who);
  assert.equal(e.mem('t1', 'budi').status, 'pending');
  assert.deepEqual(await decide(e, inv.id, 'approve', 'admin'), { ok: true, status: 'accepted' });
  assert.deepEqual({ role: e.mem('t1', 'budi').role, status: e.mem('t1', 'budi').status }, { role: 'viewer', status: 'active' });
  assert.equal((await getMembership(e.db, 't1', 'budi')).role, 'viewer');
  assert.equal(e.inv(inv.id).status, 'accepted');
  assert.equal(e.audits('member.join_approve'), 1);
  assert.equal((await decide(e, inv.id, 'approve', 'owner')).code, 'not_awaiting');
  assert.equal(e.audits('member.join_approve'), 1);
});

test('tolak: keanggotaan dicabut, undangan dibatalkan, boleh diundang lagi dan mengajukan lagi', async () => {
  const e = env();
  const inv = await requested(e);
  assert.deepEqual(await decide(e, inv.id, 'reject', 'owner'), { ok: true, status: 'cancelled' });
  assert.equal(e.mem('t1', 'budi').status, 'removed');
  assert.equal(await getMembership(e.db, 't1', 'budi'), null);
  assert.equal(e.audits('member.join_reject'), 1);
  const again = await invite(e, { role: 'viewer' });
  assert.equal(again.ok, true);
  assert.equal((await accept(e, again.token)).ok, true);
  assert.deepEqual({ role: e.mem('t1', 'budi').role, status: e.mem('t1', 'budi').status }, { role: 'viewer', status: 'pending' });
});

test('keputusan bergabung: aksi tidak dikenal, tidak ada, belum menunggu', async () => {
  const e = env();
  const inv = await invite(e);
  assert.equal((await decide(e, inv.id, 'maybe')).code, 'bad_action');
  assert.equal((await decide(e, 'hantu')).code, 'not_found');
  assert.equal((await decide(e, inv.id)).code, 'not_awaiting');
  assert.equal(e.inv(inv.id).status, 'pending');
});

test('batalkan: yang menunggu dipakai, yang menunggu persetujuan (keanggotaan ikut dicabut), tidak yang sudah diterima', async () => {
  const e = env();
  const a = await invite(e);
  for (const who of ['contrib', 'viewer', 'out']) assert.equal((await cancelInvitation(e.db, { treeId: 't1', invitationId: a.id, actorId: who })).code, 'forbidden', who);
  assert.deepEqual(await cancelInvitation(e.db, { treeId: 't1', invitationId: a.id, actorId: 'admin' }), { ok: true, status: 'cancelled' });
  assert.equal((await accept(e, a.token)).code, 'invalid_invitation');
  assert.equal(e.audits('invitation.cancel'), 1);
  assert.deepEqual(JSON.parse(e.sqlite.prepare("SELECT before_json b FROM audit_events WHERE action='invitation.cancel'").get().b), { status: 'pending' });
  assert.equal((await cancelInvitation(e.db, { treeId: 't1', invitationId: a.id, actorId: 'admin' })).code, 'not_cancellable');
  const b = await requested(e);
  assert.equal(e.mem('t1', 'budi').status, 'pending');
  assert.equal((await cancelInvitation(e.db, { treeId: 't1', invitationId: b.id, actorId: 'owner' })).ok, true);
  assert.equal(e.mem('t1', 'budi').status, 'removed');
  assert.equal(e.inv(b.id).status, 'cancelled');
  const c = await requested(e);
  await decide(e, c.id);
  assert.equal((await cancelInvitation(e.db, { treeId: 't1', invitationId: c.id, actorId: 'admin' })).code, 'not_cancellable');
  assert.equal(e.mem('t1', 'budi').status, 'active');
  assert.equal((await cancelInvitation(e.db, { treeId: 't1', invitationId: 'hantu', actorId: 'admin' })).code, 'not_found');
});

test('isolasi pohon: Owner pohon lain tidak bisa memutuskan atau membatalkan undangan pohon ini', async () => {
  const e = env();
  const inv = await requested(e);
  assert.equal((await decide(e, inv.id, 'approve', 'owner', 't2')).code, 'not_found'); // 'owner' juga Owner di t2
  assert.equal((await cancelInvitation(e.db, { treeId: 't2', invitationId: inv.id, actorId: 'owner' })).code, 'not_found');
  assert.equal(e.inv(inv.id).status, 'awaiting_approval');
  assert.equal(e.mem('t1', 'budi').status, 'pending');
  assert.equal(e.mem('t2', 'budi'), undefined);
});

test('isolasi pohon: Admin pohon ini tidak bisa mengundang atas nama pohon lain', async () => {
  const e = env();
  assert.equal((await invite(e, { treeId: 't2', inviterId: 'admin' })).code, 'forbidden');
  assert.equal(e.count('SELECT COUNT(*) n FROM invitations'), 0);
});

test('satu email boleh punya undangan aktif di dua pohon berbeda', async () => {
  const e = env();
  assert.equal((await invite(e)).ok, true);
  assert.equal((await invite(e, { treeId: 't2', inviterId: 'owner' })).ok, true);
  assert.equal(e.count("SELECT COUNT(*) n FROM invitations WHERE status = 'pending'"), 2);
});

test('kedaluwarsa malas: hanya yang menunggu dipakai dan sudah lewat, hanya di pohon itu', async () => {
  const e = env();
  const a = await invite(e);
  const b = await invite(e, { email: 'lain@x.com' });
  const c = await requested(e, { email: 'budi@x.com' }).catch(() => null);
  const t2 = await invite(e, { treeId: 't2', inviterId: 'owner', email: 'x2@x.com' });
  const later = new Date('2026-12-01T00:00:00Z');
  assert.equal(await expireInvitations(e.db, 't1', new Date('2026-11-26T09:59:59Z')), 0);
  const n = await expireInvitations(e.db, 't1', later);
  assert.equal(n, 1); // hanya b; a sudah dibatalkan oleh kirim ulang, c menunggu persetujuan
  assert.equal(e.inv(b.id).status, 'expired');
  assert.equal(e.inv(a.id).status, 'cancelled');
  assert.equal(e.inv(c.id).status, 'awaiting_approval');
  assert.equal(e.inv(t2.id).status, 'pending');
  assert.equal(await expireInvitations(e.db, 't1', later), 0);
});

test('indeks unik di database menolak dua undangan aktif untuk email yang sama walau huruf berbeda', () => {
  const e = env();
  e.sqlite.exec("INSERT INTO invitations(id,tree_id,email,role,token_hash,invited_by,expires_at) VALUES ('i1','t1','a@x.com','viewer','h1','admin','2099-01-01 00:00:00')");
  assert.throws(() => e.sqlite.exec("INSERT INTO invitations(id,tree_id,email,role,token_hash,invited_by,expires_at) VALUES ('i2','t1','A@x.com','viewer','h2','admin','2099-01-01 00:00:00')"), /UNIQUE/);
  e.sqlite.exec("UPDATE invitations SET status='expired' WHERE id='i1'");
  e.sqlite.exec("INSERT INTO invitations(id,tree_id,email,role,token_hash,invited_by,expires_at) VALUES ('i2','t1','A@x.com','viewer','h2','admin','2099-01-01 00:00:00')");
});
