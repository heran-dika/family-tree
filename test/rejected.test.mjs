import { test } from 'node:test'; import assert from 'node:assert/strict';
import { freshDb } from './helpers/d1.mjs'; import { myRejectedRequests } from '../src/access.js';
test('penolakan 7 hari terakhir, tersembunyi bila sudah mengajukan lagi atau lama', async () => {
  const e = freshDb(); const now = new Date('2026-11-25T00:00:00Z');
  e.sqlite.exec(`INSERT INTO accounts(id,email,email_verified) VALUES ('o','o@x',1),('a','a@x',1); INSERT INTO family_trees(id,name,created_by) VALUES ('t1','Satu','o'),('t2','Dua','o'),('t3','Tiga','o');
  INSERT INTO join_requests(id,tree_id,account_id,status,reason,decided_at,created_at) VALUES ('r1','t1','a','rejected','Belum kenal','2026-11-24 10:00:00','2026-11-23 10:00:00'),('r2','t2','a','rejected','Lama','2026-11-01 10:00:00','2026-10-31 10:00:00'),('r3','t3','a','rejected','Salah','2026-11-24 09:00:00','2026-11-23 09:00:00'),('r4','t3','a','pending',NULL,NULL,'2026-11-24 11:00:00')`);
  const r = await myRejectedRequests(e.db, 'a', now); assert.deepEqual(r.map(x => [x.treeName, x.reason]), [['Satu', 'Belum kenal']]);
  assert.deepEqual(await myRejectedRequests(e.db, 'o', now), []);
});
