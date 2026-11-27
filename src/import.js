// Validasi impor JSON (PRD P2-7), fungsi murni tanpa database. Tahap ini HANYA memvalidasi dan membuat pratinjau;
// penerapan ke pohon (backup sebelum impor, deteksi duplikat terhadap pohon, pembatalan) belum ada.
// Aturan isi orang, relasi, dan pasangan memakai ulang cleanFields/cleanEdge/cleanPartnership dari apply.js.
// Mengembalikan { ok:false, errors:[{path,code}], moreErrors } atau { ok:true, data, summary, warnings }.

import { cleanEdge, cleanFields, cleanPartnership, partnershipWarnings, softWarnings } from './apply.js';
import { EXPORT_FORMAT, EXPORT_VERSION } from './export.js';

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_PEOPLE = 5000; // [Menebak] desain sampai 2.000 profil per pohon (PRD K6); 5.000 = batas pagar
export const MAX_ROWS = 20000;
const MAX_ERRORS = 50;
const MAX_WARNINGS = 200;
const MAX_ID = 64;

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const TOP = ['format', 'version', 'exportedAt', 'tree', 'people', 'nameVariants', 'parentChild', 'partnerships'];
const PERSON = ['id', 'name', 'gender', 'confirmation', 'sourceNote', 'isPlaceholder', 'placeholderOf', 'archived', 'birth', 'death'];
const DATE_KEYS = ['precision', 'year', 'date', 'month'];
const PRECISIONS = ['full', 'year', 'approx', 'unknown', 'hidden'];

export function validateImport(input, { now = new Date() } = {}) {
  let doc = input;
  if (typeof input === 'string') {
    if (new TextEncoder().encode(input).length > MAX_IMPORT_BYTES) return bad([{ path: '', code: 'file_too_large' }]);
    try { doc = JSON.parse(input); } catch { return bad([{ path: '', code: 'invalid_json' }]); }
  }
  if (!isObj(doc)) return bad([{ path: '', code: 'invalid_payload' }]);
  if (doc.format !== EXPORT_FORMAT) return bad([{ path: 'format', code: 'wrong_format' }]);
  if (doc.version !== EXPORT_VERSION) return bad([{ path: 'version', code: 'unsupported_version' }]);

  const errs = [];
  let dropped = 0;
  const err = (path, code) => (errs.length < MAX_ERRORS ? errs.push({ path, code }) : dropped++);
  for (const k of Object.keys(doc)) if (!TOP.includes(k)) err(k, 'unknown_field');
  if (typeof doc.exportedAt !== 'string' || Number.isNaN(Date.parse(doc.exportedAt))) err('exportedAt', 'invalid_exported_at');
  if (!isObj(doc.tree) || typeof doc.tree.name !== 'string' || doc.tree.name.length > 200 || Object.keys(doc.tree).some((k) => k !== 'name')) {
    err('tree', 'invalid_tree');
  }
  const arr = (key, max) => {
    const a = doc[key];
    if (!Array.isArray(a)) { err(key, 'not_array'); return []; }
    if (a.length > max) { err(key, key === 'people' ? 'too_many_people' : 'too_many_rows'); return []; }
    return a;
  };
  const rawPeople = arr('people', MAX_PEOPLE);
  const rawVariants = arr('nameVariants', MAX_ROWS);
  const rawEdges = arr('parentChild', MAX_ROWS);
  const rawPartners = arr('partnerships', MAX_ROWS);

  const warnings = [];
  const wcount = {};
  const warn = (path, code) => {
    wcount[code] = (wcount[code] ?? 0) + 1;
    if (warnings.length < MAX_WARNINGS) warnings.push({ path, code });
  };

  // ---- orang ----
  const people = [];
  const byId = new Map();
  let hiddenBirth = 0;
  const datePart = (x, path, isBirth) => {
    if (x === undefined) return { date: null, precision: 'unknown' };
    if (!isObj(x) || Object.keys(x).some((k) => !DATE_KEYS.includes(k))) { err(path, 'invalid_date'); return null; }
    const { precision, year = null, date = null } = x;
    if (!PRECISIONS.includes(precision) || (precision === 'hidden' && !isBirth)) { err(path, 'invalid_date'); return null; }
    if (precision === 'unknown' || precision === 'hidden') {
      if (year !== null || date !== null) { err(path, 'invalid_date'); return null; }
      if (precision === 'hidden') hiddenBirth++;
      return { date: null, precision: 'unknown' };
    }
    if (precision === 'full') {
      if (typeof date !== 'string' || !Number.isInteger(year) || String(year) !== date.slice(0, 4)) { err(path, 'invalid_date'); return null; }
      return { date, precision };
    }
    const mo = x.month ?? null;
    if (!Number.isInteger(year) || date !== null || (mo !== null && !(precision === 'year' && Number.isInteger(mo) && mo >= 1 && mo <= 12))) { err(path, 'invalid_date'); return null; }
    return { date: mo ? `${year}-${String(mo).padStart(2, '0')}` : String(year), precision };
  };
  rawPeople.forEach((r, i) => {
    const path = `people[${i}]`;
    if (!isObj(r)) return err(path, 'invalid_person');
    if (Object.keys(r).some((k) => !PERSON.includes(k))) return err(path, 'unknown_field');
    if (typeof r.id !== 'string' || !r.id || r.id.length > MAX_ID) return err(path, 'invalid_id');
    if (byId.has(r.id)) return err(path, 'duplicate_id');
    byId.set(r.id, null);
    for (const k of ['isPlaceholder', 'archived']) {
      if (r[k] !== undefined && typeof r[k] !== 'boolean') return err(path, `invalid_${k}`);
    }
    if (r.placeholderOf !== undefined && r.placeholderOf !== null) {
      if (typeof r.placeholderOf !== 'string' || !r.placeholderOf || r.placeholderOf === r.id) return err(path, 'invalid_placeholder_of');
      if (r.isPlaceholder !== true) return err(path, 'placeholder_of_without_placeholder');
    }
    const b = datePart(r.birth, `${path}.birth`, true);
    const d = datePart(r.death, `${path}.death`, false);
    if (!b || !d) return;
    const c = cleanFields({
      display_name: r.name, gender: r.gender ?? null,
      confirmation: r.confirmation ?? 'unverified', source_note: r.sourceNote ?? null,
      birth_date: b.date, birth_precision: b.precision, death_date: d.date, death_precision: d.precision,
    }, { create: true });
    if (!c.ok) return err(path, c.code);
    const person = { id: r.id, fields: c.values, isPlaceholder: r.isPlaceholder === true, placeholderOf: r.placeholderOf ?? null, archived: r.archived === true };
    byId.set(r.id, person);
    people.push(person);
    for (const w of softWarnings(c.values, now)) warn(path, w);
  });
  for (const p of people) {
    if (p.placeholderOf !== null && !byId.has(p.placeholderOf)) err(`people[${rawPeople.findIndex((x) => x.id === p.id)}]`, 'unknown_person');
  }
  const known = (id) => byId.has(id);

  // ---- varian ejaan ----
  const nameVariants = [];
  const seenV = new Set();
  rawVariants.forEach((r, i) => {
    const path = `nameVariants[${i}]`;
    if (!isObj(r) || Object.keys(r).some((k) => k !== 'person' && k !== 'variant')) return err(path, 'invalid_variant');
    if (typeof r.person !== 'string' || !known(r.person)) return err(path, 'unknown_person');
    const v = typeof r.variant === 'string' ? r.variant.trim() : '';
    if (!v || [...v].length > 200) return err(path, 'invalid_variant');
    const key = `${r.person}\u0000${v.toLowerCase()}`;
    if (seenV.has(key)) return err(path, 'duplicate_variant');
    seenV.add(key);
    nameVariants.push({ person_id: r.person, variant: v });
  });

  // ---- relasi orang tua-anak ----
  const EDGE = ['parent', 'child', 'type', 'role', 'customLabel'];
  const parentChild = [];
  const edgeIdx = [];
  const seenE = new Set();
  const bd = (f) => (f.birth_precision === 'unknown' || !f.birth_date ? null : f.birth_date);
  const younger = (p, c) => {
    const a = bd(p), b = bd(c);
    if (!a || !b) return false;
    return a.length === 10 && b.length === 10 ? a > b : Number(a.slice(0, 4)) > Number(b.slice(0, 4));
  };
  rawEdges.forEach((r, i) => {
    const path = `parentChild[${i}]`;
    if (!isObj(r)) return err(path, 'invalid_edge');
    if (Object.keys(r).some((k) => !EDGE.includes(k))) return err(path, 'unknown_field');
    const c = cleanEdge({
      action: 'create', parent_id: r.parent, child_id: r.child, relation_type: r.type,
      parent_role: r.role, custom_label: r.customLabel ?? null,
    });
    if (!c.ok) return err(path, c.code);
    if (!known(c.parentId) || !known(c.childId)) return err(path, 'unknown_person');
    const key = `${c.parentId}\u0000${c.childId}`;
    if (seenE.has(key)) return err(path, 'duplicate_edge');
    seenE.add(key);
    parentChild.push({ parent_id: c.parentId, child_id: c.childId, ...c.values });
    edgeIdx.push(i);
    if (c.values.relation_type === 'biological' && younger(byId.get(c.parentId)?.fields ?? {}, byId.get(c.childId)?.fields ?? {})) {
      warn(path, 'parent_younger_than_child');
    }
  });
  // siklus: Kahn. Relasi di antara simpul yang tidak bisa diurutkan ditandai (termasuk yang hilir dari siklus).
  {
    const indeg = new Map();
    const out = new Map();
    for (const e of parentChild) {
      indeg.set(e.child_id, (indeg.get(e.child_id) ?? 0) + 1);
      indeg.set(e.parent_id, indeg.get(e.parent_id) ?? 0);
      (out.get(e.parent_id) ?? out.set(e.parent_id, []).get(e.parent_id)).push(e.child_id);
    }
    const q = [...indeg].filter(([, n]) => n === 0).map(([id]) => id);
    const done = new Set();
    while (q.length) {
      const x = q.pop();
      done.add(x);
      for (const y of out.get(x) ?? []) { indeg.set(y, indeg.get(y) - 1); if (indeg.get(y) === 0) q.push(y); }
    }
    parentChild.forEach((e, k) => { if (!done.has(e.parent_id) && !done.has(e.child_id)) err(`parentChild[${edgeIdx[k]}]`, 'would_create_cycle'); });
  }

  // ---- pasangan ----
  const PART = ['a', 'b', 'status', 'startYear', 'endYear'];
  const partnerships = [];
  const seenP = new Set();
  rawPartners.forEach((r, i) => {
    const path = `partnerships[${i}]`;
    if (!isObj(r)) return err(path, 'invalid_partnership');
    if (Object.keys(r).some((k) => !PART.includes(k))) return err(path, 'unknown_field');
    const c = cleanPartnership({
      action: 'create', person_a: r.a, person_b: r.b, status: r.status,
      start_year: r.startYear ?? null, end_year: r.endYear ?? null,
    });
    if (!c.ok) return err(path, c.code);
    const { person_a: a, person_b: b } = c.values;
    if (!known(a) || !known(b)) return err(path, 'unknown_person');
    const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
    if (seenP.has(key)) return err(path, 'duplicate_partnership');
    seenP.add(key);
    partnerships.push(c.values);
    for (const w of partnershipWarnings(c.values)) warn(path, w);
  });

  if (errs.length) return bad(errs, dropped > 0);
  return {
    ok: true,
    data: { people, nameVariants, parentChild, partnerships },
    summary: {
      people: people.length,
      archived: people.filter((p) => p.archived).length,
      placeholders: people.filter((p) => p.isPlaceholder).length,
      nameVariants: nameVariants.length,
      parentChild: parentChild.length,
      partnerships: partnerships.length,
      hiddenBirthDates: hiddenBirth,
      warningCounts: wcount,
    },
    warnings,
  };
}

const bad = (errors, moreErrors = false) => ({ ok: false, errors, moreErrors });
