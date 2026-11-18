export async function getMembership(db, treeId, accountId) {
  return db
    .prepare(
      "SELECT role FROM memberships WHERE tree_id = ?1 AND account_id = ?2 AND status = 'active'"
    )
    .bind(treeId, accountId)
    .first();
}

export async function countManagers(db, treeId) {
  const rows = await db
    .prepare(
      "SELECT role, COUNT(*) AS n FROM memberships WHERE tree_id = ?1 AND status = 'active' AND role IN ('owner','admin') GROUP BY role"
    )
    .bind(treeId)
    .all();
  const counts = { owner: 0, admin: 0 };
  for (const r of rows.results) counts[r.role] = r.n;
  return counts;
}

export function forTree(db, treeId) {
  const stmt = (sql, params = []) => {
    if (!/\?1\b/.test(sql) || !/tree_id/.test(sql)) {
      throw new Error('QUERY_NOT_SCOPED: SQL harus memakai tree_id dan ?1');
    }
    return db.prepare(sql).bind(treeId, ...params);
  };
  return {
    stmt,
    all: async (sql, params) => (await stmt(sql, params).all()).results,
    first: (sql, params) => stmt(sql, params).first(),
    run: (sql, params) => stmt(sql, params).run(),
  };
}
