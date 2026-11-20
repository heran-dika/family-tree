// D1 tiruan di atas node:sqlite (prepare/bind/first/all/run/batch) dan skema dari folder migrations.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export const MIGRATIONS = [
  '0001_init', '0002_people_gender', '0003_people_visibility_by_self',
  '0004_partnership_unique_pair', '0005_edge_unique_pair', '0006_invitations_flow',
];

export function fakeD1(sqlite) {
  const mk = (sql) => ({
    params: [],
    bind(...p) { this.params = p; return this; },
    async first() { return sqlite.prepare(sql).get(...this.params) ?? null; },
    async all() { return { results: sqlite.prepare(sql).all(...this.params) }; },
    async run() { const r = sqlite.prepare(sql).run(...this.params); return { success: true, meta: { changes: Number(r.changes) } }; },
  });
  return {
    prepare: mk,
    async batch(stmts) {
      sqlite.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        sqlite.exec('COMMIT');
        return out;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

export function freshDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const f of MIGRATIONS) sqlite.exec(readFileSync(new URL(`../../migrations/${f}.sql`, import.meta.url), 'utf8'));
  const count = (sql, ...p) => sqlite.prepare(sql).get(...p).n;
  return { sqlite, db: fakeD1(sqlite), count };
}
