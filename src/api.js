// Endpoint pohon. Semua butuh sesi. Metode yang mengubah data wajib: Origin sama dengan situs (CSRF; cookie SameSite=Lax saja
// tidak cukup untuk ini), dan isi JSON. Respons selalu no-store.
//   GET  /api/trees                       daftar pohon akun ini
//   POST /api/trees                       { name, selfName, selfGender? } buat pohon + profil pertama
//   GET  /api/trees/:id                   isi pohon (lewat filter privasi)
//   POST /api/trees/:id/changes           { kind, targetPersonId?, after } terapkan langsung (Admin/Owner; relasi hanya di Mode Penyusunan Awal)
//   GET  /api/trees/:id/duplicates?name=&birth_year=
//   GET  /api/trees/:id/export            berkas JSON (Owner/Admin), tercatat di audit
// Usulan (Contributor, atau relasi saat sudah ada Admin kedua) BELUM tersambung: perubahan seperti itu dijawab 409 needs_proposal.

import { getSession } from './auth.js';
import { applyDirect } from './apply.js';
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

const NOT_FOUND = ['not_found', 'target_not_found', 'person_not_found', 'partnership_not_found', 'edge_not_found'];
const CONFLICT = ['tree_limit', 'needs_proposal', 'duplicate_partnership', 'duplicate_edge', 'would_create_cycle', 'blocked_bootstrap'];
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

export async function handleApi(request, env, { now = new Date() } = {}) {
  const url = new URL(request.url);
  const m = /^\/api\/trees(?:\/([^/]+)(?:\/(changes|duplicates|export))?)?$/.exec(url.pathname);
  if (!m) return null;
  const [, id, sub] = m;
  const method = request.method;
  const allowed = id === undefined ? ['GET', 'POST'] : sub === 'changes' ? ['POST'] : sub ? ['GET'] : ['GET'];
  if (!allowed.includes(method)) return json({ error: 'method_not_allowed' }, 405, { allow: allowed.join(', ') });

  const me = await getSession(env.DB, request, now);
  if (!me) return json({ error: 'unauthorized' }, 401);
  if (method !== 'GET' && request.headers.get('origin') !== url.origin) return json({ ok: false, code: 'forbidden' }, 403);

  if (id === undefined) {
    if (method === 'GET') return json({ trees: await listTrees(env.DB, me.id) });
    const b = await body(request);
    if (b.bad) return json({ ok: false, code: b.bad }, b.status);
    const r = await createTree(env.DB, { accountId: me.id, name: b.v.name, selfName: b.v.selfName, selfGender: b.v.selfGender ?? null });
    return r.ok ? json({ ok: true, tree: { id: r.treeId, name: r.name }, personId: r.personId }, 201) : fail(r);
  }
  // id yang bukan UUID tidak pernah menyentuh database
  if (!ID.test(id)) return json({ ok: false, code: 'not_found' }, 404);

  if (!sub) {
    const r = await readTree(env.DB, { treeId: id, accountId: me.id, now });
    return r.ok ? json(r) : fail(r);
  }
  if (sub === 'changes') {
    const b = await body(request);
    if (b.bad) return json({ ok: false, code: b.bad }, b.status);
    const { kind, targetPersonId = null, after } = b.v;
    if (typeof kind !== 'string' || (targetPersonId !== null && typeof targetPersonId !== 'string')) return json({ ok: false, code: 'invalid_payload' }, 400);
    const r = await applyDirect(env.DB, { treeId: id, actorId: me.id, kind, targetPersonId, after, now });
    return r.ok ? json(r) : fail(r);
  }
  if (sub === 'duplicates') {
    const by = url.searchParams.get('birth_year');
    const r = await findDuplicates(env.DB, {
      treeId: id, actorId: me.id, name: url.searchParams.get('name') ?? '', birthYear: by ? Number(by) : null, now,
    });
    return r.ok ? json(r) : fail(r);
  }
  const r = await exportTree(env.DB, { treeId: id, actorId: me.id, now });
  if (!r.ok) return fail(r);
  return new Response(JSON.stringify(r.doc), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-disposition': `attachment; filename="family-tree-${id.slice(0, 8)}.json"`,
    },
  });
}
