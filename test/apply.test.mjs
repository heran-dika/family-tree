import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { APPLY_KINDS, applyDirect, approveAndApply, cleanEdge, cleanFields, cleanPartnership, partnershipWarnings, softWarnings } from '../src/apply.js';
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
  for (const f of ['0001_init', '0002_people_gender', '0003_people_visibility_by_self', '0004_partnership_unique_pair', '0005_edge_unique_pair']) {
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
  assert.deepEqual(cleanFields({ display_name: ' A ', source_note: '  ', gender: null }).values, { display_name: 'A', source_note: null, gender: null });
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
  assert.equal(cleanFields({ source_note: 'x' }, { create: true }).code, 'name_required');
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
  const { id } = await propose(e, { after: { display_name: 'Budi Santoso', source_note: 'Bud' } });
  const r = await approve(e, id);
  assert.equal(r.ok, true);
  assert.equal(r.personId, 'p1');
  const p = e.person('p1');
  assert.equal(p.display_name, 'Budi Santoso');
  assert.equal(p.source_note, 'Bud');
  assert.equal(p.version, 2);
  assert.equal(e.prop(id).status, 'approved');
  const a = e.sqlite.prepare("SELECT * FROM audit_events WHERE action='person.update'").get();
  assert.equal(a.target_id, 'p1');
  assert.equal(a.actor_id, 'admin');
  assert.deepEqual(JSON.parse(a.before_json), { display_name: 'Budi', source_note: null });
  assert.deepEqual(JSON.parse(a.after_json), { display_name: 'Budi Santoso', source_note: 'Bud' });
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
  const b = await propose(e, { after: { source_note: 'B' } });
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
  assert.deepEqual(APPLY_KINDS, ['person_edit', 'person_create', 'partnership', 'parent_child', 'archive']);
  for (const kind of ['archive_restore', 'merge', 'unmerge']) {
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
    const r = await applyDirect(e.db, { treeId: 't1', actorId: who, kind: 'person_edit', targetPersonId: 'p1', after: { source_note: who }, now: T0 });
    assert.equal(r.ok, true, who);
    assert.equal(e.person('p1').source_note, who);
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
  const d = (who, kind = 'person_edit') => applyDirect(e.db, { treeId: 't1', actorId: who, kind, targetPersonId: 'p1', after: { source_note: 'x' }, now: T0 });
  assert.equal((await d('contrib')).code, 'needs_proposal');
  assert.equal((await d('viewer')).code, 'forbidden');
  assert.equal((await d('out')).code, 'forbidden');
  assert.equal((await d('admin', 'merge')).code, 'kind_not_supported');
  assert.equal(e.person('p1').source_note, null);
  assert.equal(e.person('p1').version, 1);
});

test('langsung: validasi tetap berlaku dan perubahan langsung membuat usulan lain pada orang itu stale', async () => {
  const e = env();
  const bad = await applyDirect(e.db, { treeId: 't1', actorId: 'admin', kind: 'person_edit', targetPersonId: 'p1', after: { birth_visibility: 'full' }, now: T0 });
  assert.equal(bad.code, 'unknown_field');
  const { id } = await propose(e);
  await applyDirect(e.db, { treeId: 't1', actorId: 'admin', kind: 'person_edit', targetPersonId: 'p1', after: { source_note: 'D' }, now: T0 });
  assert.equal(e.prop(id).status, 'stale');
  assert.equal(e.audits('proposal.stale'), 1);
});

test('langsung: target pohon lain tidak bisa diubah', async () => {
  const e = env();
  const r = await applyDirect(e.db, { treeId: 't1', actorId: 'admin', kind: 'person_edit', targetPersonId: 'p2', after: { display_name: 'Bocor' }, now: T0 });
  assert.equal(r.code, 'target_not_found');
  assert.equal(e.person('p2').display_name, 'Citra');
});

// ---------- pasangan ----------
const addPeople = (e) =>
  e.sqlite.exec("INSERT INTO people(id,tree_id,display_name) VALUES ('p3','t1','Siti'),('p4','t1','Ani'),('p5','t1','Rina')");
const part = (e, id) => e.sqlite.prepare('SELECT * FROM partnerships WHERE id = ?').get(id);
const nPart = (e) => e.count('SELECT COUNT(*) n FROM partnerships');
const mk = (over = {}) => ({ action: 'create', person_a: 'p1', person_b: 'p3', status: 'married', ...over });

test('cleanPartnership: field, aksi, orang, status, dan tahun divalidasi', () => {
  assert.equal(cleanPartnership(null).code, 'invalid_payload');
  assert.equal(cleanPartnership({}).code, 'invalid_action');
  assert.equal(cleanPartnership(mk({ action: 'remove' })).code, 'invalid_action');
  assert.equal(cleanPartnership(mk({ tree_id: 'x' })).code, 'unknown_field');
  assert.equal(cleanPartnership(mk({ order: 1 })).code, 'unknown_field');
  assert.equal(cleanPartnership(mk({ person_b: 'p1' })).code, 'same_person');
  assert.equal(cleanPartnership(mk({ person_a: '' })).code, 'invalid_person_a');
  assert.equal(cleanPartnership(mk({ person_b: undefined })).code, 'invalid_person_b');
  assert.equal(cleanPartnership(mk({ status: 'pertama' })).code, 'invalid_status');
  assert.equal(cleanPartnership({ action: 'create', person_a: 'a', person_b: 'b' }).code, 'invalid_status');
  for (const bad of [1.5, 999, 10000, '2000', NaN]) assert.equal(cleanPartnership(mk({ start_year: bad })).code, 'invalid_start_year', String(bad));
  assert.equal(cleanPartnership(mk({ end_year: 'x' })).code, 'invalid_end_year');
  assert.deepEqual(cleanPartnership(mk()).values, { person_a: 'p1', person_b: 'p3', status: 'married', start_year: null, end_year: null });
  for (const status of ['married', 'divorced', 'separated', 'partner_deceased', 'unknown']) assert.equal(cleanPartnership(mk({ status })).ok, true, status);
});

test('cleanPartnership update: siapa pasangannya tidak bisa diubah, minimal satu perubahan', () => {
  const u = (o) => ({ action: 'update', partnership_id: 'x', ...o });
  assert.equal(cleanPartnership(u({ person_a: 'p1' })).code, 'unknown_field');
  assert.equal(cleanPartnership(u({ person_b: 'p1' })).code, 'unknown_field');
  assert.equal(cleanPartnership(u({})).code, 'empty_change');
  assert.equal(cleanPartnership({ action: 'update', status: 'divorced' }).code, 'invalid_partnership_id');
  assert.deepEqual(cleanPartnership(u({ status: 'divorced', end_year: 2002 })).values, { partnership_id: 'x', status: 'divorced', end_year: 2002 });
});

test('partnershipWarnings: hanya tahun akhir sebelum tahun mulai', () => {
  assert.deepEqual(partnershipWarnings({ start_year: 2000, end_year: 1990 }), ['end_before_start']);
  assert.deepEqual(partnershipWarnings({ start_year: 2000, end_year: 2000 }), []);
  assert.deepEqual(partnershipWarnings({ start_year: null, end_year: 1990 }), []);
  assert.deepEqual(partnershipWarnings({}), []);
});

test('setujui pasangan baru: baris dibuat, audit bertipe partnership, usulan ditutup, orang tidak diubah', async () => {
  const e = env();
  addPeople(e);
  const other = await propose(e); // person_edit pada p1 harus tetap pending
  const { id } = await propose(e, { kind: 'partnership', targetPersonId: null, after: mk({ start_year: 2010 }) });
  const r = await approve(e, id);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
  const row = part(e, r.partnershipId);
  assert.deepEqual({ a: row.person_a, b: row.person_b, s: row.status, y: row.start_year, z: row.end_year, t: row.tree_id }, { a: 'p1', b: 'p3', s: 'married', y: 2010, z: null, t: 't1' });
  const a = e.sqlite.prepare("SELECT * FROM audit_events WHERE action='partnership.create'").get();
  assert.equal(a.target_type, 'partnership');
  assert.equal(a.target_id, r.partnershipId);
  assert.equal(a.approval_note, `proposal:${id}`);
  assert.equal(e.prop(id).status, 'approved');
  assert.equal(e.prop(other.id).status, 'pending');
  assert.equal(e.person('p1').version, 1);
});

test('beberapa pasangan bersamaan: diizinkan tanpa peringatan apa pun', async () => {
  const e = env();
  addPeople(e);
  for (const b of ['p3', 'p4', 'p5']) {
    const r = await applyDirect(e.db, { treeId: 't1', actorId: 'admin', kind: 'partnership', after: mk({ person_b: b }), now: T0 });
    assert.equal(r.ok, true, b);
    assert.deepEqual(r.warnings, []);
  }
  assert.equal(nPart(e), 3);
});

test('setujui perubahan pasangan: status dan tahun berubah, sebelum/sesudah tercatat, orang pasangan tetap', async () => {
  const e = env();
  addPeople(e);
  const c = await applyDirect(e.db, { treeId: 't1', actorId: 'admin', kind: 'partnership', after: mk({ start_year: 2000 }), now: T0 });
  const { id } = await propose(e, { kind: 'partnership', targetPersonId: null, after: { action: 'update', partnership_id: c.partnershipId, status: 'divorced', end_year: 2010 } });
  const r = await approve(e, id, 'owner');
  assert.equal(r.ok, true);
  const row = part(e, c.partnershipId);
  assert.deepEqual({ a: row.person_a, b: row.person_b, s: row.status, y: row.start_year, z: row.end_year }, { a: 'p1', b: 'p3', s: 'divorced', y: 2000, z: 2010 });
  const a = e.sqlite.prepare("SELECT * FROM audit_events WHERE action='partnership.update'").get();
  assert.deepEqual(JSON.parse(a.before_json), { status: 'married', end_year: null });
  assert.deepEqual(JSON.parse(a.after_json), { status: 'divorced', end_year: 2010 });
});

test('cerai tidak menyentuh relasi orang tua-anak (syarat rilis PRD)', async () => {
  const e = env();
  addPeople(e);
  e.sqlite.exec("INSERT INTO parent_child_edges(id,tree_id,parent_id,child_id,relation_type) VALUES ('e1','t1','p1','p4','biological'),('e2','t1','p3','p4','biological')");
  const c = await applyDirect(e.db, { treeId: 't1', actorId: 'admin', kind: 'partnership', after: mk(), now: T0 });
  await applyDirect(e.db, { treeId: 't1', actorId: 'admin', kind: 'partnership', after: { action: 'update', partnership_id: c.partnershipId, status: 'divorced', end_year: 2005 }, now: T0 });
  assert.equal(e.count('SELECT COUNT(*) n FROM parent_child_edges'), 2);
});

test('pasangan dobel ditolak, urutan A/B terbalik pun, dan usulannya tetap pending', async () => {
  const e = env();
  addPeople(e);
  assert.equal((await applyDirect(e.db, { treeId: 't1', actorId: 'admin', kind: 'partnership', after: mk(), now: T0 })).ok, true);
  const rev = await applyDirect(e.db, { treeId: 't1', actorId: 'admin', kind: 'partnership', after: mk({ person_a: 'p3', person_b: 'p1', status: 'divorced' }), now: T0 });
  assert.equal(rev.code, 'duplicate_partnership');
  const { id } = await propose(e, { kind: 'partnership', targetPersonId: null, after: mk({ person_a: 'p3', person_b: 'p1' }) });
  assert.equal((await approve(e, id)).code, 'duplicate_partnership');
  assert.equal(e.prop(id).status, 'pending');
  assert.equal(nPart(e), 1);
});

test('balapan pasangan dobel: indeks unik membatalkan seluruh batch, usulan tidak ditutup, tanpa audit', async () => {
  const e = env();
  addPeople(e);
  const { id } = await propose(e, { kind: 'partnership', targetPersonId: null, after: mk() });
  const real = e.db.batch.bind(e.db);
  let call = 0;
  e.db.batch = async (stmts) => {
    call += 1; // #1 expireDue, #2 batch penerapan
    if (call === 2) e.sqlite.exec("INSERT INTO partnerships(id,tree_id,person_a,person_b,status) VALUES ('x','t1','p3','p1','married')");
    return real(stmts);
  };
  const r = await approve(e, id);
  assert.equal(r.code, 'duplicate_partnership');
  assert.equal(e.prop(id).status, 'pending');
  assert.equal(e.audits('partnership.create'), 0);
  assert.equal(e.audits('proposal.approve'), 0);
  assert.equal(nPart(e), 1);
});

test('indeks unik di database menolak pasangan dobel walau dimasukkan langsung', () => {
  const e = env();
  addPeople(e);
  e.sqlite.exec("INSERT INTO partnerships(id,tree_id,person_a,person_b,status) VALUES ('a','t1','p1','p3','married')");
  assert.throws(() => e.sqlite.exec("INSERT INTO partnerships(id,tree_id,person_a,person_b,status) VALUES ('b','t1','p3','p1','divorced')"), /UNIQUE/);
  e.sqlite.exec("INSERT INTO partnerships(id,tree_id,person_a,person_b,status) VALUES ('c','t1','p1','p4','married')");
});

test('pasangan: orang tidak ada, milik pohon lain, atau diarsipkan ditolak', async () => {
  const e = env();
  addPeople(e);
  const d = (after) => applyDirect(e.db, { treeId: 't1', actorId: 'admin', kind: 'partnership', after, now: T0 });
  assert.equal((await d(mk({ person_b: 'hantu' }))).code, 'person_not_found');
  assert.equal((await d(mk({ person_b: 'p2' }))).code, 'person_not_found'); // p2 milik t2
  e.sqlite.exec("UPDATE people SET archived_at='2026-01-01' WHERE id='p3'");
  assert.equal((await d(mk())).code, 'person_archived');
  assert.equal(nPart(e), 0);
});

test('pasangan: ubah pasangan pohon lain atau yang tidak ada ditolak', async () => {
  const e = env();
  e.sqlite.exec("INSERT INTO people(id,tree_id,display_name) VALUES ('q','t2','Q'); INSERT INTO partnerships(id,tree_id,person_a,person_b,status) VALUES ('x2','t2','p2','q','married')");
  const d = (partnership_id) => applyDirect(e.db, { treeId: 't1', actorId: 'admin', kind: 'partnership', after: { action: 'update', partnership_id, status: 'divorced' }, now: T0 });
  assert.equal((await d('x2')).code, 'partnership_not_found');
  assert.equal((await d('tidak-ada')).code, 'partnership_not_found');
  assert.equal(part(e, 'x2').status, 'married');
});

test('pasangan langsung: Contributor ke usulan, Viewer dan orang luar ditolak, tahun terbalik hanya peringatan', async () => {
  const e = env();
  addPeople(e);
  const d = (who, after = mk()) => applyDirect(e.db, { treeId: 't1', actorId: who, kind: 'partnership', after, now: T0 });
  assert.equal((await d('contrib')).code, 'needs_proposal');
  assert.equal((await d('viewer')).code, 'forbidden');
  assert.equal((await d('out')).code, 'forbidden');
  assert.equal(nPart(e), 0);
  const r = await d('owner', mk({ start_year: 2000, end_year: 1990 }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, ['end_before_start']);
  assert.equal(part(e, r.partnershipId).end_year, 1990);
});

test('pasangan: setujui dua kali oleh orang yang sama hanya sekali diterapkan; izin dan self-approval dijaga', async () => {
  const e = env();
  addPeople(e);
  const { id } = await propose(e, { kind: 'partnership', targetPersonId: null, after: mk() });
  for (const who of ['contrib', 'viewer', 'out']) assert.equal((await approve(e, id, who)).code, 'forbidden', who);
  assert.equal((await approve(e, id)).ok, true);
  assert.equal((await approve(e, id)).code, 'not_pending');
  assert.equal(nPart(e), 1);
  assert.equal(e.audits('partnership.create'), 1);
  const own = await propose(e, { proposerId: 'admin', kind: 'partnership', targetPersonId: null, after: mk({ person_b: 'p4' }) });
  assert.equal((await approve(e, own.id, 'admin')).code, 'self_approval');
  assert.equal(nPart(e), 1);
});

test('pasangan: isi usulan tidak valid saat penerapan tidak menutup usulan', async () => {
  const e = env();
  addPeople(e);
  for (const after of [mk({ status: 'x' }), mk({ person_b: 'p1' }), { action: 'update', partnership_id: 'x' }]) {
    const { id } = await propose(e, { kind: 'partnership', targetPersonId: null, after });
    assert.equal((await approve(e, id)).ok, false);
    assert.equal(e.prop(id).status, 'pending');
  }
  assert.equal(nPart(e), 0);
});

// ---------- hapus pasangan ----------
const del = (partnership_id) => ({ action: 'delete', partnership_id });
const mkPart = async (e, over = {}) =>
  (await applyDirect(e.db, { treeId: 't1', actorId: 'admin', kind: 'partnership', after: mk({ start_year: 2000, ...over }), now: T0 })).partnershipId;

test('cleanPartnership delete: hanya action dan partnership_id', () => {
  assert.deepEqual(cleanPartnership(del('x')), { ok: true, action: 'delete', values: { partnership_id: 'x' } });
  assert.equal(cleanPartnership({ action: 'delete' }).code, 'invalid_partnership_id');
  assert.equal(cleanPartnership({ ...del('x'), status: 'divorced' }).code, 'unknown_field');
  assert.equal(cleanPartnership({ ...del('x'), person_a: 'p1' }).code, 'unknown_field');
});

test('hapus langsung oleh Admin dan Owner: baris hilang, audit memuat isi lengkap sebelum dihapus', async () => {
  const e = env();
  addPeople(e);
  for (const [who, b] of [['admin', 'p3'], ['owner', 'p4']]) {
    const id = await mkPart(e, { person_b: b });
    const r = await applyDirect(e.db, { treeId: 't1', actorId: who, kind: 'partnership', after: del(id), now: T0 });
    assert.equal(r.ok, true, who);
    assert.equal(r.partnershipId, id);
    assert.equal(part(e, id), undefined);
  }
  assert.equal(nPart(e), 0);
  const a = e.sqlite.prepare("SELECT * FROM audit_events WHERE action='partnership.delete' ORDER BY rowid").get();
  assert.equal(a.target_type, 'partnership');
  assert.deepEqual(JSON.parse(a.before_json), { person_a: 'p1', person_b: 'p3', status: 'married', start_year: 2000, end_year: null });
  assert.equal(a.after_json, null);
  assert.equal(e.audits('partnership.delete'), 2);
});

test('setelah dihapus, pasangan yang sama bisa dibuat ulang; relasi orang tua-anak dan orangnya utuh', async () => {
  const e = env();
  addPeople(e);
  e.sqlite.exec("INSERT INTO parent_child_edges(id,tree_id,parent_id,child_id,relation_type) VALUES ('e1','t1','p1','p4','biological')");
  const id = await mkPart(e);
  await applyDirect(e.db, { treeId: 't1', actorId: 'admin', kind: 'partnership', after: del(id), now: T0 });
  const again = await applyDirect(e.db, { treeId: 't1', actorId: 'admin', kind: 'partnership', after: mk({ person_a: 'p3', person_b: 'p1' }), now: T0 });
  assert.equal(again.ok, true);
  assert.equal(e.count('SELECT COUNT(*) n FROM parent_child_edges'), 1);
  assert.equal(e.count('SELECT COUNT(*) n FROM people WHERE tree_id = ?', 't1'), 4);
});

test('hapus langsung: Contributor ke usulan, Viewer dan orang luar ditolak, baris tetap', async () => {
  const e = env();
  addPeople(e);
  const id = await mkPart(e);
  for (const [who, code] of [['contrib', 'needs_proposal'], ['viewer', 'forbidden'], ['out', 'forbidden']]) {
    assert.equal((await applyDirect(e.db, { treeId: 't1', actorId: who, kind: 'partnership', after: del(id), now: T0 })).code, code, who);
  }
  assert.ok(part(e, id));
});

test('hapus lewat usulan Contributor: Admin menyetujui, baris hilang, usulan ditutup, sekali saja', async () => {
  const e = env();
  addPeople(e);
  const pid = await mkPart(e);
  const { id } = await propose(e, { kind: 'partnership', targetPersonId: null, after: del(pid) });
  for (const who of ['contrib', 'viewer', 'out']) assert.equal((await approve(e, id, who)).code, 'forbidden', who);
  assert.ok(part(e, pid));
  assert.equal((await approve(e, id)).ok, true);
  assert.equal(part(e, pid), undefined);
  assert.equal(e.prop(id).status, 'approved');
  assert.equal((await approve(e, id)).code, 'not_pending');
  assert.equal(e.audits('partnership.delete'), 1);
  const a = e.sqlite.prepare("SELECT approval_note n FROM audit_events WHERE action='partnership.delete'").get();
  assert.equal(a.n, `proposal:${id}`);
});

test('hapus: pengaju sendiri tidak bisa menyetujui, pasangan tidak ada atau milik pohon lain ditolak', async () => {
  const e = env();
  addPeople(e);
  const pid = await mkPart(e);
  const own = await propose(e, { proposerId: 'admin', kind: 'partnership', targetPersonId: null, after: del(pid) });
  assert.equal((await approve(e, own.id, 'admin')).code, 'self_approval');
  assert.ok(part(e, pid));
  e.sqlite.exec("INSERT INTO people(id,tree_id,display_name) VALUES ('q','t2','Q'); INSERT INTO partnerships(id,tree_id,person_a,person_b,status) VALUES ('x2','t2','p2','q','married')");
  const d = (id) => applyDirect(e.db, { treeId: 't1', actorId: 'admin', kind: 'partnership', after: del(id), now: T0 });
  assert.equal((await d('x2')).code, 'partnership_not_found');
  assert.equal((await d('tidak-ada')).code, 'partnership_not_found');
  assert.ok(part(e, 'x2'));
  const ghost = await propose(e, { kind: 'partnership', targetPersonId: null, after: del('tidak-ada') });
  assert.equal((await approve(e, ghost.id)).code, 'partnership_not_found');
  assert.equal(e.prop(ghost.id).status, 'pending');
});

test('hapus idempoten: baris sudah dihapus pihak lain tepat sebelum batch, tanpa audit palsu', async () => {
  const e = env();
  addPeople(e);
  const pid = await mkPart(e);
  const { id } = await propose(e, { kind: 'partnership', targetPersonId: null, after: del(pid) });
  const real = e.db.batch.bind(e.db);
  let call = 0;
  e.db.batch = async (stmts) => {
    call += 1; // #1 expireDue, #2 batch penerapan
    if (call === 2) e.sqlite.prepare('DELETE FROM partnerships WHERE id = ?').run(pid);
    return real(stmts);
  };
  const r = await approve(e, id);
  assert.equal(r.ok, true);
  assert.equal(e.audits('partnership.delete'), 0);
  assert.equal(e.prop(id).status, 'approved');
});

test('hapus: usulan ubah yang menyasar pasangan yang sudah dihapus ditolak saat disetujui', async () => {
  const e = env();
  addPeople(e);
  const pid = await mkPart(e);
  const upd = await propose(e, { kind: 'partnership', targetPersonId: null, after: { action: 'update', partnership_id: pid, status: 'divorced' } });
  await applyDirect(e.db, { treeId: 't1', actorId: 'admin', kind: 'partnership', after: del(pid), now: T0 });
  assert.equal((await approve(e, upd.id)).code, 'partnership_not_found');
  assert.equal(e.prop(upd.id).status, 'pending');
  assert.equal(nPart(e), 0);
});

test('hapus: penyetuju lain menolak usulan tepat sebelum batch kita, baris tidak dihapus dan tanpa audit', async () => {
  const e = env();
  addPeople(e);
  const pid = await mkPart(e);
  const { id } = await propose(e, { kind: 'partnership', targetPersonId: null, after: del(pid) });
  const real = e.db.batch.bind(e.db);
  let call = 0;
  e.db.batch = async (stmts) => {
    call += 1; // #1 expireDue, #2 batch penerapan
    if (call === 2) e.sqlite.prepare("UPDATE proposals SET status='rejected', decided_by='owner', decided_at='2026-11-19 10:00:00', rejection_reason='x' WHERE id=?").run(id);
    return real(stmts);
  };
  const r = await approve(e, id);
  assert.equal(r.code, 'not_pending');
  assert.ok(part(e, pid));
  assert.equal(e.audits('partnership.delete'), 0);
  assert.equal(e.audits('proposal.approve'), 0);
});

// ---------- relasi orang tua-anak ----------
// a1..a4 tanpa tanggal; old (1950), mid (1980), young (2000) untuk peringatan umur.
const addTree = (e) =>
  e.sqlite.exec(`INSERT INTO people(id,tree_id,display_name,birth_date,birth_precision) VALUES
    ('a1','t1','A1',NULL,'unknown'),('a2','t1','A2',NULL,'unknown'),('a3','t1','A3',NULL,'unknown'),('a4','t1','A4',NULL,'unknown'),
    ('old','t1','Old','1950','year'),('mid','t1','Mid','1980','year'),('young','t1','Young','2000','year')`);
const edge = (e, id) => e.sqlite.prepare('SELECT * FROM parent_child_edges WHERE id = ?').get(id);
const nEdge = (e) => e.count('SELECT COUNT(*) n FROM parent_child_edges');
const ec = (over = {}) => ({ action: 'create', parent_id: 'a1', child_id: 'a2', relation_type: 'biological', parent_role: 'father', ...over });
const eprop = (e, after, over = {}) => propose(e, { kind: 'parent_child', targetPersonId: null, after, ...over });
const direct = (e, who, after, treeId = 't1') => applyDirect(e.db, { treeId, actorId: who, kind: 'parent_child', after, now: T0 });
const mkEdge = async (e, over = {}) => {
  const { id } = await eprop(e, ec(over));
  const r = await approve(e, id);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.edgeId;
};

test('cleanEdge create: titik ujung, jenis, peran, dan label divalidasi', () => {
  assert.equal(cleanEdge(null).code, 'invalid_payload');
  assert.equal(cleanEdge({}).code, 'invalid_action');
  assert.equal(cleanEdge({ action: 'constructor' }).code, 'invalid_action');
  assert.equal(cleanEdge(ec({ x: 1 })).code, 'unknown_field');
  assert.equal(cleanEdge(ec({ tree_id: 't2' })).code, 'unknown_field');
  assert.equal(cleanEdge(ec({ relation_type: undefined })).code, 'invalid_relation_type');
  assert.equal(cleanEdge(ec({ relation_type: 'darah' })).code, 'invalid_relation_type');
  assert.equal(cleanEdge(ec({ parent_role: 'kakek' })).code, 'invalid_parent_role');
  // tidak ada peran netral (U3 dicabut): 'parent' ditolak, dan peran wajib diisi
  assert.equal(cleanEdge(ec({ parent_role: 'parent' })).code, 'invalid_parent_role');
  assert.equal(cleanEdge(ec({ parent_role: null })).code, 'invalid_parent_role');
  assert.equal(cleanEdge(ec({ parent_role: undefined })).code, 'invalid_parent_role');
  const { parent_role: _omit, ...noRole } = ec();
  assert.equal(cleanEdge(noRole).code, 'invalid_parent_role');
  assert.equal(cleanEdge({ action: 'update', edge_id: 'x', parent_role: 'parent' }).code, 'invalid_parent_role');
  assert.equal(cleanEdge(ec({ child_id: 'a1' })).code, 'same_person');
  assert.equal(cleanEdge(ec({ child_id: undefined })).code, 'invalid_endpoints');
  assert.equal(cleanEdge(ec({ parent_id: undefined })).code, 'invalid_endpoints');
  assert.equal(cleanEdge(ec({ parent_id: 5 })).code, 'invalid_parent_id');
  assert.equal(cleanEdge(ec({ relation_type: 'custom' })).code, 'custom_label_required');
  assert.equal(cleanEdge(ec({ relation_type: 'custom', custom_label: '   ' })).code, 'custom_label_required');
  assert.equal(cleanEdge(ec({ relation_type: 'custom', custom_label: 'x'.repeat(101) })).code, 'custom_label_too_long');
  assert.equal(cleanEdge(ec({ custom_label: 'Pengasuh' })).code, 'custom_label_not_allowed');
  const ok = cleanEdge(ec());
  assert.deepEqual(ok.values, { relation_type: 'biological', parent_role: 'father', custom_label: null });
  assert.equal(cleanEdge(ec({ relation_type: 'custom', custom_label: ' Pengasuh ', parent_role: 'mother' })).values.custom_label, 'Pengasuh');
  for (const relation_type of ['biological', 'adoptive', 'step', 'guardian']) assert.equal(cleanEdge(ec({ relation_type })).ok, true, relation_type);
});

test('cleanEdge: orang baru sebagai orang tua atau anak, dan penanda placeholder', () => {
  const np = (extra = {}) => ({ display_name: 'Ayah dari A2', ...extra });
  assert.equal(cleanEdge(ec({ parent_id: undefined, new_person: np() })).ok, true); // orang tua baru untuk a2
  assert.equal(cleanEdge(ec({ child_id: undefined, new_person: np() })).ok, true); // anak baru untuk a1
  assert.equal(cleanEdge(ec({ new_person: np() })).code, 'invalid_endpoints'); // dua id sekaligus
  assert.equal(cleanEdge(ec({ parent_id: undefined, child_id: undefined, new_person: np() })).code, 'invalid_endpoints');
  assert.equal(cleanEdge(ec({ parent_id: undefined, new_person: null })).code, 'invalid_payload');
  assert.equal(cleanEdge(ec({ parent_id: undefined, new_person: {} })).code, 'name_required');
  assert.equal(cleanEdge(ec({ parent_id: undefined, new_person: np({ birth_visibility: 'full' }) })).code, 'unknown_field');
  assert.equal(cleanEdge(ec({ parent_id: undefined, new_person: np({ is_placeholder: 'ya' }) })).code, 'invalid_is_placeholder');
  assert.equal(cleanEdge(ec({ child_id: undefined, new_person: np({ is_placeholder: true }) })).code, 'placeholder_only_for_parent');
  const ph = cleanEdge(ec({ parent_id: undefined, new_person: np({ is_placeholder: true }) }));
  assert.equal(ph.person.placeholder, true);
  assert.equal(ph.person.v.is_placeholder, undefined);
});

test('cleanEdge update dan delete', () => {
  const u = (o) => ({ action: 'update', edge_id: 'x', ...o });
  assert.equal(cleanEdge({ action: 'update' }).code, 'invalid_edge_id');
  assert.equal(cleanEdge(u({})).code, 'empty_change');
  assert.equal(cleanEdge(u({ parent_id: 'a' })).code, 'unknown_field');
  assert.equal(cleanEdge(u({ child_id: 'a' })).code, 'unknown_field');
  assert.deepEqual(cleanEdge(u({ relation_type: 'adoptive' })).values, { relation_type: 'adoptive' });
  assert.deepEqual(cleanEdge({ action: 'delete', edge_id: 'x' }), { ok: true, action: 'delete', edgeId: 'x' });
  assert.equal(cleanEdge({ action: 'delete', edge_id: 'x', relation_type: 'step' }).code, 'unknown_field');
  assert.equal(cleanEdge({ action: 'delete' }).code, 'invalid_edge_id');
});

test('setujui relasi: baris dibuat dengan bawaan, audit dari baris sebenarnya, usulan ditutup', async () => {
  const e = env();
  addTree(e);
  const { id } = await eprop(e, ec({ parent_role: 'father' }));
  const r = await approve(e, id);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
  const row = edge(e, r.edgeId);
  assert.deepEqual({ p: row.parent_id, c: row.child_id, t: row.relation_type, role: row.parent_role, l: row.custom_label, tree: row.tree_id }, { p: 'a1', c: 'a2', t: 'biological', role: 'father', l: null, tree: 't1' });
  const a = e.sqlite.prepare("SELECT * FROM audit_events WHERE action='parent_child.create'").get();
  assert.equal(a.target_type, 'parent_child');
  assert.equal(a.target_id, r.edgeId);
  assert.deepEqual(JSON.parse(a.after_json), { parent_id: 'a1', child_id: 'a2', relation_type: 'biological', parent_role: 'father', custom_label: null });
  assert.equal(a.approval_note, `proposal:${id}`);
  assert.equal(e.prop(id).status, 'approved');
});

test('orang tua baru (placeholder): orang dan relasi dibuat bersamaan, placeholder_of menunjuk anak', async () => {
  const e = env();
  addTree(e);
  const { id } = await eprop(e, ec({ parent_id: undefined, parent_role: 'father', new_person: { display_name: 'Ayah dari A2', is_placeholder: true } }));
  const r = await approve(e, id);
  assert.equal(r.ok, true);
  const p = e.person(r.personId);
  assert.deepEqual({ n: p.display_name, ph: p.is_placeholder, of: p.placeholder_of, by: p.created_by, tree: p.tree_id, conf: p.confirmation }, { n: 'Ayah dari A2', ph: 1, of: 'a2', by: 'contrib', tree: 't1', conf: 'unverified' });
  const row = edge(e, r.edgeId);
  assert.equal(row.parent_id, r.personId);
  assert.equal(row.child_id, 'a2');
  assert.equal(e.audits('person.create'), 1);
  assert.equal(e.audits('parent_child.create'), 1);
});

test('anak baru untuk orang yang sudah ada', async () => {
  const e = env();
  addTree(e);
  const { id } = await eprop(e, ec({ child_id: undefined, new_person: { display_name: 'Bayi', birth_date: '2026', birth_precision: 'year' } }));
  const r = await approve(e, id);
  assert.equal(r.ok, true);
  assert.equal(e.person(r.personId).is_placeholder, 0);
  assert.equal(edge(e, r.edgeId).parent_id, 'a1');
  assert.equal(edge(e, r.edgeId).child_id, r.personId);
});

test('siklus: leluhur tidak boleh menjadi keturunannya sendiri, langsung maupun berantai, semua jenis relasi', async () => {
  const e = env();
  addTree(e);
  await mkEdge(e, { parent_id: 'a1', child_id: 'a2' });
  await mkEdge(e, { parent_id: 'a2', child_id: 'a3', relation_type: 'adoptive' });
  await mkEdge(e, { parent_id: 'a3', child_id: 'a4', relation_type: 'guardian' });
  for (const [p, c] of [['a2', 'a1'], ['a3', 'a1'], ['a4', 'a1'], ['a4', 'a2'], ['a3', 'a2']]) {
    const { id } = await eprop(e, ec({ parent_id: p, child_id: c }));
    assert.equal((await approve(e, id)).code, 'would_create_cycle', `${p}->${c}`);
    assert.equal(e.prop(id).status, 'pending');
  }
  assert.equal(nEdge(e), 3);
  const ok = await eprop(e, ec({ parent_id: 'a1', child_id: 'a4' })); // jalur lain, bukan siklus
  assert.equal((await approve(e, ok.id)).ok, true);
});

test('balapan siklus: relasi lawan masuk tepat sebelum batch, seluruh batch dibatalkan', async () => {
  const e = env();
  addTree(e);
  const { id } = await eprop(e, ec({ parent_id: 'a1', child_id: 'a2' }));
  const real = e.db.batch.bind(e.db);
  let call = 0;
  e.db.batch = async (stmts) => {
    call += 1; // #1 expireDue, #2 batch penerapan
    if (call === 2) e.sqlite.exec("INSERT INTO parent_child_edges(id,tree_id,parent_id,child_id,relation_type) VALUES ('rev','t1','a2','a1','biological')");
    return real(stmts);
  };
  const r = await approve(e, id);
  assert.equal(r.code, 'would_create_cycle');
  assert.equal(e.prop(id).status, 'pending');
  assert.equal(nEdge(e), 1);
  assert.equal(e.audits('parent_child.create'), 0);
  assert.equal(e.audits('proposal.approve'), 0);
});

test('balapan siklus dengan orang baru: orang baru juga tidak jadi dibuat', async () => {
  const e = env();
  addTree(e);
  // a1 menjadi anak dari orang baru, sementara a1 sudah menjadi orang tua a2; relasi lawan a2 -> baru tidak mungkin,
  // jadi balapan dibuat lewat usulan biasa dengan orang baru sebagai anak a1 lalu menutup lewat insert langsung.
  const { id } = await eprop(e, ec({ child_id: undefined, new_person: { display_name: 'Baru' } }));
  const real = e.db.batch.bind(e.db);
  let call = 0;
  e.db.batch = async (stmts) => {
    call += 1;
    if (call === 2) e.sqlite.exec("UPDATE proposals SET status='rejected', decided_by='owner', decided_at='2026-11-19 10:00:00', rejection_reason='x' WHERE id='" + id + "'");
    return real(stmts);
  };
  const r = await approve(e, id);
  assert.equal(r.code, 'not_pending');
  assert.equal(e.count("SELECT COUNT(*) n FROM people WHERE display_name='Baru'"), 0);
  assert.equal(nEdge(e), 0);
});

test('relasi dobel untuk pasangan orang yang sama ditolak walau jenisnya beda, dan oleh indeks unik', async () => {
  const e = env();
  addTree(e);
  await mkEdge(e);
  const { id } = await eprop(e, ec({ relation_type: 'adoptive' }));
  assert.equal((await approve(e, id)).code, 'duplicate_edge');
  assert.equal(e.prop(id).status, 'pending');
  const race = await eprop(e, ec({ parent_id: 'a3', child_id: 'a4' }));
  const real = e.db.batch.bind(e.db);
  let call = 0;
  e.db.batch = async (stmts) => {
    call += 1;
    if (call === 2) e.sqlite.exec("INSERT INTO parent_child_edges(id,tree_id,parent_id,child_id,relation_type) VALUES ('x','t1','a3','a4','step')");
    return real(stmts);
  };
  assert.equal((await approve(e, race.id)).code, 'duplicate_edge');
  assert.equal(e.prop(race.id).status, 'pending');
  assert.equal(nEdge(e), 2);
  assert.equal(e.audits('proposal.approve'), 1); // hanya dari mkEdge di awal; usulan yang kalah tidak menambah
});

test('relasi: orang tidak ada, milik pohon lain, diarsipkan ditolak', async () => {
  const e = env();
  addTree(e);
  const t = async (after) => { const { id } = await eprop(e, after); const r = await approve(e, id); assert.equal(e.prop(id).status, 'pending'); return r.code; };
  assert.equal(await t(ec({ child_id: 'hantu' })), 'person_not_found');
  assert.equal(await t(ec({ child_id: 'p2' })), 'person_not_found'); // p2 milik t2
  e.sqlite.exec("UPDATE people SET archived_at='2026-01-01' WHERE id='a2'");
  assert.equal(await t(ec()), 'person_archived');
  assert.equal(await t(ec({ parent_id: undefined, child_id: 'a2', new_person: { display_name: 'X' } })), 'person_archived');
  assert.equal(nEdge(e), 0);
});

test('peringatan umur: hanya relasi biologis, hanya bila tanggal terlihat oleh pelaku', async () => {
  const e = env();
  addTree(e);
  const w = async (after) => { const { id } = await eprop(e, after); return (await approve(e, id)).warnings; };
  assert.deepEqual(await w(ec({ parent_id: 'young', child_id: 'old' })), ['parent_younger_than_child']);
  for (const relation_type of ['adoptive', 'step', 'guardian']) {
    e.sqlite.exec("DELETE FROM parent_child_edges");
    assert.deepEqual(await w(ec({ parent_id: 'young', child_id: 'old', relation_type })), [], relation_type);
  }
  e.sqlite.exec("DELETE FROM parent_child_edges");
  assert.deepEqual(await w(ec({ parent_id: 'old', child_id: 'young' })), []);
  e.sqlite.exec("DELETE FROM parent_child_edges");
  assert.deepEqual(await w(ec({ parent_id: 'a1', child_id: 'old' })), []); // tanggal tidak diketahui
  // tanggal disembunyikan oleh pemiliknya: tidak boleh membocorkan urutan umur
  e.sqlite.exec("DELETE FROM parent_child_edges; UPDATE people SET birth_visibility='hidden', visibility_by_self=1 WHERE id='young'");
  assert.deepEqual(await w(ec({ parent_id: 'young', child_id: 'old' })), []);
  // orang baru yang lebih muda dari anaknya
  e.sqlite.exec("DELETE FROM parent_child_edges");
  assert.deepEqual(await w(ec({ parent_id: undefined, child_id: 'old', new_person: { display_name: 'Muda', birth_date: '2010', birth_precision: 'year' } })), ['parent_younger_than_child']);
});

test('peringatan umur: tidak memblokir dan tanggal lengkap dibandingkan persis', async () => {
  const e = env();
  addTree(e);
  e.sqlite.exec("INSERT INTO people(id,tree_id,display_name,birth_date,birth_precision,birth_visibility,visibility_by_self) VALUES ('f1','t1','F1','1990-06-01','full','full',1),('f2','t1','F2','1990-05-01','full','full',1)");
  const { id } = await eprop(e, ec({ parent_id: 'f1', child_id: 'f2' }));
  const r = await approve(e, id);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, ['parent_younger_than_child']);
  assert.equal(nEdge(e), 1);
});

test('ubah relasi: jenis, peran, dan label; label dibersihkan saat keluar dari custom', async () => {
  const e = env();
  addTree(e);
  const eid = await mkEdge(e, { relation_type: 'adoptive' });
  const up = async (after, who = 'admin') => { const { id } = await eprop(e, { action: 'update', edge_id: eid, ...after }); return approve(e, id, who); };
  assert.equal((await up({ relation_type: 'biological', parent_role: 'mother' })).ok, true);
  assert.deepEqual({ t: edge(e, eid).relation_type, r: edge(e, eid).parent_role }, { t: 'biological', r: 'mother' });
  const a = e.sqlite.prepare("SELECT * FROM audit_events WHERE action='parent_child.update'").get();
  assert.equal(a.target_type, 'parent_child');
  assert.deepEqual(JSON.parse(a.before_json), { relation_type: 'adoptive', parent_role: 'father' });
  assert.deepEqual(JSON.parse(a.after_json), { relation_type: 'biological', parent_role: 'mother' });
  assert.equal((await up({ relation_type: 'custom' })).code, 'custom_label_required');
  assert.equal((await up({ relation_type: 'custom', custom_label: 'Pengasuh' })).ok, true);
  assert.equal(edge(e, eid).custom_label, 'Pengasuh');
  assert.equal((await up({ relation_type: 'step' })).ok, true);
  assert.equal(edge(e, eid).custom_label, null);
  assert.equal((await up({ custom_label: 'Sisa' })).code, 'custom_label_not_allowed');
  assert.equal(edge(e, eid).parent_id, 'a1');
  assert.equal(edge(e, eid).child_id, 'a2');
});

test('ubah relasi ke biologis memunculkan peringatan umur bila orang tuanya lebih muda', async () => {
  const e = env();
  addTree(e);
  const eid = await mkEdge(e, { parent_id: 'young', child_id: 'old', relation_type: 'guardian' });
  const { id } = await eprop(e, { action: 'update', edge_id: eid, relation_type: 'biological' });
  assert.deepEqual((await approve(e, id)).warnings, ['parent_younger_than_child']);
});

test('hapus relasi: baris hilang, audit memuat isi sebelum dihapus, orang dan pasangan utuh, idempoten', async () => {
  const e = env();
  addTree(e);
  e.sqlite.exec("INSERT INTO partnerships(id,tree_id,person_a,person_b,status) VALUES ('s','t1','a1','a3','married')");
  const eid = await mkEdge(e, { relation_type: 'step', parent_role: 'mother' });
  const { id } = await eprop(e, { action: 'delete', edge_id: eid });
  assert.equal((await approve(e, id)).ok, true);
  assert.equal(edge(e, eid), undefined);
  const a = e.sqlite.prepare("SELECT * FROM audit_events WHERE action='parent_child.delete'").get();
  assert.deepEqual(JSON.parse(a.before_json), { parent_id: 'a1', child_id: 'a2', relation_type: 'step', parent_role: 'mother', custom_label: null });
  assert.equal(e.count('SELECT COUNT(*) n FROM people WHERE id IN (?, ?)', 'a1', 'a2'), 2);
  assert.equal(e.count('SELECT COUNT(*) n FROM partnerships'), 1);
  assert.equal((await approve(e, id)).code, 'not_pending');
  assert.equal(e.audits('parent_child.delete'), 1);
  const again = await mkEdge(e); // pasangan yang sama bisa dibuat lagi
  assert.ok(edge(e, again));
});

test('ubah dan hapus: relasi tidak ada atau milik pohon lain ditolak', async () => {
  const e = env();
  addTree(e);
  e.sqlite.exec("INSERT INTO people(id,tree_id,display_name) VALUES ('q','t2','Q'); INSERT INTO parent_child_edges(id,tree_id,parent_id,child_id,relation_type) VALUES ('x2','t2','p2','q','biological')");
  for (const after of [{ action: 'update', edge_id: 'x2', relation_type: 'step' }, { action: 'delete', edge_id: 'x2' }, { action: 'delete', edge_id: 'hantu' }]) {
    const { id } = await eprop(e, after);
    assert.equal((await approve(e, id)).code, 'edge_not_found');
    assert.equal(e.prop(id).status, 'pending');
  }
  assert.equal(edge(e, 'x2').relation_type, 'biological');
});

test('hapus: penyetuju lain menutup usulan tepat sebelum batch, relasi tidak dihapus', async () => {
  const e = env();
  addTree(e);
  const eid = await mkEdge(e);
  const { id } = await eprop(e, { action: 'delete', edge_id: eid });
  const real = e.db.batch.bind(e.db);
  let call = 0;
  e.db.batch = async (stmts) => {
    call += 1;
    if (call === 2) e.sqlite.exec("UPDATE proposals SET status='rejected', decided_by='owner', decided_at='2026-11-19 10:00:00', rejection_reason='x' WHERE id='" + id + "'");
    return real(stmts);
  };
  assert.equal((await approve(e, id)).code, 'not_pending');
  assert.ok(edge(e, eid));
  assert.equal(e.audits('parent_child.delete'), 0);
});

test('izin: Contributor, Viewer, orang luar tidak bisa menyetujui; pengaju sendiri tidak; sekali saja', async () => {
  const e = env();
  addTree(e);
  const { id } = await eprop(e, ec());
  for (const who of ['contrib', 'viewer', 'out']) assert.equal((await approve(e, id, who)).code, 'forbidden', who);
  assert.equal(nEdge(e), 0);
  const own = await eprop(e, ec({ parent_id: 'a3', child_id: 'a4' }), { proposerId: 'admin' });
  assert.equal((await approve(e, own.id, 'admin')).code, 'self_approval');
  assert.equal((await approve(e, own.id, 'owner')).ok, true);
  assert.equal((await approve(e, id)).ok, true);
  assert.equal((await approve(e, id)).code, 'not_pending');
  assert.equal(nEdge(e), 2);
  assert.equal(e.audits('parent_child.create'), 2);
});

test('isi usulan tidak valid saat penerapan tidak menutup usulan', async () => {
  const e = env();
  addTree(e);
  for (const after of [ec({ relation_type: 'x' }), ec({ child_id: 'a1' }), ec({ extra: 1 }), { action: 'update', edge_id: 'x' }]) {
    const { id } = await eprop(e, after);
    assert.equal((await approve(e, id)).ok, false);
    assert.equal(e.prop(id).status, 'pending');
  }
  assert.equal(nEdge(e), 0);
});

test('langsung: di pohon dengan Admin, Owner pun harus lewat usulan; Contributor ke usulan; Viewer ditolak', async () => {
  const e = env();
  addTree(e);
  assert.equal((await direct(e, 'owner', ec())).code, 'needs_proposal');
  assert.equal((await direct(e, 'admin', ec())).code, 'needs_proposal');
  assert.equal((await direct(e, 'contrib', ec())).code, 'needs_proposal');
  assert.equal((await direct(e, 'viewer', ec())).code, 'forbidden');
  assert.equal((await direct(e, 'out', ec())).code, 'forbidden');
  assert.equal(nEdge(e), 0);
});

test('Mode Penyusunan Awal: Owner tunggal langsung, berakhir saat ada Admin kedua', async () => {
  const e = env(); // t2 hanya punya satu Owner
  e.sqlite.exec("INSERT INTO people(id,tree_id,display_name) VALUES ('q1','t2','Q1'),('q2','t2','Q2')");
  const r = await direct(e, 'owner', { action: 'create', parent_id: 'q1', child_id: 'q2', relation_type: 'biological', parent_role: 'father' }, 't2');
  assert.equal(r.ok, true);
  assert.equal(edge(e, r.edgeId).tree_id, 't2');
  const ph = await direct(e, 'owner', { action: 'create', child_id: 'q1', new_person: { display_name: 'Ayah dari Q1', is_placeholder: true }, relation_type: 'biological', parent_role: 'father' }, 't2');
  assert.equal(ph.ok, true);
  assert.equal(e.person(ph.personId).placeholder_of, 'q1');
  assert.equal((await direct(e, 'owner', { action: 'update', edge_id: r.edgeId, relation_type: 'adoptive' }, 't2')).ok, true);
  assert.equal((await direct(e, 'owner', { action: 'delete', edge_id: r.edgeId }, 't2')).ok, true);
  assert.equal(e.audits('parent_child.create'), 2);
  e.sqlite.exec("INSERT INTO memberships(tree_id,account_id,role,status) VALUES ('t2','admin','admin','active')");
  assert.equal((await direct(e, 'owner', { action: 'create', parent_id: 'q2', child_id: 'q1', relation_type: 'biological', parent_role: 'father' }, 't2')).code, 'needs_proposal');
});

test('langsung (Mode Penyusunan Awal): siklus, dobel, dan orang pohon lain tetap ditolak', async () => {
  const e = env();
  e.sqlite.exec("INSERT INTO people(id,tree_id,display_name) VALUES ('q1','t2','Q1'),('q2','t2','Q2')");
  const c = (p, ch) => direct(e, 'owner', { action: 'create', parent_id: p, child_id: ch, relation_type: 'biological', parent_role: 'father' }, 't2');
  assert.equal((await c('q1', 'q2')).ok, true);
  assert.equal((await c('q2', 'q1')).code, 'would_create_cycle');
  assert.equal((await c('q1', 'q2')).code, 'duplicate_edge');
  assert.equal((await c('q1', 'p1')).code, 'person_not_found'); // p1 milik t1
  assert.equal(nEdge(e), 1);
});
