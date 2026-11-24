// Kelola anggota pohon: daftar, ubah peran (Viewer/Contributor), keluarkan. Owner/Admin saja.
// Peran Admin/Owner tidak bisa diubah lewat sini (butuh MFA, belum ada). Admin hanya bisa mengeluarkan Viewer/Contributor;
// Owner juga bisa mengeluarkan Admin. Owner tidak bisa dikeluarkan. Mengeluarkan = status 'removed' (profil dan relasi tetap).
import { forTree, getMembership } from './db.js';
import { can } from './permissions.js';
import { newId } from './audit.js';

export const SET_ROLES = ['viewer', 'contributor'];
const REMOVABLE = { owner: ['viewer', 'contributor', 'admin'], admin: ['viewer', 'contributor'] };
const fail = (code) => ({ ok: false, code });
const inList = (a) => a.map((r) => `'${r}'`).join(',');

async function gate(db, treeId, actorId) {
  const m = await getMembership(db, treeId, actorId);
  return m && can(m.role, 'member.remove') ? m : null;
}

export async function listMembers(db, { treeId, actorId }) {
  if (!(await gate(db, treeId, actorId))) return fail('forbidden');
  const rows = await forTree(db, treeId).all(
    "SELECT m.account_id, m.role, m.created_at, a.display_name, a.email FROM memberships m JOIN accounts a ON a.id = m.account_id WHERE m.tree_id = ?1 AND m.status = 'active' ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'contributor' THEN 2 ELSE 3 END, a.display_name, m.account_id"
  );
  return { ok: true, members: rows.map((r) => ({ accountId: r.account_id, name: r.display_name || r.email.split('@')[0], email: r.email, role: r.role, since: r.created_at, self: r.account_id === actorId })) };
}

async function target(db, treeId, actorId, accountId, allowed) {
  const m = await gate(db, treeId, actorId);
  if (!m) return fail('forbidden');
  if (typeof accountId !== 'string' || accountId === actorId) return fail('forbidden');
  const t = await forTree(db, treeId).first("SELECT role FROM memberships WHERE tree_id = ?1 AND account_id = ?2 AND status = 'active'", [accountId]);
  if (!t) return fail('not_found');
  const ok = allowed(m.role);
  return ok.includes(t.role) ? { ok: true, from: t.role, list: ok } : fail('forbidden');
}

export async function setMemberRole(db, { treeId, actorId, accountId, role }) {
  if (!SET_ROLES.includes(role)) return fail('invalid_role');
  const g = await target(db, treeId, actorId, accountId, () => SET_ROLES);
  if (!g.ok) return g;
  if (g.from === role) return { ok: true, role };
  const t = forTree(db, treeId);
  const res = await db.batch([
    t.stmt(`INSERT INTO audit_events (id, tree_id, actor_id, action, target_type, target_id, before_json, after_json) SELECT ?2, ?1, ?3, 'member.set_role', 'account', ?4, json_object('role', role), json_object('role', ?5) FROM memberships WHERE tree_id = ?1 AND account_id = ?4 AND status = 'active' AND role = ?6`, [newId(), actorId, accountId, role, g.from]),
    t.stmt("UPDATE memberships SET role = ?3 WHERE tree_id = ?1 AND account_id = ?2 AND status = 'active' AND role = ?4", [accountId, role, g.from]),
  ]);
  return res[1].meta.changes === 1 ? { ok: true, role } : fail('not_found');
}

export async function removeMember(db, { treeId, actorId, accountId }) {
  const g = await target(db, treeId, actorId, accountId, (r) => REMOVABLE[r] ?? []);
  if (!g.ok) return g;
  const t = forTree(db, treeId);
  const L = inList(g.list);
  const res = await db.batch([
    t.stmt(`INSERT INTO audit_events (id, tree_id, actor_id, action, target_type, target_id, before_json) SELECT ?2, ?1, ?3, 'member.remove', 'account', ?4, json_object('role', role) FROM memberships WHERE tree_id = ?1 AND account_id = ?4 AND status = 'active' AND role IN (${L})`, [newId(), actorId, accountId]),
    t.stmt(`UPDATE memberships SET status = 'removed' WHERE tree_id = ?1 AND account_id = ?2 AND status = 'active' AND role IN (${L})`, [accountId]),
  ]);
  return res[1].meta.changes === 1 ? { ok: true } : fail('not_found');
}
