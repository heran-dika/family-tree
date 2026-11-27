// Pencarian orang (PRD P0-1). Nama utama, nama panggilan, dan variasi ejaan; tidak peka huruf besar, aksen,
// apostrof, dan tanda hubung. Hanya pohon yang diminta, hanya profil yang tidak diarsipkan, hanya anggota aktif.
// Hasil selalu lewat redactPerson, dan hanya TAHUN yang dikembalikan (tidak pernah tanggal lengkap).
// Pencarian tidak mencocokkan tanggal sama sekali, jadi tidak ada cara menebak tanggal tersembunyi lewat pencarian.
//
// Normalisasi dilakukan di JS saat baca (D1/SQLite tidak punya pencocokan aksen). Biayanya: satu pencarian membaca
// semua profil aktif pohon itu (n baris) + varian (m baris) dari kuota baca harian. Tidak ada kolom ternormalisasi
// di tabel, jadi tidak ada risiko tidak sinkron di jalur tulis. Bila kuota baca jadi masalah, tambahkan kolom lewat migrasi.

import { forTree, getMembership } from './db.js';
import { can } from './permissions.js';
import { redactPerson } from './privacy.js';

export const MAX_QUERY = 100;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

// huruf kecil, tanpa tanda aksen dan apostrof (Ma'ruf = Maruf), tanda baca pemisah menjadi spasi
export const norm = (s) =>
  String(s ?? '')
    .normalize('NFKD')
    .replace(/[\p{M}'’‘ʻʼʿ`´]/gu, '')
    .toLowerCase()
    .replace(/[\s\-._,]+/g, ' ')
    .trim();

// 0 persis, 1 awalan, 2 awalan kata (semua kata kunci), 3 mengandung (semua kata kunci); null tidak cocok
function score(f, q, tokens) {
  if (!f) return null;
  if (f === q) return 0;
  if (f.startsWith(q)) return 1;
  const words = f.split(' ');
  if (tokens.every((t) => words.some((w) => w.startsWith(t)))) return 2;
  if (tokens.every((t) => f.includes(t))) return 3;
  return null;
}

const FIELDS = ['name', 'variant'];
// Hasil pencarian hanya memuat tahun. 'full' dijadikan 'year' supaya presisi pun tidak memberi tahu bahwa ada tanggal lengkap.
const yearOnly = (d) => ({ precision: d.precision === 'full' ? 'year' : d.precision, year: d.year });

export async function searchPeople(db, { treeId, actorId, query, limit, now = new Date() }) {
  const m = await getMembership(db, treeId, actorId);
  if (!m || !can(m.role, 'tree.read')) return { ok: false, code: 'forbidden' };
  if (typeof query !== 'string') return { ok: false, code: 'invalid_query' };
  if ([...query].length > MAX_QUERY) return { ok: false, code: 'query_too_long' };
  const q = norm(query);
  // kata kunci kosong tidak pernah mengembalikan daftar semua orang
  if (!q) return { ok: true, results: [], total: 0, truncated: false };
  const lim = Number.isInteger(limit) ? Math.min(MAX_LIMIT, Math.max(1, limit)) : DEFAULT_LIMIT;
  const tokens = q.split(' ');

  const t = forTree(db, treeId);
  const people = await t.all('SELECT * FROM people WHERE tree_id = ?1 AND archived_at IS NULL');
  const variants = new Map();
  for (const v of await t.all('SELECT person_id, variant FROM name_variants WHERE tree_id = ?1')) {
    if (!variants.has(v.person_id)) variants.set(v.person_id, []);
    variants.get(v.person_id).push(v.variant);
  }

  const hits = [];
  for (const p of people) {
    let best = null;
    const consider = (text, field, shown) => {
      const sc = score(text, q, tokens);
      if (sc !== null && (!best || sc < best.sc || (sc === best.sc && field < best.field))) best = { sc, field, shown };
    };
    const name = norm(p.display_name);
    consider(name, 0, null);
    for (const v of variants.get(p.id) ?? []) consider(norm(v), 1, v);
    if (best) hits.push({ p, name, ...best });
  }
  hits.sort((a, b) => a.sc - b.sc || a.field - b.field || (a.name < b.name ? -1 : a.name > b.name ? 1 : a.p.id < b.p.id ? -1 : 1));

  const page = hits.slice(0, lim);
  const link = page.length
    ? await t.first("SELECT person_id FROM account_person_links WHERE tree_id = ?1 AND account_id = ?2 AND status = 'active'", [actorId])
    : null;
  const viewer = { role: m.role, selfPersonId: link?.person_id ?? null, guardianOfIds: new Set() };
  const results = page.map((h) => {
    const r = redactPerson(h.p, viewer, now);
    return {
      id: r.id, name: r.name, isPlaceholder: r.isPlaceholder,
      birth: yearOnly(r.birth),
      death: yearOnly(r.death),
      matchedOn: FIELDS[h.field],
      ...(h.field === 1 ? { variant: h.shown } : {}),
    };
  });
  return { ok: true, results, total: hits.length, truncated: hits.length > lim };
}
