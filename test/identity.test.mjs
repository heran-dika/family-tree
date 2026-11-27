import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/d1.mjs';
import { applyDirect, approveAndApply } from '../src/apply.js';
import { createProposal } from '../src/proposals.js';
import { exportTree } from '../src/export.js';
import { validateImport } from '../src/import.js';
import { findDuplicates } from '../src/duplicates.js';

const T0 = new Date('2026-11-20T10:00:00Z');

// t1: hanya satu Owner (Mode Penyusunan Awal). t2: Owner + Admin + Contributor.
function env() {
  const e = freshDb();
  e.sqlite.exec(`
    INSERT INTO accounts(id,email,email_verified) VALUES ('owner','o@x.com',1),('admin','a@x.com',1),('contrib','c@x.com',1),('viewer','v@x.com',1);
    INSERT INTO family_trees(id,name,created_by) VALUES ('t1','Satu','owner'),('t2','Dua','owner');
    INSERT INTO memberships(tree_id,account_id,role,status) VALUES
      ('t1','owner','owner','active'),
      ('t2','owner','owner','active'),('t2','admin','admin','active'),('t2','contrib','contributor','active'),('t2','viewer','viewer','active');
    INSERT INTO people(id,tree_id,display_name,birth_date,birth_precision) VALUES ('anak','t1','Budi','1990','year'),('x','t2','Anak Dua','2000','year');
    INSERT INTO people(id,tree_id,display_name,is_placeholder,placeholder_of) VALUES ('ph2','t2','Ayah dari Anak Dua',1,'x');
    INSERT INTO parent_child_edges(id,tree_id,parent_id,child_id,relation_type,parent_role) VALUES ('e2','t2','ph2','x','biological','father');
  `);
  e.person = (id) => e.sqlite.prepare('SELECT * FROM people WHERE id = ?').get(id);
  e.audits = (a) => e.count('SELECT COUNT(*) n FROM audit_events WHERE action = ?', a);
  return e;
}
// Owner tunggal membuat placeholder lewat Mode Penyusunan Awal, seperti alur nyata P0-4
async function mkPlaceholder(e) {
  const r = await applyDirect(e.db, { treeId: 't1', actorId: 'owner', kind: 'parent_child', now: T0,
    after: { action: 'create', child_id: 'anak', relation_type: 'biological', parent_role: 'father', new_person: { display_name: 'Ayah dari Budi', is_placeholder: true } } });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}
const fill = (e, id, after, who = 'owner', treeId = 't1') => applyDirect(e.db, { treeId, actorId: who, kind: 'person_edit', targetPersonId: id, after, now: T0 });
const edges = (e, tree = 't1') => e.sqlite.prepare('SELECT id, parent_id, child_id, relation_type, parent_role FROM parent_child_edges WHERE tree_id = ? ORDER BY id').all(tree).map((r) => ({ ...r }));

test('isi identitas: profil yang sama berubah di tempat, penanda placeholder lepas, relasi tidak tersentuh (penerimaan P0-4)', async () => {
  const e = env();
  const ph = await mkPlaceholder(e);
  const before = edges(e);
  assert.equal(before.length, 1);
  assert.equal(e.person(ph.personId).is_placeholder, 1);
  assert.equal(e.person(ph.personId).placeholder_of, 'anak');
  const r = await fill(e, ph.personId, { display_name: 'Slamet Riyadi', birth_date: '1960', birth_precision: 'year' });
  assert.equal(r.ok, true);
  assert.equal(r.personId, ph.personId);
  assert.equal(r.identityFilled, true);
  const p = e.person(ph.personId);
  assert.deepEqual({ n: p.display_name, ph: p.is_placeholder, of: p.placeholder_of, v: p.version, c: p.confirmation, y: p.birth_date }, { n: 'Slamet Riyadi', ph: 0, of: null, v: 2, c: 'unverified', y: '1960' });
  assert.deepEqual(edges(e), before); // id relasi sama, jumlah sama, tidak diputus atau dibuat ulang
  assert.equal(e.count('SELECT COUNT(*) n FROM people WHERE tree_id = ?', 't1'), 2);
});

test('isi identitas: audit tersendiri dengan sebelum/sesudah, bukan person.update', async () => {
  const e = env();
  const ph = await mkPlaceholder(e);
  await fill(e, ph.personId, { display_name: 'Slamet Riyadi' });
  assert.equal(e.audits('person.fill_identity'), 1);
  assert.equal(e.audits('person.update'), 0);
  const a = e.sqlite.prepare("SELECT * FROM audit_events WHERE action='person.fill_identity'").get();
  assert.equal(a.target_id, ph.personId);
  assert.deepEqual(JSON.parse(a.before_json), { display_name: 'Ayah dari Budi', is_placeholder: 1, placeholder_of: 'anak' });
  assert.deepEqual(JSON.parse(a.after_json), { display_name: 'Slamet Riyadi', is_placeholder: 0, placeholder_of: null });
});

test('mengubah field lain saja, atau nama yang sama, tidak melepas penanda placeholder', async () => {
  const e = env();
  const ph = await mkPlaceholder(e);
  const r1 = await fill(e, ph.personId, { gender: 'male' });
  assert.equal(r1.ok, true);
  assert.equal('identityFilled' in r1, false);
  const r2 = await fill(e, ph.personId, { display_name: 'Ayah dari Budi', source_note: 'Pak' });
  assert.equal('identityFilled' in r2, false);
  const p = e.person(ph.personId);
  assert.deepEqual([p.is_placeholder, p.placeholder_of, p.gender], [1, 'anak', 'male']);
  assert.equal(e.audits('person.fill_identity'), 0);
  assert.equal(e.audits('person.update'), 2);
});

test('mengganti nama orang biasa bukan "isi identitas"', async () => {
  const e = env();
  const r = await fill(e, 'anak', { display_name: 'Budi Santoso' });
  assert.equal(r.ok, true);
  assert.equal('identityFilled' in r, false);
  assert.equal(e.audits('person.update'), 1);
  assert.equal(e.audits('person.fill_identity'), 0);
});

test('Contributor mengusulkan, Admin menyetujui: identitas terisi lewat jalur usulan', async () => {
  const e = env();
  const { id } = await createProposal(e.db, { treeId: 't2', proposerId: 'contrib', kind: 'person_edit', targetPersonId: 'ph2', after: { display_name: 'Hasan Basri' }, now: T0 });
  const r = await approveAndApply(e.db, { treeId: 't2', proposalId: id, deciderId: 'admin', now: T0 });
  assert.equal(r.ok, true);
  assert.equal(r.identityFilled, true);
  const p = e.person('ph2');
  assert.deepEqual([p.display_name, p.is_placeholder, p.placeholder_of], ['Hasan Basri', 0, null]);
  assert.deepEqual(edges(e, 't2'), [{ id: 'e2', parent_id: 'ph2', child_id: 'x', relation_type: 'biological', parent_role: 'father' }]);
  const a = e.sqlite.prepare("SELECT approval_note n, actor_id a FROM audit_events WHERE action='person.fill_identity'").get();
  assert.deepEqual([a.n, a.a], [`proposal:${id}`, 'admin']);
  assert.equal(e.sqlite.prepare('SELECT status FROM proposals WHERE id = ?').get(id).status, 'approved');
});

test('izin dan jalur: Contributor langsung ditolak, Viewer ditolak, usulan lain pada placeholder jadi stale', async () => {
  const e = env();
  assert.equal((await fill(e, 'ph2', { display_name: 'X' }, 'contrib', 't2')).code, 'needs_proposal');
  assert.equal((await fill(e, 'ph2', { display_name: 'X' }, 'viewer', 't2')).code, 'forbidden');
  assert.equal(e.person('ph2').is_placeholder, 1);
  const other = await createProposal(e.db, { treeId: 't2', proposerId: 'contrib', kind: 'person_edit', targetPersonId: 'ph2', after: { source_note: 'Pak' }, now: T0 });
  assert.equal((await fill(e, 'ph2', { display_name: 'Hasan Basri' }, 'admin', 't2')).ok, true);
  assert.equal(e.sqlite.prepare('SELECT status FROM proposals WHERE id = ?').get(other.id).status, 'stale');
});

test('placeholder diarsipkan atau milik pohon lain tidak bisa diisi', async () => {
  const e = env();
  e.sqlite.exec("UPDATE people SET archived_at='2026-01-01' WHERE id='ph2'");
  assert.equal((await fill(e, 'ph2', { display_name: 'X' }, 'admin', 't2')).code, 'target_archived');
  assert.equal((await fill(e, 'ph2', { display_name: 'X' }, 'owner', 't1')).code, 'target_not_found');
  assert.equal(e.person('ph2').display_name, 'Ayah dari Anak Dua');
});

test('berkas ekspor valid untuk impor sebelum dan sesudah identitas diisi', async () => {
  const e = env();
  const ph = await mkPlaceholder(e);
  const ex = (await exportTree(e.db, { treeId: 't1', actorId: 'owner', now: T0 })).doc;
  const was = ex.people.find((p) => p.id === ph.personId);
  assert.deepEqual([was.isPlaceholder, was.placeholderOf], [true, 'anak']);
  assert.equal(validateImport(ex, { now: T0 }).ok, true);
  await fill(e, ph.personId, { display_name: 'Slamet Riyadi' });
  const doc = (await exportTree(e.db, { treeId: 't1', actorId: 'owner', now: T0 })).doc;
  const now = doc.people.find((p) => p.id === ph.personId);
  assert.deepEqual([now.name, now.isPlaceholder, now.placeholderOf], ['Slamet Riyadi', false, null]);
  const v = validateImport(doc, { now: T0 });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.summary.placeholders, 0);
});

test('alur P0-4: duplikat ditawarkan lebih dulu, tetapi pengisian tidak diblokir (peringatan, bukan penghalang)', async () => {
  const e = env();
  e.sqlite.exec("INSERT INTO people(id,tree_id,display_name,birth_date,birth_precision) VALUES ('sl','t1','Slamet Riyadi','1960','year')");
  const ph = await mkPlaceholder(e);
  const d = await findDuplicates(e.db, { treeId: 't1', actorId: 'owner', name: 'Slamet Riyadi', excludeId: ph.personId, now: T0 });
  assert.deepEqual(d.candidates.map((c) => c.id), ['sl']);
  const r = await fill(e, ph.personId, { display_name: 'Slamet Riyadi' }); // pengguna memilih tetap buat baru
  assert.equal(r.ok, true);
  assert.equal(e.count("SELECT COUNT(*) n FROM people WHERE display_name='Slamet Riyadi'"), 2);
});
