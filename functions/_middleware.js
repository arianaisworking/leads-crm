// functions/_middleware.js
// Gates the API behind a session. Static assets (index.html) are served
// without middleware, so the app shell loads and then authenticates via /api.
//
// Exemptions:
//   /api/auth/*  -> login/bootstrap/logout/me
//   /api/apply/* -> public driver application (token- or carrier-scoped)
//   /api/cron/*  -> follow-up nudge pass (self-authenticated: x-cron-key)
//   /api/sms/*   -> Twilio inbound webhook + cron tick (self-authenticated:
//                   Twilio signature / x-cron-key)
//
// Client-role logins are confined to read-only reports for their own tenant.
//
// Public marketing hosts (truckerandtrokeros.com) share this deployment so the
// site's form can post to the same API with no CORS and no second project. On
// those hostnames "/" serves the driver-facing site instead of the CRM shell —
// the CRM stays reachable on the pages.dev host and any admin domain.

import { readSession } from './_lib/auth.js';
import { json } from './_lib/tenant.js';

// hostname -> the page "/" should serve
const PUBLIC_SITES = {
  'truckerandtrokeros.com': '/drive.html',
  'www.truckerandtrokeros.com': '/drive.html',
};

export async function onRequest(context) {
  const { request, next } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // Public site hosts never expose the CRM shell at the root.
  const site = PUBLIC_SITES[url.hostname.toLowerCase()];
  if (site && (path === '/' || path === '/index.html')) {
    return next(new Request(new URL(site, url), request));
  }

  if (!path.startsWith('/api/')) return next();
  if (path.startsWith('/api/auth/') || path.startsWith('/api/sms/') || path.startsWith('/api/intake/') || path.startsWith('/api/capture/') || path.startsWith('/api/apply/') || path.startsWith('/api/cron/')) return next();

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
