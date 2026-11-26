// Penerapan perubahan data orang: jalur "setujui usulan" dan jalur "langsung" (Admin/Owner).
// Jenis yang didukung saat ini: person_edit, person_create, partnership, parent_child. Jenis lain ditolak SEBELUM usulan ditutup,
// supaya tombol Setujui tidak pernah menutup usulan tanpa mengubah data.
//
// Atomik: semua pernyataan (penerapan, audit, penandaan stale, penutupan usulan) ada dalam satu db.batch().
// Pernyataan penerapan dijaga "usulan masih pending". Penutupan usulan dijalankan TERAKHIR, jadi dua
// penyetuju yang berbalapan tidak bisa menerapkan dua kali (yang kedua melihat usulan sudah tidak pending).
//
// Endpoint yang menerima usulan baru sebaiknya memanggil cleanFields() lebih dulu agar pengaju langsung
// dapat pesan error; penerapan memeriksanya lagi sebagai pagar terakhir.

import { forTree, getMembership, countManagers } from './db.js';
import { isBootstrap, route } from './permissions.js';
import { checkDecision, closeStmts, expireDue } from './proposals.js';
import { redactPerson } from './privacy.js';
import { newId, sqlTime } from './audit.js';

export const APPLY_KINDS = ['person_edit', 'person_create', 'partnership', 'parent_child', 'archive'];

// Anak (belum diarsipkan) dari seseorang. Orang yang punya anak tidak boleh diarsipkan supaya pohon tidak terputus (kecuali placeholder).
const CHILD_SQL = 'SELECT 1 FROM parent_child_edges e JOIN people c ON c.id = e.child_id AND c.tree_id = e.tree_id WHERE e.tree_id = ?1 AND e.parent_id = ?2 AND c.archived_at IS NULL';

// Hanya field ini yang boleh diubah lewat usulan. Pengaturan privasi (birth_visibility,
// visibility_by_self) sengaja tidak ada: perubahannya lewat endpoint privasi sendiri.
const FIELDS = [
  'display_name', 'nickname', 'gender', 'confirmation', 'source_note',
  'birth_date', 'birth_precision', 'death_date', 'death_precision',
];
const TEXT_MAX = { display_name: 200, nickname: 100, source_note: 500 };
const ENUMS = {
  gender: ['male', 'female'],
  confirmation: ['unverified', 'confirmed'],
  birth_precision: ['full', 'year', 'approx', 'unknown'],
  death_precision: ['full', 'year', 'approx', 'unknown'],
};
const NULLABLE = ['gender'];
const PAIRS = [['birth_date', 'birth_precision'], ['death_date', 'death_precision']];

const fail = (code) => ({ ok: false, code });
const chars = (s) => [...s].length;
const j = (x) => (x === null || x === undefined ? null : JSON.stringify(x));
const validDay = (s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

// Validasi keras isi usulan. Mengembalikan { ok, values } dengan nilai yang sudah dibersihkan.
export function cleanFields(after, { create = false } = {}) {
  if (after === null || typeof after !== 'object' || Array.isArray(after)) return fail('invalid_payload');
  const keys = Object.keys(after);
  if (keys.some((k) => !FIELDS.includes(k))) return fail('unknown_field');
  const v = {};
  for (const k of keys) {
    const x = after[k];
    if (k in TEXT_MAX) {
      if (x === null) {
        if (k === 'display_name') return fail('name_required');
        v[k] = null;
        continue;
      }
      if (typeof x !== 'string') return fail(`invalid_${k}`);
      const s = x.trim();
      if (k === 'display_name' && !s) return fail('name_required');
      if (chars(s) > TEXT_MAX[k]) return fail(`${k}_too_long`);
      v[k] = s || null;
    } else if (k in ENUMS) {
      if (x === null && NULLABLE.includes(k)) v[k] = null;
      else if (typeof x === 'string' && ENUMS[k].includes(x)) v[k] = x;
      else return fail(`invalid_${k}`);
    } else {
      if (x !== null && typeof x !== 'string') return fail(`invalid_${k}`);
      v[k] = x;
    }
  }
  for (const [d, p] of PAIRS) {
    if ((d in v) !== (p in v)) return fail('date_pair_required');
    if (!(d in v)) continue;
    const date = v[d];
    const prec = v[p];
    if (prec === 'unknown') {
      if (date !== null) return fail(`invalid_${d}`);
    } else if (prec === 'full') {
      if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !validDay(date)) return fail(`invalid_${d}`);
    } else if (typeof date !== 'string' || !(prec === 'year' ? /^\d{4}(-(0[1-9]|1[0-2]))?$/ : /^\d{4}$/).test(date)) {
      return fail(`invalid_${d}`);
    }
  }
  if (create && !('display_name' in v)) return fail('name_required');
  if (!create && keys.length === 0) return fail('empty_change');
  return { ok: true, values: v };
}

// Validasi lunak P0-2: peringatan saja, tidak pernah memblokir.
export function softWarnings(p, now = new Date()) {
  const known = (d, prec) => (prec === 'unknown' || !d ? null : d);
  const b = known(p.birth_date ?? null, p.birth_precision);
  const d = known(p.death_date ?? null, p.death_precision);
  const by = b ? Number(b.slice(0, 4)) : null;
  const dy = d ? Number(d.slice(0, 4)) : null;
  const w = [];
  if (by !== null && dy !== null && (dy < by || (dy === by && b.length === 10 && d.length === 10 && d < b))) {
    w.push('death_before_birth');
  }
  if (by !== null && (dy ?? now.getUTCFullYear()) - by > 120) w.push('age_over_120');
  return w;
}

const P_STATUS = ['married', 'divorced', 'separated', 'partner_deceased', 'unknown'];
const P_KEYS = {
  create: ['action', 'person_a', 'person_b', 'status', 'start_year', 'end_year'],
  update: ['action', 'partnership_id', 'status', 'start_year', 'end_year'],
  delete: ['action', 'partnership_id'],
};
const okYear = (x) => x === null || (Number.isInteger(x) && x >= 1000 && x <= 9999);

// Validasi usulan pasangan. after = { action: 'create', person_a, person_b, status, start_year?, end_year? }
// atau { action: 'update', partnership_id, status?, start_year?, end_year? } atau { action: 'delete', partnership_id }.
// Siapa pasangannya tidak bisa diubah (salah orang: hapus lalu buat ulang).
export function cleanPartnership(after) {
  if (after === null || typeof after !== 'object' || Array.isArray(after)) return fail('invalid_payload');
  const action = after.action;
  if (typeof action !== 'string' || !Object.hasOwn(P_KEYS, action)) return fail('invalid_action');
  if (Object.keys(after).some((k) => !P_KEYS[action].includes(k))) return fail('unknown_field');
  const v = {};
  for (const k of ['start_year', 'end_year']) {
    if (k in after) {
      if (!okYear(after[k])) return fail(`invalid_${k}`);
      v[k] = after[k];
    }
  }
  if ('status' in after) {
    if (!P_STATUS.includes(after.status)) return fail('invalid_status');
    v.status = after.status;
  }
  if (action === 'create') {
    for (const k of ['person_a', 'person_b']) {
      if (typeof after[k] !== 'string' || !after[k]) return fail(`invalid_${k}`);
      v[k] = after[k];
    }
    if (v.person_a === v.person_b) return fail('same_person');
    if (!('status' in v)) return fail('invalid_status');
    v.start_year ??= null;
    v.end_year ??= null;
    return { ok: true, action, values: v };
  }
  if (typeof after.partnership_id !== 'string' || !after.partnership_id) return fail('invalid_partnership_id');
  if (action === 'delete') return { ok: true, action, values: { partnership_id: after.partnership_id } };
  if (Object.keys(v).length === 0) return fail('empty_change');
  return { ok: true, action, values: { partnership_id: after.partnership_id, ...v } };
}

// Peringatan lunak: tahun akhir lebih awal dari tahun mulai. Pasangan bersamaan sengaja TIDAK diperingatkan (P0-3).
export const partnershipWarnings = (p) =>
  Number.isInteger(p.start_year) && Number.isInteger(p.end_year) && p.end_year < p.start_year ? ['end_before_start'] : [];

const E_TYPES = ['biological', 'adoptive', 'step', 'guardian', 'custom'];
// Tidak ada peran netral (U3 dicabut, PRD v1.2 G2): peran orang tua hanya Ayah atau Ibu, dan WAJIB diisi saat membuat relasi.
// Kolom DB masih mengizinkan 'parent' lewat CHECK lama (SQLite tidak bisa mengubah CHECK); penjaganya di kode ini.
const E_ROLES = ['father', 'mother'];
const E_KEYS = {
  create: ['action', 'parent_id', 'child_id', 'new_person', 'relation_type', 'parent_role', 'custom_label'],
  update: ['action', 'edge_id', 'relation_type', 'parent_role', 'custom_label'],
  delete: ['action', 'edge_id'],
};

// Validasi usulan relasi orang tua-anak.
//   create: { action, relation_type, parent_role (father|mother, wajib), custom_label?, dan salah satu dari:
//             parent_id + child_id (dua-duanya sudah ada)
//             child_id + new_person (orang tua baru; new_person.is_placeholder = "orang tua belum diketahui")
//             parent_id + new_person (anak baru) }
//   update: { action, edge_id, relation_type?, parent_role?, custom_label? }   delete: { action, edge_id }
export function cleanEdge(after) {
  if (after === null || typeof after !== 'object' || Array.isArray(after)) return fail('invalid_payload');
  const action = after.action;
  if (typeof action !== 'string' || !Object.hasOwn(E_KEYS, action)) return fail('invalid_action');
  if (Object.keys(after).some((k) => !E_KEYS[action].includes(k))) return fail('unknown_field');
  const v = {};
  if ('relation_type' in after) {
    if (!E_TYPES.includes(after.relation_type)) return fail('invalid_relation_type');
    v.relation_type = after.relation_type;
  }
  if ('parent_role' in after) {
    if (!E_ROLES.includes(after.parent_role)) return fail('invalid_parent_role');
    v.parent_role = after.parent_role;
  }
  if ('custom_label' in after) {
    const x = after.custom_label;
    if (x === null) v.custom_label = null;
    else if (typeof x !== 'string') return fail('invalid_custom_label');
    else {
      const t = x.trim();
      if (chars(t) > 100) return fail('custom_label_too_long');
      v.custom_label = t || null;
    }
  }
  if (action !== 'create') {
    if (typeof after.edge_id !== 'string' || !after.edge_id) return fail('invalid_edge_id');
    if (action === 'delete') return { ok: true, action, edgeId: after.edge_id };
    if (Object.keys(v).length === 0) return fail('empty_change');
    return { ok: true, action, edgeId: after.edge_id, values: v };
  }
  if (!('relation_type' in v)) return fail('invalid_relation_type');
  if (v.relation_type === 'custom') {
    if (!v.custom_label) return fail('custom_label_required');
  } else if (v.custom_label) return fail('custom_label_not_allowed');
  v.custom_label ??= null;
  if (!v.parent_role) return fail('invalid_parent_role');
  const { parent_id: pid, child_id: cid, new_person: np } = after;
  for (const [k, x] of [['parent_id', pid], ['child_id', cid]]) {
    if (x !== undefined && (typeof x !== 'string' || !x)) return fail(`invalid_${k}`);
  }
  let person = null;
  if (np !== undefined) {
    if ((pid === undefined) === (cid === undefined)) return fail('invalid_endpoints');
    if (np === null || typeof np !== 'object' || Array.isArray(np)) return fail('invalid_payload');
    const { is_placeholder: ph, ...rest } = np;
    if (ph !== undefined && typeof ph !== 'boolean') return fail('invalid_is_placeholder');
    if (ph && pid !== undefined) return fail('placeholder_only_for_parent');
    const c = cleanFields(rest, { create: true });
    if (!c.ok) return c;
    person = { v: c.values, placeholder: ph === true };
  } else {
    if (pid === undefined || cid === undefined) return fail('invalid_endpoints');
    if (pid === cid) return fail('same_person');
  }
  return { ok: true, action, parentId: pid, childId: cid, person, values: v };
}

// Peringatan lunak P0-2: orang tua lebih muda dari anak. HANYA untuk relasi biologis (orang tua angkat,
// tiri, dan wali bisa saja lebih muda). Dihitung dari tanggal yang boleh dilihat peran pelaku, jadi
// peringatan tidak membocorkan urutan umur dari tanggal yang disembunyikan.
function parentYounger(parent, child, role, now) {
  const a = redactPerson(parent, { role }, now)?.birth;
  const b = redactPerson(child, { role }, now)?.birth;
  if (!a || !b || a.year === null || b.year === null) return false;
  return a.date && b.date ? a.date > b.date : a.year > b.year;
}
const edgeWarnings = (type, parent, child, role, now) =>
  type === 'biological' && parentYounger(parent, child, role, now) ? ['parent_younger_than_child'] : [];

// Penjaga: usulan ini masih pending. Tanpa proposalId (jalur langsung) selalu benar.
const guard = (n, proposalId) =>
  proposalId
    ? { sql: `EXISTS (SELECT 1 FROM proposals WHERE tree_id = ?1 AND id = ?${n} AND status = 'pending')`, p: [proposalId] }
    : { sql: '1 = 1', p: [] };

function auditStmt(t, e, proposalId) {
  const G = guard(10, proposalId);
  return t.stmt(
    `INSERT INTO audit_events (id, tree_id, actor_id, action, target_type, target_id, before_json, after_json, approval_note) SELECT ?2, ?1, ?3, ?4, ?9, ?5, ?6, ?7, ?8 WHERE ${G.sql}`,
    [newId(), e.actor, e.action, e.target, j(e.before), j(e.after), e.note ?? null, e.type ?? 'person', ...G.p]
  );
}

// Usulan lain yang menyasar orang yang sama menjadi "stale" (Perlu diajukan ulang).
function staleStmts(t, personId, proposalId) {
  const G = guard(4, proposalId);
  const cond = `tree_id = ?1 AND status = 'pending' AND target_person_id = ?2 AND id <> ?3 AND ${G.sql}`;
  const args = [personId, proposalId ?? '', ...G.p];
  return [
    t.stmt(
      `INSERT INTO audit_events (id, tree_id, actor_id, action, target_type, target_id, before_json, after_json, approval_note) SELECT lower(hex(randomblob(16))), tree_id, NULL, 'proposal.stale', 'proposal', id, NULL, NULL, NULL FROM proposals WHERE ${cond}`,
      args
    ),
    t.stmt(`UPDATE proposals SET status = 'stale' WHERE ${cond}`, args),
  ];
}

const DUP_SQL =
  'SELECT id FROM partnerships WHERE tree_id = ?1 AND ((person_a = ?2 AND person_b = ?3) OR (person_a = ?3 AND person_b = ?2))';

async function loadTarget(t, personId) {
  if (!personId) return fail('target_not_found');
  const row = await t.first('SELECT * FROM people WHERE tree_id = ?1 AND id = ?2', [personId]);
  if (!row) return fail('target_not_found');
  if (row.archived_at != null) return fail('target_archived');
  return { ok: true, row };
}

// Validasi dan pra-cek terhadap data saat ini. Dipakai bersama oleh jalur setujui dan jalur langsung.
const CYCLE_PRE =
  'WITH RECURSIVE d(id) AS (SELECT ?3 UNION SELECT e.child_id FROM parent_child_edges e JOIN d ON e.parent_id = d.id WHERE e.tree_id = ?1) SELECT 1 AS x FROM d WHERE id = ?2';

async function prepareEdge(t, { after, role, now }) {
  const c = cleanEdge(after);
  if (!c.ok) return c;
  const loadPeople = (ids) =>
    t.all(`SELECT * FROM people WHERE tree_id = ?1 AND id IN (${ids.map((_, i) => `?${i + 2}`).join(', ')})`, ids);
  if (c.action === 'create') {
    const ids = [c.parentId, c.childId].filter(Boolean);
    const rows = await loadPeople(ids);
    if (rows.length !== ids.length) return fail('person_not_found');
    if (rows.some((r) => r.archived_at != null)) return fail('person_archived');
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    let person = null;
    let synth = null;
    if (c.person) {
      const nv = c.person.v;
      person = {
        id: newId(),
        v: nv,
        extra: c.person.placeholder ? { is_placeholder: 1, placeholder_of: c.childId } : {},
      };
      synth = {
        id: person.id, display_name: nv.display_name, birth_date: nv.birth_date ?? null,
        birth_precision: nv.birth_precision ?? 'unknown', birth_visibility: 'year', visibility_by_self: 0,
      };
    } else {
      if (await t.first('SELECT id FROM parent_child_edges WHERE tree_id = ?1 AND parent_id = ?2 AND child_id = ?3', [c.parentId, c.childId])) {
        return fail('duplicate_edge');
      }
      if (await t.first(CYCLE_PRE, [c.parentId, c.childId])) return fail('would_create_cycle');
    }
    const parentId = c.parentId ?? person.id;
    const childId = c.childId ?? person.id;
    const parentRow = byId[parentId] ?? synth;
    const childRow = byId[childId] ?? synth;
    const v = { parent_id: parentId, child_id: childId, ...c.values };
    return {
      ok: true, kind: 'parent_child', action: 'create', v, row: null, id: newId(), newPerson: person,
      warnings: edgeWarnings(v.relation_type, parentRow, childRow, role, now),
    };
  }
  const row = await t.first('SELECT * FROM parent_child_edges WHERE tree_id = ?1 AND id = ?2', [c.edgeId]);
  if (!row) return fail('edge_not_found');
  if (c.action === 'delete') return { ok: true, kind: 'parent_child', action: 'delete', v: {}, row, id: c.edgeId, warnings: [] };
  const v = { ...c.values };
  const type = v.relation_type ?? row.relation_type;
  if (type === 'custom') {
    if (!('custom_label' in v ? v.custom_label : row.custom_label)) return fail('custom_label_required');
  } else if (v.custom_label) return fail('custom_label_not_allowed');
  else if (row.custom_label !== null) v.custom_label = null;
  const rows = await loadPeople([row.parent_id, row.child_id]);
  const pr = rows.find((r) => r.id === row.parent_id);
  const cr = rows.find((r) => r.id === row.child_id);
  return {
    ok: true, kind: 'parent_child', action: 'update', v, row, id: c.edgeId,
    warnings: pr && cr ? edgeWarnings(type, pr, cr, role, now) : [],
  };
}

async function prepare(t, { kind, after, targetPersonId, role, now }) {
  if (kind === 'archive') {
    // "Hapus orang" = arsip (hapus lunak, tercatat di audit). Profil yang tertaut ke akun atau punya anak tidak bisa.
    if (after === null || typeof after !== 'object' || Array.isArray(after)) return fail('invalid_payload');
    if (Object.keys(after).some((k) => k !== 'reason')) return fail('unknown_field');
    const rs = after.reason ?? null;
    if (rs !== null && (typeof rs !== 'string' || chars(rs.trim()) > 300)) return fail('invalid_reason');
    const tg = await loadTarget(t, targetPersonId);
    if (!tg.ok) return tg;
    if (await t.first('SELECT 1 AS x FROM account_person_links WHERE tree_id = ?1 AND person_id = ?2', [targetPersonId])) return fail('person_is_account');
    if (tg.row.is_placeholder !== 1 && (await t.first(CHILD_SQL, [targetPersonId]))) return fail('has_children');
    return { ok: true, kind, action: 'archive', v: {}, row: tg.row, id: targetPersonId, reason: rs === null ? null : rs.trim() || null, warnings: [] };
  }
  if (kind === 'parent_child') return prepareEdge(t, { after, role, now });
  if (kind === 'partnership') {
    const c = cleanPartnership(after);
    if (!c.ok) return c;
    if (c.action === 'create') {
      const { person_a: a, person_b: b } = c.values;
      const ppl = await t.all('SELECT id, archived_at FROM people WHERE tree_id = ?1 AND id IN (?2, ?3)', [a, b]);
      if (ppl.length !== 2) return fail('person_not_found');
      if (ppl.some((x) => x.archived_at != null)) return fail('person_archived');
      if (await t.first(DUP_SQL, [a, b])) return fail('duplicate_partnership');
      return { ok: true, kind, action: 'create', v: c.values, row: null, id: newId(), warnings: partnershipWarnings(c.values) };
    }
    const { partnership_id: pid, ...v } = c.values;
    const row = await t.first('SELECT * FROM partnerships WHERE tree_id = ?1 AND id = ?2', [pid]);
    if (!row) return fail('partnership_not_found');
    return { ok: true, kind, action: c.action, v, row, id: pid, warnings: c.action === 'delete' ? [] : partnershipWarnings({ ...row, ...v }) };
  }
  const c = cleanFields(after, { create: kind === 'person_create' });
  if (!c.ok) return c;
  let row = null;
  let id = newId();
  if (kind === 'person_edit') {
    const tg = await loadTarget(t, targetPersonId);
    if (!tg.ok) return tg;
    row = tg.row;
    id = targetPersonId;
  }
  // "Isi identitas" (PRD P0-4): mengganti nama placeholder mengubah profil yang sama di tempat dan melepas penanda placeholder.
  // Relasi tidak disentuh. Mengubah field lain saja (tanpa nama baru) tidak mengubah status placeholder.
  const fills = kind === 'person_edit' && row.is_placeholder === 1 && typeof c.values.display_name === 'string' && c.values.display_name !== row.display_name;
  return {
    ok: true, kind, action: kind === 'person_edit' ? 'update' : 'create', v: c.values, row, id, fills,
    warnings: softWarnings({ ...(row ?? {}), ...c.values }, now),
  };
}

const CYCLE_SQL =
  'WITH RECURSIVE d(id) AS (SELECT ?4 UNION SELECT e.child_id FROM parent_child_edges e JOIN d ON e.parent_id = d.id WHERE e.tree_id = ?1) SELECT 1 FROM d WHERE id = ?3';

// Menyusun pernyataan penerapan dari hasil prepare().
function plan(t, p, { proposalId, actor, createdBy }) {
  const { v, row, id } = p;
  const ks = Object.keys(v);
  const note = proposalId ? `proposal:${proposalId}` : null;
  const before = row ? Object.fromEntries(ks.map((k) => [k, row[k] ?? null])) : null;
  if (p.kind === 'partnership') {
    if (p.action === 'create') {
      const G = guard(8, proposalId);
      return [
        t.stmt(
          `INSERT INTO partnerships (id, tree_id, person_a, person_b, status, start_year, end_year) SELECT ?2, ?1, ?3, ?4, ?5, ?6, ?7 WHERE ${G.sql}`,
          [id, v.person_a, v.person_b, v.status, v.start_year, v.end_year, ...G.p]
        ),
        auditStmt(t, { type: 'partnership', actor, action: 'partnership.create', target: id, before: null, after: v, note }, proposalId),
      ];
    }
    if (p.action === 'delete') {
      // Audit lebih dulu: isi sebelum dihapus diambil dari barisnya sendiri, dan hanya tercatat bila barisnya ada.
      // Hapus bersifat idempoten: bila barisnya sudah tidak ada, tidak ada yang berubah dan tidak ada audit palsu.
      const GA = guard(6, proposalId);
      const GD = guard(3, proposalId);
      return [
        t.stmt(
          `INSERT INTO audit_events (id, tree_id, actor_id, action, target_type, target_id, before_json, after_json, approval_note) SELECT ?2, ?1, ?3, 'partnership.delete', 'partnership', id, json_object('person_a', person_a, 'person_b', person_b, 'status', status, 'start_year', start_year, 'end_year', end_year), NULL, ?4 FROM partnerships WHERE tree_id = ?1 AND id = ?5 AND ${GA.sql}`,
          [newId(), actor, note, id, ...GA.p]
        ),
        t.stmt(`DELETE FROM partnerships WHERE tree_id = ?1 AND id = ?2 AND ${GD.sql}`, [id, ...GD.p]),
      ];
    }
    const G = guard(ks.length + 3, proposalId);
    return [
      t.stmt(
        `UPDATE partnerships SET ${ks.map((k, i) => `${k} = ?${i + 3}`).join(', ')} WHERE tree_id = ?1 AND id = ?2 AND ${G.sql}`,
        [id, ...ks.map((k) => v[k]), ...G.p]
      ),
      auditStmt(t, { type: 'partnership', actor, action: 'partnership.update', target: id, before, after: v, note }, proposalId),
    ];
  }
  if (p.kind === 'parent_child') {
    if (p.action === 'create') {
      const G = guard(8, proposalId);
      const GA = guard(3, proposalId);
      const pre = p.newPerson
        ? personInsert(t, { id: p.newPerson.id, fields: { ...p.newPerson.v, ...p.newPerson.extra }, proposalId, actor, createdBy, note })
        : [];
      return [
        ...pre,
        t.stmt(
          `INSERT INTO parent_child_edges (id, tree_id, parent_id, child_id, relation_type, custom_label, parent_role) SELECT ?2, ?1, ?3, ?4, ?5, ?6, ?7 WHERE ${G.sql} AND NOT EXISTS (${CYCLE_SQL})`,
          [id, v.parent_id, v.child_id, v.relation_type, v.custom_label, v.parent_role, ...G.p]
        ),
        // audit diambil dari baris relasi yang benar-benar tercatat
        t.stmt(
          `INSERT INTO audit_events (id, tree_id, actor_id, action, target_type, target_id, before_json, after_json, approval_note) SELECT ?2, ?1, ?3, 'parent_child.create', 'parent_child', id, NULL, json_object('parent_id', parent_id, 'child_id', child_id, 'relation_type', relation_type, 'parent_role', parent_role, 'custom_label', custom_label), ?4 FROM parent_child_edges WHERE tree_id = ?1 AND id = ?5`,
          [newId(), actor, note, id]
        ),
        // Pagar: bila relasi tidak terbentuk padahal usulan masih pending (siklus akibat balapan), paksa galat
        // supaya SELURUH batch dibatalkan, termasuk penutupan usulan dan pembuatan orang baru.
        t.stmt(
          `SELECT abs(-9223372036854775808) WHERE ${GA.sql} AND NOT EXISTS (SELECT 1 FROM parent_child_edges WHERE tree_id = ?1 AND id = ?2)`,
          [id, ...GA.p]
        ),
      ];
    }
    if (p.action === 'delete') {
      const GA = guard(6, proposalId);
      const GD = guard(3, proposalId);
      return [
        t.stmt(
          `INSERT INTO audit_events (id, tree_id, actor_id, action, target_type, target_id, before_json, after_json, approval_note) SELECT ?2, ?1, ?3, 'parent_child.delete', 'parent_child', id, json_object('parent_id', parent_id, 'child_id', child_id, 'relation_type', relation_type, 'parent_role', parent_role, 'custom_label', custom_label), NULL, ?4 FROM parent_child_edges WHERE tree_id = ?1 AND id = ?5 AND ${GA.sql}`,
          [newId(), actor, note, id, ...GA.p]
        ),
        t.stmt(`DELETE FROM parent_child_edges WHERE tree_id = ?1 AND id = ?2 AND ${GD.sql}`, [id, ...GD.p]),
      ];
    }
    const G = guard(ks.length + 3, proposalId);
    return [
      t.stmt(
        `UPDATE parent_child_edges SET ${ks.map((k, i) => `${k} = ?${i + 3}`).join(', ')} WHERE tree_id = ?1 AND id = ?2 AND ${G.sql}`,
        [id, ...ks.map((k) => v[k]), ...G.p]
      ),
      auditStmt(t, { type: 'parent_child', actor, action: 'parent_child.update', target: id, before, after: v, note }, proposalId),
    ];
  }
  if (p.kind === 'archive') {
    const G = guard(3, proposalId);
    const GA = guard(7, proposalId);
    return [
      t.stmt(
        `UPDATE people SET archived_at = datetime('now'), version = version + 1, updated_at = datetime('now') WHERE tree_id = ?1 AND id = ?2 AND archived_at IS NULL AND (is_placeholder = 1 OR NOT EXISTS (${CHILD_SQL})) AND NOT EXISTS (SELECT 1 FROM account_person_links WHERE tree_id = ?1 AND person_id = ?2) AND ${G.sql}`,
        [id, ...G.p]
      ),
      t.stmt(
        `INSERT INTO audit_events (id, tree_id, actor_id, action, target_type, target_id, before_json, approval_note) SELECT ?3, ?1, ?4, 'person.archive', 'person', id, json_object('display_name', display_name, 'reason', ?6), ?5 FROM people WHERE tree_id = ?1 AND id = ?2 AND archived_at IS NOT NULL AND ${GA.sql}`,
        [id, newId(), actor, note, p.reason ?? null, ...GA.p]
      ),
      // Pagar: bila orangnya masih belum diarsipkan padahal usulan masih pending (balapan: anak baru masuk), batalkan seluruh batch.
      t.stmt(`SELECT abs(-9223372036854775808) WHERE ${G.sql} AND EXISTS (SELECT 1 FROM people WHERE tree_id = ?1 AND id = ?2 AND archived_at IS NULL)`, [id, ...G.p]),
      ...staleStmts(t, id, proposalId),
    ];
  }
  if (p.kind === 'person_edit') {
    const G = guard(ks.length + 3, proposalId);
    const reset = p.fills ? ', is_placeholder = 0, placeholder_of = NULL' : '';
    return [
      t.stmt(
        `UPDATE people SET ${ks.map((k, i) => `${k} = ?${i + 3}`).join(', ')}${reset}, version = version + 1, updated_at = datetime('now') WHERE tree_id = ?1 AND id = ?2 AND archived_at IS NULL AND ${G.sql}`,
        [id, ...ks.map((k) => v[k]), ...G.p]
      ),
      auditStmt(t, p.fills
        ? { actor, action: 'person.fill_identity', target: id, before: { ...before, is_placeholder: 1, placeholder_of: row.placeholder_of ?? null }, after: { ...v, is_placeholder: 0, placeholder_of: null }, note }
        : { actor, action: 'person.update', target: id, before, after: v, note }, proposalId),
      ...staleStmts(t, id, proposalId),
    ];
  }
  return personInsert(t, { id, fields: v, proposalId, actor, createdBy, note });
}

// Membuat orang baru (usulan person_create, atau orang baru di dalam usulan relasi).
function personInsert(t, { id, fields, proposalId, actor, createdBy, note }) {
  const ks = Object.keys(fields);
  const G = guard(ks.length + 4, proposalId);
  return [
    t.stmt(
      `INSERT INTO people (id, tree_id, created_by, ${ks.join(', ')}) SELECT ?2, ?1, ?3, ${ks.map((_, i) => `?${i + 4}`).join(', ')} WHERE ${G.sql}`,
      [id, createdBy, ...ks.map((k) => fields[k]), ...G.p]
    ),
    auditStmt(t, { actor, action: 'person.create', target: id, before: null, after: fields, note }, proposalId),
  ];
}

// Batch dengan pemetaan galat UNIQUE pada pasangan menjadi kode yang jelas. Batch gagal = semuanya dibatalkan.
async function runBatch(db, kind, stmts) {
  try {
    return { ok: true, res: await db.batch(stmts) };
  } catch (e) {
    const msg = String(e?.message);
    if (kind === 'partnership' && /UNIQUE/i.test(msg)) return fail('duplicate_partnership');
    if (kind === 'parent_child' && /UNIQUE/i.test(msg)) return fail('duplicate_edge');
    if (kind === 'parent_child' && /integer overflow/i.test(msg)) return fail('would_create_cycle');
    if (kind === 'archive' && /integer overflow/i.test(msg)) return fail('cannot_archive');
    throw e;
  }
}

const idOut = (p) =>
  p.kind === 'archive'
    ? { personId: p.id, archived: true }
    : p.kind === 'partnership'
    ? { partnershipId: p.id }
    : p.kind === 'parent_child'
      ? { edgeId: p.id, ...(p.newPerson ? { personId: p.newPerson.id } : {}) }
      : { personId: p.id, ...(p.fills ? { identityFilled: true } : {}) };

// Setujui usulan DAN terapkan isinya dalam satu batch.
export async function approveAndApply(db, { treeId, proposalId, deciderId, now = new Date() }) {
  const m = await getMembership(db, treeId, deciderId);
  if (!m) return fail('forbidden');
  const t = forTree(db, treeId);
  await expireDue(db, treeId, now);
  const q = await t.first(
    'SELECT kind, target_person_id, after_json, status, proposer_id FROM proposals WHERE tree_id = ?1 AND id = ?2',
    [proposalId]
  );
  if (!q) return fail('not_found');
  const ck = checkDecision({ role: m.role, deciderId, proposerId: q.proposer_id, status: q.status, action: 'approve' });
  if (!ck.ok) return ck;
  if (!APPLY_KINDS.includes(q.kind)) return fail('kind_not_supported');
  let after;
  try {
    after = JSON.parse(q.after_json);
  } catch {
    return fail('invalid_payload');
  }
  const p = await prepare(t, { kind: q.kind, after, targetPersonId: q.target_person_id, role: m.role, now });
  if (!p.ok) return p;
  const stmts = plan(t, p, { proposalId, actor: deciderId, createdBy: q.proposer_id });
  const closeAt = stmts.length;
  stmts.push(...closeStmts(t, { proposalId, actorId: deciderId, status: 'approved', action: 'proposal.approve', reason: null, now }));
  const r = await runBatch(db, q.kind, stmts);
  if (!r.ok) return r;
  if (r.res[closeAt].meta.changes !== 1) return fail('not_pending');
  return { ok: true, status: 'approved', ...idOut(p), warnings: p.warnings };
}

// Jalur langsung (Admin/Owner) tanpa usulan. Contributor diarahkan ke usulan, Viewer ditolak.
export async function applyDirect(db, { treeId, actorId, kind, targetPersonId = null, after, now = new Date() }) {
  const m = await getMembership(db, treeId, actorId);
  if (!m) return fail('forbidden');
  const bootstrap = isBootstrap(await countManagers(db, treeId).then((c) => ({ owners: c.owner, admins: c.admin })));
  const r = route({ role: m.role, kind, bootstrap });
  if (r === 'forbidden') return fail('forbidden');
  if (!APPLY_KINDS.includes(kind)) return fail('kind_not_supported');
  if (r !== 'direct') return fail('needs_proposal');
  const t = forTree(db, treeId);
  const p = await prepare(t, { kind, after, targetPersonId, role: m.role, now });
  if (!p.ok) return p;
  const b = await runBatch(db, kind, plan(t, p, { proposalId: null, actor: actorId, createdBy: actorId }));
  if (!b.ok) return b;
  return { ok: true, ...idOut(p), warnings: p.warnings, at: sqlTime(now) };
}
