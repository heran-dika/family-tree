import { test } from 'node:test'; import assert from 'node:assert/strict';
import { freshDb } from './helpers/d1.mjs'; import { decideJoinRequest } from '../src/access.js'; import { listMembers } from '../src/members.js';
test('alasan tolak + sesi', async () => {
  const e = freshDb(); const now = new Date('2026-11-25T00:00:00Z');
  e.sqlite.exec(`INSERT INTO accounts(id,email,email_verified,display_name) VALUES ('o','o@x',1,'Own'),('a','a@x',1,'Ani'); INSERT INTO family_trees(id,name,created_by) VALUES ('t','T','o'); INSERT INTO memberships(tree_id,account_id,role,status) VALUES ('t','o','owner','active'),('t','a','viewer','active'); INSERT INTO join_requests(id,tree_id,account_id) VALUES ('r1','t','a'); INSERT INTO sessions(id,account_id,expires_at) VALUES ('s1','a','2026-12-20 10:00:00'),('s2','a','2026-12-25 11:30:00'),('s3','o','2026-01-01 00:00:00')`);
  const d = (reason) => decideJoinRequest(e.db, { treeId:'t', requestId:'r1', deciderId:'o', action:'reject', reason, now });
  assert.equal((await d(undefined)).code, 'reason_required'); assert.equal((await d('  ')).code, 'reason_required'); assert.equal((await d('x'.repeat(301))).code, 'reason_too_long');
  assert.equal(e.sqlite.prepare("select status from join_requests where id='r1'").get().status, 'pending');
  assert.equal((await d(' Belum kenal ')).ok, true);
  const r = e.sqlite.prepare("select status,reason from join_requests where id='r1'").get(); assert.deepEqual([r.status, r.reason], ['rejected','Belum kenal']);
  assert.match(e.sqlite.prepare("select after_json a from audit_events where action='member.join_reject'").get().a, /Belum kenal/);
  const l = await listMembers(e.db, { treeId:'t', actorId:'o', now });
  assert.deepEqual(l.members.map(m => [m.name, m.sessionExpiresAt]), [['Own', null], ['Ani', '2026-12-25T11:30:00Z']]);
  assert.equal((await listMembers(e.db, { treeId:'t', actorId:'a', now })).code, 'forbidden');
});
