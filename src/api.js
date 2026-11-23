// Endpoint pohon dan jalur bergabung. Semua butuh sesi. Metode yang mengubah data wajib: Origin sama dengan situs (CSRF; cookie
// SameSite=Lax saja tidak cukup untuk ini). Respons selalu no-store.
//   GET  /api/trees                                  daftar pohon akun ini
//   POST /api/trees                                  { name, selfName, selfGender? } buat pohon + profil pertama
//   GET  /api/trees/:id                              isi pohon (lewat filter privasi)
//   POST /api/trees/:id/changes                      { kind, targetPersonId?, after } terapkan langsung (Admin/Owner; relasi hanya di Mode Penyusunan Awal)
//   GET  /api/trees/:id/duplicates?name=&birth_year=
//   GET  /api/trees/:id/export                       berkas JSON (Owner/Admin), tercatat di audit
//   GET  /api/trees/:id/access-code                  { active, createdAt } (Owner)
//   POST /api/trees/:id/access-code                  buat kode baru, kode lama mati; kode mentah hanya dikembalikan sekali (Owner)
//   POST /api/trees/:id/access-code/revoke           cabut kode (Owner)
//   GET  /api/trees/:id/join-requests                permintaan bergabung menunggu (Owner/Admin)
//   POST /api/trees/:id/join-requests/:rid           { action: approve|reject, role?: viewer|contributor } (Owner/Admin)
//   POST /api/join/lookup                            { code } nama pohon + nama pengelola
//   POST /api/join                                   { code, message? } ajukan bergabung
//   GET  /api/join/mine                              permintaan menunggu milik akun ini
// Usulan (Contributor, atau relasi saat sudah ada Admin kedua) BELUM tersambung: perubahan seperti itu dijawab 409 needs_proposal.

import { getSession } from './auth.js';
import { applyDirect } from './apply.js';
import { accessCodeStatus, createAccessCode, decideJoinRequest, listJoinRequests, lookupAccessCode, myJoinRequests, requestJoin, revokeAccessCode } from './access.js';
import { findDuplicates } from './duplicates.js';
import { exportTree } from './export.js';
import { createTree, listTrees, readTree } from './trees.js';

export const MAX_BODY = 64 * 1024;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });

const NOT_FOUND = ['not_found', 'target_not_found', 'person_not_found', 'partnership_not_found', 'edge_not_found', 'invalid_code'];
const CONFLICT = [
  'tree_limit', 'needs_proposal', 'duplicate_partnership', 'duplicate_edge', 'would_create_cycle', 'blocked_bootstrap',
  'already_member', 'already_pending', 'too_many_pending', 'request_limit', 'join_failed', 'not_pending',
];
export const statusOf = (code) =>
  code === 'forbidden' ? 403 : NOT_FOUND.includes(code) ? 404 : CONFLICT.includes(code) ? 409 : 400;
const fail = (r) => json({ ok: false, code: r.code }, statusOf(r.code));

async function body(request) {
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/json\b/i.test(type)) return { bad: 'unsupported_media_type', status: 415 };
  const len = Number(request.headers.get('content-length'));
  if (Number.isFinite(len) && len > MAX_BODY) return { bad: 'payload_too_large', status: 413 };
  let text;
  try { text = await request.text(); } catch { return { bad: 'invalid_json', status: 400 }; }
  if (new TextEncoder().encode(text).length > MAX_BODY) return { bad: 'payload_too_large', status: 413 };
  try {
    const v = JSON.parse(text);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return { bad: 'invalid_json', status: 400 };
    return { v };
  } catch { return { bad: 'invalid_json', status: 400 }; }
}

// Tabel rute: [pola, metode yang diizinkan, nama]. Pola berisi segmen setelah /api.
const ROUTES = [
  [/^trees$/, ['GET', 'POST'], 'trees'],
  [/^trees\/([^/]+)$/, ['GET'], 'tree'],
  [/^trees\/([^/]+)\/changes$/, ['POST'], 'changes'],
  [/^trees\/([^/]+)\/duplicates$/, ['GET'], 'duplicates'],
  [/^trees\/([^/]+)\/export$/, ['GET'], 'export'],
  [/^trees\/([^/]+)\/access-code$/, ['GET', 'POST'], 'code'],
  [/^trees\/([^/]+)\/access-code\/revoke$/, ['POST'], 'revoke'],
  [/^trees\/([^/]+)\/join-requests$/, ['GET'], 'requests'],
  [/^trees\/([^/]+)\/join-requests\/([^/]+)$/, ['POST'], 'decide'],
  [/^join\/lookup$/, ['POST'], 'lookup'],
  [/^join\/mine$/, ['GET'], 'mine'],
  [/^join$/, ['POST'], 'join'],
];

export async function handleApi(request, env, { now = new Date() } = {}) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return null;
  const rest = url.pathname.slice(5);
  const hit = ROUTES.map(([re, methods, name]) => ({ m: re.exec(rest), methods, name })).find((x) => x.m);
  if (!hit) return null;
  const method = request.method;
  if (!hit.methods.includes(method)) return json({ error: 'method_not_allowed' }, 405, { allow: hit.methods.join(', ') });

  const me = await getSession(env.DB, request, now);
  if (!me) return json({ error: 'unauthorized' }, 401);
  if (method !== 'GET' && request.headers.get('origin') !== url.origin) return json({ ok: false, code: 'forbidden' }, 403);

  const [, id, rid] = hit.m;
  const db = env.DB;
  const reply = (r, ok = (x) => x, status = 200) => (r.ok ? json(ok(r), status) : fail(r));
  // butuh isi JSON: bacakan dulu supaya galat 415/413/400 seragam
  const needBody = async () => body(request);

  if (hit.name === 'trees') {
    if (method === 'GET') return json({ trees: await listTrees(db, me.id), pending: await myJoinRequests(db, me.id) });
    const b = await needBody();
    if (b.bad) return json({ ok: false, code: b.bad }, b.status);
    const r = await createTree(db, { accountId: me.id, name: b.v.name, selfName: b.v.selfName, selfGender: b.v.selfGender ?? null });
    return reply(r, (x) => ({ ok: true, tree: { id: x.treeId, name: x.name }, personId: x.personId }), 201);
  }
  if (hit.name === 'lookup' || hit.name === 'join') {
    const b = await needBody();
    if (b.bad) return json({ ok: false, code: b.bad }, b.status);
    if (hit.name === 'lookup') return reply(await lookupAccessCode(db, { code: b.v.code }), (x) => ({ ok: true, treeName: x.treeName, managers: x.managers }));
    return reply(await requestJoin(db, { code: b.v.code, accountId: me.id, message: b.v.message ?? null, now }), (x) => ({ ok: true, treeName: x.treeName }), 201);
  }
  if (hit.name === 'mine') return json({ requests: await myJoinRequests(db, me.id) });

  // id yang bukan UUID tidak pernah menyentuh database
  if (!ID.test(id)) return json({ ok: false, code: 'not_found' }, 404);

  switch (hit.name) {
    case 'tree': return reply(await readTree(db, { treeId: id, accountId: me.id, now }), (x) => x);
    case 'changes': {
      const b = await needBody();
      if (b.bad) return json({ ok: false, code: b.bad }, b.status);
      const { kind, targetPersonId = null, after } = b.v;
      if (typeof kind !== 'string' || (targetPersonId !== null && typeof targetPersonId !== 'string')) return json({ ok: false, code: 'invalid_payload' }, 400);
      return reply(await applyDirect(db, { treeId: id, actorId: me.id, kind, targetPersonId, after, now }), (x) => x);
    }
    case 'duplicates': {
      const by = url.searchParams.get('birth_year');
      return reply(await findDuplicates(db, { treeId: id, actorId: me.id, name: url.searchParams.get('name') ?? '', birthYear: by ? Number(by) : null, now }), (x) => x);
    }
    case 'export': {
      const r = await exportTree(db, { treeId: id, actorId: me.id, now });
      if (!r.ok) return fail(r);
      return new Response(JSON.stringify(r.doc), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-disposition': `attachment; filename="family-tree-${id.slice(0, 8)}.json"`,
        },
      });
    }
    case 'code':
      if (method === 'GET') return reply(await accessCodeStatus(db, { treeId: id, actorId: me.id }), (x) => ({ ok: true, active: x.active, createdAt: x.createdAt }));
      return reply(await createAccessCode(db, { treeId: id, actorId: me.id, now }), (x) => ({ ok: true, code: x.code }), 201);
    case 'revoke': return reply(await revokeAccessCode(db, { treeId: id, actorId: me.id, now }), () => ({ ok: true }));
    case 'requests': return reply(await listJoinRequests(db, { treeId: id, actorId: me.id }), (x) => ({ ok: true, requests: x.requests }));
    case 'decide': {
      if (!ID.test(rid)) return json({ ok: false, code: 'not_found' }, 404);
      const b = await needBody();
      if (b.bad) return json({ ok: false, code: b.bad }, b.status);
      return reply(await decideJoinRequest(db, { treeId: id, requestId: rid, deciderId: me.id, action: b.v.action, role: b.v.role ?? null, now }), (x) => ({ ok: true, status: x.status }));
    }
    default: return null;
  }
}
