// Ekspor JSON pohon (PRD P1-4). Hanya Owner/Admin. Mengikuti privasi: setiap orang lewat redactPerson dengan
// konteks penonton si pengekspor, jadi berkas ini BUKAN backup penuh (tanggal lahir yang tersembunyi atau
// hanya-tahun tidak ada di dalamnya). Backup penuh = backup terenkripsi ke Drive, fitur terpisah.
// Setiap ekspor dicatat di audit log; tanpa catatan audit, berkas tidak dikembalikan.

import { forTree, getMembership } from './db.js';
import { can } from './permissions.js';
import { redactPerson } from './privacy.js';
import { writeAudit } from './audit.js';

export const EXPORT_FORMAT = 'family-tree-export';
export const EXPORT_VERSION = 1;

export async function exportTree(db, { treeId, actorId, now = new Date() }) {
  const m = await getMembership(db, treeId, actorId);
  if (!m || !can(m.role, 'export.run')) return { ok: false, code: 'forbidden' };
  const t = forTree(db, treeId);
  // Urutan baca penting: relasi dan varian DULU, orang TERAKHIR. Orang hanya bertambah (arsip, bukan hapus),
  // jadi relasi yang terbaca selalu menunjuk orang yang ada di berkas, walau ada penulisan di tengah ekspor.
  const variants = await t.all('SELECT person_id, variant FROM name_variants WHERE tree_id = ?1 ORDER BY person_id, variant');
  const edges = await t.all(
    'SELECT parent_id, child_id, relation_type, parent_role, custom_label FROM parent_child_edges WHERE tree_id = ?1 ORDER BY parent_id, child_id'
  );
  const partners = await t.all(
    'SELECT person_a, person_b, status, start_year, end_year FROM partnerships WHERE tree_id = ?1 ORDER BY person_a, person_b'
  );
  const people = await t.all('SELECT * FROM people WHERE tree_id = ?1 ORDER BY id');
  const link = await t.first("SELECT person_id FROM account_person_links WHERE tree_id = ?1 AND account_id = ?2 AND status = 'active'", [actorId]);
  const tree = await db.prepare('SELECT name FROM family_trees WHERE id = ?1').bind(treeId).first();
  const viewer = { role: m.role, selfPersonId: link?.person_id ?? null, guardianOfIds: new Set() };

  const doc = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now.toISOString(),
    tree: { name: tree?.name ?? '' },
    people: people.map((r) => {
      const p = redactPerson(r, viewer, now);
      return {
        id: p.id, name: p.name, nickname: p.nickname, gender: p.gender, confirmation: p.confirmation,
        sourceNote: p.sourceNote, isPlaceholder: p.isPlaceholder, placeholderOf: r.placeholder_of ?? null,
        archived: p.archived, birth: p.birth, death: p.death,
      };
    }),
    nameVariants: variants.map((v) => ({ person: v.person_id, variant: v.variant })),
    parentChild: edges.map((e) => ({ parent: e.parent_id, child: e.child_id, type: e.relation_type, role: e.parent_role, customLabel: e.custom_label ?? null })),
    partnerships: partners.map((p) => ({ a: p.person_a, b: p.person_b, status: p.status, startYear: p.start_year ?? null, endYear: p.end_year ?? null })),
  };
  await writeAudit(t, {
    actorId, action: 'export.run', targetType: 'tree', targetId: treeId,
    after: { people: doc.people.length, parentChild: doc.parentChild.length, partnerships: doc.partnerships.length },
  });
  return { ok: true, doc };
}
