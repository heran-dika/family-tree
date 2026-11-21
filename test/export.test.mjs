import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/d1.mjs';
import { EXPORT_FORMAT, EXPORT_VERSION, exportTree } from '../src/export.js';
import { validateImport } from '../src/import.js';

const T0 = new Date('2026-11-20T10:00:00Z');

function env() {
  const e = freshDb();
  e.sqlite.exec(`
    INSERT INTO accounts(id,email,email_verified) VALUES ('owner','o@x.com',1),('admin','a@x.com',1),('contrib','c@x.com',1),('viewer','v@x.com',1),('out','z@x.com',1),('gone','g@x.com',1);
    INSERT INTO family_trees(id,name,created_by) VALUES ('t1','Keluarga Satu','owner'),('t2','Keluarga Dua','owner');
    INSERT INTO memberships(tree_id,account_id,role,status) VALUES
      ('t1','owner','owner','active'),('t1','admin','admin','active'),('t1','contrib','contributor','active'),
      ('t1','viewer','viewer','active'),('t1','gone','admin','removed'),('t2','owner','owner','active');
    INSERT INTO people(id,tree_id,display_name,nickname,gender,birth_date,birth_precision,birth_visibility,visibility_by_self,death_date,death_precision,source_note,confirmation) VALUES
      ('a','t1','Ahmad','Mad','male','1962-03-04','full','full',0,NULL,'unknown','akta','confirmed'),
      ('b','t1','Siti',NULL,'female','1965','year','year',0,'2020-01-02','full',NULL,'unverified'),
      ('c','t1','Rahasia',NULL,NULL,'1990-05-17','full','hidden',1,NULL,'unknown',NULL,'unverified'),
      ('k','t1','Kecil',NULL,NULL,'2018-06-07','full','year',0,NULL,'unknown',NULL,'unverified'),
      ('z','t2','Orang Lain',NULL,NULL,'1970-01-01','full','full',1,NULL,'unknown',NULL,'unverified');
    INSERT INTO people(id,tree_id,display_name,is_placeholder,placeholder_of,archived_at) VALUES ('ph','t1','Ayah dari Ahmad',1,'a',NULL),('ar','t1','Diarsipkan',0,NULL,'2026-01-01');
    INSERT INTO parent_child_edges(id,tree_id,parent_id,child_id,relation_type,parent_role) VALUES
      ('e1','t1','ph','a','biological','father'),('e2','t1','a','k','adoptive','mother');
  `);
  e.sqlite.exec(`
    INSERT INTO people(id,tree_id,display_name) VALUES ('z2','t2','Anak Orang Lain');
    INSERT INTO parent_child_edges(id,tree_id,parent_id,child_id,relation_type) VALUES ('e3','t2','z','z2','biological');
    INSERT INTO partnerships(id,tree_id,person_a,person_b,status,start_year,end_year) VALUES ('s1','t1','a','b','married',1986,NULL);
    INSERT INTO name_variants(id,tree_id,person_id,variant) VALUES ('v1','t1','a','Achmad'),('v2','t1','a','Ahmat');
  `);
  e.audits = (action) => e.count('SELECT COUNT(*) n FROM audit_events WHERE action = ?', action);
  return e;
}
const run = (e, actorId, treeId = 't1') => exportTree(e.db, { treeId, actorId, now: T0 });
const person = (doc, id) => doc.people.find((p) => p.id === id);

test('hanya Owner dan Admin; Contributor, Viewer, orang luar, anggota dikeluarkan ditolak tanpa audit', async () => {
  const e = env();
  for (const who of ['contrib', 'viewer', 'out', 'gone', 'nope']) assert.deepEqual(await run(e, who), { ok: false, code: 'forbidden' }, who);
  assert.equal(e.audits('export.run'), 0);
  for (const who of ['admin', 'owner']) assert.equal((await run(e, who)).ok, true, who);
});

test('bentuk berkas, isi pohon, isolasi pohon, dan audit dengan jumlah', async () => {
  const e = env();
  const { doc } = await run(e, 'admin');
  assert.equal(doc.format, EXPORT_FORMAT);
  assert.equal(doc.version, EXPORT_VERSION);
  assert.equal(doc.exportedAt, '2026-11-20T10:00:00.000Z');
  assert.deepEqual(doc.tree, { name: 'Keluarga Satu' });
  assert.deepEqual(doc.people.map((p) => p.id), ['a', 'ar', 'b', 'c', 'k', 'ph']);
  assert.equal(doc.people.some((p) => p.id === 'z'), false);
  assert.deepEqual(doc.nameVariants, [{ person: 'a', variant: 'Achmad' }, { person: 'a', variant: 'Ahmat' }]);
  assert.deepEqual(doc.parentChild, [
    { parent: 'a', child: 'k', type: 'adoptive', role: 'mother', customLabel: null },
    { parent: 'ph', child: 'a', type: 'biological', role: 'father', customLabel: null },
  ]);
  assert.deepEqual(doc.partnerships, [{ a: 'a', b: 'b', status: 'married', startYear: 1986, endYear: null }]);
  const a = e.sqlite.prepare("SELECT * FROM audit_events WHERE action='export.run'").get();
  assert.equal(a.actor_id, 'admin');
  assert.equal(a.target_id, 't1');
  assert.deepEqual(JSON.parse(a.after_json), { people: 6, parentChild: 2, partnerships: 1 });
  assert.equal(e.audits('export.run'), 1);
});

test('placeholder, arsip, nama panggilan, sumber, dan konfirmasi ikut; email akun tidak bocor', async () => {
  const e = env();
  const { doc } = await run(e, 'owner');
  assert.equal(person(doc, 'ph').isPlaceholder, true);
  assert.equal(person(doc, 'ph').placeholderOf, 'a');
  assert.equal(person(doc, 'ar').archived, true);
  assert.equal(person(doc, 'a').nickname, 'Mad');
  assert.equal(person(doc, 'a').sourceNote, 'akta');
  assert.equal(person(doc, 'a').confirmation, 'confirmed');
  const s = JSON.stringify(doc);
  for (const leak of ['@x.com', 'owner', 'admin', 'contrib']) assert.ok(!s.includes(leak), leak);
});

test('privasi: dewasa yang belum memilih hanya tahun, walau pengaturan lama "full" (aturan usia 18)', async () => {
  const e = env();
  const { doc } = await run(e, 'owner');
  assert.deepEqual(person(doc, 'a').birth, { precision: 'year', year: 1962, date: null });
  assert.equal(JSON.stringify(doc).includes('1962-03-04'), false);
});

test('privasi: dewasa memilih tersembunyi tidak membocorkan tanggal maupun tahun, ke Owner pun', async () => {
  const e = env();
  for (const who of ['admin', 'owner']) {
    const { doc } = await run(e, who);
    assert.deepEqual(person(doc, 'c').birth, { precision: 'hidden', year: null, date: null }, who);
    const s = JSON.stringify(doc);
    assert.ok(!s.includes('1990-05-17') && !s.includes('1990'), who);
  }
});

test('privasi: anak di bawah 18 tanggal lengkap untuk Admin/Owner; tanggal meninggal selalu terlihat', async () => {
  const e = env();
  const { doc } = await run(e, 'admin');
  assert.deepEqual(person(doc, 'k').birth, { precision: 'full', year: 2018, date: '2018-06-07' });
  assert.deepEqual(person(doc, 'b').death, { precision: 'full', year: 2020, date: '2020-01-02' });
});

test('privasi: Admin yang tertaut ke profil dewasanya melihat tanggal lengkap sendiri, bukan orang lain', async () => {
  const e = env();
  e.sqlite.exec("INSERT INTO account_person_links(tree_id,account_id,person_id,status) VALUES ('t1','admin','a','active')");
  const { doc } = await run(e, 'admin');
  assert.equal(person(doc, 'a').birth.date, '1962-03-04');
  assert.equal(person(doc, 'b').birth.date, null);
  e.sqlite.exec("UPDATE account_person_links SET status='pending'");
  assert.equal(person((await run(e, 'admin')).doc, 'a').birth.date, null);
});

test('urutan baca: relasi, pasangan, varian dibaca sebelum orang (orang terakhir)', async () => {
  const e = env();
  const log = [];
  const real = e.db.prepare;
  e.db.prepare = (sql) => { log.push(sql); return real(sql); };
  await run(e, 'owner');
  const at = (re) => log.findIndex((s) => re.test(s));
  const people = at(/FROM people/);
  for (const re of [/FROM name_variants/, /FROM parent_child_edges/, /FROM partnerships/]) {
    assert.ok(at(re) >= 0 && at(re) < people, String(re));
  }
});

test('keluaran deterministik dan bisa langsung dibaca validasi impor (round trip)', async () => {
  const e = env();
  const a = JSON.stringify((await run(e, 'owner')).doc);
  assert.equal(JSON.stringify((await run(e, 'owner')).doc), a);
  const v = validateImport(a, { now: T0 });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.deepEqual(
    { ...v.summary, warningCounts: undefined },
    { people: 6, archived: 1, placeholders: 1, nameVariants: 2, parentChild: 2, partnerships: 1, hiddenBirthDates: 1, warningCounts: undefined }
  );
});

test('pohon kosong tetap valid sebagai berkas', async () => {
  const e = env();
  e.sqlite.exec("INSERT INTO accounts(id,email) VALUES ('o3','o3@x.com'); INSERT INTO family_trees(id,name,created_by) VALUES ('t3','Kosong','o3'); INSERT INTO memberships(tree_id,account_id,role) VALUES ('t3','o3','owner')");
  const { doc } = await run(e, 'o3', 't3');
  assert.deepEqual([doc.people, doc.parentChild, doc.partnerships, doc.nameVariants], [[], [], [], []]);
  assert.equal(validateImport(doc, { now: T0 }).ok, true);
});
