// Deteksi kemungkinan duplikat (PRD P0-4 dan P2-1): dipanggil SEBELUM membuat profil atau mengisi identitas placeholder,
// supaya pengguna ditawari memakai profil yang ada. Ini PERINGATAN, bukan penghalang: penerapan tidak menolak nama kembar
// (bapak dan anak yang bernama sama itu lazim). Penggabungan sungguhan (merge) adalah P2-1 dan belum ada.
//
// Cocok bila nama (atau variasi ejaan) sama persis, sama bila urutan kata diabaikan, atau beda satu huruf (nama >= 5 karakter),
// setelah normalisasi seperti pencarian (huruf besar, aksen, apostrof). Bila tahun lahir kedua pihak diketahui dan selisihnya
// lebih dari YEAR_TOLERANCE, bukan kandidat.
//
// PRIVASI: tahun yang dibandingkan adalah tahun yang BOLEH DILIHAT penanya (lewat redactPerson). Tahun tersembunyi dianggap
// tidak diketahui. Memakai tahun asli akan membocorkannya (kandidat hilang bila tahunnya jauh).
// Tidak dianggap kandidat: profil arsip dan placeholder (namanya sintetis), serta profil yang sedang diubah (excludeId).

import { forTree, getMembership } from './db.js';
import { can } from './permissions.js';
import { redactPerson } from './privacy.js';
import { norm } from './search.js';

export const YEAR_TOLERANCE = 2; // [Menebak] untuk tahun perkiraan dan salah catat
export const MAX_NAME = 200;
export const DEFAULT_LIMIT = 5;
export const MAX_LIMIT = 20;
const MIN_CLOSE = 5;

const sortedWords = (s) => s.split(' ').sort().join(' ');

function withinOneEdit(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  return s.slice(i) === l.slice(i + 1);
}

// 0 persis, 1 kata sama beda urutan, 2 beda satu huruf; null tidak mirip
function similarity(text, q, qSorted) {
  if (!text) return null;
  if (text === q) return 0;
  if (sortedWords(text) === qSorted) return 1;
  if (q.length >= MIN_CLOSE && text.length >= MIN_CLOSE && withinOneEdit(text, q)) return 2;
  return null;
}
const REASONS = ['exact', 'tokens', 'close'];

export async function findDuplicates(db, { treeId, actorId, name, birthYear = null, excludeId = null, limit, now = new Date() }) {
  const m = await getMembership(db, treeId, actorId);
  if (!m || !can(m.role, 'person.propose')) return { ok: false, code: 'forbidden' };
  if (typeof name !== 'string') return { ok: false, code: 'invalid_name' };
  if ([...name].length > MAX_NAME) return { ok: false, code: 'name_too_long' };
  if (birthYear !== null && !(Number.isInteger(birthYear) && birthYear >= 1000 && birthYear <= 9999)) return { ok: false, code: 'invalid_birth_year' };
  if (excludeId !== null && typeof excludeId !== 'string') return { ok: false, code: 'invalid_exclude_id' };
  const q = norm(name);
  if (!q) return { ok: true, candidates: [], total: 0 };
  const qSorted = sortedWords(q);
  const lim = Number.isInteger(limit) ? Math.min(MAX_LIMIT, Math.max(1, limit)) : DEFAULT_LIMIT;

  const t = forTree(db, treeId);
  const people = await t.all('SELECT * FROM people WHERE tree_id = ?1 AND archived_at IS NULL AND is_placeholder = 0');
  const variants = new Map();
  for (const v of await t.all('SELECT person_id, variant FROM name_variants WHERE tree_id = ?1')) {
    if (!variants.has(v.person_id)) variants.set(v.person_id, []);
    variants.get(v.person_id).push(v.variant);
  }

  const named = [];
  for (const p of people) {
    if (p.id === excludeId) continue;
    let best = null;
    const consider = (text, viaVariant, shown) => {
      const sim = similarity(text, q, qSorted);
      if (sim !== null && (!best || sim < best.sim)) best = { sim, viaVariant, shown };
    };
    consider(norm(p.display_name), false, null);
    for (const v of variants.get(p.id) ?? []) consider(norm(v), true, v);
    if (best) named.push({ p, ...best });
  }
  if (!named.length) return { ok: true, candidates: [], total: 0 };

  const link = await t.first("SELECT person_id FROM account_person_links WHERE tree_id = ?1 AND account_id = ?2 AND status = 'active'", [actorId]);
  const viewer = { role: m.role, selfPersonId: link?.person_id ?? null, guardianOfIds: new Set() };
  const out = [];
  for (const h of named) {
    const r = redactPerson(h.p, viewer, now);
    const cy = r.birth.year;
    const known = birthYear !== null && cy !== null;
    if (known && Math.abs(cy - birthYear) > YEAR_TOLERANCE) continue;
    out.push({
      id: r.id, name: r.name, birth: { precision: r.birth.precision === 'full' ? 'year' : r.birth.precision, year: cy },
      matchedOn: h.viaVariant ? 'variant' : 'name', ...(h.viaVariant ? { variant: h.shown } : {}),
      reason: REASONS[h.sim], yearCheck: known ? 'match' : 'unknown', _k: norm(r.name),
    });
  }
  out.sort((a, b) => REASONS.indexOf(a.reason) - REASONS.indexOf(b.reason) || (a.yearCheck === b.yearCheck ? 0 : a.yearCheck === 'match' ? -1 : 1) || (a._k < b._k ? -1 : a._k > b._k ? 1 : a.id < b.id ? -1 : 1));
  const candidates = out.slice(0, lim).map(({ _k, ...c }) => c);
  return { ok: true, candidates, total: out.length };
}
