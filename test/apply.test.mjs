import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { APPLY_KINDS, applyDirect, approveAndApply, cleanFields, softWarnings } from '../src/apply.js';
import { createProposal } from '../src/proposals.js';

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
  for (const f of ['0001_init', '0002_people_gender', '0003_people_visibility_by_self']) {
    sqlite.exec(readFileSync(new URL(`../migrations/${f}.sql`, import.meta.url), 'utf8'));
  }
  sqlite.exec(`
    INSERT INTO accounts(id,email) VALUES ('owner','o@x'),('admin','a@x'),('contrib','c@x'),('viewer','v@x'),('out','z@x');
    INSERT INTO family_trees(id,name,created_by) VALUES ('t1','Satu','owner'),('t2','Dua','owner');
    INSERT INTO memberships(tree_id,account_id,role,status) VALUES
      ('t1','owner','owner','active'),('t1','admin','admin','active'),('t1','contrib','contributor','active'),
      ('t1','viewer','viewer','active'),('t2','owner','owner','active');
    INSERT INTO people(id,tree_id,display_name,birth_date,birth_precision) VALUES ('p1','t1','Budi','1990','year'),('p2','t2','Citra',NULL,'unknown');
  `);
  const db = fakeD1(sqlite);
  const count = (sql, ...p) => sqlite.prepare(sql).get(...p).n;
  const person = (id) => sqlite.prepare('SELECT * FROM people WHERE id = ?').get(id);
  const prop = (id) => sqlite.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
  const audits = (action) => count('SELECT COUNT(*) n FROM audit_events WHERE action = ?', action);
  return { sqlite, db, count, person, prop, audits };
}

const T0 = new Date('2026-11-19T10:00:00Z');
const propose = (e, over = {}) =>
  createProposal(e.db, { treeId: 't1', proposerId: 'contrib', kind: 'person_edit', targetPersonId: 'p1', after: { display_name: 'Budi Santoso' }, now: T0, ...over });
const approve = (e, id, who = 'admin') => approveAndApply(e.db, { treeId: 't1', proposalId: id, deciderId: who, now: T0 });

test('cleanFields: field di luar daftar ditolak, termasuk privasi, id, dan tree_id', () => {
  for (const k of ['birth_visibility', 'visibility_by_self', 'id', 'tree_id', 'version', 'archived_at', 'is_placeholder']) {
    assert.equal(cleanFields({ [k]: 1 }).code, 'unknown_field', k);
  }
});

test('cleanFields: nama, panjang teks, enum, dan pembersihan', () => {
  assert.equal(cleanFields({ display_name: '   ' }).code, 'name_required');
  assert.equal(cleanFields({ display_name: null }).code, 'name_required');
  assert.equal(cleanFields({ display_name: 'x'.repeat(201) }).code, 'display_name_too_long');
  assert.equal(cleanFields({ source_note: 'x'.repeat(501) }).code, 'source_note_too_long');
  assert.equal(cleanFields({ display_name: 5 }).code, 'invalid_display_name');
  assert.equal(cleanFields({ gender: 'x' }).code, 'invalid_gender');
  assert.equal(cleanFields({ confirmation: null }).code, 'invalid_confirmation');
  assert.deepEqual(cleanFields({ display_name: ' A ', nickname: '  ', gender: null }).values, { display_name: 'A', nickname: null, gender: null });
  assert.equal(cleanFields({ display_name: '😀'.repeat(200) }).ok, true);
});

test('cleanFields: tanggal harus berpasangan dengan presisi dan konsisten', () => {
  assert.equal(cleanFields({ birth_date: '1990' }).code, 'date_pair_required');
  assert.equal(cleanFields({ birth_precision: 'year' }).code, 'date_pair_required');
  assert.equal(cleanFields({ birth_date: '1990-05-17', birth_precision: 'year' }).code, 'invalid_birth_date');
  assert.equal(cleanFields({ birth_date: '1990', birth_precision: 'full' }).code, 'invalid_birth_date');
  assert.equal(cleanFields({ birth_date: '1990-02-30', birth_precision: 'full' }).code, 'invalid_birth_date');
  assert.equal(cleanFields({ birth_date: '1990', birth_precision: 'unknown' }).code, 'invalid_birth_date');
  assert.equal(cleanFields({ death_date: 'abcd', birth_date: null, birth_precision: 'unknown', death_precision: 'approx' }).code, 'invalid_death_date');
  assert.equal(cleanFields({ birth_date: '1990-05-17', birth_precision: 'full' }).ok, true);
  assert.equal(cleanFields({ birth_date: '1950', birth_precision: 'approx' }).ok, true);
  assert.equal(cleanFields({ birth_date: null, birth_precision: 'unknown' }).ok, true);
});

test('cleanFields: create wajib nama, edit tidak boleh kosong', () => {
  assert.equal(cleanFields({ nickname: 'x' }, { create: true }).code, 'name_required');
  assert.equal(cleanFields({}).code, 'empty_change');
  assert.equal(cleanFields(null).code, 'invalid_payload');
  assert.equal(cleanFields([]).code, 'invalid_payload');
});

test('softWarnings: meninggal sebelum lahir dan usia di atas 120, tanpa memblokir', () => {
  const w = (o) => softWarnings({ birth_precision: 'unknown', death_precision: 'unknown', ...o }, T0);
  assert.deepEqual(w({ birth_date: '1990', birth_precision: 'year', death_date: '1980', death_precision: 'year' }), ['death_before_birth']);
  assert.deepEqual(w({ birth_date: '1990-05-17', birth_precision: 'full', death_date: '1990-05-16', death_precision: 'full' }), ['death_before_birth']);
  assert.deepEqual(w({ birth_date: '1990-05-17', birth_precision: 'full', death_date: '1990-05-17', death_precision: 'full' }), []);
  assert.deepEqual(w({ birth_date: '1850', birth_precision: 'year' }), ['age_over_120']);
  assert.deepEqual(w({ birth_date: '1850', birth_precision: 'year', death_date: '1900', death_precision: 'year' }), []);
  assert.deepEqual(w({ birth_date: '1850', birth_precision: 'year', death_date: '1990', death_precision: 'year' }), ['age_over_120']);
  assert.deepEqual(w({ birth_date: '1850', birth_precision: 'unknown' }), []);
  assert.deepEqual(w({}), []);
});

test('setujui person_edit: data berubah, versi naik, audit sebelum/sesudah, usulan ditutup', async () => {
  const e = env();
  const { id } = await propose(e, { after: { display_name: 'Budi Santoso', nickname: 'Bud' } });
  const r = await approve(e, id);
  assert.equal(r.ok, true);
  assert.equal(r.personId, 'p1');
  const p = e.person('p1');
  assert.equal(p.display_name, 'Budi Santoso');
  assert.equal(p.nickname, 'Bud');
  assert.equal(p.version, 2);
  assert.equal(e.prop(id).status, 'approved');
  const a = e.sqlite.prepare("SELECT * FROM audit_events WHERE action='person.update'").get();
  assert.equal(a.target_id, 'p1');
  assert.equal(a.actor_id, 'admin');
  assert.deepEqual(JSON.parse(a.before_json), { display_name: 'Budi', nickname: null });
  assert.deepEqual(JSON.parse(a.after_json), { display_name: 'Budi Santoso', nickname: 'Bud' });
  assert.equal(a.approval_note, `proposal:${id}`);
  assert.equal(e.audits('proposal.approve'), 1);
});

test('setujui person_edit: pengaturan privasi tidak tersentuh', async () => {
  const e = env();
  const { id } = await propose(e, { after: { display_name: 'X' } });
  await approve(e, id);
  const p = e.person('p1');
  assert.equal(p.birth_visibility, 'year');
  assert.equal(p.visibility_by_self, 0);
});

test('setujui: usulan lain pada orang yang sama menjadi stale, yang tanpa target tidak', async () => {
  const e = env();
  const a = await propose(e);
  const b = await propose(e, { after: { nickname: 'B' } });
  const c = await propose(e, { kind: 'person_create', targetPersonId: null, after: { display_name: 'Baru' } });
  await approve(e, a.id);
  assert.equal(e.prop(b.id).status, 'stale');
  assert.equal(e.prop(c.id).status, 'pending');
  assert.equal(e.prop(a.id).status, 'approved');
  assert.equal(e.audits('proposal.stale'), 1);
});

test('setujui person_create: orang baru dibuat oleh pengaju, bawaan terisi, audit tercatat', async () => {
  const e = env();
  const { id } = await propose(e, { kind: 'person_create', targetPersonId: null, after: { display_name: 'Dewi', gender: 'female', birth_date: '1999', birth_precision: 'year' } });
  const r = await approve(e, id);
  assert.equal(r.ok, true);
  const p = e.person(r.personId);
  assert.equal(p.tree_id, 't1');
  assert.equal(p.display_name, 'Dewi');
  assert.equal(p.created_by, 'contrib');
  assert.equal(p.gender, 'female');
  assert.equal(p.birth_visibility, 'year');
  assert.equal(p.confirmation, 'unverified');
  assert.equal(e.count("SELECT COUNT(*) n FROM audit_events WHERE action='person.create' AND target_id=?", r.personId), 1);
  assert.equal(e.count('SELECT COUNT(*) n FROM people WHERE tree_id = ?', 't1'), 2);
});

test('jenis yang belum didukung: ditolak sebelum usulan ditutup, data utuh', async () => {
  const e = env();
  assert.deepEqual(APPLY_KINDS, ['person_edit', 'person_create']);
  for (const kind of ['partnership', 'parent_child', 'archive', 'archive_restore', 'merge', 'unmerge']) {
    const { id } = await propose(e, { kind, targetPersonId: null, after: { x: 1 } });
    assert.equal((await approve(e, id)).code, 'kind_not_supported', kind);
    assert.equal(e.prop(id).status, 'pending', kind);
  }
  assert.equal(e.audits('proposal.approve'), 0);
});

test('izin dan pengaju sendiri: tidak ada yang diterapkan', async () => {
  const e = env();
  const { id } = await propose(e);
  for (const who of ['contrib', 'viewer', 'out']) assert.equal((await approve(e, id, who)).code, 'forbidden', who);
  const own = await propose(e, { proposerId: 'admin', after: { display_name: 'Sendiri' } });
  assert.equal((await approve(e, own.id, 'admin')).code, 'self_approval');
  assert.equal(e.person('p1').display_name, 'Budi');
  assert.equal(e.person('p1').version, 1);
});

test('isi usulan tidak valid saat penerapan: tidak ditutup, tidak ada perubahan', async () => {
  const e = env();
  for (const after of [{ birth_visibility: 'full' }, { display_name: '' }, { birth_date: '1990' }, {}]) {
    const { id } = await propose(e, { after });
    const r = await approve(e, id);
    assert.equal(r.ok, false, JSON.stringify(after));
    assert.equal(e.prop(id).status, 'pending');
  }
  assert.equal(e.person('p1').version, 1);
  assert.equal(e.person('p1').birth_visibility, 'year');
});

test('setujui dua kali oleh orang yang sama pada detik yang sama: hanya sekali diterapkan', async () => {
  const e = env();
  const { id } = await propose(e);
  assert.equal((await approve(e, id)).ok, true);
  assert.equal((await approve(e, id)).code, 'not_pending');
  assert.equal(e.person('p1').version, 2);
  assert.equal(e.audits('person.update'), 1);
  const c = await propose(e, { kind: 'person_create', targetPersonId: null, after: { display_name: 'Satu' } });
  await approve(e, c.id);
  await approve(e, c.id);
  assert.equal(e.count("SELECT COUNT(*) n FROM people WHERE display_name='Satu'"), 1);
});

test('balapan: penyetuju lain menutup tepat sebelum batch kita, tidak ada yang diterapkan', async () => {
  const e = env();
  const { id } = await propose(e);
  const real = e.db.batch.bind(e.db);
  let call = 0;
  e.db.batch = async (stmts) => {
    call += 1; // #1 expireDue, #2 batch penerapan kita
    if (call === 2) e.sqlite.prepare("UPDATE proposals SET status='rejected', decided_by='owner', decided_at='2026-11-19 10:00:00', rejection_reason='x' WHERE id=?").run(id);
    return real(stmts);
  };
  const r = await approve(e, id);
  assert.equal(call, 2);
  assert.equal(r.code, 'not_pending');
  assert.equal(e.person('p1').version, 1);
  assert.equal(e.person('p1').display_name, 'Budi');
  assert.equal(e.audits('person.update'), 0);
  assert.equal(e.audits('proposal.approve'), 0);
});

test('target diarsipkan, hilang, atau milik pohon lain: ditolak dan usulan tetap pending', async () => {
  const e = env();
  const a = await propose(e);
  e.sqlite.prepare("UPDATE people SET archived_at='2026-01-01' WHERE id='p1'").run();
  assert.equal((await approve(e, a.id)).code, 'target_archived');
  e.sqlite.prepare("INSERT INTO proposals(id,tree_id,kind,target_person_id,after_json,proposer_id,expires_at) VALUES ('x','t1','person_edit','p2','{\"display_name\":\"Bocor\"}','contrib','2099-01-01 00:00:00')").run();
  assert.equal((await approve(e, 'x')).code, 'target_not_found');
  assert.equal(e.person('p2').display_name, 'Citra');
  assert.equal(e.prop('x').status, 'pending');
  assert.equal(e.prop(a.id).status, 'pending');
});

test('usulan kedaluwarsa tidak diterapkan', async () => {
  const e = env();
  const { id } = await propose(e);
  const r = await approveAndApply(e.db, { treeId: 't1', proposalId: id, deciderId: 'admin', now: new Date('2026-12-20T00:00:00Z') });
  assert.equal(r.code, 'expired');
  assert.equal(e.person('p1').version, 1);
});

test('peringatan lunak dikembalikan tapi tidak memblokir penerapan', async () => {
  const e = env();
  const { id } = await propose(e, { after: { death_date: '1980', death_precision: 'year' } });
  const r = await approve(e, id);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, ['death_before_birth']);
  assert.equal(e.person('p1').death_date, '1980');
});

test('langsung: Admin dan Owner mengubah dan membuat tanpa usulan, tercatat di audit', async () => {
  const e = env();
  for (const who of ['admin', 'owner']) {
    const r = await applyDirect(e.db, { treeId: 't1', actorId: who, kind: 'person_edit', targetPersonId: 'p1', after: { nickname: who }, now: T0 });
    assert.equal(r.ok, true, who);
    assert.equal(e.person('p1').nickname, who);
  }
  const c = await applyDirect(e.db, { treeId: 't1', actorId: 'admin', kind: 'person_create', after: { display_name: 'Baru' }, now: T0 });
  assert.equal(c.ok, true);
  assert.equal(e.person(c.personId).created_by, 'admin');
  assert.equal(e.audits('person.update'), 2);
  assert.equal(e.audits('person.create'), 1);
  assert.equal(e.count('SELECT COUNT(*) n FROM proposals'), 0);
});

test('langsung: Contributor diarahkan ke usulan, Viewer dan orang luar ditolak, jenis lain tidak didukung', async () => {
  const e = env();
  const d = (who, kind = 'person_edit') => applyDirect(e.db, { treeId: 't1', actorId: who, kind, targetPersonId: 'p1', after: { nickname: 'x' }, now: T0 });
  assert.equal((await d('contrib')).code, 'needs_proposal');
  assert.equal((await d('viewer')).code, 'forbidden');
  assert.equal((await d('out')).code, 'forbidden');
  assert.equal((await d('admin', 'parent_child')).code, 'kind_not_supported');
  assert.equal(e.person('p1').nickname, null);
  assert.equal(e.person('p1').version, 1);
});

test('langsung: validasi tetap berlaku dan perubahan langsung membuat usulan lain pada orang itu stale', async () => {
  const e = env();
  const bad = await applyDirect(e.db, { treeId: 't1', actorId: 'admin', kind: 'person_edit', targetPersonId: 'p1', after: { birth_visibility: 'full' }, now: T0 });
  assert.equal(bad.code, 'unknown_field');
  const { id } = await propose(e);
  await applyDirect(e.db, { treeId: 't1', actorId: 'admin', kind: 'person_edit', targetPersonId: 'p1', after: { nickname: 'D' }, now: T0 });
  assert.equal(e.prop(id).status, 'stale');
  assert.equal(e.audits('proposal.stale'), 1);
});

test('langsung: target pohon lain tidak bisa diubah', async () => {
  const e = env();
  const r = await applyDirect(e.db, { treeId: 't1', actorId: 'admin', kind: 'person_edit', targetPersonId: 'p2', after: { display_name: 'Bocor' }, now: T0 });
  assert.equal(r.code, 'target_not_found');
  assert.equal(e.person('p2').display_name, 'Citra');
});
