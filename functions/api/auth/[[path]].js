// functions/api/auth/[[path]].js
// Auth routes (exempt from the session gate in _middleware.js):
//   GET  /api/auth/me          -> current user, or { needsBootstrap } / 401
//   POST /api/auth/bootstrap   -> create the FIRST admin (only when no users exist)
//   POST /api/auth/login       -> { email, password }
//   POST /api/auth/logout
//   GET  /api/auth/users       -> list logins (team only)
//   POST /api/auth/users       -> create a login (team only)
//   DELETE /api/auth/users/:id -> remove a login (team only)

import { json, uid } from '../../_lib/tenant.js';
import {
  hashPassword, verifyPassword, makeToken, sessionCookie, clearCookie, readSession,
} from '../../_lib/auth.js';

function pub(u) { return { id: u.id, email: u.email, role: u.role, client_id: u.client_id, name: u.name }; }
function setCookie(body, token, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'Set-Cookie': sessionCookie(token) },
  });
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const db = env.DB;
  const seg = params.path || [];
  const action = seg[0];
  const method = request.method;

  const userCount = async () => {
    const r = await db.prepare('SELECT COUNT(*) AS n FROM users').first().catch(() => ({ n: 0 }));
    return r ? r.n : 0;
  };

  if (action === 'me' && method === 'GET') {
    const sess = await readSession(context);
    if (!sess) {
      const n = await userCount();
      return json({ authenticated: false, needsBootstrap: n === 0 }, n === 0 ? 200 : 401);
    }
    const u = await db.prepare('SELECT * FROM users WHERE id=?').bind(sess.uid).first();
    if (!u) return json({ authenticated: false }, 401);
    return json({ authenticated: true, user: pub(u) });
  }

  if (action === 'bootstrap' && method === 'POST') {
    if (await userCount() > 0) return json({ error: 'already set up' }, 403);
    const b = await request.json().catch(() => ({}));
    if (!b.email || !b.password) return json({ error: 'email and password required' }, 400);
    const { salt, hash } = await hashPassword(b.password);
    const id = uid('u_');
    await db.prepare('INSERT INTO users (id, email, password_hash, password_salt, role, name) VALUES (?,?,?,?,?,?)')
      .bind(id, b.email.toLowerCase().trim(), hash, salt, 'team', b.name || null).run();
    const token = await makeToken(env, { id, role: 'team', client_id: null });
    return setCookie({ ok: true, user: { id, email: b.email, role: 'team', name: b.name } }, token);
  }

  if (action === 'login' && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const u = await db.prepare('SELECT * FROM users WHERE email=?').bind((b.email || '').toLowerCase().trim()).first();
    if (!u || !(await verifyPassword(b.password || '', u.password_salt, u.password_hash))) {
      return json({ error: 'Wrong email or password.' }, 401);
    }
    const token = await makeToken(env, u);
    return setCookie({ ok: true, user: pub(u) }, token);
  }

  if (action === 'logout' && method === 'POST') {
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json', 'Set-Cookie': clearCookie() },
    });
  }

  // ---- user management (team only) ----
  if (action === 'users') {
    const sess = await readSession(context);
    if (!sess || sess.role !== 'team') return json({ error: 'forbidden' }, 403);

    if (method === 'GET') {
      const { results } = await db.prepare('SELECT id, email, role, client_id, name, created_at FROM users ORDER BY created_at').all();
      return json({ users: results || [] });
    }
    if (method === 'POST') {
      const b = await request.json().catch(() => ({}));
      if (!b.email || !b.password) return json({ error: 'email and password required' }, 400);
      const role = b.role === 'client' ? 'client' : 'team';
      if (role === 'client' && !b.client_id) return json({ error: 'client login needs a client_id' }, 400);
      const dupe = await db.prepare('SELECT id FROM users WHERE email=?').bind(b.email.toLowerCase().trim()).first();
      if (dupe) return json({ error: 'that email already has a login' }, 400);
      const { salt, hash } = await hashPassword(b.password);
      const id = uid('u_');
      await db.prepare('INSERT INTO users (id, email, password_hash, password_salt, role, client_id, name) VALUES (?,?,?,?,?,?,?)')
        .bind(id, b.email.toLowerCase().trim(), hash, salt, role, role === 'client' ? b.client_id : null, b.name || null).run();
      return json({ ok: true, id });
    }
    if (method === 'DELETE') {
      const targetId = seg[1];
      if (!targetId) return json({ error: 'id required' }, 400);
      if (targetId === sess.uid) return json({ error: "you can't delete your own login" }, 400);
      await db.prepare('DELETE FROM users WHERE id=?').bind(targetId).run();
      return json({ ok: true });
    }
  }

  return json({ error: 'not found' }, 404);
}
