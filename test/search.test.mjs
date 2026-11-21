import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/d1.mjs';
import { DEFAULT_LIMIT, MAX_LIMIT, MAX_QUERY, norm, searchPeople } from '../src/search.js';

const T0 = new Date('2026-11-20T10:00:00Z');

function env() {
  const e = freshDb();
  e.sqlite.exec(`
    INSERT INTO accounts(id,email,email_verified) VALUES ('owner','o@x.com',1),('admin','a@x.com',1),('contrib','c@x.com',1),('viewer','v@x.com',1),('out','z@x.com',1),('gone','g@x.com',1);
    INSERT INTO family_trees(id,name,created_by) VALUES ('t1','Satu','owner'),('t2','Dua','owner');
    INSERT INTO memberships(tree_id,account_id,role,status) VALUES
      ('t1','owner','owner','active'),('t1','admin','admin','active'),('t1','contrib','contributor','active'),
      ('t1','viewer','viewer','active'),('t1','gone','admin','removed'),('t2','owner','owner','active');
    INSERT INTO people(id,tree_id,display_name,nickname,birth_date,birth_precision,birth_visibility,visibility_by_self,death_date,death_precision) VALUES
      ('a','t1','Ahmad Fauzi Rahman','Mad','1962-03-04','full','full',0,NULL,'unknown'),
      ('b','t1','Siti Rohmah','Ummi','1965','year','year',0,'2020-01-02','full'),
      ('c','t1','Ma''ruf Hidayat',NULL,NULL,'unknown','year',0,NULL,'unknown'),
      ('d','t1','José Álvarez Muñoz',NULL,NULL,'unknown','year',0,NULL,'unknown'),
      ('e','t1','Rahasia Budi',NULL,'1990-05-17','full','hidden',1,NULL,'unknown'),
      ('f','t1','Anak Kecil',NULL,'2018-06-07','full','year',0,NULL,'unknown'),
      ('z','t2','Ahmad Lain','Lainnya','1970-01-01','full','full',1,NULL,'unknown');
    INSERT INTO people(id,tree_id,display_name,archived_at) VALUES ('g','t1','Ahmad Arsip','2026-01-01');
    INSERT INTO name_variants(id,tree_id,person_id,variant) VALUES
      ('v1','t1','a','Achmad'),('v2','t1','a','Ahmat'),('v3','t1','g','Ahmad Lama'),('v4','t2','z','Achmad Lain');
  `);
  e.add = (id, name, extra = '') => e.sqlite.exec(`INSERT INTO people(id,tree_id,display_name${extra ? ',' + extra.split('=')[0] : ''}) VALUES ('${id}','t1','${name}'${extra ? ",'" + extra.split('=')[1] + "'" : ''})`);
  return e;
}
const find = (e, query, who = 'owner', over = {}) => searchPeople(e.db, { treeId: 't1', actorId: who, query, now: T0, ...over });
const ids = (r) => r.results.map((x) => x.id);

test('norm: huruf besar, aksen, apostrof (lurus dan melengkung), tanda hubung, spasi ganda', () => {
  assert.equal(norm("  Ma’ruf-Hidayat  "), 'maruf hidayat');
  assert.equal(norm('José   Álvarez Muñoz'), 'jose alvarez munoz');
  assert.equal(norm("MA'RUF"), 'maruf');
  assert.equal(norm(null), '');
  assert.equal(norm(undefined), '');
  assert.equal(norm('H. Ahmad'), 'h ahmad');
});

test('hanya anggota aktif yang boleh mencari; semua peran boleh', async () => {
  const e = env();
  for (const who of ['out', 'gone', 'nope']) assert.deepEqual(await find(e, 'ahmad', who), { ok: false, code: 'forbidden' }, who);
  for (const who of ['viewer', 'contrib', 'admin', 'owner']) assert.deepEqual(ids(await find(e, 'ahmad', who)), ['a'], who);
});

test('nama panggilan menemukan profil (penerimaan P0-1)', async () => {
  const e = env();
  const r = await find(e, 'ummi');
  assert.deepEqual(ids(r), ['b']);
  assert.equal(r.results[0].matchedOn, 'nickname');
  assert.equal(r.results[0].name, 'Siti Rohmah');
});

test('tidak peka huruf besar dan aksen, dua arah', async () => {
  const e = env();
  for (const q of ['JOSE ALVAREZ', 'josé', 'José Álvarez', 'munoz', 'Muñoz', 'álvarez jose']) assert.deepEqual(ids(await find(e, q)), ['d'], q);
});

test('apostrof dan tanda hubung diabaikan: Ma\'ruf = Maruf', async () => {
  const e = env();
  for (const q of ['maruf', "ma'ruf", 'ma’ruf', 'MA`RUF', 'ma-ruf']) assert.deepEqual(ids(await find(e, q)), ['c'], q);
});

test('variasi ejaan dicari seperti nama panggilan; nama utama menang bila sama-sama cocok', async () => {
  const e = env();
  const r = await find(e, 'achmad');
  assert.deepEqual(ids(r), ['a']);
  assert.equal(r.results[0].matchedOn, 'variant');
  assert.equal(r.results[0].variant, 'Achmad');
  assert.equal((await find(e, 'ahmat')).results[0].variant, 'Ahmat');
  const byName = (await find(e, 'ahmad')).results[0];
  assert.equal(byName.matchedOn, 'name');
  assert.equal('variant' in byName, false);
});

test('profil arsip (nama maupun variannya) tidak pernah muncul', async () => {
  const e = env();
  assert.equal((await find(e, 'arsip')).total, 0);
  assert.equal((await find(e, 'ahmad lama')).total, 0);
  assert.ok(!ids(await find(e, 'ahmad')).includes('g'));
});

test('isolasi pohon: orang dan varian pohon lain tidak ditemukan', async () => {
  const e = env();
  assert.equal((await find(e, 'lain')).total, 0);
  assert.equal((await find(e, 'lainnya')).total, 0);
  assert.equal((await find(e, 'achmad lain')).total, 0);
  const t2 = await searchPeople(e.db, { treeId: 't2', actorId: 'owner', query: 'ahmad', now: T0 });
  assert.deepEqual(ids(t2), ['z']);
  assert.deepEqual(await searchPeople(e.db, { treeId: 't2', actorId: 'admin', query: 'ahmad', now: T0 }), { ok: false, code: 'forbidden' });
});

test('privasi: tanggal tersembunyi tidak tampil, tahun tersembunyi pun tidak; hasil tidak memuat tanggal lengkap', async () => {
  const e = env();
  for (const who of ['viewer', 'admin', 'owner']) {
    const r = await find(e, 'rahasia', who);
    assert.deepEqual(r.results[0].birth, { precision: 'hidden', year: null }, who);
    const s = JSON.stringify(r);
    assert.ok(!s.includes('1990'), `${who} bocor`);
  }
  for (const who of ['viewer', 'contrib', 'admin', 'owner']) {
    const s = JSON.stringify(await find(e, '', who)) + JSON.stringify(await find(e, 'kecil', who)) + JSON.stringify(await find(e, 'ahmad', who));
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(s), `${who} tanggal lengkap bocor`);
  }
});

test('privasi: dewasa belum memilih hanya tahun; anak di bawah 18 tahun saja untuk semua peran; tanggal meninggal terlihat tahunnya', async () => {
  const e = env();
  assert.deepEqual((await find(e, 'ahmad', 'viewer')).results[0].birth, { precision: 'year', year: 1962 });
  for (const who of ['viewer', 'admin']) assert.deepEqual((await find(e, 'kecil', who)).results[0].birth, { precision: 'year', year: 2018 }, who);
  assert.deepEqual((await find(e, 'siti')).results[0].death, { precision: 'year', year: 2020 });
});

test('privasi: orang yang tertaut ke profilnya sendiri melihat tahunnya, orang lain tidak', async () => {
  const e = env();
  e.sqlite.exec("INSERT INTO account_person_links(tree_id,account_id,person_id,status) VALUES ('t1','viewer','e','active')");
  assert.equal((await find(e, 'rahasia', 'viewer')).results[0].birth.year, 1990);
  assert.equal((await find(e, 'rahasia', 'contrib')).results[0].birth.year, null);
  e.sqlite.exec("UPDATE account_person_links SET status='pending'");
  assert.equal((await find(e, 'rahasia', 'viewer')).results[0].birth.year, null);
});

test('pencarian tidak mencocokkan tanggal sama sekali', async () => {
  const e = env();
  for (const q of ['1962', '1990', '1990-05-17', '2018', '1965']) assert.equal((await find(e, q)).total, 0, q);
});

test('kata kunci kosong, spasi, atau hanya tanda baca: tidak ada daftar semua orang', async () => {
  const e = env();
  for (const q of ['', '   ', "''", '---', '. ,']) assert.deepEqual(await find(e, q), { ok: true, results: [], total: 0, truncated: false }, JSON.stringify(q));
  assert.equal((await find(e, 5)).code, 'invalid_query');
  assert.equal((await find(e, null)).code, 'invalid_query');
  assert.equal((await find(e, 'a'.repeat(MAX_QUERY + 1))).code, 'query_too_long');
  assert.equal((await find(e, '😀'.repeat(MAX_QUERY))).ok, true); // hitung karakter, bukan unit UTF-16
});

test('kata kunci aneh aman: tidak ada galat dan tidak ada hasil', async () => {
  const e = env();
  for (const q of ["' OR 1=1 --", '%', '_', '\\', 'a%b', '"; DROP TABLE people; --']) assert.equal((await find(e, q)).total, 0, q);
  assert.equal(e.count('SELECT COUNT(*) n FROM people'), 8);
});

test('urutan hasil: persis, awalan, awalan kata, mengandung; lalu nama dan id', async () => {
  const e = env();
  e.add('w1', 'Budiman');
  e.add('w2', 'Sri Budi');
  e.add('w3', 'Rabudi');
  e.add('w4', 'Budi');
  const r = await find(e, 'budi');
  assert.deepEqual(r.results.map((x) => x.name), ['Budi', 'Budiman', 'Rahasia Budi', 'Sri Budi', 'Rabudi']);
});

test('urutan hasil: skor sama, kecocokan nama utama mendahului panggilan walau namanya lebih akhir secara abjad', async () => {
  const e = env();
  e.sqlite.exec("INSERT INTO people(id,tree_id,display_name,nickname) VALUES ('n1','t1','Aaron','Madiun'),('n2','t1','Madina',NULL)");
  assert.deepEqual(ids(await find(e, 'madi')), ['n2', 'n1']);
});

test('beberapa kata kunci: urutan bebas, semua harus cocok', async () => {
  const e = env();
  assert.deepEqual(ids(await find(e, 'fauzi ahmad')), ['a']);
  assert.deepEqual(ids(await find(e, 'rahman  AHMAD')), ['a']);
  assert.equal((await find(e, 'ahmad xyz')).total, 0);
  assert.deepEqual(ids(await find(e, 'mad')), ['a']); // potongan di tengah kata
});

test('batas hasil: total dan truncated jujur, limit dijepit', async () => {
  const e = env();
  for (let i = 0; i < 30; i++) e.add(`zt${String(i).padStart(2, '0')}`, `Zeta ${String(i).padStart(2, '0')}`);
  const r5 = await find(e, 'zeta', 'owner', { limit: 5 });
  assert.deepEqual([r5.results.length, r5.total, r5.truncated], [5, 30, true]);
  assert.equal(r5.results[0].name, 'Zeta 00');
  assert.equal((await find(e, 'zeta')).results.length, DEFAULT_LIMIT);
  assert.equal((await find(e, 'zeta', 'owner', { limit: 100000 })).results.length, 30);
  assert.equal(MAX_LIMIT, 50);
  assert.equal((await find(e, 'zeta', 'owner', { limit: 0 })).results.length, 1);
  for (const bad of ['x', 2.5, NaN, null]) assert.equal((await find(e, 'zeta', 'owner', { limit: bad })).results.length, DEFAULT_LIMIT, String(bad));
  const all = await find(e, 'zeta', 'owner', { limit: 50 });
  assert.deepEqual([all.results.length, all.truncated], [30, false]);
});

test('hanya membaca sekali per tabel (tanpa N+1), dan tidak menulis apa pun', async () => {
  const e = env();
  const log = [];
  const real = e.db.prepare;
  e.db.prepare = (sql) => { log.push(sql); return real(sql); };
  const before = e.count('SELECT COUNT(*) n FROM audit_events');
  await find(e, 'ahmad');
  assert.equal(log.filter((s) => /FROM people/.test(s)).length, 1);
  assert.equal(log.filter((s) => /FROM name_variants/.test(s)).length, 1);
  assert.ok(log.every((s) => /^\s*SELECT/i.test(s)));
  assert.equal(e.count('SELECT COUNT(*) n FROM audit_events'), before);
  log.length = 0;
  await find(e, '  ');
  assert.equal(log.filter((s) => /FROM people/.test(s)).length, 0); // kata kunci kosong tidak membaca profil
});

test('uji beban: 2.000 orang dengan 2.000 varian', async () => {
  const e = env();
  e.sqlite.exec('BEGIN');
  const ins = e.sqlite.prepare("INSERT INTO people(id,tree_id,display_name,nickname) VALUES (?,?,?,?)");
  const vin = e.sqlite.prepare("INSERT INTO name_variants(id,tree_id,person_id,variant) VALUES (?,?,?,?)");
  for (let i = 0; i < 2000; i++) { ins.run(`x${i}`, 't1', `Nama Panjang Orang ${i} Hidayat`, `Pnl${i}`); vin.run(`xv${i}`, 't1', `x${i}`, `Varian ${i}`); }
  e.sqlite.exec('COMMIT');
  const t = performance.now();
  const r = await find(e, 'hidayat');
  const ms = performance.now() - t;
  console.log(`# pencarian 2000 orang: ${ms.toFixed(1)} ms (termasuk baca sqlite)`);
  assert.equal(r.total, 2001); // 2000 + Ma'ruf Hidayat
  assert.equal(r.results.length, DEFAULT_LIMIT);
  assert.ok(ms < 1000);
});
