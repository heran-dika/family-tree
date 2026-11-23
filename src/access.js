// Jalur B (PRD A1): kode pohon. Owner membuat kode acak panjang (bisa diganti atau dicabut). Pemegang kode login, melihat
// nama pohon dan nama tampilan pengelola (bukan email), menulis pesan singkat, lalu mengajukan bergabung. Pemohon BELUM
// anggota; Owner/Admin menyetujui dengan memilih peran Viewer atau Contributor. Admin/Owner tidak bisa diangkat lewat jalur ini.
//
// Kode mentah hanya dikembalikan sekali saat dibuat (yang disimpan hanya hash SHA-256), jadi kode yang hilang = buat baru
// (kode lama otomatis mati). Pola atomik sama dengan invitations.js: pernyataan yang mengubah data dijaga "permintaan masih
// pending", dan pernyataan yang menutup status dijalankan TERAKHIR.

import { forTree, getMembership } from './db.js';
import { can } from './permissions.js';
import { newToken, sha256Hex } from './invitations.js';
import { auditStmt, newId, sqlTime } from './audit.js';

export const MAX_PENDING_PER_TREE = 20; // [Menebak] angka pagar
export const MAX_PENDING_PER_ACCOUNT = 3; // [Menebak]
export const MAX_MESSAGE = 200;
export const JOIN_ROLES = ['viewer', 'contributor'];

const fail = (code) => ({ ok: false, code });
const chars = (s) => [...s].length;
const validCode = (c) => typeof c === 'string' && c.length >= 20 && c.length <= 200;

async function findCode(db, code) {
  if (!validCode(code)) return null;
  // Satu-satunya kueri tanpa tree_id: pohonnya baru diketahui dari hash rahasia (sama seperti byToken di invitations.js).
  return db
    .prepare(
      'SELECT c.tree_id, t.name FROM tree_access_codes c JOIN family_trees t ON t.id = c.tree_id WHERE c.code_hash = ?1 AND c.revoked_at IS NULL'
    )
    .bind(await sha256Hex(code))
    .first();
}

export async function createAccessCode(db, { treeId, actorId, now = new Date() }) {
  const m = await getMembership(db, treeId, actorId);
  if (!m || m.role !== 'owner') return fail('forbidden');
  const t = forTree(db, treeId);
  const code = newToken();
  const id = newId();
  await db.batch([
    t.stmt('UPDATE tree_access_codes SET revoked_at = ?2 WHERE tree_id = ?1 AND revoked_at IS NULL', [sqlTime(now)]),
    t.stmt('INSERT INTO tree_access_codes (id, tree_id, code_hash, created_by) VALUES (?2, ?1, ?3, ?4)', [id, await sha256Hex(code), actorId]),
    auditStmt(t, { actorId, action: 'access_code.create', targetType: 'access_code', targetId: id }),
  ]);
  return { ok: true, code, id };
}

export async function accessCodeStatus(db, { treeId, actorId }) {
  const m = await getMembership(db, treeId, actorId);
  if (!m || m.role !== 'owner') return fail('forbidden');
  const row = await forTree(db, treeId).first('SELECT created_at FROM tree_access_codes WHERE tree_id = ?1 AND revoked_at IS NULL');
  return { ok: true, active: Boolean(row), createdAt: row?.created_at ?? null };
}

export async function revokeAccessCode(db, { treeId, actorId, now = new Date() }) {
  const m = await getMembership(db, treeId, actorId);
  if (!m || m.role !== 'owner') return fail('forbidden');
  const t = forTree(db, treeId);
  const cur = await t.first('SELECT id FROM tree_access_codes WHERE tree_id = ?1 AND revoked_at IS NULL');
  if (!cur) return fail('not_found');
  const at = sqlTime(now);
  const res = await db.batch([
    t.stmt('UPDATE tree_access_codes SET revoked_at = ?3 WHERE tree_id = ?1 AND id = ?2 AND revoked_at IS NULL', [cur.id, at]),
    t.stmt(
      "INSERT INTO audit_events (id, tree_id, actor_id, action, target_type, target_id) SELECT ?4, ?1, ?5, 'access_code.revoke', 'access_code', id FROM tree_access_codes WHERE tree_id = ?1 AND id = ?2 AND revoked_at = ?3",
      [cur.id, at, newId(), actorId]
    ),
  ]);
  return res[0].meta.changes === 1 ? { ok: true } : fail('not_found');
}

// Untuk layar "Gabung ke pohon ini?": hanya nama pohon dan nama tampilan pengelola, tidak pernah email.
export async function lookupAccessCode(db, { code }) {
  const f = await findCode(db, code);
  if (!f) return fail('invalid_code');
  const rows = await forTree(db, f.tree_id).all(
    "SELECT a.display_name FROM memberships m JOIN accounts a ON a.id = m.account_id WHERE m.tree_id = ?1 AND m.status = 'active' AND m.role IN ('owner', 'admin') ORDER BY m.role DESC, a.created_at, a.id"
  );
  return { ok: true, treeName: f.name, managers: rows.map((r) => r.display_name || 'Pengelola') };
}

export async function requestJoin(db, { code, accountId, message = null, now = new Date() }) {
  const f = await findCode(db, code);
  if (!f) return fail('invalid_code');
  const acc = await db.prepare('SELECT id, email_verified FROM accounts WHERE id = ?1').bind(accountId ?? '').first();
  if (!acc) return fail('forbidden');
  if (!acc.email_verified) return fail('email_not_verified');
  let msg = null;
  if (message !== null && message !== undefined) {
    if (typeof message !== 'string') return fail('invalid_message');
    const s = message.trim();
    if (chars(s) > MAX_MESSAGE) return fail('message_too_long');
    msg = s || null;
  }
  const t = forTree(db, f.tree_id);
  const mem = await t.first('SELECT status FROM memberships WHERE tree_id = ?1 AND account_id = ?2', [accountId]);
  if (mem?.status === 'active') return fail('already_member');
  if (await t.first("SELECT id FROM join_requests WHERE tree_id = ?1 AND account_id = ?2 AND status = 'pending'", [accountId])) return fail('already_pending');
  const nt = await t.first("SELECT COUNT(*) AS n FROM join_requests WHERE tree_id = ?1 AND status = 'pending'");
  if (nt.n >= MAX_PENDING_PER_TREE) return fail('too_many_pending');
  const na = await db.prepare("SELECT COUNT(*) AS n FROM join_requests WHERE account_id = ?1 AND status = 'pending'").bind(accountId).first();
  if (na.n >= MAX_PENDING_PER_ACCOUNT) return fail('request_limit');

  const id = newId();
  try {
    const res = await db.batch([
      t.stmt(
        `INSERT INTO join_requests (id, tree_id, account_id, message) SELECT ?2, ?1, ?3, ?4 WHERE EXISTS (SELECT 1 FROM tree_access_codes WHERE tree_id = ?1 AND code_hash = ?5 AND revoked_at IS NULL) AND (SELECT COUNT(*) FROM join_requests WHERE tree_id = ?1 AND status = 'pending') < ?6 AND (SELECT COUNT(*) FROM join_requests WHERE account_id = ?3 AND status = 'pending') < ?7 AND NOT EXISTS (SELECT 1 FROM memberships WHERE tree_id = ?1 AND account_id = ?3 AND status = 'active')`,
        [id, accountId, msg, await sha256Hex(code), MAX_PENDING_PER_TREE, MAX_PENDING_PER_ACCOUNT]
      ),
      t.stmt(
        "INSERT INTO audit_events (id, tree_id, actor_id, action, target_type, target_id, after_json) SELECT ?3, ?1, ?4, 'member.join_request', 'join_request', ?2, json_object('via', 'access_code') WHERE EXISTS (SELECT 1 FROM join_requests WHERE tree_id = ?1 AND id = ?2)",
        [id, newId(), accountId]
      ),
    ]);
    if (res[0].meta.changes !== 1) return fail('join_failed');
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message))) return fail('already_pending');
    throw e;
  }
  return { ok: true, requestId: id, treeId: f.tree_id, treeName: f.name };
}

// Daftar permintaan menunggu untuk Owner/Admin. Email pemohon DITAMPILKAN ke pengelola supaya bisa mengenali siapa itu.
export async function listJoinRequests(db, { treeId, actorId }) {
  const m = await getMembership(db, treeId, actorId);
  if (!m || !can(m.role, 'member.invite')) return fail('forbidden');
  const rows = await forTree(db, treeId).all(
    "SELECT jr.id, jr.message, jr.created_at, a.display_name, a.email FROM join_requests jr JOIN accounts a ON a.id = jr.account_id WHERE jr.tree_id = ?1 AND jr.status = 'pending' ORDER BY jr.created_at, jr.id"
  );
  return { ok: true, requests: rows.map((r) => ({ id: r.id, name: r.display_name || r.email.split('@')[0], email: r.email, message: r.message ?? null, createdAt: r.created_at })) };
}

// Permintaan menunggu milik akun ini (untuk kartu "Menunggu persetujuan" di Home).
export async function myJoinRequests(db, accountId) {
  const { results } = await db
    .prepare("SELECT jr.id, t.name, jr.created_at FROM join_requests jr JOIN family_trees t ON t.id = jr.tree_id WHERE jr.account_id = ?1 AND jr.status = 'pending' ORDER BY jr.created_at, jr.id")
    .bind(accountId ?? '')
    .all();
  return results.map((r) => ({ id: r.id, treeName: r.name, createdAt: r.created_at }));
}

export async function decideJoinRequest(db, { treeId, requestId, deciderId, action, role = null, now = new Date() }) {
  if (action !== 'approve' && action !== 'reject') return fail('bad_action');
  const ok = action === 'approve';
  if (ok && !JOIN_ROLES.includes(role)) return fail('invalid_role');
  const m = await getMembership(db, treeId, deciderId);
  if (!m || !can(m.role, 'member.invite')) return fail('forbidden');
  const t = forTree(db, treeId);
  const req = await t.first('SELECT status FROM join_requests WHERE tree_id = ?1 AND id = ?2', [requestId]);
  if (!req) return fail('not_found');
  if (req.status !== 'pending') return fail('not_pending');
  const stmts = [];
  if (ok) {
    stmts.push(
      t.stmt(
        "INSERT INTO memberships (tree_id, account_id, role, status) SELECT ?1, account_id, ?3, 'active' FROM join_requests WHERE tree_id = ?1 AND id = ?2 AND status = 'pending' ON CONFLICT (tree_id, account_id) DO UPDATE SET role = excluded.role, status = 'active' WHERE memberships.status <> 'active'",
        [requestId, role]
      )
    );
  }
  stmts.push(
    t.stmt(
      "INSERT INTO audit_events (id, tree_id, actor_id, action, target_type, target_id, after_json) SELECT ?3, ?1, ?4, ?5, 'join_request', ?2, ?6 WHERE EXISTS (SELECT 1 FROM join_requests WHERE tree_id = ?1 AND id = ?2 AND status = 'pending')",
      [requestId, newId(), deciderId, ok ? 'member.join_approve' : 'member.join_reject', JSON.stringify(ok ? { role } : {})]
    ),
    t.stmt(
      "UPDATE join_requests SET status = ?3, role = ?4, decided_by = ?5, decided_at = ?6 WHERE tree_id = ?1 AND id = ?2 AND status = 'pending'",
      [requestId, ok ? 'approved' : 'rejected', ok ? role : null, deciderId, sqlTime(now)]
    )
  );
  const res = await db.batch(stmts);
  return res[res.length - 1].meta.changes === 1 ? { ok: true, status: ok ? 'approved' : 'rejected' } : fail('not_pending');
}
