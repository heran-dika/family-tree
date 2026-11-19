import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { effectiveLevel, isMinor, redactPerson, redactSnapshot } from '../src/privacy.js';

const NOW = new Date('2026-11-19T12:00:00Z');
const ROLES = ['viewer', 'contributor', 'admin', 'owner'];
const base = {
  id: 'p1', display_name: 'Budi', nickname: 'Bud', gender: 'male', confirmation: 'confirmed',
  source_note: 'akta', is_placeholder: 0, archived_at: null,
  birth_date: '1990-05-17', birth_precision: 'full', birth_visibility: 'year', visibility_by_self: 0,
  death_date: null, death_precision: 'unknown',
};
const person = (over = {}) => ({ ...base, ...over });
const as = (role, extra = {}) => ({ role, ...extra });

test('bukan anggota atau peran tak dikenal: tidak ada akses sama sekali', () => {
  assert.equal(redactPerson(person(), null, NOW), null);
  assert.equal(redactPerson(person(), {}, NOW), null);
  assert.equal(redactPerson(person(), { role: 'hacker' }, NOW), null);
  assert.equal(redactSnapshot({ birth_date: '1990-05-17' }, person(), { role: 'x' }, NOW), null);
});

test('dewasa yang belum memilih: hanya tahun, untuk semua peran termasuk Owner', () => {
  for (const role of ROLES) {
    const r = redactPerson(person({ birth_visibility: 'year' }), as(role), NOW);
    assert.deepEqual(r.birth, { precision: 'year', year: 1990, date: null }, role);
  }
});

test('dewasa memilih sendiri "full": semua anggota melihat tanggal lengkap', () => {
  for (const role of ROLES) {
    const r = redactPerson(person({ birth_visibility: 'full', visibility_by_self: 1 }), as(role), NOW);
    assert.deepEqual(r.birth, { precision: 'full', year: 1990, date: '1990-05-17' }, role);
  }
});

test('pengaturan "full" yang BUKAN pilihan sendiri tidak membuka tanggal (aturan usia 18)', () => {
  for (const role of ROLES) {
    const r = redactPerson(person({ birth_visibility: 'full', visibility_by_self: 0 }), as(role), NOW);
    assert.equal(r.birth.date, null, role);
    assert.equal(r.birth.year, 1990, role);
  }
});

test('dewasa memilih "hidden": semua peran melihat tersembunyi, dirinya sendiri melihat penuh', () => {
  const p = person({ birth_visibility: 'hidden', visibility_by_self: 1 });
  for (const role of ROLES) {
    assert.deepEqual(redactPerson(p, as(role), NOW).birth, { precision: 'hidden', year: null, date: null }, role);
  }
  const self = redactPerson(p, as('viewer', { selfPersonId: 'p1' }), NOW);
  assert.equal(self.birth.date, '1990-05-17');
});

test('anak di bawah 18: Viewer dan Contributor hanya tahun walau pengaturannya "full"', () => {
  const kid = person({ birth_date: '2015-03-02', birth_visibility: 'full', visibility_by_self: 1 });
  for (const role of ['viewer', 'contributor']) {
    const r = redactPerson(kid, as(role), NOW);
    assert.deepEqual(r.birth, { precision: 'year', year: 2015, date: null }, role);
  }
});

test('anak di bawah 18: Owner, Admin, wali, dan anak itu sendiri melihat tanggal lengkap', () => {
  const kid = person({ birth_date: '2015-03-02', birth_visibility: 'hidden' });
  for (const role of ['admin', 'owner']) assert.equal(redactPerson(kid, as(role), NOW).birth.date, '2015-03-02', role);
  assert.equal(redactPerson(kid, as('viewer', { guardianOfIds: new Set(['p1']) }), NOW).birth.date, '2015-03-02');
  assert.equal(redactPerson(kid, as('viewer', { selfPersonId: 'p1' }), NOW).birth.date, '2015-03-02');
});

test('wali anak lain tidak mendapat hak atas anak ini', () => {
  const kid = person({ birth_date: '2015-03-02', birth_visibility: 'year' });
  const r = redactPerson(kid, as('contributor', { guardianOfIds: new Set(['p999']) }), NOW);
  assert.equal(r.birth.date, null);
});

test('anak dengan pengaturan "hidden": orang lain melihat tersembunyi', () => {
  const kid = person({ birth_date: '2015-03-02', birth_visibility: 'hidden' });
  assert.equal(redactPerson(kid, as('viewer'), NOW).birth.precision, 'hidden');
});

test('batas usia 18 dihitung persis pada tanggal lengkap', () => {
  assert.equal(isMinor(person({ birth_date: '2008-11-19' }), NOW), false); // tepat 18 hari ini
  assert.equal(isMinor(person({ birth_date: '2008-11-20' }), NOW), true); // 18 besok
  assert.equal(isMinor(person({ birth_date: '2008-12-31' }), NOW), true);
  assert.equal(isMinor(person({ birth_date: '2008-01-01' }), NOW), false);
});

test('hanya tahun diketahui: dianggap anak bila mungkin masih di bawah 18 (gagal aman)', () => {
  assert.equal(isMinor(person({ birth_date: '2008', birth_precision: 'year' }), NOW), true);
  assert.equal(isMinor(person({ birth_date: '2007', birth_precision: 'year' }), NOW), false);
  assert.equal(isMinor(person({ birth_date: '2010', birth_precision: 'approx' }), NOW), true);
});

test('tanggal lahir tidak diketahui: tidak error, tidak dianggap anak', () => {
  const p = person({ birth_date: null, birth_precision: 'unknown' });
  assert.equal(isMinor(p, NOW), false);
  assert.deepEqual(redactPerson(p, as('viewer'), NOW).birth, { precision: 'unknown', year: null, date: null });
  const hidden = person({ birth_date: null, birth_precision: 'unknown', birth_visibility: 'hidden', visibility_by_self: 1 });
  assert.equal(redactPerson(hidden, as('viewer'), NOW).birth.precision, 'hidden'); // tidak membocorkan "ada atau tidak"
});

test('perkiraan tampil sebagai approx, tidak pernah sebagai tanggal', () => {
  const p = person({ birth_date: '1950', birth_precision: 'approx', birth_visibility: 'full', visibility_by_self: 1 });
  assert.deepEqual(redactPerson(p, as('viewer'), NOW).birth, { precision: 'approx', year: 1950, date: null });
});

test('presisi tahun walau pengaturan "full": tetap tahun', () => {
  const p = person({ birth_date: '1950', birth_precision: 'year', birth_visibility: 'full', visibility_by_self: 1 });
  assert.deepEqual(redactPerson(p, as('viewer'), NOW).birth, { precision: 'year', year: 1950, date: null });
});

test('nilai visibilitas tak dikenal diperlakukan sebagai hidden', () => {
  const p = person({ birth_visibility: 'terbuka', visibility_by_self: 1 });
  assert.equal(redactPerson(p, as('owner'), NOW).birth.precision, 'hidden');
  assert.equal(effectiveLevel(person({ birth_visibility: null, visibility_by_self: 1 }), as('owner'), NOW), 'hidden');
});

test('nama, panggilan, placeholder, arsip, dan tanggal meninggal tetap terlihat saat tanggal lahir tersembunyi', () => {
  const p = person({
    birth_visibility: 'hidden', visibility_by_self: 1, is_placeholder: 1, archived_at: '2026-01-01',
    death_date: '2020-02-03', death_precision: 'full',
  });
  const r = redactPerson(p, as('viewer'), NOW);
  assert.equal(r.name, 'Budi');
  assert.equal(r.nickname, 'Bud');
  assert.equal(r.isPlaceholder, true);
  assert.equal(r.archived, true);
  assert.deepEqual(r.death, { precision: 'full', year: 2020, date: '2020-02-03' });
});

test('tanggal tersembunyi tidak muncul di bentuk apa pun pada keluaran', () => {
  const p = person({ birth_visibility: 'hidden', visibility_by_self: 1 });
  for (const role of ROLES) {
    const s = JSON.stringify(redactPerson(p, as(role), NOW));
    assert.ok(!s.includes('1990-05-17'), `${role} tanggal bocor`);
    assert.ok(!s.includes('1990'), `${role} tahun bocor`);
  }
});

test('invarian: penonton biasa hanya melihat tanggal lengkap bila dewasa, memilih sendiri, dan memilih full', () => {
  for (const birth_date of ['1990-05-17', '2015-03-02']) {
    for (const birth_visibility of ['full', 'year', 'hidden']) {
      for (const visibility_by_self of [0, 1]) {
        for (const role of ['viewer', 'contributor']) {
          const p = person({ birth_date, birth_visibility, visibility_by_self });
          const r = redactPerson(p, as(role), NOW);
          const allowed = birth_date === '1990-05-17' && visibility_by_self === 1 && birth_visibility === 'full';
          assert.equal(r.birth.date !== null, allowed, JSON.stringify({ birth_date, birth_visibility, visibility_by_self, role }));
          if (birth_visibility === 'hidden') assert.equal(r.birth.year, null);
        }
      }
    }
  }
});

test('snapshot usulan: tanggal disamarkan menurut catatan orang saat ini, penanda masked diisi', () => {
  const before = { display_name: 'Budi', birth_date: '1990-05-17' };
  const out = redactSnapshot(before, person({ birth_visibility: 'year' }), as('contributor'), NOW);
  assert.deepEqual(out.values, { display_name: 'Budi', birth_date: '1990' });
  assert.deepEqual(out.masked, ['birth_date']);
  const hid = redactSnapshot(before, person({ birth_visibility: 'hidden', visibility_by_self: 1 }), as('owner'), NOW);
  assert.equal(hid.values.birth_date, null);
  assert.deepEqual(hid.masked, ['birth_date']);
});

test('snapshot: yang boleh melihat penuh tidak disamarkan, dan input tidak diubah', () => {
  const snap = { birth_date: '1990-05-17' };
  const out = redactSnapshot(snap, person({ birth_visibility: 'full', visibility_by_self: 1 }), as('viewer'), NOW);
  assert.deepEqual(out, { values: { birth_date: '1990-05-17' }, masked: [] });
  redactSnapshot(snap, person(), as('viewer'), NOW);
  assert.equal(snap.birth_date, '1990-05-17');
});

test('snapshot: usulan yang mengubah visibilitas ke "full" tidak bisa dipakai membuka tanggal', () => {
  const after = { birth_date: '1990-05-17', birth_visibility: 'full' };
  const out = redactSnapshot(after, person({ birth_visibility: 'hidden', visibility_by_self: 1 }), as('contributor'), NOW);
  assert.equal(out.values.birth_date, null);
});

test('snapshot tanpa field tanggal lahir tidak disentuh; orang baru memakai bawaan tahun saja', () => {
  assert.deepEqual(redactSnapshot({ nickname: 'Bud' }, person(), as('viewer'), NOW), { values: { nickname: 'Bud' }, masked: [] });
  const created = redactSnapshot({ display_name: 'Baru', birth_date: '1999-09-09', birth_precision: 'full' }, null, as('viewer'), NOW);
  assert.equal(created.values.birth_date, '1999');
});

test('migrasi 0003: kolom visibility_by_self default 0 dan hanya menerima 0 atau 1', () => {
  const db = new DatabaseSync(':memory:');
  for (const f of ['0001_init', '0002_people_gender', '0003_people_visibility_by_self']) {
    db.exec(readFileSync(new URL(`../migrations/${f}.sql`, import.meta.url), 'utf8'));
  }
  db.exec("INSERT INTO accounts(id,email) VALUES('u','u@x'); INSERT INTO family_trees(id,name,created_by) VALUES('t','T','u'); INSERT INTO people(id,tree_id,display_name) VALUES('p','t','A')");
  assert.equal(db.prepare("SELECT visibility_by_self v FROM people WHERE id='p'").get().v, 0);
  assert.throws(() => db.exec("UPDATE people SET visibility_by_self = 2 WHERE id='p'"));
});
