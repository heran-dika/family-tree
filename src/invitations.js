// Undangan (jalur A): Owner/Admin mengundang lewat email dengan peran Contributor atau Viewer.
// Alur: pending -> (penerima mengajukan bergabung) awaiting_approval -> (Owner/Admin setuju) accepted,
//       atau cancelled (ditolak atau dibatalkan), atau expired (7 hari tanpa dipakai).
// Token: acak 256 bit, hanya hash SHA-256 yang disimpan; token mentah hanya dikembalikan sekali ke pemanggil
// (untuk dikirim lewat email; penyedia email belum diputuskan). Sekali pakai, terikat ke email terverifikasi.
// Data pohon tidak terlihat sebelum disetujui: keanggotaan baru berstatus 'pending', dan getMembership hanya
// mengenali 'active'. Admin/Owner TIDAK bisa diangkat lewat undangan (hanya Owner, di jalur lain).
//
// Pola atomik sama dengan proposals.js: pernyataan yang mengubah data dijaga "undangan masih berstatus X" dan
// pernyataan yang menutup status dijalankan TERAKHIR, jadi dua permintaan yang berbalapan tidak bisa menang dua kali.

import { forTree, getMembership } from './db.js';
import { can } from './permissions.js';
import { auditStmt, newId, sqlTime } from './audit.js';

export const INVITE_DAYS = 7;
export const INVITE_ROLES = ['contributor', 'viewer'];

const fail = (code) => ({ ok: false, code });
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const normEmail = (e) => (typeof e === 'string' ? e.trim().toLowerCase() : '');
const DAY = 86400000;

export async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Audit yang hanya masuk bila undangan masih berstatus `status` (id undangan = ?5 pada pernyataan pemanggil).
const guardedAudit = (t, { actor, action, invitationId, status, after }) =>
  t.stmt(
    "INSERT INTO audit_events (id, tree_id, actor_id, action, target_type, target_id, before_json, after_json, approval_note) SELECT ?2, ?1, ?3, ?4, 'invitation', ?5, NULL, ?6, NULL WHERE EXISTS (SELECT 1 FROM invitations WHERE tree_id = ?1 AND id = ?5 AND status = ?7)",
    [newId(), actor, action, invitationId, after === undefined ? null : JSON.stringify(after), status]
  );

export async function createInvitation(db, { treeId, inviterId, email, role, now = new Date() }) {
  const m = await getMembership(db, treeId, inviterId);
  if (!m || !can(m.role, 'member.invite')) return fail('forbidden');
  if (!INVITE_ROLES.includes(role)) return fail('invalid_role');
  const addr = normEmail(email);
  if (!addr || addr.length > 254 || !EMAIL.test(addr)) return fail('invalid_email');
  const t = forTree(db, treeId);
  const member = await t.first(
    "SELECT mb.status FROM memberships mb JOIN accounts a ON a.id = mb.account_id WHERE mb.tree_id = ?1 AND lower(a.email) = ?2 AND mb.status IN ('active', 'pending')",
    [addr]
  );
  if (member) return fail(member.status === 'active' ? 'already_member' : 'already_pending');
  const token = newToken();
  const id = newId();
  const expiresAt = sqlTime(new Date(now.getTime() + INVITE_DAYS * DAY));
  try {
    await db.batch([
      t.stmt("UPDATE invitations SET status = 'cancelled' WHERE tree_id = ?1 AND lower(email) = ?2 AND status = 'pending'", [addr]),
      t.stmt(
        'INSERT INTO invitations (id, tree_id, email, role, token_hash, invited_by, expires_at) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7)',
        [id, addr, role, await sha256Hex(token), inviterId, expiresAt]
      ),
      auditStmt(t, { actorId: inviterId, action: 'invitation.create', targetType: 'invitation', targetId: id, after: { email: addr, role, expiresAt } }),
    ]);
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message))) return fail('invite_awaiting_approval');
    throw e;
  }
  return { ok: true, id, token, expiresAt };
}

// Untuk layar "Anda diundang": tanpa login, hanya nama pohon dan peran. Satu-satunya kueri tanpa tree_id
// karena pohonnya baru diketahui dari token (kunci pencarian adalah hash rahasia, bukan id yang bisa ditebak).
async function byToken(db, token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  return db
    .prepare(
      'SELECT i.id, i.tree_id, i.email, i.role, i.status, i.expires_at, t.name AS tree_name FROM invitations i JOIN family_trees t ON t.id = i.tree_id WHERE i.token_hash = ?1'
    )
    .bind(await sha256Hex(token))
    .first();
}

const unusable = (inv, now) => {
  if (!inv) return fail('invalid_invitation');
  if (inv.status === 'expired' || (inv.status === 'pending' && inv.expires_at <= sqlTime(now))) return fail('invitation_expired');
  return inv.status === 'pending' ? null : fail('invalid_invitation');
};

export async function lookupInvitation(db, token, now = new Date()) {
  const inv = await byToken(db, token);
  return unusable(inv, now) ?? { ok: true, treeName: inv.tree_name, role: inv.role };
}

// Penerima (sudah login) mengajukan bergabung. Belum menjadi anggota sampai Owner/Admin menyetujui.
export async function acceptInvitation(db, { token, accountId, now = new Date() }) {
  const inv = await byToken(db, token);
  const bad = unusable(inv, now);
  if (bad) return bad;
  const acc = await db.prepare('SELECT id, email, email_verified FROM accounts WHERE id = ?1').bind(accountId ?? '').first();
  if (!acc) return fail('forbidden');
  if (!acc.email_verified) return fail('email_not_verified');
  if (normEmail(acc.email) !== inv.email) return fail('wrong_account');
  const t = forTree(db, inv.tree_id);
  const cur = await t.first('SELECT status FROM memberships WHERE tree_id = ?1 AND account_id = ?2', [accountId]);
  if (cur?.status === 'active') return fail('already_member');
  if (cur?.status === 'pending') return fail('already_pending');
  const at = sqlTime(now);
  const live = "EXISTS (SELECT 1 FROM invitations WHERE tree_id = ?1 AND id = ?2 AND status = 'pending' AND expires_at > ?3)";
  const res = await db.batch([
    t.stmt(
      `INSERT INTO memberships (tree_id, account_id, role, status) SELECT ?1, ?4, ?5, 'pending' WHERE ${live} ON CONFLICT (tree_id, account_id) DO UPDATE SET role = excluded.role, status = 'pending' WHERE memberships.status = 'removed'`,
      [inv.id, at, accountId, inv.role]
    ),
    t.stmt(
      `INSERT INTO audit_events (id, tree_id, actor_id, action, target_type, target_id, before_json, after_json, approval_note) SELECT ?4, ?1, ?5, 'member.join_request', 'invitation', ?2, NULL, ?6, NULL WHERE ${live}`,
      [inv.id, at, newId(), accountId, JSON.stringify({ role: inv.role })]
    ),
    t.stmt(
      "UPDATE invitations SET status = 'awaiting_approval', accepted_by = ?4 WHERE tree_id = ?1 AND id = ?2 AND status = 'pending' AND expires_at > ?3",
      [inv.id, at, accountId]
    ),
  ]);
  return res[2].meta.changes === 1 ? { ok: true, invitationId: inv.id, treeId: inv.tree_id, status: 'awaiting_approval' } : fail('invalid_invitation');
}

// Owner/Admin menyetujui atau menolak permintaan bergabung.
export async function decideJoin(db, { treeId, invitationId, deciderId, action, now = new Date() }) {
  if (action !== 'approve' && action !== 'reject') return fail('bad_action');
  const m = await getMembership(db, treeId, deciderId);
  if (!m || !can(m.role, 'member.invite')) return fail('forbidden');
  const t = forTree(db, treeId);
  const inv = await t.first('SELECT status, role FROM invitations WHERE tree_id = ?1 AND id = ?2', [invitationId]);
  if (!inv) return fail('not_found');
  if (inv.status !== 'awaiting_approval') return fail('not_awaiting');
  const ok = action === 'approve';
  const who = "account_id = (SELECT accepted_by FROM invitations WHERE tree_id = ?1 AND id = ?2 AND status = 'awaiting_approval')";
  const res = await db.batch([
    t.stmt(`UPDATE memberships SET status = ?3 WHERE tree_id = ?1 AND ${who} AND status = 'pending'`, [invitationId, ok ? 'active' : 'removed']),
    guardedAudit(t, { actor: deciderId, action: ok ? 'member.join_approve' : 'member.join_reject', invitationId, status: 'awaiting_approval', after: { role: inv.role } }),
    t.stmt("UPDATE invitations SET status = ?3 WHERE tree_id = ?1 AND id = ?2 AND status = 'awaiting_approval'", [invitationId, ok ? 'accepted' : 'cancelled']),
  ]);
  return res[2].meta.changes === 1 ? { ok: true, status: ok ? 'accepted' : 'cancelled' } : fail('not_awaiting');
}

// Membatalkan undangan yang menunggu dipakai atau yang menunggu persetujuan.
export async function cancelInvitation(db, { treeId, invitationId, actorId }) {
  const m = await getMembership(db, treeId, actorId);
  if (!m || !can(m.role, 'member.invite')) return fail('forbidden');
  const t = forTree(db, treeId);
  const inv = await t.first('SELECT status FROM invitations WHERE tree_id = ?1 AND id = ?2', [invitationId]);
  if (!inv) return fail('not_found');
  if (inv.status !== 'pending' && inv.status !== 'awaiting_approval') return fail('not_cancellable');
  const res = await db.batch([
    t.stmt(
      "UPDATE memberships SET status = 'removed' WHERE tree_id = ?1 AND status = 'pending' AND account_id = (SELECT accepted_by FROM invitations WHERE tree_id = ?1 AND id = ?2 AND status = 'awaiting_approval')",
      [invitationId]
    ),
    t.stmt(
      "INSERT INTO audit_events (id, tree_id, actor_id, action, target_type, target_id, before_json, after_json, approval_note) SELECT ?2, ?1, ?3, 'invitation.cancel', 'invitation', ?4, json_object('status', status), NULL, NULL FROM invitations WHERE tree_id = ?1 AND id = ?4 AND status IN ('pending', 'awaiting_approval')",
      [newId(), actorId, invitationId]
    ),
    t.stmt("UPDATE invitations SET status = 'cancelled' WHERE tree_id = ?1 AND id = ?2 AND status IN ('pending', 'awaiting_approval')", [invitationId]),
  ]);
  return res[2].meta.changes === 1 ? { ok: true, status: 'cancelled' } : fail('not_cancellable');
}

// Kedaluwarsa "malas": panggil sebelum menampilkan daftar undangan. Hanya yang menunggu dipakai; yang menunggu
// persetujuan tidak kedaluwarsa (sudah dipakai).
export async function expireInvitations(db, treeId, now = new Date()) {
  const t = forTree(db, treeId);
  return (await t.run("UPDATE invitations SET status = 'expired' WHERE tree_id = ?1 AND status = 'pending' AND expires_at <= ?2", [sqlTime(now)])).meta.changes;
}
