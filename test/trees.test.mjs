import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/d1.mjs';
import { MAX_PERSON_NAME, MAX_TREE_NAME, createTree, listTrees, readTree } from '../src/trees.js';

const T0 = new Date('2026-11-22T10:00:00Z');

function env() {
  const e = freshDb();
  e.sqlite.exec(`
    INSERT INTO accounts(id,email,email_verified) VALUES ('u1','u1@x.com',1),('u2','u2@x.com',1),('u3','u3@x.com',1);
  `);
  e.row = (sql, ...p) => e.sqlite.prepare(sql).get(...p);
  e.rows = (sql, ...p) => e.sqlite.prepare(sql).all(...p).map((r) => ({ ...r }));
  return e;
}
const make = (e, over = {}) => createTree(e.db, { accountId: 'u1', name: 'Keluarga Ahmad', selfName: 'Ahmad Fauzi', selfGender: 'male', ...over });
const untouched = (e) => assert.deepEqual([e.count('SELECT COUNT(*) n FROM family_trees'), e.count('SELECT COUNT(*) n FROM people'), e.count('SELECT COUNT(*) n FROM memberships')], [0, 0, 0]);

test('buat pohon: pohon, Owner aktif, profil pertama, tautan akun-profil, dan audit terbentuk bersamaan', async () => {
  const e = env();
  const r = await make(e);
  assert.equal(r.ok, true);
  assert.deepEqual(e.rows('SELECT id,name,created_by FROM family_trees'), [{ id: r.treeId, name: 'Keluarga Ahmad', created_by: 'u1' }]);
  assert.deepEqual(e.rows('SELECT tree_id,account_id,role,status FROM memberships'), [{ tree_id: r.treeId, account_id: 'u1', role: 'owner', status: 'active' }]);
  const p = e.row('SELECT * FROM people');
  assert.deepEqual([p.id, p.tree_id, p.display_name, p.gender, p.created_by, p.birth_precision], [r.personId, r.treeId, 'Ahmad Fauzi', 'male', 'u1', 'unknown']);
  assert.deepEqual(e.rows('SELECT tree_id,account_id,person_id,status FROM account_person_links'), [{ tree_id: r.treeId, account_id: 'u1', person_id: r.personId, status: 'active' }]);
  const a = e.row("SELECT * FROM audit_events WHERE action = 'tree.create'");
  assert.deepEqual([a.tree_id, a.actor_id, a.target_type, a.target_id], [r.treeId, 'u1', 'tree', r.treeId]);
  assert.deepEqual(JSON.parse(a.after_json), { name: 'Keluarga Ahmad', selfPersonId: r.personId });
  assert.equal(e.count('SELECT COUNT(*) n FROM audit_events'), 1);
});

test('buat pohon: nama dipangkas, jenis kelamin boleh kosong, dihitung per karakter', async () => {
  const e = env();
  const r = await make(e, { name: '  Pohon  ', selfName: ' Budi ', selfGender: null });
  assert.equal(r.ok, true);
  assert.equal(r.name, 'Pohon');
  const p = e.row('SELECT display_name, gender FROM people');
  assert.deepEqual([p.display_name, p.gender], ['Budi', null]);
  const f = env();
  assert.equal((await make(f, { name: '😀'.repeat(MAX_TREE_NAME), selfName: '😀'.repeat(MAX_PERSON_NAME) })).ok, true);
});

test('buat pohon: masukan tidak valid ditolak tanpa menulis apa pun', async () => {
  const e = env();
  const cases = [
    [{ name: '' }, 'name_required'], [{ name: '   ' }, 'name_required'], [{ name: 5 }, 'name_required'], [{ name: undefined }, 'name_required'],
    [{ name: 'x'.repeat(MAX_TREE_NAME + 1) }, 'name_too_long'],
    [{ selfName: '' }, 'self_name_required'], [{ selfName: null }, 'self_name_required'],
    [{ selfName: 'x'.repeat(MAX_PERSON_NAME + 1) }, 'self_name_too_long'],
    [{ selfGender: 'x' }, 'invalid_gender'], [{ selfGender: 'L' }, 'invalid_gender'], [{ selfGender: '' }, 'invalid_gender'],
    [{ accountId: 'hantu' }, 'forbidden'], [{ accountId: null }, 'forbidden'],
  ];
  for (const [over, code] of cases) assert.equal((await make(e, over)).code, code, JSON.stringify(over));
  untouched(e);
});

test('kuota: satu pohon per akun; ditolak tanpa sisa baris; akun lain tidak terpengaruh; bisa dinaikkan', async () => {
  const e = env();
  assert.equal((await make(e)).ok, true);
  assert.equal((await make(e, { name: 'Kedua' })).code, 'tree_limit');
  assert.deepEqual([e.count('SELECT COUNT(*) n FROM family_trees'), e.count('SELECT COUNT(*) n FROM people'), e.count('SELECT COUNT(*) n FROM memberships'), e.count('SELECT COUNT(*) n FROM audit_events'), e.count('SELECT COUNT(*) n FROM account_person_links')], [1, 1, 1, 1, 1]);
  assert.equal((await make(e, { accountId: 'u2' })).ok, true);
  e.sqlite.exec("UPDATE accounts SET tree_quota = 2 WHERE id = 'u1'");
  assert.equal((await make(e, { name: 'Kedua' })).ok, true);
  assert.equal((await make(e, { name: 'Ketiga' })).code, 'tree_limit');
  e.sqlite.exec("UPDATE accounts SET tree_quota = 0 WHERE id = 'u3'");
  assert.equal((await make(e, { accountId: 'u3' })).code, 'tree_limit');
});

test('kuota dihitung dari pembuat, bukan peran saat ini: pindah kepemilikan tidak membuka kuota baru', async () => {
  const e = env();
  const r = await make(e);
  e.sqlite.exec(`UPDATE memberships SET role = 'viewer' WHERE tree_id = '${r.treeId}' AND account_id = 'u1'`);
  assert.equal((await make(e, { name: 'Lagi' })).code, 'tree_limit');
});

test('balapan kuota: pohon lain keburu dibuat tepat sebelum batch kita, tidak ada baris tersisa', async () => {
  const e = env();
  const real = e.db.batch.bind(e.db);
  e.db.batch = async (stmts) => {
    e.sqlite.exec("INSERT INTO family_trees(id,name,created_by) VALUES ('lain','Lain','u1')");
    return real(stmts);
  };
  assert.equal((await make(e)).code, 'tree_limit');
  assert.deepEqual([e.count('SELECT COUNT(*) n FROM family_trees'), e.count('SELECT COUNT(*) n FROM people'), e.count('SELECT COUNT(*) n FROM memberships'), e.count('SELECT COUNT(*) n FROM audit_events')], [1, 0, 0, 0]);
});

test('daftar pohon: hanya keanggotaan aktif milik akun itu, dengan peran', async () => {
  const e = env();
  const a = await make(e);
  const b = await make(e, { accountId: 'u2', name: 'Punya U2' });
  e.sqlite.exec(`UPDATE family_trees SET created_at = '2026-01-01 00:00:00' WHERE id = '${a.treeId}'; UPDATE family_trees SET created_at = '2026-02-01 00:00:00' WHERE id = '${b.treeId}'`);
  e.sqlite.exec(`INSERT INTO memberships(tree_id,account_id,role,status) VALUES ('${b.treeId}','u1','viewer','pending')`);
  assert.deepEqual(await listTrees(e.db, 'u1'), [{ id: a.treeId, name: 'Keluarga Ahmad', role: 'owner' }]);
  e.sqlite.exec(`UPDATE memberships SET status = 'active' WHERE account_id = 'u1' AND tree_id = '${b.treeId}'`);
  assert.deepEqual((await listTrees(e.db, 'u1')).map((t) => [t.name, t.role]), [['Keluarga Ahmad', 'owner'], ['Punya U2', 'viewer']]);
  e.sqlite.exec(`UPDATE memberships SET status = 'removed' WHERE account_id = 'u1' AND tree_id = '${b.treeId}'`);
  assert.equal((await listTrees(e.db, 'u1')).length, 1);
  assert.deepEqual(await listTrees(e.db, 'u3'), []);
  assert.deepEqual(await listTrees(e.db, null), []);
});

test('baca pohon: pohon baru berisi satu orang, me menunjuk profilnya, Mode Penyusunan Awal aktif', async () => {
  const e = env();
  const r = await make(e);
  const t = await readTree(e.db, { treeId: r.treeId, accountId: 'u1', now: T0 });
  assert.equal(t.ok, true);
  assert.deepEqual([t.tree, t.role, t.bootstrap, t.me], [{ id: r.treeId, name: 'Keluarga Ahmad' }, 'owner', true, r.personId]);
  assert.deepEqual(t.people.map((p) => [p.id, p.name, p.gender, p.isPlaceholder]), [[r.personId, 'Ahmad Fauzi', 'male', false]]);
  assert.deepEqual([t.parentChild, t.partnerships], [[], []]);
  e.sqlite.exec(`INSERT INTO accounts(id,email,email_verified) VALUES ('adm','adm@x.com',1); INSERT INTO memberships(tree_id,account_id,role,status) VALUES ('${r.treeId}','adm','admin','active')`);
  assert.equal((await readTree(e.db, { treeId: r.treeId, accountId: 'u1', now: T0 })).bootstrap, false);
});

test('baca pohon: bukan anggota, pending, dikeluarkan, dan pohon tidak ada ditolak', async () => {
  const e = env();
  const r = await make(e);
  const rd = (accountId, treeId = r.treeId) => readTree(e.db, { treeId, accountId, now: T0 });
  assert.deepEqual(await rd('u2'), { ok: false, code: 'forbidden' });
  e.sqlite.exec(`INSERT INTO memberships(tree_id,account_id,role,status) VALUES ('${r.treeId}','u2','viewer','pending')`);
  assert.equal((await rd('u2')).code, 'forbidden');
  e.sqlite.exec("UPDATE memberships SET status = 'removed' WHERE account_id = 'u2'");
  assert.equal((await rd('u2')).code, 'forbidden');
  assert.equal((await rd('u1', 'hantu')).code, 'forbidden');
  assert.equal((await rd(null)).code, 'forbidden');
});

test('baca pohon: isolasi, privasi, arsip, dan relasi menggantung', async () => {
  const e = env();
  const a = await make(e);
  const b = await make(e, { accountId: 'u2', name: 'Pohon U2', selfName: 'Orang U2' });
  e.sqlite.exec(`
    INSERT INTO people(id,tree_id,display_name,birth_date,birth_precision,birth_visibility,visibility_by_self) VALUES
      ('p1','${a.treeId}','Rahasia','1990-05-17','full','hidden',1),
      ('p2','${a.treeId}','Dewasa Biasa','1962-03-04','full','full',0),
      ('p3','${a.treeId}','Anak Kecil','2018-06-07','full','year',0);
    INSERT INTO people(id,tree_id,display_name,archived_at) VALUES ('arc','${a.treeId}','Diarsipkan','2026-01-01');
    INSERT INTO parent_child_edges(id,tree_id,parent_id,child_id,relation_type,parent_role) VALUES
      ('e1','${a.treeId}','p2','p1','biological','father'),('e2','${a.treeId}','arc','p3','biological','mother');
    INSERT INTO partnerships(id,tree_id,person_a,person_b,status,start_year) VALUES ('s1','${a.treeId}','p2','p1','married',1986),('s2','${a.treeId}','arc','p3','married',NULL);
  `);
  const t = await readTree(e.db, { treeId: a.treeId, accountId: 'u1', now: T0 });
  const byId = Object.fromEntries(t.people.map((p) => [p.id, p]));
  assert.equal(t.people.length, 4); // pembuat + 3; arsip tidak ikut
  assert.equal('arc' in byId, false);
  assert.ok(!JSON.stringify(t).includes('Orang U2') && !JSON.stringify(t).includes(b.treeId));
  assert.deepEqual(byId.p1.birth, { precision: 'hidden', year: null, date: null });
  assert.deepEqual(byId.p2.birth, { precision: 'year', year: 1962, date: null });
  assert.deepEqual(byId.p3.birth, { precision: 'full', year: 2018, date: '2018-06-07' }); // Owner melihat anak penuh
  assert.ok(!JSON.stringify(t).includes('1990'));
  assert.deepEqual(t.parentChild.map((x) => x.id), ['e1']);
  assert.deepEqual(t.partnerships.map((x) => [x.id, x.startYear, x.endYear]), [['s1', 1986, null]]);
  // Viewer: anak hanya tahun; tidak melihat tanggal lengkap mana pun
  e.sqlite.exec(`INSERT INTO accounts(id,email,email_verified) VALUES ('vw','vw@x.com',1); INSERT INTO memberships(tree_id,account_id,role,status) VALUES ('${a.treeId}','vw','viewer','active')`);
  const v = await readTree(e.db, { treeId: a.treeId, accountId: 'vw', now: T0 });
  assert.deepEqual(v.people.find((p) => p.id === 'p3').birth, { precision: 'year', year: 2018, date: null });
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(JSON.stringify(v)));
  assert.equal(v.me, null);
});

test('baca pohon: placeholder membawa placeholderOf', async () => {
  const e = env();
  const a = await make(e);
  e.sqlite.exec(`INSERT INTO people(id,tree_id,display_name,is_placeholder,placeholder_of) VALUES ('ph','${a.treeId}','Ayah dari Ahmad',1,'${a.personId}')`);
  const t = await readTree(e.db, { treeId: a.treeId, accountId: 'u1', now: T0 });
  const ph = t.people.find((p) => p.id === 'ph');
  assert.deepEqual([ph.isPlaceholder, ph.placeholderOf], [true, a.personId]);
});
