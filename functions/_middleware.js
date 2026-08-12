// functions/_middleware.js
// Gates the API behind a session. Static assets (index.html) are served
// without middleware, so the app shell loads and then authenticates via /api.
//
// Exemptions:
//   /api/auth/*  -> login/bootstrap/logout/me
//   /api/sms/*   -> Twilio inbound webhook + cron tick (self-authenticated:
//                   Twilio signature / x-cron-key)
//
// Client-role logins are confined to read-only reports for their own tenant.

import { readSession } from './_lib/auth.js';
import { json } from './_lib/tenant.js';

export async function onRequest(context) {
  const { request, next } = context;
  const path = new URL(request.url).pathname;

  if (!path.startsWith('/api/')) return next();
  if (path.startsWith('/api/auth/') || path.startsWith('/api/sms/')) return next();

  const sess = await readSession(context);
  if (!sess) return json({ error: 'unauthorized' }, 401);

  if (sess.role === 'client') {
    const seg = path.split('/').filter(Boolean); // ['api','tenant',<cid>,<action>,...]
    const allowed = ['stats', 'inbox', 'thread', 'events'];
    const okTenant = seg[1] === 'tenant' && seg[2] === sess.cid;
    if (request.method !== 'GET' || !okTenant || !allowed.includes(seg[3])) {
      return json({ error: 'forbidden' }, 403);
    }
  }

  return next();
}
