// functions/api/capture/[[path]].js
// PUBLIC (exempt from the auth gate in _middleware.js). Website contact/interest
// forms POST here to drop a new lead straight into the CRM for THIS deployment's
// database (e.g. mxncells.com -> aiw-patients, thenetworkboss.com -> aiw-crm).
//
//   POST /api/capture/lead   { name, phone, email, interest, location, message, source, _hp }
//
// CORS is open so the form can live on a separate site/origin. Spam is filtered
// with a honeypot field (_hp): if it's filled we return ok but store nothing.

import { json } from '../../_lib/tenant.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Max-Age': '86400',
};

function reply(data, status = 200) {
  const r = json(data, status);
  for (const [k, v] of Object.entries(CORS)) r.headers.set(k, v);
  return r;
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const action = (params.path || [])[0];

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (action !== 'lead') return reply({ error: 'not found' }, 404);
  if (request.method !== 'POST') return reply({ error: 'method not allowed' }, 405);

  const b = await request.json().catch(() => ({}));

  // Honeypot: real people never fill a hidden field. Pretend success, store nothing.
  if (b._hp) return reply({ ok: true });

  const name = (b.name || '').toString().trim().slice(0, 200);
  const phone = (b.phone || '').toString().trim().slice(0, 40) || null;
  const email = (b.email || '').toString().trim().slice(0, 200) || null;
  const interest = (b.interest || '').toString().trim().slice(0, 300) || null;
  const message = (b.message || '').toString().trim().slice(0, 2000) || null;
  const source = (b.source || 'website').toString().trim().slice(0, 120);
  // Destination / office the visitor asked for. Accepts either key so a form can
  // send whichever reads better in its own markup.
  const location = (b.location || b.preferred_location || '').toString().trim().slice(0, 160) || null;

  if (!name) return reply({ error: 'Please enter your name.' }, 400);
  if (!phone && !email) return reply({ error: 'Please enter a phone number or email.' }, 400);

  try {
    const r = await env.DB.prepare(
      `INSERT INTO leads (name, phone, email, interest, preferred_location, message, source, status, client_id, acquisition_date, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?, 'New', 'house', date('now'), datetime('now'), datetime('now'))`
    ).bind(name, phone, email, interest, location, message, source).run();
    return reply({ ok: true, id: r.meta.last_row_id });
  } catch (e) {
    return reply({ error: 'Could not save. Please try again.' }, 500);
  }
}
