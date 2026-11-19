import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  EXPIRY_DAYS,
  cancelProposal,
  checkDecision,
  cleanReason,
  createProposal,
  decideProposal,
  expireDue,
  markStale,
} from '../src/proposals.js';

// Pembungkus tipis agar node:sqlite meniru antarmuka D1 (prepare/bind/first/all/run/batch).
function fakeD1(sqlite) {
  const mk = (sql) => ({
    params: [],
    bind(...p) { this.params = p; return this; },
    async first() { return sqlite.prepare(sql).get(...this.params) ?? null; },
    async all() { return { results: sqlite.prepare(sql).all(...this.params) }; },
    async run() { const r = sqlite.prepare(sql).run(...this.params); return { success: true, meta: { changes: Number(r.changes) } }; },
  });
  return {
    prepare: mk,
    async batch(stmts) {
      sqlite.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        sqlite.exec('COMMIT');
        return out;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

function env() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  sqlite.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0002_people_gender.sql', import.meta.url), 'utf8'));
  sqlite.exec(`
    INSERT INTO accounts(id,email) VALUES ('owner','o@x'),('admin','a@x'),('contrib','c@x'),('viewer','v@x'),('out','z@x'),('removed','r@x');
    INSERT INTO family_trees(id,name,created_by) VALUES ('t1','Satu','owner'),('t2','Dua','owner');
    INSERT INTO memberships(tree_id,account_id,role,status) VALUES
      ('t1','owner','owner','active'),('t1','admin','admin','active'),('t1','contrib','contributor','active'),
      ('t1','viewer','viewer','active'),('t1','removed','admin','removed'),('t2','owner','owner','active');
    INSERT INTO people(id,tree_id,display_name) VALUES ('p1','t1','Budi'),('p2','t2','Citra');
  `);
  const db = fakeD1(sqlite);
  const count = (sql, ...p) => sqlite.prepare(sql).get(...p).n;
  const row = (id) => sqlite.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
  const audits = (action) => count('SELECT COUNT(*) n FROM audit_events WHERE action = ?', action);
  return { sqlite, db, count, row, audits };
}

const T0 = new Date('2026-11-18T10:00:00Z');
const mkProp = (e, over = {}) =>
  createProposal(e.db, { treeId: 't1', proposerId: 'contrib', kind: 'person_edit', targetPersonId: 'p1', before: { n: 'Budi' }, after: { n: 'Budi S' }, now: T0, ...over });

test('createProposal: pending, kedaluwarsa 30 hari, tercatat di audit', async () => {
  const e = env();
  const r = await mkProp(e);
  assert.equal(r.ok, true);
  const p = e.row(r.id);
  assert.equal(p.status, 'pending');
  assert.equal(p.proposer_id, 'contrib');
  assert.equal(p.expires_at, '2026-12-18 10:00:00');
  assert.equal(EXPIRY_DAYS, 30);
  assert.equal(e.audits('proposal.create'), 1);
});

test('createProposal: Viewer, orang luar, dan anggota yang dikeluarkan ditolak', async () => {
  const e = env();
  for (const who of ['viewer', 'out', 'removed']) {
    assert.deepEqual(await mkProp(e, { proposerId: who }), { ok: false, code: 'forbidden' }, who);
  }
  assert.equal(e.count('SELECT COUNT(*) n FROM proposals'), 0);
});

test('createProposal: validasi jenis, isi, catatan sumber, dan target lintas pohon', async () => {
  const e = env();
  assert.equal((await mkProp(e, { kind: 'ngawur' })).code, 'bad_kind');
  assert.equal((await mkProp(e, { after: undefined })).code, 'after_required');
  assert.equal((await mkProp(e, { sourceNote: 'x'.repeat(501) })).code, 'note_too_long');
  assert.equal((await mkProp(e, { targetPersonId: 'p2' })).code, 'target_not_found'); // p2 milik pohon t2
});

test('decide: Admin menyetujui, status dan audit tercatat', async () => {
  const e = env();
  const { id } = await mkProp(e);
  const r = await decideProposal(e.db, { treeId: 't1', proposalId: id, deciderId: 'admin', action: 'approve', now: T0 });
  assert.deepEqual(r, { ok: true, status: 'approved' });
  const p = e.row(id);
  assert.equal(p.status, 'approved');
  assert.equal(p.decided_by, 'admin');
  assert.equal(p.rejection_reason, null);
  assert.equal(e.audits('proposal.approve'), 1);
});

test('decide: pengaju tidak boleh menyetujui usulannya sendiri, Admin pun tidak', async () => {
  const e = env();
  const { id } = await mkProp(e, { proposerId: 'admin', kind: 'parent_child', targetPersonId: null, before: null, after: { parent: 'a', child: 'b' } });
  const r = await decideProposal(e.db, { treeId: 't1', proposalId: id, deciderId: 'admin', action: 'approve', now: T0 });
  assert.equal(r.code, 'self_approval');
  assert.equal(e.row(id).status, 'pending');
  const ok = await decideProposal(e.db, { treeId: 't1', proposalId: id, deciderId: 'owner', action: 'approve', now: T0 });
  assert.equal(ok.ok, true);
});

test('decide: Contributor, Viewer, orang luar, dan anggota dikeluarkan ditolak', async () => {
  const e = env();
  const { id } = await mkProp(e);
  for (const who of ['contrib', 'viewer', 'out', 'removed']) {
    const r = await decideProposal(e.db, { treeId: 't1', proposalId: id, deciderId: who, action: 'approve', now: T0 });
    assert.equal(r.code, 'forbidden', who);
  }
  assert.equal(e.row(id).status, 'pending');
});

test('tolak: alasan wajib, maksimal 300 karakter, disimpan setelah di-trim', async () => {
  const e = env();
  const { id } = await mkProp(e);
  const d = (reason) => decideProposal(e.db, { treeId: 't1', proposalId: id, deciderId: 'admin', action: 'reject', reason, now: T0 });
  assert.equal((await d(undefined)).code, 'reason_required');
  assert.equal((await d('   ')).code, 'reason_required');
  assert.equal((await d('x'.repeat(301))).code, 'reason_too_long');
  assert.equal(e.row(id).status, 'pending');
  const ok = await d('  Sumbernya belum jelas  ');
  assert.equal(ok.status, 'rejected');
  assert.equal(e.row(id).rejection_reason, 'Sumbernya belum jelas');
  assert.equal(e.audits('proposal.reject'), 1);
  assert.equal(e.sqlite.prepare("SELECT approval_note n FROM audit_events WHERE action='proposal.reject'").get().n, 'Sumbernya belum jelas');
});

test('cleanReason menghitung karakter, bukan byte atau unit UTF-16', () => {
  assert.equal(cleanReason('😀'.repeat(300)).ok, true);
  assert.equal(cleanReason('😀'.repeat(301)).code, 'reason_too_long');
});

test('keputusan kedua atas proposal yang sama gagal dan tidak menulis audit ganda', async () => {
  const e = env();
  const { id } = await mkProp(e);
  const a = { treeId: 't1', proposalId: id, deciderId: 'admin', action: 'approve', now: T0 };
  assert.equal((await decideProposal(e.db, a)).ok, true);
  assert.equal((await decideProposal(e.db, { ...a, deciderId: 'owner', action: 'reject', reason: 'x' })).code, 'not_pending');
  assert.equal(e.row(id).status, 'approved');
  assert.equal(e.audits('proposal.approve'), 1);
  assert.equal(e.audits('proposal.reject'), 0);
});

test('balapan: bila penyetuju lain menang tepat sebelum batch penutup, kita gagal dan audit kita tidak ditulis', async () => {
  const e = env();
  const { id } = await mkProp(e);
  const realBatch = e.db.batch.bind(e.db);
  let call = 0;
  e.db.batch = async (stmts) => {
    call += 1; // batch #1 = expireDue, batch #2 = penutupan proposal
    if (call === 2) {
      e.sqlite.prepare("UPDATE proposals SET status='approved', decided_by='owner', decided_at='2026-11-18 10:00:00' WHERE id=?").run(id);
    }
    return realBatch(stmts);
  };
  const r = await decideProposal(e.db, { treeId: 't1', proposalId: id, deciderId: 'admin', action: 'approve', now: T0 });
  assert.equal(call, 2);
  assert.equal(r.code, 'not_pending');
  assert.equal(e.audits('proposal.approve'), 0);
  assert.equal(e.row(id).decided_by, 'owner');
});

test('cancel: hanya pengaju, hanya saat pending', async () => {
  const e = env();
  const { id } = await mkProp(e);
  assert.equal((await cancelProposal(e.db, { treeId: 't1', proposalId: id, actorId: 'admin', now: T0 })).code, 'forbidden');
  assert.equal((await cancelProposal(e.db, { treeId: 't1', proposalId: id, actorId: 'viewer', now: T0 })).code, 'forbidden');
  assert.deepEqual(await cancelProposal(e.db, { treeId: 't1', proposalId: id, actorId: 'contrib', now: T0 }), { ok: true, status: 'cancelled' });
  assert.equal(e.audits('proposal.cancel'), 1);
  assert.equal((await cancelProposal(e.db, { treeId: 't1', proposalId: id, actorId: 'contrib', now: T0 })).code, 'not_pending');
});

test('kedaluwarsa: setelah 30 hari proposal menjadi expired dan tidak bisa diputuskan', async () => {
  const e = env();
  const { id } = await mkProp(e);
  const later = new Date('2026-12-19T00:00:00Z');
  const r = await decideProposal(e.db, { treeId: 't1', proposalId: id, deciderId: 'admin', action: 'approve', now: later });
  assert.equal(r.code, 'expired');
  assert.equal(e.row(id).status, 'expired');
  assert.equal(e.audits('proposal.expire'), 1);
  assert.equal(await expireDue(e.db, 't1', later), 0); // idempoten
  assert.equal(e.audits('proposal.expire'), 1);
});

test('kedaluwarsa: sebelum batas waktu proposal tetap pending', async () => {
  const e = env();
  const { id } = await mkProp(e);
  assert.equal(await expireDue(e.db, 't1', new Date('2026-12-18T09:59:59Z')), 0);
  assert.equal(e.row(id).status, 'pending');
});

test('stale: usulan lain pada orang yang sama ditandai perlu diajukan ulang', async () => {
  const e = env();
  const a = await mkProp(e);
  const b = await mkProp(e, { after: { n: 'Budi X' } });
  const c = await mkProp(e, { kind: 'person_create', targetPersonId: null, before: null, after: { n: 'Baru' } });
  assert.equal(await markStale(e.db, 't1', 'p1', a.id), 1);
  assert.equal(e.row(a.id).status, 'pending'); // yang dikecualikan tetap
  assert.equal(e.row(b.id).status, 'stale');
  assert.equal(e.row(c.id).status, 'pending'); // tanpa target tidak ikut
  assert.equal(e.audits('proposal.stale'), 1);
  const r = await decideProposal(e.db, { treeId: 't1', proposalId: b.id, deciderId: 'admin', action: 'approve', now: T0 });
  assert.equal(r.code, 'not_pending');
});

test('isolasi pohon: id proposal pohon lain tidak ditemukan dan tidak terpengaruh', async () => {
  const e = env();
  const { id } = await mkProp(e);
  // 'owner' adalah Owner di t2 juga, tapi proposal ini milik t1
  const r = await decideProposal(e.db, { treeId: 't2', proposalId: id, deciderId: 'owner', action: 'approve', now: T0 });
  assert.equal(r.code, 'not_found');
  assert.equal((await cancelProposal(e.db, { treeId: 't2', proposalId: id, actorId: 'contrib', now: T0 })).code, 'forbidden');
  assert.equal(e.row(id).status, 'pending');
  assert.equal(await expireDue(e.db, 't2', new Date('2030-01-01T00:00:00Z')), 0);
  assert.equal(e.row(id).status, 'pending');
});

test('checkDecision murni: urutan pemeriksaan', () => {
  const base = { role: 'admin', deciderId: 'a', proposerId: 'b', status: 'pending', action: 'approve' };
  assert.equal(checkDecision(base).ok, true);
  assert.equal(checkDecision({ ...base, role: 'contributor' }).code, 'forbidden');
  assert.equal(checkDecision({ ...base, status: 'expired' }).code, 'expired');
  assert.equal(checkDecision({ ...base, status: 'stale' }).code, 'not_pending');
  assert.equal(checkDecision({ ...base, proposerId: 'a' }).code, 'self_approval');
  assert.equal(checkDecision({ ...base, action: 'reject' }).code, 'reason_required');
});
