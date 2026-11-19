// Mesin proposal: pembuatan, keputusan, pembatalan, kedaluwarsa, dan penandaan "perlu diajukan ulang".
// Status: pending -> approved | rejected | cancelled | expired | stale. Semua status selain pending final.
// Setiap perubahan status dan catatan audit-nya ditulis dalam satu db.batch() (atomik).
// Modul ini TIDAK menerapkan isi usulan ke data orang/relasi; itu langkah terpisah per jenis usulan.

import { forTree, getMembership } from './db.js';
import { can, canDecideProposal } from './permissions.js';
import { auditStmt, newId, sqlTime } from './audit.js';

export const EXPIRY_DAYS = 30; // U5 di PRD: usulan, belum dikonfirmasi
export const MAX_REASON = 300;
export const MAX_SOURCE_NOTE = 500;
export const KINDS = [
  'person_edit',
  'person_create',
  'partnership',
  'parent_child',
  'archive',
  'archive_restore',
  'merge',
  'unmerge',
];

const fail = (code) => ({ ok: false, code });
const chars = (s) => [...s].length; // hitung karakter, sama dengan length() di SQLite
const notPending = (status) => fail(status === 'expired' ? 'expired' : 'not_pending');

const AUDIT_COLS =
  'INSERT INTO audit_events (id, tree_id, actor_id, action, target_type, target_id, before_json, after_json, approval_note)';
const SYS_AUDIT = (action) =>
  `${AUDIT_COLS} SELECT lower(hex(randomblob(16))), tree_id, NULL, '${action}', 'proposal', id, NULL, NULL, NULL FROM proposals WHERE`;

export function cleanReason(reason) {
  const v = typeof reason === 'string' ? reason.trim() : '';
  if (!v) return fail('reason_required');
  if (chars(v) > MAX_REASON) return fail('reason_too_long');
  return { ok: true, value: v };
}

// Aturan keputusan murni (tanpa database). Urutan: izin, status, pengaju sendiri, alasan tolak.
export function checkDecision({ role, deciderId, proposerId, status, action, reason }) {
  if (!can(role, 'proposal.decide')) return fail('forbidden');
  if (status !== 'pending') return notPending(status);
  if (!canDecideProposal({ role, deciderId, proposerId })) return fail('self_approval');
  if (action === 'reject') {
    const r = cleanReason(reason);
    return r.ok ? { ok: true, reason: r.value } : r;
  }
  return { ok: true, reason: null };
}

export async function createProposal(
  db,
  { treeId, proposerId, kind, targetPersonId = null, before = null, after, sourceNote = null, now = new Date() }
) {
  const m = await getMembership(db, treeId, proposerId);
  if (!m || !can(m.role, 'person.propose')) return fail('forbidden');
  if (!KINDS.includes(kind)) return fail('bad_kind');
  if (after === null || typeof after !== 'object') return fail('after_required');
  if (sourceNote !== null && chars(sourceNote) > MAX_SOURCE_NOTE) return fail('note_too_long');
  const t = forTree(db, treeId);
  if (targetPersonId && !(await t.first('SELECT id FROM people WHERE tree_id = ?1 AND id = ?2', [targetPersonId]))) {
    return fail('target_not_found');
  }
  const id = newId();
  const expiresAt = sqlTime(new Date(now.getTime() + EXPIRY_DAYS * 86400000));
  await db.batch([
    t.stmt(
      'INSERT INTO proposals (id, tree_id, kind, target_person_id, before_json, after_json, source_note, proposer_id, expires_at) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9)',
      [id, kind, targetPersonId, before === null ? null : JSON.stringify(before), JSON.stringify(after), sourceNote, proposerId, expiresAt]
    ),
    auditStmt(t, { actorId: proposerId, action: 'proposal.create', targetType: 'proposal', targetId: id, after: { kind, targetPersonId } }),
  ]);
  return { ok: true, id, expiresAt };
}

// Kedaluwarsa dijalankan "malas": dipanggil sebelum membaca daftar atau memutuskan. Tanpa Cron.
export async function expireDue(db, treeId, now = new Date()) {
  const t = forTree(db, treeId);
  const cond = "tree_id = ?1 AND status = 'pending' AND expires_at <= ?2";
  const res = await db.batch([
    t.stmt(`${SYS_AUDIT('proposal.expire')} ${cond}`, [sqlTime(now)]),
    t.stmt(`UPDATE proposals SET status = 'expired' WHERE ${cond}`, [sqlTime(now)]),
  ]);
  return res[1].meta.changes;
}

// Panggil saat data orang berubah (mis. setelah usulan lain disetujui atau Admin mengubah langsung).
// Usulan pending lain yang menyasar orang itu menjadi "stale" (Perlu diajukan ulang).
export async function markStale(db, treeId, personId, exceptProposalId = null) {
  const t = forTree(db, treeId);
  const cond = "tree_id = ?1 AND status = 'pending' AND target_person_id = ?2 AND id <> ?3";
  const args = [personId, exceptProposalId ?? ''];
  const res = await db.batch([
    t.stmt(`${SYS_AUDIT('proposal.stale')} ${cond}`, args),
    t.stmt(`UPDATE proposals SET status = 'stale' WHERE ${cond}`, args),
  ]);
  return res[1].meta.changes;
}

// Menutup proposal yang masih pending. Perubahan status dan audit dalam satu batch.
// Audit hanya masuk bila pembaruan ini yang benar-benar menutup proposal (aman dari balapan dua penyetuju).
async function closePending(db, t, { proposalId, actorId, status, action, reason, now }) {
  const at = sqlTime(now);
  const [upd] = await db.batch([
    t.stmt(
      "UPDATE proposals SET status = ?2, decided_by = ?3, decided_at = ?4, rejection_reason = ?5 WHERE tree_id = ?1 AND id = ?6 AND status = 'pending'",
      [status, actorId, at, status === 'rejected' ? reason : null, proposalId]
    ),
    t.stmt(
      `${AUDIT_COLS} SELECT lower(hex(randomblob(16))), tree_id, ?2, ?3, 'proposal', id, before_json, after_json, ?4 FROM proposals WHERE tree_id = ?1 AND id = ?5 AND status = ?6 AND decided_by = ?2 AND decided_at = ?7`,
      [actorId, action, reason, proposalId, status, at]
    ),
  ]);
  return upd.meta.changes === 1 ? { ok: true, status } : fail('not_pending');
}

export async function decideProposal(db, { treeId, proposalId, deciderId, action, reason = null, now = new Date() }) {
  if (action !== 'approve' && action !== 'reject') return fail('bad_action');
  const m = await getMembership(db, treeId, deciderId);
  if (!m) return fail('forbidden');
  const t = forTree(db, treeId);
  await expireDue(db, treeId, now);
  const p = await t.first('SELECT status, proposer_id FROM proposals WHERE tree_id = ?1 AND id = ?2', [proposalId]);
  if (!p) return fail('not_found');
  const v = checkDecision({ role: m.role, deciderId, proposerId: p.proposer_id, status: p.status, action, reason });
  if (!v.ok) return v;
  return closePending(db, t, {
    proposalId,
    actorId: deciderId,
    status: action === 'approve' ? 'approved' : 'rejected',
    action: `proposal.${action}`,
    reason: v.reason,
    now,
  });
}

export async function cancelProposal(db, { treeId, proposalId, actorId, now = new Date() }) {
  const m = await getMembership(db, treeId, actorId);
  if (!m || !can(m.role, 'person.propose')) return fail('forbidden');
  const t = forTree(db, treeId);
  await expireDue(db, treeId, now);
  const p = await t.first('SELECT status, proposer_id FROM proposals WHERE tree_id = ?1 AND id = ?2', [proposalId]);
  if (!p) return fail('not_found');
  if (p.proposer_id !== actorId) return fail('forbidden');
  if (p.status !== 'pending') return notPending(p.status);
  return closePending(db, t, { proposalId, actorId, status: 'cancelled', action: 'proposal.cancel', reason: null, now });
}
