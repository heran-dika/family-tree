// Penerapan perubahan data orang: jalur "setujui usulan" dan jalur "langsung" (Admin/Owner).
// Jenis yang didukung saat ini: person_edit, person_create. Jenis lain ditolak SEBELUM usulan ditutup,
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
import { newId, sqlTime } from './audit.js';

export const APPLY_KINDS = ['person_edit', 'person_create'];

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
    } else if (typeof date !== 'string' || !/^\d{4}$/.test(date)) {
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

// Penjaga: usulan ini masih pending. Tanpa proposalId (jalur langsung) selalu benar.
const guard = (n, proposalId) =>
  proposalId
    ? { sql: `EXISTS (SELECT 1 FROM proposals WHERE tree_id = ?1 AND id = ?${n} AND status = 'pending')`, p: [proposalId] }
    : { sql: '1 = 1', p: [] };

function auditStmt(t, e, proposalId) {
  const G = guard(9, proposalId);
  return t.stmt(
    `INSERT INTO audit_events (id, tree_id, actor_id, action, target_type, target_id, before_json, after_json, approval_note) SELECT ?2, ?1, ?3, ?4, 'person', ?5, ?6, ?7, ?8 WHERE ${G.sql}`,
    [newId(), e.actor, e.action, e.target, j(e.before), j(e.after), e.note ?? null, ...G.p]
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

// Menyusun pernyataan penerapan. `row` = baris orang saat ini (hanya untuk edit).
function plan(t, { kind, v, row, personId, proposalId, actor, createdBy }) {
  const ks = Object.keys(v);
  const note = proposalId ? `proposal:${proposalId}` : null;
  if (kind === 'person_edit') {
    const G = guard(ks.length + 3, proposalId);
    const before = Object.fromEntries(ks.map((k) => [k, row[k] ?? null]));
    return [
      t.stmt(
        `UPDATE people SET ${ks.map((k, i) => `${k} = ?${i + 3}`).join(', ')}, version = version + 1, updated_at = datetime('now') WHERE tree_id = ?1 AND id = ?2 AND archived_at IS NULL AND ${G.sql}`,
        [personId, ...ks.map((k) => v[k]), ...G.p]
      ),
      auditStmt(t, { actor, action: 'person.update', target: personId, before, after: v, note }, proposalId),
      ...staleStmts(t, personId, proposalId),
    ];
  }
  const G = guard(ks.length + 4, proposalId);
  return [
    t.stmt(
      `INSERT INTO people (id, tree_id, created_by, ${ks.join(', ')}) SELECT ?2, ?1, ?3, ${ks.map((_, i) => `?${i + 4}`).join(', ')} WHERE ${G.sql}`,
      [personId, createdBy, ...ks.map((k) => v[k]), ...G.p]
    ),
    auditStmt(t, { actor, action: 'person.create', target: personId, before: null, after: v, note }, proposalId),
  ];
}

async function loadTarget(t, personId) {
  if (!personId) return fail('target_not_found');
  const row = await t.first('SELECT * FROM people WHERE tree_id = ?1 AND id = ?2', [personId]);
  if (!row) return fail('target_not_found');
  if (row.archived_at != null) return fail('target_archived');
  return { ok: true, row };
}

// Setujui usulan DAN terapkan isinya dalam satu batch.
export async function approveAndApply(db, { treeId, proposalId, deciderId, now = new Date() }) {
  const m = await getMembership(db, treeId, deciderId);
  if (!m) return fail('forbidden');
  const t = forTree(db, treeId);
  await expireDue(db, treeId, now);
  const p = await t.first(
    'SELECT kind, target_person_id, after_json, status, proposer_id FROM proposals WHERE tree_id = ?1 AND id = ?2',
    [proposalId]
  );
  if (!p) return fail('not_found');
  const ck = checkDecision({ role: m.role, deciderId, proposerId: p.proposer_id, status: p.status, action: 'approve' });
  if (!ck.ok) return ck;
  if (!APPLY_KINDS.includes(p.kind)) return fail('kind_not_supported');
  let after;
  try {
    after = JSON.parse(p.after_json);
  } catch {
    return fail('invalid_payload');
  }
  const c = cleanFields(after, { create: p.kind === 'person_create' });
  if (!c.ok) return c;

  let row = null;
  let personId = newId();
  if (p.kind === 'person_edit') {
    const tg = await loadTarget(t, p.target_person_id);
    if (!tg.ok) return tg;
    row = tg.row;
    personId = p.target_person_id;
  }
  const warnings = softWarnings({ ...(row ?? {}), ...c.values }, now);
  const stmts = plan(t, { kind: p.kind, v: c.values, row, personId, proposalId, actor: deciderId, createdBy: p.proposer_id });
  const closeAt = stmts.length;
  stmts.push(...closeStmts(t, { proposalId, actorId: deciderId, status: 'approved', action: 'proposal.approve', reason: null, now }));
  const res = await db.batch(stmts);
  if (res[closeAt].meta.changes !== 1) return fail('not_pending');
  return { ok: true, status: 'approved', personId, warnings };
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
  const c = cleanFields(after, { create: kind === 'person_create' });
  if (!c.ok) return c;
  const t = forTree(db, treeId);
  let row = null;
  let personId = newId();
  if (kind === 'person_edit') {
    const tg = await loadTarget(t, targetPersonId);
    if (!tg.ok) return tg;
    row = tg.row;
    personId = targetPersonId;
  }
  const warnings = softWarnings({ ...(row ?? {}), ...c.values }, now);
  await db.batch(plan(t, { kind, v: c.values, row, personId, proposalId: null, actor: actorId, createdBy: actorId }));
  return { ok: true, personId, warnings, at: sqlTime(now) };
}
