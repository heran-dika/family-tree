// Filter privasi: fungsi murni yang menentukan apa yang boleh dilihat seorang penonton (viewer).
// Semua jalur baca (pohon, pencarian, usulan, audit, ekspor) WAJIB melewati modul ini.
//
// Konteks penonton:
//   viewer = { role, selfPersonId?, guardianOfIds? }
//   role           peran di pohon ini ('viewer' | 'contributor' | 'admin' | 'owner'); bukan anggota = tidak ada akses
//   selfPersonId   id profil yang tertaut ke akun penonton (U8), bila ada
//   guardianOfIds  Set id profil anak yang penonton menjadi walinya
//
// Aturan tanggal lahir (PRD P0-1, P0-2, P1-5):
//   - Nama, panggilan, struktur relasi, dan tanggal meninggal selalu terlihat oleh anggota.
//   - Dewasa yang memilih sendiri (visibility_by_self = 1): ikut pilihannya (full / year / hidden).
//   - Selain itu (belum memilih, tanpa akun, atau pilihan lama dari wali): paling banyak tahun saja.
//   - Anak di bawah 18: orang lain hanya melihat tahun (atau tersembunyi); tanggal lengkap hanya untuk
//     Owner/Admin, wali, dan anak itu sendiri.
//   - Orang itu sendiri selalu melihat tanggal lengkapnya.
//   - Nilai tidak dikenal diperlakukan sebagai 'hidden' (gagal aman).
//
// KEPUTUSAN YANG BELUM DIKONFIRMASI (ditandai [Menebak] di log):
//   - Untuk DEWASA yang memilih 'hidden', Owner/Admin juga tidak melihat. Hanya untuk anak ada pengecualian Owner/Admin.
//   - Tanggal meninggal tidak punya pengaturan privasi.

import { can } from './permissions.js';

export const ADULT_AGE = 18;

const ORDER = { hidden: 0, year: 1, full: 2 };
const FULL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const YEAR = /^(\d{4})/;

const norm = (v) => (typeof v === 'string' && Object.hasOwn(ORDER, v) ? v : 'hidden');
const cap = (level, max) => (ORDER[level] <= ORDER[max] ? level : max);
const yearOf = (d) => {
  const m = typeof d === 'string' ? YEAR.exec(d) : null;
  return m ? Number(m[1]) : null;
};
const knownDate = (p) => (p.birth_precision === 'unknown' ? null : p.birth_date ?? null);

// Anak di bawah 18? Tanggal lengkap dihitung persis. Hanya tahun: dianggap anak bila mungkin masih di bawah 18.
export function isMinor(person, now = new Date()) {
  const d = knownDate(person);
  if (typeof d === 'string' && FULL_DATE.test(d)) {
    const [y, m, day] = d.split('-').map(Number);
    const nm = now.getUTCMonth() + 1;
    const nd = now.getUTCDate();
    const age = now.getUTCFullYear() - y - (nm < m || (nm === m && nd < day) ? 1 : 0);
    return age < ADULT_AGE;
  }
  const y = yearOf(d);
  return y !== null && now.getUTCFullYear() - y <= ADULT_AGE;
}

// Tingkat tanggal lahir yang boleh dilihat penonton ini: 'full' | 'year' | 'hidden'.
export function effectiveLevel(person, viewer, now = new Date()) {
  const stored = norm(person.birth_visibility);
  if (viewer.selfPersonId != null && viewer.selfPersonId === person.id) return 'full';
  const minor = isMinor(person, now);
  if (minor) {
    const privileged = Boolean(viewer.guardianOfIds?.has(person.id)) || can(viewer.role, 'person.edit_direct');
    return privileged ? 'full' : cap(stored, 'year');
  }
  return person.visibility_by_self === 1 ? stored : cap(stored, 'year');
}

const UNKNOWN = { precision: 'unknown', year: null, date: null };

function shape(date, precision, level) {
  if (level === 'hidden') return { precision: 'hidden', year: null, date: null };
  if (precision === 'unknown') return UNKNOWN;
  const year = yearOf(date);
  if (year === null) return UNKNOWN;
  if (precision === 'full' && FULL_DATE.test(date) && level === 'full') return { precision: 'full', year, date };
  // tahun + bulan disimpan sebagai presisi 'year' dengan date 'YYYY-MM'; bulan hanya tampil bila tingkatnya 'full'
  const month = precision === 'year' && level === 'full' && /^\d{4}-\d{2}$/.test(date) ? Number(date.slice(5)) : null;
  return { precision: precision === 'approx' ? 'approx' : 'year', year, date: null, ...(month ? { month } : {}) };
}

// Profil untuk ditampilkan. Mengembalikan null bila penonton bukan anggota.
export function redactPerson(person, viewer, now = new Date()) {
  if (!viewer || !can(viewer.role, 'tree.read')) return null;
  const level = effectiveLevel(person, viewer, now);
  return {
    id: person.id,
    name: person.display_name,
    gender: person.gender ?? null,
    confirmation: person.confirmation ?? 'unverified',
    sourceNote: person.source_note ?? null,
    isPlaceholder: Boolean(person.is_placeholder),
    archived: person.archived_at != null,
    birth: shape(person.birth_date, person.birth_precision, level),
    death: shape(person.death_date, person.death_precision, 'full'),
  };
}

// Untuk nilai sebelum/sesudah di usulan dan audit log (peta field, bisa sebagian).
// Tingkat ditentukan dari catatan orang SAAT INI, bukan dari isi usulan, supaya usulan yang
// mengubah pengaturan privasi tidak bisa dipakai membuka tanggal.
// `person` boleh null untuk usulan membuat orang baru (dianggap pengaturan bawaan: tahun saja).
export function redactSnapshot(snapshot, person, viewer, now = new Date()) {
  if (!viewer || !can(viewer.role, 'tree.read') || snapshot == null) return null;
  const subject = person ?? {
    birth_date: snapshot.birth_date,
    birth_precision: snapshot.birth_precision,
    birth_visibility: 'year',
    visibility_by_self: 0,
  };
  const level = effectiveLevel(subject, viewer, now);
  const values = { ...snapshot };
  const masked = [];
  if (Object.hasOwn(values, 'birth_date') && level !== 'full') {
    const y = level === 'year' ? yearOf(values.birth_date) : null;
    values.birth_date = y === null ? null : String(y);
    masked.push('birth_date');
  }
  return { values, masked };
}
