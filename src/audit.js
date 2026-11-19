// Penulis audit log. Append-only: modul ini sengaja hanya punya INSERT, tanpa fungsi ubah atau hapus.

export const newId = () => crypto.randomUUID();

// Format sama dengan datetime('now') di SQLite: "YYYY-MM-DD HH:MM:SS" (UTC), supaya perbandingan teks benar.
export const sqlTime = (d = new Date()) => d.toISOString().slice(0, 19).replace('T', ' ');

const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));

// Pernyataan INSERT untuk dimasukkan ke db.batch(), supaya atomik dengan perubahan yang dicatat.
// `t` adalah hasil forTree(db, treeId).
export function auditStmt(t, e) {
  return t.stmt(
    'INSERT INTO audit_events (id, tree_id, actor_id, action, target_type, target_id, before_json, after_json, approval_note) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9)',
    [
      newId(),
      e.actorId ?? null,
      e.action,
      e.targetType ?? null,
      e.targetId ?? null,
      json(e.before),
      json(e.after),
      e.note ?? null,
    ]
  );
}

// Untuk peristiwa yang berdiri sendiri (tidak ada perubahan data lain yang harus atomik dengannya).
export const writeAudit = (t, e) => auditStmt(t, e).run();
