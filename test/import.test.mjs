import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_IMPORT_BYTES, MAX_PEOPLE, MAX_ROWS, validateImport } from '../src/import.js';

const NOW = new Date('2026-11-20T10:00:00Z');
const U = { precision: 'unknown', year: null, date: null };
const P = (id, over = {}) => ({
  id, name: `Orang ${id}`, gender: null, confirmation: 'unverified', sourceNote: null,
  isPlaceholder: false, placeholderOf: null, archived: false, birth: U, death: U, ...over,
});
const doc = (over = {}) => ({
  format: 'family-tree-export', version: 1, exportedAt: '2026-11-20T10:00:00.000Z', tree: { name: 'T' },
  people: [P('a'), P('b'), P('c')], nameVariants: [], parentChild: [], partnerships: [], ...over,
});
const V = (d) => validateImport(d, { now: NOW });
const codes = (d) => V(d).errors?.map((e) => `${e.path}:${e.code}`);
const one = (d, path, code) => assert.deepEqual(codes(d), [`${path}:${code}`]);
const edge = (over = {}) => ({ parent: 'a', child: 'b', type: 'biological', role: 'father', customLabel: null, ...over });

test('berkas minimal valid: data dinormalkan, ringkasan benar', () => {
  const r = V(doc({ parentChild: [edge()], partnerships: [{ a: 'a', b: 'c', status: 'married', startYear: 1990, endYear: null }], nameVariants: [{ person: 'a', variant: ' Achmad ' }] }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.summary, { people: 3, archived: 0, placeholders: 0, nameVariants: 1, parentChild: 1, partnerships: 1, hiddenBirthDates: 0, warningCounts: {} });
  assert.deepEqual(r.data.nameVariants, [{ person_id: 'a', variant: 'Achmad' }]);
  assert.deepEqual(r.data.parentChild[0], { parent_id: 'a', child_id: 'b', relation_type: 'biological', parent_role: 'father', custom_label: null });
  assert.deepEqual(r.data.partnerships[0], { person_a: 'a', person_b: 'c', status: 'married', start_year: 1990, end_year: null });
  assert.equal(r.data.people[0].fields.display_name, 'Orang a');
  assert.equal(r.data.people[0].fields.birth_precision, 'unknown');
});

test('masukan: string JSON, JSON rusak, bukan objek, terlalu besar', () => {
  assert.equal(V(JSON.stringify(doc())).ok, true);
  for (const bad of ['{', '', 'null']) assert.equal(V(bad).ok, false, bad);
  assert.deepEqual(V('{').errors, [{ path: '', code: 'invalid_json' }]);
  for (const bad of [null, 5, [], undefined]) assert.deepEqual(V(bad).errors, [{ path: '', code: 'invalid_payload' }], String(bad));
  assert.deepEqual(V('x'.repeat(MAX_IMPORT_BYTES + 1)).errors, [{ path: '', code: 'file_too_large' }]);
  assert.deepEqual(V('é'.repeat(MAX_IMPORT_BYTES / 2 + 1)).errors, [{ path: '', code: 'file_too_large' }]); // hitung byte, bukan karakter
});

test('format, versi, dan field tingkat atas', () => {
  assert.deepEqual(V(doc({ format: 'lain' })).errors, [{ path: 'format', code: 'wrong_format' }]);
  assert.deepEqual(V(doc({ version: 2 })).errors, [{ path: 'version', code: 'unsupported_version' }]);
  assert.deepEqual(V(doc({ version: '1' })).errors, [{ path: 'version', code: 'unsupported_version' }]);
  one(doc({ extra: 1 }), 'extra', 'unknown_field');
  one(doc({ exportedAt: 'kemarin' }), 'exportedAt', 'invalid_exported_at');
  one(doc({ tree: { name: 'x', id: 't1' } }), 'tree', 'invalid_tree');
  one(doc({ tree: null }), 'tree', 'invalid_tree');
  one(doc({ people: {} }), 'people', 'not_array');
  const noTree = doc(); delete noTree.partnerships;
  one(noTree, 'partnerships', 'not_array');
});

test('orang: id, duplikat, field asing, tipe, nama', () => {
  one(doc({ people: [P('a'), P('a')] }), 'people[1]', 'duplicate_id');
  for (const id of ['', 5, null, 'x'.repeat(65)]) one(doc({ people: [P('a', { id })] }), 'people[0]', 'invalid_id');
  one(doc({ people: [{ ...P('a'), tree_id: 't2' }] }), 'people[0]', 'unknown_field');
  one(doc({ people: [{ ...P('a'), birth_visibility: 'full' }] }), 'people[0]', 'unknown_field');
  one(doc({ people: ['x'] }), 'people[0]', 'invalid_person');
  one(doc({ people: [P('a', { name: '   ' })] }), 'people[0]', 'name_required');
  one(doc({ people: [P('a', { name: 5 })] }), 'people[0]', 'invalid_display_name');
  one(doc({ people: [P('a', { name: 'x'.repeat(201) })] }), 'people[0]', 'display_name_too_long');
  one(doc({ people: [P('a', { sourceNote: 'x'.repeat(501) })] }), 'people[0]', 'source_note_too_long');
  one(doc({ people: [P('a', { gender: 'x' })] }), 'people[0]', 'invalid_gender');
  one(doc({ people: [P('a', { confirmation: 'ya' })] }), 'people[0]', 'invalid_confirmation');
  one(doc({ people: [P('a', { archived: 'ya' })] }), 'people[0]', 'invalid_archived');
  one(doc({ people: [P('a', { isPlaceholder: 1 })] }), 'people[0]', 'invalid_isPlaceholder');
  assert.equal(V(doc({ people: [P('a', { name: '😀'.repeat(200) })] })).ok, true);
});

test('orang: kunci berbahaya tidak lolos dan tidak mencemari prototipe', () => {
  const evil = JSON.parse('{"id":"a","name":"A","__proto__":{"polluted":1}}');
  assert.equal(V(doc({ people: [evil] })).ok, false);
  assert.equal({}.polluted, undefined);
  assert.equal(V(doc({ people: [P('__proto__'), P('constructor')], parentChild: [edge({ parent: '__proto__', child: 'constructor' })] })).ok, true);
});

test('tanggal: kombinasi presisi, tahun, dan tanggal harus konsisten', () => {
  const ok = (birth, death = U) => V(doc({ people: [P('a', { birth, death })] })).ok;
  assert.equal(ok({ precision: 'full', year: 1990, date: '1990-05-17' }), true);
  assert.equal(ok({ precision: 'year', year: 1950, date: null }), true);
  assert.equal(ok({ precision: 'approx', year: 1950, date: null }), true);
  assert.equal(ok({ precision: 'unknown', year: null, date: null }), true);
  assert.equal(ok({ precision: 'hidden', year: null, date: null }), true);
  assert.equal(ok({ precision: 'year', year: 1950 }), true); // date boleh dihilangkan
  for (const bad of [
    { precision: 'full', year: 1990, date: '1990-02-30' }, { precision: 'full', year: 1991, date: '1990-05-17' },
    { precision: 'full', year: 1990, date: null }, { precision: 'full', year: 1990, date: '1990' },
    { precision: 'year', year: 1950, date: '1950' }, { precision: 'year', year: '1950' }, { precision: 'year', year: 1950.5 },
    { precision: 'year', year: 999 }, { precision: 'approx', year: null },
    { precision: 'unknown', year: 1950 }, { precision: 'hidden', date: '1990-05-17' },
    { precision: 'rahasia', year: null }, { year: 1950 }, 'x', { precision: 'year', year: 1950, tz: 1 },
  ]) assert.equal(ok(bad), false, JSON.stringify(bad));
  one(doc({ people: [P('a', { death: { precision: 'hidden', year: null, date: null } })] }), 'people[0].death', 'invalid_date');
  one(doc({ people: [P('a', { birth: { precision: 'rahasia' } })] }), 'people[0].birth', 'invalid_date');
});

test('tanggal tersembunyi dihitung sebagai tidak ada di berkas, dilaporkan di ringkasan', () => {
  const h = { precision: 'hidden', year: null, date: null };
  const r = V(doc({ people: [P('a', { birth: h }), P('b', { birth: h }), P('c')] }));
  assert.equal(r.summary.hiddenBirthDates, 2);
  assert.equal(r.data.people[0].fields.birth_date, null);
  assert.equal(r.data.people[0].fields.birth_precision, 'unknown');
});

test('placeholder: placeholderOf wajib placeholder, menunjuk orang di berkas, bukan diri sendiri', () => {
  assert.equal(V(doc({ people: [P('a'), P('p', { isPlaceholder: true, placeholderOf: 'a' })] })).ok, true);
  one(doc({ people: [P('a'), P('p', { placeholderOf: 'a' })] }), 'people[1]', 'placeholder_of_without_placeholder');
  one(doc({ people: [P('p', { isPlaceholder: true, placeholderOf: 'hantu' })] }), 'people[0]', 'unknown_person');
  one(doc({ people: [P('p', { isPlaceholder: true, placeholderOf: 'p' })] }), 'people[0]', 'invalid_placeholder_of');
  one(doc({ people: [P('p', { isPlaceholder: true, placeholderOf: 5 })] }), 'people[0]', 'invalid_placeholder_of');
  assert.equal(V(doc({ people: [P('p', { isPlaceholder: true })] })).summary.placeholders, 1);
});

test('varian ejaan: orang harus ada, tidak kosong, tanpa duplikat (tak peka huruf), tanpa field asing', () => {
  const nv = (...v) => doc({ nameVariants: v });
  one(nv({ person: 'hantu', variant: 'X' }), 'nameVariants[0]', 'unknown_person');
  one(nv({ person: 'a', variant: '  ' }), 'nameVariants[0]', 'invalid_variant');
  one(nv({ person: 'a', variant: 5 }), 'nameVariants[0]', 'invalid_variant');
  one(nv({ person: 'a', variant: 'x'.repeat(201) }), 'nameVariants[0]', 'invalid_variant');
  one(nv({ person: 'a', variant: 'X', id: 1 }), 'nameVariants[0]', 'invalid_variant');
  one(nv({ person: 'a', variant: 'Ahmat' }, { person: 'a', variant: ' AHMAT ' }), 'nameVariants[1]', 'duplicate_variant');
  assert.equal(V(nv({ person: 'a', variant: 'Ahmat' }, { person: 'b', variant: 'Ahmat' })).ok, true);
});

test('relasi: jenis, peran, label, orang, diri sendiri, dobel (apa pun jenisnya), field asing', () => {
  const pc = (...e) => doc({ parentChild: e });
  one(pc(edge({ type: 'darah' })), 'parentChild[0]', 'invalid_relation_type');
  one(pc(edge({ role: 'kakek' })), 'parentChild[0]', 'invalid_parent_role');
  one(pc(edge({ type: 'custom' })), 'parentChild[0]', 'custom_label_required');
  one(pc(edge({ customLabel: 'Pengasuh' })), 'parentChild[0]', 'custom_label_not_allowed');
  one(pc(edge({ type: 'custom', customLabel: 'x'.repeat(101) })), 'parentChild[0]', 'custom_label_too_long');
  assert.equal(V(pc(edge({ type: 'custom', customLabel: 'Pengasuh' }))).ok, true);
  one(pc(edge({ child: 'a' })), 'parentChild[0]', 'same_person');
  one(pc(edge({ child: 'hantu' })), 'parentChild[0]', 'unknown_person');
  one(pc(edge({ parent: undefined })), 'parentChild[0]', 'invalid_endpoints');
  one(pc(edge({ tree_id: 't' })), 'parentChild[0]', 'unknown_field');
  one(pc(edge(), edge({ type: 'adoptive' })), 'parentChild[1]', 'duplicate_edge');
  assert.equal(V(pc(edge(), edge({ parent: 'b', child: 'c' }), edge({ parent: 'a', child: 'c' }))).ok, true);
  // tanpa peran netral (U3 dicabut): peran wajib dan hanya father atau mother
  one(pc({ parent: 'a', child: 'b', type: 'step' }), 'parentChild[0]', 'invalid_parent_role');
  one(pc(edge({ role: 'parent' })), 'parentChild[0]', 'invalid_parent_role');
  one(pc(edge({ role: null })), 'parentChild[0]', 'invalid_parent_role');
  assert.equal(V(pc(edge({ role: 'mother' }))).data.parentChild[0].parent_role, 'mother');
});

test('siklus ditolak: langsung, berantai, semua jenis relasi; jalur berlian bukan siklus', () => {
  const pc = (...e) => doc({ parentChild: e });
  assert.deepEqual(codes(pc(edge(), edge({ parent: 'b', child: 'a' }))), ['parentChild[0]:would_create_cycle', 'parentChild[1]:would_create_cycle']);
  const chain = pc(edge(), edge({ parent: 'b', child: 'c', type: 'adoptive' }), edge({ parent: 'c', child: 'a', type: 'guardian' }));
  assert.equal(codes(chain).length, 3);
  assert.ok(codes(chain).every((c) => c.endsWith('would_create_cycle')));
  const d = doc({ people: [P('a'), P('b'), P('c'), P('d')], parentChild: [edge(), edge({ parent: 'a', child: 'c' }), edge({ parent: 'b', child: 'd' }), edge({ parent: 'c', child: 'd' })] });
  assert.equal(V(d).ok, true);
});

test('pasangan: status, tahun, orang, diri sendiri, dobel walau urutan terbalik, bersamaan tanpa peringatan', () => {
  const pt = (...p) => doc({ partnerships: p });
  const part = (over = {}) => ({ a: 'a', b: 'b', status: 'married', startYear: null, endYear: null, ...over });
  one(pt(part({ status: 'pertama' })), 'partnerships[0]', 'invalid_status');
  one(pt(part({ b: 'a' })), 'partnerships[0]', 'same_person');
  one(pt(part({ b: 'hantu' })), 'partnerships[0]', 'unknown_person');
  one(pt(part({ startYear: '2000' })), 'partnerships[0]', 'invalid_start_year');
  one(pt(part({ endYear: 99 })), 'partnerships[0]', 'invalid_end_year');
  one(pt(part({ order: 1 })), 'partnerships[0]', 'unknown_field');
  one(pt(part(), part({ a: 'b', b: 'a', status: 'divorced' })), 'partnerships[1]', 'duplicate_partnership');
  const multi = V(pt(part(), part({ b: 'c' })));
  assert.equal(multi.ok, true);
  assert.deepEqual(multi.warnings, []);
  assert.equal(V(pt({ a: 'a', b: 'b', status: 'unknown' })).data.partnerships[0].start_year, null); // tahun boleh dihilangkan
});

test('peringatan lunak tidak memblokir dan dihitung per jenis', () => {
  const full = (d) => ({ precision: 'full', year: Number(d.slice(0, 4)), date: d });
  const yr = (y) => ({ precision: 'year', year: y, date: null });
  const r = V(doc({
    people: [P('a', { birth: yr(1990), death: yr(1980) }), P('b', { birth: yr(1850) }), P('young', { birth: full('2000-06-01') }), P('old', { birth: full('1999-05-01') }), P('older', { birth: full('1950-01-01') }), P('x'), P('y')],
    parentChild: [
      { parent: 'young', child: 'old', type: 'biological', role: 'father', customLabel: null },
      { parent: 'young', child: 'older', type: 'adoptive', role: 'father', customLabel: null }, // bukan biologis, orang tua lebih muda: tanpa peringatan
      { parent: 'young', child: 'x', type: 'guardian', role: 'father', customLabel: null },
      { parent: 'x', child: 'y', type: 'biological', role: 'father', customLabel: null }, // tanggal tak diketahui: tanpa peringatan
    ],
    partnerships: [{ a: 'a', b: 'b', status: 'divorced', startYear: 2000, endYear: 1990 }],
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.summary.warningCounts, { death_before_birth: 1, age_over_120: 1, parent_younger_than_child: 1, end_before_start: 1 });
  assert.deepEqual(r.warnings.find((w) => w.code === 'parent_younger_than_child'), { path: 'parentChild[0]', code: 'parent_younger_than_child' });
});

test('daftar peringatan dibatasi, hitungan tetap lengkap', () => {
  const people = Array.from({ length: 300 }, (_, i) => P(`p${i}`, { birth: { precision: 'year', year: 1990, date: null }, death: { precision: 'year', year: 1980, date: null } }));
  const r = V(doc({ people }));
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 200);
  assert.equal(r.summary.warningCounts.death_before_birth, 300);
});

test('banyak galat: dikumpulkan sampai 50, sisanya ditandai moreErrors', () => {
  const people = Array.from({ length: 80 }, (_, i) => P(`p${i}`, { name: '' }));
  const r = V(doc({ people }));
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 50);
  assert.equal(r.moreErrors, true);
  assert.equal(V(doc({ people: [P('a', { name: '' }), P('b', { name: '' })] })).moreErrors, false);
});

test('batas jumlah baris', () => {
  assert.deepEqual(V(doc({ people: new Array(MAX_PEOPLE + 1).fill(0) })).errors, [{ path: 'people', code: 'too_many_people' }]);
  assert.deepEqual(V(doc({ parentChild: new Array(MAX_ROWS + 1).fill(0) })).errors, [{ path: 'parentChild', code: 'too_many_rows' }]);
});

test('uji beban: 2.000 orang dengan relasi divalidasi cepat', () => {
  const people = Array.from({ length: 2000 }, (_, i) => P(`p${i}`, { birth: { precision: 'year', year: 1900 + (i % 100), date: null } }));
  const parentChild = Array.from({ length: 1999 }, (_, i) => edge({ parent: `p${Math.floor(i / 2)}`, child: `p${i + 1}` }));
  const t = performance.now();
  const r = V(doc({ people, parentChild }));
  const ms = performance.now() - t;
  assert.equal(r.ok, true, JSON.stringify(r.errors?.slice(0, 3)));
  console.log(`# validasi 2000 orang: ${ms.toFixed(1)} ms`);
  assert.ok(ms < 1000);
});
