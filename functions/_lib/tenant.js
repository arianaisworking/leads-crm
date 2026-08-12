// functions/_lib/tenant.js
// Single source of truth for "which client is this?" and "am I allowed to see it?"
// RULE: nothing in the app queries leads/notes/conversations/messages without a
// client_id filter. Use these helpers instead of hand-writing WHERE clauses.

export async function getClientById(db, clientId) {
  if (!clientId) return null;
  return await db
    .prepare('SELECT * FROM clients WHERE id = ?')
    .bind(clientId)
    .first();
}

// Inbound Twilio webhook: resolve the tenant from the number the lead texted.
// One webhook URL for every client - never one URL per client.
export async function getClientByNumber(db, e164) {
  if (!e164) return null;
  return await db
    .prepare('SELECT * FROM clients WHERE twilio_number = ?')
    .bind(e164)
    .first();
}

// Pulls /c/:clientId/... or ?client_id= out of the request.
export function clientIdFromRequest(request) {
  const url = new URL(request.url);
  const m = url.pathname.match(/\/c\/([a-z0-9-]+)/i);
  if (m) return m[1];
  return url.searchParams.get('client_id') || null;
}

// Guard for every tenant-scoped API route.
// Usage:  const { client, error } = await requireClient(context);
//         if (error) return error;
export async function requireClient(context) {
  const { request, env } = context;
  const id = clientIdFromRequest(request);
  if (!id) {
    return { error: json({ error: 'client_id required' }, 400) };
  }
  const client = await getClientById(env.DB, id);
  if (!client) {
    return { error: json({ error: 'unknown client' }, 404) };
  }
  return { client };
}

// Every tenant-scoped SELECT goes through here so the filter can't be forgotten.
export function scoped(db, sql, clientId, ...params) {
  if (!/client_id\s*=\s*\?/.test(sql)) {
    throw new Error('scoped(): query is missing a client_id = ? filter');
  }
  return db.prepare(sql).bind(clientId, ...params);
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function uid(prefix = '') {
  return prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
}

// --- phone + time helpers -------------------------------------------------

export function toE164(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  if (String(raw).startsWith('+')) return String(raw);
  return null;
}

// Current hour in an IANA timezone, without pulling in a date library.
export function hourInTz(tz, when = new Date()) {
  const s = new Intl.DateTimeFormat('en-US', {
    timeZone: tz || 'America/Chicago',
    hour: 'numeric',
    hour12: false,
  }).format(when);
  return parseInt(s, 10);
}

export function dayInTz(tz, when = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(when); // YYYY-MM-DD
}

// Quiet hours are a compliance line, not a preference. Never send outside them.
export function withinSendWindow(client, when = new Date()) {
  const h = hourInTz(client.timezone, when);
  return h >= (client.send_window_start ?? 9) && h < (client.send_window_end ?? 19);
}

export async function isOptedOut(db, clientId, phone) {
  const row = await db
    .prepare(
      "SELECT 1 AS x FROM opt_outs WHERE phone = ? AND (client_id = ? OR client_id = '*') LIMIT 1"
    )
    .bind(phone, clientId)
    .first();
  return !!row;
}

export async function logEvent(db, clientId, kind, refId, detail) {
  await db
    .prepare('INSERT INTO events (id, client_id, kind, ref_id, detail) VALUES (?,?,?,?,?)')
    .bind(uid('ev_'), clientId, kind, refId || null, typeof detail === 'string' ? detail : JSON.stringify(detail || {}))
    .run();
}

export async function bumpLedger(db, clientId, tz, field, n = 1) {
  const day = dayInTz(tz);
  await db.prepare('INSERT OR IGNORE INTO send_ledger (client_id, day) VALUES (?,?)').bind(clientId, day).run();
  await db.prepare(`UPDATE send_ledger SET ${field} = ${field} + ? WHERE client_id = ? AND day = ?`)
    .bind(n, clientId, day).run();
}
