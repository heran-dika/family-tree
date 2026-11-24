// Anggota tanpa akun Google: Owner membuat akun + link login sekali pakai. Link berisi token di fragmen (#login=...), jadi
// tidak ikut ke server saat pratinjau WhatsApp membuka tautan; JS halaman yang menukarnya lewat POST. Token sekali pakai,
// berlaku 7 hari, hanya hash yang disimpan. Penukaran membuat sesi panjang (cookie di perangkat itu). HP hilang/ganti:
// Owner "buat ulang link" (token lama mati, semua sesi akun itu dihapus). Peran hanya Viewer atau Contributor; tidak bisa buat pohon.
import { forTree, getMembership } from './db.js';
import { newToken, sha256Hex } from './invitations.js';
import { newId, sqlTime } from './audit.js';
import { SESSION_COOKIE } from './auth.js';

export const GUEST_ROLES = ['viewer', 'contributor'];
export const LINK_DAYS = 7;
export const GUEST_SESSION_DAYS = 180; // [Menebak]
export const MAX_GUESTS = 10; // [Menebak]
const DAY = 86400000;
const fail = (code) => ({ ok: false, code });
const chars = (s) => [...s].length;

async function owner(db, treeId, actorId) {
  const m = await getMembership(db, treeId, actorId);
  return m?.role === 'owner';
}
const tokenStmts = (t, { accountId, actorId, token, now, hash }) => [
  t.stmt('UPDATE guest_tokens SET revoked_at = ?3 WHERE tree_id = ?1 AND account_id = ?2 AND used_at IS NULL AND revoked_at IS NULL', [accountId, sqlTime(now)]),
  t.stmt('INSERT INTO guest_tokens (id, tree_id, account_id, token_hash, created_by, expires_at) VALUES (?2, ?1, ?3, ?4, ?5, ?6)', [newId(), accountId, hash, actorId, sqlTime(new Date(now.getTime() + LINK_DAYS * DAY))]),
];

export async function createGuest(db, { treeId, actorId, name, role, now = new Date() }) {
  if (!(await owner(db, treeId, actorId))) return fail('forbidden');
  if (!GUEST_ROLES.includes(role)) return fail('invalid_role');
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) return fail('name_required');
  if (chars(n) > 100) return fail('name_too_long');
  const t = forTree(db, treeId);
  const cnt = await t.first("SELECT COUNT(*) AS n FROM memberships m JOIN accounts a ON a.id = m.account_id WHERE m.tree_id = ?1 AND m.status = 'active' AND a.login_link = 1");
  if (cnt.n >= MAX_GUESTS) return fail('too_many_guests');
  const token = newToken();
  const accountId = newId();
  await db.batch([
    // bukan data per pohon: pakai db.prepare langsung (forTree menolak SQL tanpa tree_id)
    db.prepare('INSERT INTO accounts (id, email, email_verified, display_name, login_link, tree_quota) VALUES (?1, ?2, 0, ?3, 1, 0)').bind(accountId, `guest-${accountId}@guest.invalid`, n),
    t.stmt("INSERT INTO memberships (tree_id, account_id, role, status) VALUES (?1, ?2, ?3, 'active')", [accountId, role]),
    ...tokenStmts(t, { accountId, actorId, token, now, hash: await sha256Hex(token) }),
    t.stmt("INSERT INTO audit_events (id, tree_id, actor_id, action, target_type, target_id, after_json) VALUES (?2, ?1, ?3, 'member.guest_create', 'account', ?4, json_object('role', ?5))", [newId(), actorId, accountId, role]),
  ]);
  return { ok: true, token, accountId };
}

export async function reissueGuest(db, { treeId, actorId, accountId, now = new Date() }) {
  if (!(await owner(db, treeId, actorId))) return fail('forbidden');
  const t = forTree(db, treeId);
  const row = await t.first("SELECT 1 AS x FROM memberships m JOIN accounts a ON a.id = m.account_id WHERE m.tree_id = ?1 AND m.account_id = ?2 AND m.status = 'active' AND a.login_link = 1", [accountId]);
  if (!row) return fail('not_found');
  const token = newToken();
  await db.batch([
    ...tokenStmts(t, { accountId, actorId, token, now, hash: await sha256Hex(token) }),
    db.prepare('DELETE FROM sessions WHERE account_id = ?1').bind(accountId),
    t.stmt("INSERT INTO audit_events (id, tree_id, actor_id, action, target_type, target_id) VALUES (?2, ?1, ?3, 'member.guest_reissue', 'account', ?4)", [newId(), actorId, accountId]),
  ]);
  return { ok: true, token };
}

// Tanpa sesi. Sesi dibuat lebih dulu dan dijaga "token masih sah"; penandaan dipakai di pernyataan berikutnya dalam batch yang sama.
export async function guestLogin(db, { token, now = new Date() }) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return fail('invalid_link');
  const hash = await sha256Hex(token);
  const session = newToken();
  const at = sqlTime(now);
  const res = await db.batch([
    db.prepare("INSERT INTO sessions (id, account_id, expires_at) SELECT ?2, account_id, ?3 FROM guest_tokens WHERE token_hash = ?1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?4").bind(hash, await sha256Hex(session), sqlTime(new Date(now.getTime() + GUEST_SESSION_DAYS * DAY)), at),
    db.prepare('UPDATE guest_tokens SET used_at = ?2 WHERE token_hash = ?1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?2').bind(hash, at),
  ]);
  if (res[1].meta.changes !== 1) return fail('invalid_link');
  return { ok: true, cookie: `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${GUEST_SESSION_DAYS * 86400}` };
}
