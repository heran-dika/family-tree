import { test } from 'node:test'; import assert from 'node:assert/strict';
import { freshDb } from './helpers/d1.mjs'; import { applyDirect, approveAndApply } from '../src/apply.js'; import { createProposal } from '../src/proposals.js';
const now = new Date('2026-11-25T00:00:00Z');
function env() { const e = freshDb(); e.sqlite.exec(`INSERT INTO accounts(id,email,email_verified) VALUES ('o','o@x',1),('a','a@x',1),('c','c@x',1),('v','v@x',1);
 INSERT INTO family_trees(id,name,created_by) VALUES ('t','T','o'),('u','U','o');
 INSERT INTO memberships(tree_id,account_id,role,status) VALUES ('t','o','owner','active'),('t','c','contributor','active'),('t','v','viewer','active'),('u','o','owner','active');
 INSERT INTO people(id,tree_id,display_name) VALUES ('me','t','Saya'),('pa','t','Ortu'),('k1','t','Anak1'),('k2','t','Anak2'),('ph','t','Ayah dari Anak2'),('x','u','Orang U');
 UPDATE people SET is_placeholder=1, placeholder_of='k2' WHERE id='ph';
 INSERT INTO parent_child_edges(id,tree_id,parent_id,child_id,relation_type,parent_role) VALUES ('e1','t','pa','k1','biological','father'),('e2','t','ph','k2','biological','father');
 INSERT INTO account_person_links(tree_id,account_id,person_id,status) VALUES ('t','o','me','active');`); e.p = (id) => e.sqlite.prepare('select * from people where id=?').get(id); return e; }
const arch = (e, id, who = 'o', tree = 't', after = {}) => applyDirect(e.db, { treeId: tree, actorId: who, kind: 'archive', targetPersonId: id, after, now });
test('arsip anak daun: archived_at terisi, audit, versi naik', async () => {
  const e = env(); const r = await arch(e, 'k1', 'o', 't', { reason: 'salah masuk' }); assert.deepEqual([r.ok, r.personId, r.archived], [true, 'k1', true]);
  const p = e.p('k1'); assert.ok(p.archived_at); assert.equal(p.version, 2);
  const a = e.sqlite.prepare("select before_json b from audit_events where action='person.archive'").get(); assert.match(a.b, /Anak1/); assert.match(a.b, /salah masuk/);
  assert.equal((await arch(e, 'k1')).code, 'target_archived');
});
test('ditolak: punya anak, profil akun, pohon lain, Viewer, Contributor, field asing', async () => {
  const e = env();
  assert.equal((await arch(e, 'pa')).code, 'has_children'); assert.equal((await arch(e, 'me')).code, 'person_is_account');
  assert.equal((await arch(e, 'x')).code, 'target_not_found'); assert.equal((await arch(e, 'k1', 'v')).code, 'forbidden'); assert.equal((await arch(e, 'k1', 'c')).code, 'needs_proposal');
  assert.equal((await arch(e, 'k1', 'o', 't', { id: 'z' })).code, 'unknown_field'); assert.equal((await arch(e, 'k1', 'o', 't', { reason: 'x'.repeat(301) })).code, 'invalid_reason');
  assert.equal(e.p('pa').archived_at, null);
});
test('placeholder yang punya anak boleh diarsipkan; anaknya tetap', async () => {
  const e = env(); assert.equal((await arch(e, 'ph')).ok, true); assert.equal(e.p('k2').archived_at, null);
});
test('arsip anak terakhir lalu orang tuanya bisa diarsipkan', async () => {
  const e = env(); assert.equal((await arch(e, 'pa')).code, 'has_children'); await arch(e, 'k1'); assert.equal((await arch(e, 'pa')).ok, true);
});
test('lewat usulan Contributor: Owner menyetujui, usulan lain pada orang itu jadi stale', async () => {
  const e = env(); const p = await createProposal(e.db, { treeId: 't', proposerId: 'c', kind: 'archive', targetPersonId: 'k1', after: {}, now });
  const q = await createProposal(e.db, { treeId: 't', proposerId: 'c', kind: 'person_edit', targetPersonId: 'k1', after: { display_name: 'Z' }, now });
  const r = await approveAndApply(e.db, { treeId: 't', proposalId: p.id, deciderId: 'o', now }); assert.equal(r.ok, true);
  assert.ok(e.p('k1').archived_at); assert.equal(e.sqlite.prepare('select status from proposals where id=?').get(q.id).status, 'stale');
});
test('balapan: anak baru masuk tepat sebelum batch, orang tidak diarsipkan dan usulan tetap pending', async () => {
  const e = env(); const p = await createProposal(e.db, { treeId: 't', proposerId: 'c', kind: 'archive', targetPersonId: 'k1', after: {}, now });
  const real = e.db.batch.bind(e.db); let n = 0;
  e.db.batch = async (s) => { n++; if (n === 2) e.sqlite.exec("INSERT INTO people(id,tree_id,display_name) VALUES ('cc','t','Cucu'); INSERT INTO parent_child_edges(id,tree_id,parent_id,child_id,relation_type,parent_role) VALUES ('e9','t','k1','cc','biological','father')"); return real(s); };
  const r = await approveAndApply(e.db, { treeId: 't', proposalId: p.id, deciderId: 'o', now });
  assert.equal(r.code, 'cannot_archive'); assert.equal(e.p('k1').archived_at, null); assert.equal(e.sqlite.prepare('select status from proposals where id=?').get(p.id).status, 'pending');
});
