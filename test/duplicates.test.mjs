import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/d1.mjs';
import { DEFAULT_LIMIT, MAX_NAME, YEAR_TOLERANCE, findDuplicates } from '../src/duplicates.js';

const T0 = new Date('2026-11-20T10:00:00Z');

function env() {
  const e = freshDb();
  e.sqlite.exec(`
    INSERT INTO accounts(id,email,email_verified) VALUES ('owner','o@x.com',1),('admin','a@x.com',1),('contrib','c@x.com',1),('viewer','v@x.com',1),('out','z@x.com',1),('gone','g@x.com',1);
    INSERT INTO family_trees(id,name,created_by) VALUES ('t1','Satu','owner'),('t2','Dua','owner');
    INSERT INTO memberships(tree_id,account_id,role,status) VALUES
      ('t1','owner','owner','active'),('t1','admin','admin','active'),('t1','contrib','contributor','active'),
      ('t1','viewer','viewer','active'),('t1','gone','admin','removed'),('t2','owner','owner','active');
    INSERT INTO people(id,tree_id,display_name,birth_date,birth_precision,birth_visibility,visibility_by_self) VALUES
      ('a','t1','Ahmad Fauzi Rahman','1962-03-04','full','full',0),
      ('b','t1','Siti Rohmah','1965','year','year',0),
      ('e','t1','Rahasia Budi','1990-05-17','full','hidden',1),
      ('k','t1','Ali',NULL,'unknown','year',0),
      ('z','t2','Ahmad Lain','1970-01-01','full','full',1);
    INSERT INTO people(id,tree_id,display_name,archived_at) VALUES ('g','t1','Ahmad Arsip','2026-01-01');
    INSERT INTO people(id,tree_id,display_name,is_placeholder,placeholder_of) VALUES ('ph','t1','Ayah dari Ahmad',1,'a');
    INSERT INTO name_variants(id,tree_id,person_id,variant) VALUES ('v1','t1','a','Achmad'),('v2','t1','g','Ahmad Lama');
  `);
  return e;
}
const dup = (e, name, over = {}) => findDuplicates(e.db, { treeId: 't1', actorId: 'admin', name, now: T0, ...over });
const ids = (r) => r.candidates.map((c) => c.id);

test('hanya yang boleh mengusulkan (Contributor ke atas) yang bisa memeriksa duplikat', async () => {
  const e = env();
  for (const who of ['viewer', 'out', 'gone', 'nope']) assert.deepEqual(await dup(e, 'Ahmad', { actorId: who }), { ok: false, code: 'forbidden' }, who);
  for (const who of ['contrib', 'admin', 'owner']) assert.equal((await dup(e, 'Ahmad Fauzi Rahman', { actorId: who })).ok, true, who);
});

test('nama sama persis, tanpa peka huruf dan aksen', async () => {
  const e = env();
  for (const n of ['Ahmad Fauzi Rahman', 'AHMAD FAUZI RAHMAN', '  ahmad   fauzi rahman ']) {
    const r = await dup(e, n);
    assert.deepEqual(ids(r), ['a'], n);
    assert.equal(r.candidates[0].reason, 'exact');
  }
});

test('urutan kata berbeda dan beda satu huruf; dua huruf beda bukan kandidat', async () => {
  const e = env();
  assert.equal((await dup(e, 'Rahman Ahmad Fauzi')).candidates[0].reason, 'tokens');
  assert.equal((await dup(e, 'Ahmat Fauzi Rahman')).candidates[0].reason, 'close');
  assert.equal((await dup(e, 'Ahmad Fauzi Rahmann')).candidates[0].reason, 'close'); // satu huruf lebih
  assert.equal((await dup(e, 'Ahmat Fauzi Rahmat')).total, 0);
  assert.equal((await dup(e, 'Ahmad Fauzi')).total, 0); // sebagian nama bukan duplikat
  assert.deepEqual(ids(await dup(e, 'Ahmad')), ['a']); // tapi beda satu huruf dari varian Achmad
});

test('nama pendek tidak dicocokkan "beda satu huruf" (terlalu banyak salah duga)', async () => {
  const e = env();
  assert.equal((await dup(e, 'Alo')).total, 0);
  assert.deepEqual(ids(await dup(e, 'Ali')), ['k']);
});

test('variasi ejaan ikut dibandingkan dan ditandai', async () => {
  const e = env();
  const r = await dup(e, 'achmad');
  assert.deepEqual(ids(r), ['a']);
  assert.deepEqual([r.candidates[0].matchedOn, r.candidates[0].variant], ['variant', 'Achmad']);
});

test('tahun lahir: selisih sampai toleransi tetap kandidat, lebih jauh bukan (bapak dan anak sama nama)', async () => {
  const e = env();
  assert.equal(YEAR_TOLERANCE, 2);
  for (const y of [1962, 1960, 1964]) assert.equal((await dup(e, 'Ahmad Fauzi Rahman', { birthYear: y })).candidates[0].yearCheck, 'match', String(y));
  for (const y of [1959, 1965, 1990, 1900]) assert.equal((await dup(e, 'Ahmad Fauzi Rahman', { birthYear: y })).total, 0, String(y));
  assert.equal((await dup(e, 'Ahmad Fauzi Rahman')).candidates[0].yearCheck, 'unknown');
  const k = await dup(e, 'Ali', { birthYear: 1980 }); // tahun kandidat tidak diketahui: tetap ditawarkan
  assert.deepEqual([ids(k), k.candidates[0].yearCheck], [['k'], 'unknown']);
});

test('privasi: tahun tersembunyi dianggap tidak diketahui; hasil tidak berbeda apa pun tahun yang dimasukkan', async () => {
  const e = env();
  const base = await dup(e, 'Rahasia Budi');
  assert.deepEqual(base.candidates[0].birth, { precision: 'hidden', year: null });
  for (const y of [1990, 1950, 2020]) assert.deepEqual(await dup(e, 'Rahasia Budi', { birthYear: y }), { ...base, candidates: base.candidates }, String(y));
  assert.ok(!JSON.stringify(base).includes('1990'));
  // dewasa yang belum memilih: hanya tahun yang dipakai, dan tanggal lengkap tidak pernah muncul
  const a = await dup(e, 'Ahmad Fauzi Rahman', { birthYear: 1962, actorId: 'viewer' });
  assert.equal(a.ok, false); // Viewer tidak boleh; periksa dengan Contributor
  const c = await dup(e, 'Ahmad Fauzi Rahman', { birthYear: 1962, actorId: 'contrib' });
  assert.deepEqual(c.candidates[0].birth, { precision: 'year', year: 1962 });
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(JSON.stringify(c)));
});

test('privasi: orang yang tertaut ke profilnya sendiri dibandingkan dengan tahun aslinya', async () => {
  const e = env();
  e.sqlite.exec("INSERT INTO account_person_links(tree_id,account_id,person_id,status) VALUES ('t1','contrib','e','active')");
  assert.equal((await dup(e, 'Rahasia Budi', { birthYear: 1950, actorId: 'contrib' })).total, 0); // melihat 1990 sendiri
  assert.equal((await dup(e, 'Rahasia Budi', { birthYear: 1950, actorId: 'admin' })).total, 1); // orang lain: tidak diketahui
});

test('arsip, placeholder, pohon lain, dan profil yang sedang diubah tidak jadi kandidat', async () => {
  const e = env();
  assert.equal((await dup(e, 'Ahmad Arsip')).total, 0);
  assert.equal((await dup(e, 'Ahmad Lama')).total, 0); // varian milik profil arsip
  assert.equal((await dup(e, 'Ayah dari Ahmad')).total, 0);
  assert.equal((await dup(e, 'Ahmad Lain')).total, 0);
  assert.equal((await dup(e, 'Ahmad Fauzi Rahman', { excludeId: 'a' })).total, 0);
  assert.deepEqual(ids(await findDuplicates(e.db, { treeId: 't2', actorId: 'owner', name: 'ahmad lain', now: T0 })), ['z']);
});

test('urutan: kemiripan dan kecocokan tahun mengalahkan abjad', async () => {
  const e = env();
  e.sqlite.exec("INSERT INTO people(id,tree_id,display_name) VALUES ('zz1','t1','Umar Zaki'),('zz2','t1','Zaki Umar')");
  assert.deepEqual(ids(await dup(e, 'zaki umar')), ['zz2', 'zz1']); // persis dulu, walau abjadnya belakangan
  e.sqlite.exec("INSERT INTO people(id,tree_id,display_name,birth_date,birth_precision) VALUES ('r1','t1','Rudi Hartono',NULL,'unknown'),('r2','t1','Rudi Hartono','1980','year')");
  assert.deepEqual(ids(await dup(e, 'rudi hartono', { birthYear: 1980 })), ['r2', 'r1']); // tahun cocok dulu
});

test('hasil hanya tahun: anak di bawah 18 (Admin melihat penuh) dan profil sendiri tidak membawa presisi "full"', async () => {
  const e = env();
  e.sqlite.exec("INSERT INTO people(id,tree_id,display_name,birth_date,birth_precision,birth_visibility) VALUES ('kc','t1','Anak Kecil','2018-06-07','full','year')");
  const r = await dup(e, 'Anak Kecil');
  assert.deepEqual(r.candidates[0].birth, { precision: 'year', year: 2018 });
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(JSON.stringify(r)));
  e.sqlite.exec("INSERT INTO account_person_links(tree_id,account_id,person_id,status) VALUES ('t1','contrib','a','active')");
  assert.deepEqual((await dup(e, 'Ahmad Fauzi Rahman', { actorId: 'contrib' })).candidates[0].birth, { precision: 'year', year: 1962 });
});

test('masukan tidak valid dan nama kosong', async () => {
  const e = env();
  assert.equal((await dup(e, 5)).code, 'invalid_name');
  assert.equal((await dup(e, null)).code, 'invalid_name');
  assert.equal((await dup(e, 'x'.repeat(MAX_NAME + 1))).code, 'name_too_long');
  assert.equal((await dup(e, '😀'.repeat(MAX_NAME))).ok, true);
  for (const y of ['1990', 99, 1.5, 10000, NaN]) assert.equal((await dup(e, 'Ali', { birthYear: y })).code, 'invalid_birth_year', String(y));
  assert.equal((await dup(e, 'Ali', { excludeId: 5 })).code, 'invalid_exclude_id');
  for (const n of ['', '   ', "''", '---']) assert.deepEqual(await dup(e, n), { ok: true, candidates: [], total: 0 }, JSON.stringify(n));
});

test('urutan: persis sebelum urutan kata sebelum beda huruf; tahun cocok sebelum tidak diketahui; batas hasil', async () => {
  const e = env();
  e.sqlite.exec(`INSERT INTO people(id,tree_id,display_name,birth_date,birth_precision) VALUES
    ('d1','t1','Dedi Kurnia','1980','year'),('d2','t1','Kurnia Dedi',NULL,'unknown'),('d3','t1','Dedi Kurniawan',NULL,'unknown'),('d4','t1','Dedi Kurnia','1981','year')`);
  const r = await dup(e, 'dedi kurnia', { birthYear: 1980 });
  assert.deepEqual(ids(r), ['d1', 'd4', 'd2']); // d3 dua huruf beda
  assert.deepEqual(r.candidates.map((c) => c.reason), ['exact', 'exact', 'tokens']);
  for (let i = 0; i < 10; i++) e.sqlite.exec(`INSERT INTO people(id,tree_id,display_name) VALUES ('m${i}','t1','Mira Sari')`);
  const m = await dup(e, 'mira sari');
  assert.deepEqual([m.candidates.length, m.total], [DEFAULT_LIMIT, 10]);
  assert.equal((await dup(e, 'mira sari', { limit: 100 })).candidates.length, 10);
  assert.equal((await dup(e, 'mira sari', { limit: 0 })).candidates.length, 1);
});

test('hanya membaca, satu kali per tabel; tanpa kandidat tidak membaca tautan akun', async () => {
  const e = env();
  const log = [];
  const real = e.db.prepare;
  e.db.prepare = (sql) => { log.push(sql); return real(sql); };
  const before = e.count('SELECT COUNT(*) n FROM audit_events');
  await dup(e, 'Tidak Ada Orang Ini');
  assert.ok(log.every((s) => /^\s*SELECT/i.test(s)));
  assert.equal(log.filter((s) => /FROM people/.test(s)).length, 1);
  assert.equal(log.filter((s) => /FROM name_variants/.test(s)).length, 1);
  assert.equal(log.filter((s) => /account_person_links/.test(s)).length, 0);
  assert.equal(e.count('SELECT COUNT(*) n FROM audit_events'), before);
});
