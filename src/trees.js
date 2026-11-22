// Pohon: buat, daftar milik akun, dan baca isi. Semua jalur baca isi lewat redactPerson (V2).
//
// Buat pohon (PRD A3, P1-1): satu batch membuat pohon, keanggotaan Owner, profil pertama (si pembuat), tautan akun-profil
// dan audit. Kuota (accounts.tree_quota, bawaan 1) dijaga DI DALAM pernyataan pertama, jadi dua permintaan yang berbalapan
// tidak bisa melewati kuota; pernyataan berikutnya hanya jalan bila pohonnya benar-benar terbentuk.

import { countManagers, forTree, getMembership } from './db.js';
import { can, isBootstrap } from './permissions.js';
import { redactPerson } from './privacy.js';
import { newId } from './audit.js';

export const MAX_TREE_NAME = 100;
export const MAX_PERSON_NAME = 200;

const fail = (code) => ({ ok: false, code });
const chars = (s) => [...s].length;
const GENDERS = ['male', 'female'];

export async function createTree(db, { accountId, name, selfName, selfGender = null }) {
  const tn = typeof name === 'string' ? name.trim() : '';
  if (!tn) return fail('name_required');
  if (chars(tn) > MAX_TREE_NAME) return fail('name_too_long');
  const sn = typeof selfName === 'string' ? selfName.trim() : '';
  if (!sn) return fail('self_name_required');
  if (chars(sn) > MAX_PERSON_NAME) return fail('self_name_too_long');
  if (selfGender !== null && !GENDERS.includes(selfGender)) return fail('invalid_gender');
  const acc = await db.prepare('SELECT id FROM accounts WHERE id = ?1').bind(accountId ?? '').first();
  if (!acc) return fail('forbidden');

  const treeId = newId();
  const personId = newId();
  const t = forTree(db, treeId);
  const made = 'EXISTS (SELECT 1 FROM family_trees WHERE id = ?1 AND created_by = ?2)';
  const res = await db.batch([
    db
      .prepare(
        'INSERT INTO family_trees (id, name, created_by) SELECT ?1, ?2, ?3 WHERE (SELECT COUNT(*) FROM family_trees WHERE created_by = ?3) < (SELECT tree_quota FROM accounts WHERE id = ?3)'
      )
      .bind(treeId, tn, accountId),
    t.stmt(
      `INSERT INTO memberships (tree_id, account_id, role, status) SELECT ?1, ?2, 'owner', 'active' WHERE ${made}`,
      [accountId]
    ),
    t.stmt(
      `INSERT INTO people (id, tree_id, display_name, gender, created_by) SELECT ?3, ?1, ?4, ?5, ?2 WHERE ${made}`,
      [accountId, personId, sn, selfGender]
    ),
    t.stmt(
      `INSERT INTO account_person_links (tree_id, account_id, person_id, status) SELECT ?1, ?2, ?3, 'active' WHERE ${made}`,
      [accountId, personId]
    ),
    t.stmt(
      `INSERT INTO audit_events (id, tree_id, actor_id, action, target_type, target_id, after_json) SELECT ?3, ?1, ?2, 'tree.create', 'tree', ?1, ?4 WHERE ${made}`,
      [accountId, newId(), JSON.stringify({ name: tn, selfPersonId: personId })]
    ),
  ]);
  if (res[0].meta.changes !== 1) return fail('tree_limit');
  return { ok: true, treeId, personId, name: tn };
}

export async function listTrees(db, accountId) {
  const { results } = await db
    .prepare(
      "SELECT t.id, t.name, m.role FROM memberships m JOIN family_trees t ON t.id = m.tree_id WHERE m.account_id = ?1 AND m.status = 'active' ORDER BY t.created_at, t.id"
    )
    .bind(accountId ?? '')
    .all();
  return results.map((r) => ({ id: r.id, name: r.name, role: r.role }));
}

// Konteks penonton untuk redactPerson. Wali belum didefinisikan sebagai data (V4): himpunan kosong.
export async function viewerOf(t, role, accountId) {
  const link = await t.first("SELECT person_id FROM account_person_links WHERE tree_id = ?1 AND account_id = ?2 AND status = 'active'", [accountId]);
  return { role, selfPersonId: link?.person_id ?? null, guardianOfIds: new Set() };
}

// Isi pohon untuk anggota aktif. Relasi dan pasangan dibaca SEBELUM orang (orang hanya bertambah), seperti ekspor.
export async function readTree(db, { treeId, accountId, now = new Date() }) {
  const m = await getMembership(db, treeId, accountId);
  if (!m || !can(m.role, 'tree.read')) return fail('forbidden');
  const t = forTree(db, treeId);
  const edges = await t.all(
    'SELECT id, parent_id, child_id, relation_type, parent_role FROM parent_child_edges WHERE tree_id = ?1 ORDER BY id'
  );
  const partners = await t.all(
    'SELECT id, person_a, person_b, status, start_year, end_year FROM partnerships WHERE tree_id = ?1 ORDER BY id'
  );
  const rows = await t.all('SELECT * FROM people WHERE tree_id = ?1 AND archived_at IS NULL ORDER BY created_at, id');
  const viewer = await viewerOf(t, m.role, accountId);
  const tree = await db.prepare('SELECT name FROM family_trees WHERE id = ?1').bind(treeId).first();
  const c = await countManagers(db, treeId);
  const people = rows.map((r) => {
    const p = redactPerson(r, viewer, now);
    return {
      id: p.id, name: p.name, nickname: p.nickname, gender: p.gender, confirmation: p.confirmation,
      isPlaceholder: p.isPlaceholder, placeholderOf: r.placeholder_of ?? null, birth: p.birth, death: p.death,
    };
  });
  const ids = new Set(people.map((p) => p.id));
  return {
    ok: true,
    tree: { id: treeId, name: tree?.name ?? '' },
    role: m.role,
    bootstrap: isBootstrap({ owners: c.owner, admins: c.admin }),
    me: viewer.selfPersonId && ids.has(viewer.selfPersonId) ? viewer.selfPersonId : null,
    people,
    // relasi yang menunjuk orang yang tidak ikut (diarsipkan) tidak dikirim, supaya klien tidak menerima rujukan menggantung
    parentChild: edges
      .filter((e) => ids.has(e.parent_id) && ids.has(e.child_id))
      .map((e) => ({ id: e.id, parent: e.parent_id, child: e.child_id, type: e.relation_type, role: e.parent_role })),
    partnerships: partners
      .filter((p) => ids.has(p.person_a) && ids.has(p.person_b))
      .map((p) => ({ id: p.id, a: p.person_a, b: p.person_b, status: p.status, startYear: p.start_year ?? null, endYear: p.end_year ?? null })),
  };
}
