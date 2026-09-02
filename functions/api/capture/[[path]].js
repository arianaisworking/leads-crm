// functions/api/capture/[[path]].js
// PUBLIC (exempt from the auth gate in _middleware.js). Website contact/interest
// forms POST here to drop a new lead straight into the CRM for THIS deployment's
// database (e.g. mxncells.com -> aiw-patients, thenetworkboss.com -> aiw-crm).
//
//   POST /api/capture/lead   { name, phone, email, interest, location, message, source,
//                              availability?: { dates, time, tz }, _hp }
//
// `location` and `message` need migration-003 columns. On a database where that
// migration has not run, the insert falls back to the old column layout instead
// of failing, so no lead is ever lost mid-rollout.
//
// CORS is open so the form can live on a separate site/origin. Spam is filtered
// with a honeypot field (_hp): if it's filled we return ok but store nothing.
//
// A saved lead also sends the team a heads-up email. The mail deliberately
// carries who got in touch and how to reach them, not what they said about
// their health: the free text and the area of interest stay in the CRM, behind
// a login, rather than being copied into an inbox. The send is fire-and-forget
// via waitUntil so a mail outage can never cost us the lead.

import { json } from '../../_lib/tenant.js';
import { sendEmail, emailShell, teamEmail, brandName, esc } from '../../_lib/email.js';

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
  // When a form asks when to call, it lands in the same questionnaire keys the
  // intake document, the doctor email and the patient view already read, so a
  // coordinator can propose a real time on the first reply.
  const av = b.availability && typeof b.availability === 'object' ? b.availability : {};
  const avail = {};
  if (av.dates) avail.avail_dates = String(av.dates).trim().slice(0, 200);
  if (av.time) avail.avail_time = String(av.time).trim().slice(0, 80);
  if (av.tz) avail.avail_tz = String(av.tz).trim().slice(0, 80);
  if (phone) avail.avail_phone = phone;

  if (!name) return reply({ error: 'Please enter your name.' }, 400);
  if (!phone && !email) return reply({ error: 'Please enter a phone number or email.' }, 400);

  try {
    const r = await env.DB.prepare(
      `INSERT INTO leads (name, phone, email, interest, preferred_location, message, source, status, client_id, acquisition_date, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?, 'New', 'house', date('now'), datetime('now'), datetime('now'))`
    ).bind(name, phone, email, interest, location, message, source).run();
    await saveAvailability(env, r.meta.last_row_id, avail);
    notify(context, { id: r.meta.last_row_id, name, phone, email, location, source, avail });
    return reply({ ok: true, id: r.meta.last_row_id });
  } catch (e) {
    // This same code is deployed against several databases (one per tenant), and
    // migration-003 may not have run on all of them yet. Rather than drop the
    // lead, fall back to the pre-003 column set: message goes back into
    // `signals`, and the location is appended to `interest` so it still lands
    // somewhere a human will read. Any other failure is a real error.
    if (!/no such column/i.test(String(e && e.message))) {
      return reply({ error: 'Could not save. Please try again.' }, 500);
    }
    try {
      const legacyInterest = [interest, location].filter(Boolean).join(' \u00b7 ') || null;
      const r = await env.DB.prepare(
        `INSERT INTO leads (name, phone, email, interest, signals, source, status, client_id, acquisition_date, created_at, updated_at)
         VALUES (?,?,?,?,?,?, 'New', 'house', date('now'), datetime('now'), datetime('now'))`
      ).bind(name, phone, email, legacyInterest, message, source).run();
      await saveAvailability(env, r.meta.last_row_id, avail);
      notify(context, { id: r.meta.last_row_id, name, phone, email, location, source, avail });
      return reply({ ok: true, id: r.meta.last_row_id, degraded: true });
    } catch (e2) {
      return reply({ error: 'Could not save. Please try again.' }, 500);
    }
  }
}

// Written separately from the insert on purpose. `questionnaire` exists on the
// patients database but not on every tenant's, and a lead that is already saved
// must not fail because this extra could not be stored.
async function saveAvailability(env, id, avail) {
  if (!id || !Object.keys(avail).length) return;
  try {
    await env.DB.prepare('UPDATE leads SET questionnaire=? WHERE id=?')
      .bind(JSON.stringify(avail), id).run();
  } catch {
    /* tenant without the column: availability is a bonus, never the lead */
  }
}

// Team heads-up. Never awaited by the request: a lead that is safely in the
// database must not fail because a mail provider is having a bad morning.
function notify(context, lead) {
  const { env, request } = context;
  const brand = brandName(env);
  const reach = [lead.email, lead.phone].filter(Boolean).join(' · ') || 'no contact given';
  // Default to this deployment's own origin, never a hard-coded one. The same
  // code serves several brands from separate Pages projects, and a fixed URL
  // here would send one brand's team into another brand's CRM.
  const base = (env.CRM_URL || new URL(request.url).origin).replace(/\/+$/, '');
  // The patients app opens the record straight from this hash. The other CRMs
  // have no hash routing, so they ignore it and land on the dashboard.
  const crmUrl = lead.id ? `${base}/#patient=${lead.id}` : base;
  const a = lead.avail || {};
  const when = [a.avail_dates, a.avail_time].filter(Boolean).join(', ');
  const rows = [
    ['Name', lead.name],
    ['Reach them at', reach],
    ['Best time to reach them', when ? when + (a.avail_tz ? ` (${a.avail_tz})` : '') : 'Not specified'],
    ['Preferred location', lead.location || 'Not specified'],
    ['Came from', lead.source],
  ].map(([k, v]) =>
    `<tr><td style="padding:6px 0;color:#8a95a6;font-size:13px;width:150px">${esc(k)}</td>
         <td style="padding:6px 0;font-size:14px;font-weight:600">${esc(v)}</td></tr>`).join('');

  const html = emailShell(`New enquiry: ${lead.name}`, `
    <h2 style="margin:0 0 4px;font-size:18px">New enquiry from the website</h2>
    <p style="margin:0 0 18px;color:#5b6873;font-size:14px">
      Their area of interest and anything they wrote is on the record in the CRM.</p>
    <table style="width:100%;border-collapse:collapse">${rows}</table>
    <p style="margin:22px 0 0">
      <a href="${crmUrl}" style="background:#0f1b2d;color:#fff;text-decoration:none;
         padding:11px 18px;border-radius:8px;font-size:14px;display:inline-block">Open in the CRM</a></p>`, brand);

  const text = `New enquiry from the website\n\n`
    + `Name: ${lead.name}\nReach them at: ${reach}\n`
    + `Best time to reach them: ${when ? when + (a.avail_tz ? ` (${a.avail_tz})` : '') : 'Not specified'}\n`
    + `Preferred location: ${lead.location || 'Not specified'}\nCame from: ${lead.source}\n\n`
    + `Their area of interest and anything they wrote is in the CRM: ${crmUrl}`;

  const send = sendEmail(env, {
    to: teamEmail(env),
    subject: `New enquiry: ${lead.name}`,
    html,
    text,
    // Hitting reply on the notification writes to the person who enquired,
    // not back to our own sending address.
    replyTo: lead.email || undefined,
  }).catch(() => {});
  if (context.waitUntil) context.waitUntil(send);
}
