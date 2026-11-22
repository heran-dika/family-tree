import { handleApi } from './api.js';
import { handleAuth } from './auth.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === '/api/health') {
      try {
        const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM family_trees').first();
        return json({ ok: true, trees: row.n });
      } catch (e) {
        return json({ ok: false, error: 'DB_BELUM_SIAP', hint: 'Jalankan migrations/0001_init.sql di D1 Console' }, 500);
      }
    }

    const auth = await handleAuth(request, env);
    if (auth) return auth;

    const api = await handleApi(request, env);
    if (api) return api;

    return json({ error: 'not_found' }, 404);
  },
};
