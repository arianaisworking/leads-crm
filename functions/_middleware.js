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
// Public marketing hosts (truckersandtrokeros.com) share this deployment so the
// site's form can post to the same API with no CORS and no second project. On
// those hostnames "/" serves the driver-facing site instead of the CRM shell —
// the CRM stays reachable on the pages.dev host and any admin domain.

import { readSession } from './_lib/auth.js';
import { json } from './_lib/tenant.js';

// hostname -> the page "/" should serve
const PUBLIC_SITES = {
  'truckersandtrokeros.com': '/drive.html',
  'www.truckersandtrokeros.com': '/drive.html',
};

export async function onRequest(context) {
  const { request, next } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // Public site hosts never expose the CRM shell at the root.
  //
  // /es is a real URL, not just a toggle. Half this audience finds us through a
  // link forwarded in a WhatsApp or Facebook group, and a link that opens in
  // English for a Spanish speaker is a link that gets closed. Same page either
  // way — the page reads the path and paints itself in that language.
  const site = PUBLIC_SITES[url.hostname.toLowerCase()];
  if (site) {
    // Only rewrite what Pages can't serve on its own.
    //
    // Pages already serves drivers.html at /drivers — and redirects
    // /drivers.html back to /drivers. So rewriting a clean path to the .html
    // file sends the browser a redirect straight back to the path we just
    // rewrote: an infinite loop, and a page that never loads. Clean paths are
    // therefore left alone, and the two cases that genuinely need help map to
    // clean paths as well, never to a .html:
    //
    //   /                  -> /drive   (bare / would serve the CRM shell)
    //   /es, /pa           -> /drive
    //   /es/drivers, /pa/… -> /drivers (no such file exists to serve)
    //
    // Each page reads the language out of the path it was requested under.
    const PAGES = ['drivers', 'carriers', 'about', 'refer', 'join', 'privacy', 'terms'];
    const LANGS = ['es', 'pa'];
    const langPrefix = new RegExp('^/(' + LANGS.join('|') + ')(?=/|$)');

    if (path === '/' || path === '/index.html') {
      return next(new Request(new URL('/drive', url), request));
    }
    if (langPrefix.test(path)) {
      const rest = path.replace(langPrefix, '').replace(/^\/|\/$/g, '');
      if (!rest) return next(new Request(new URL('/drive', url), request));
      if (PAGES.includes(rest)) return next(new Request(new URL('/' + rest, url), request));
    }
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
