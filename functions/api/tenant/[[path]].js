// functions/api/tenant/[[path]].js
// Tenant-scoped API. Every read filters on client_id via scoped().
// Routes:
//   GET  /api/tenant/clients
//   POST /api/tenant/clients                     { id, name, ... }
//   GET  /api/tenant/:clientId/inbox             needs-human first
//   GET  /api/tenant/:clientId/thread/:convId
//   POST /api/tenant/:clientId/takeover/:convId  { paused: true|false }
//   POST /api/tenant/:clientId/reply/:convId     { body }
//   POST /api/tenant/:clientId/pause             { paused: true|false }  KILL SWITCH
//   GET  /api/tenant/:clientId/stats

import { getClientById, scoped, json, uid, logEvent, bumpLedger } from '../../_lib/tenant.js';
import { sendSms } from '../../_lib/twilio.js';

export async function onRequest(context) {
  const { request, env, params } = context;
  const db = env.DB;
  const seg = params.path || [];
  const method = request.method;

  // ---- agency level ----
  if (seg[0] === 'clients') {
    if (method === 'GET') {
      const { results } = await db.prepare(
        `SELECT c.id, c.name, c.status, c.door, c.brand_color, c.paused, c.twilio_number,
                (SELECT COUNT(*) FROM conversations v WHERE v.client_id=c.id AND v.needs_human=1) AS needs_human,
                (SELECT COUNT(*) FROM conversations v WHERE v.client_id=c.id AND v.status='booked') AS booked
           FROM clients c ORDER BY c.name`
      ).all();
      return json({ clients: results || [] });
    }
    if (method === 'POST') {
      const b = await request.json();
      if (!b.id || !b.name) return json({ error: 'id and name required' }, 400);
      await db.prepare(
        `INSERT INTO clients (id, name, legal_name, ein, address, website, timezone,
                              brand_color, door, twilio_number, calendar_id, notify_email,
                              hot_lead_phone, crm_bcc_email, business_brain)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        b.id, b.name, b.legal_name || null, b.ein || null, b.address || null, b.website || null,
        b.timezone || 'America/Chicago', b.brand_color || '#ed1a78', b.door || 'A',
        b.twilio_number || null, b.calendar_id || null, b.notify_email || null,
        b.hot_lead_phone || null, b.crm_bcc_email || null,
        b.business_brain ? JSON.stringify(b.business_brain) : null
      ).run();
      return json({ ok: true, id: b.id });
    }
  }

  // ---- tenant level ----
  const clientId = seg[0];
  const action = seg[1];
  const ref = seg[2];
  if (!clientId) return json({ error: 'not found' }, 404);

  const client = await getClientById(db, clientId);
  if (!client) return json({ error: 'unknown client' }, 404);

  if (action === 'inbox' && method === 'GET') {
    const { results } = await scoped(db,
      `SELECT id, phone, contact_name, status, intent, needs_human, ai_paused,
              context_note, appointment_at, last_inbound_at,
              (SELECT body FROM messages m WHERE m.conversation_id = conversations.id
                ORDER BY created_at DESC LIMIT 1) AS last_message
         FROM conversations
        WHERE client_id = ?
        ORDER BY needs_human DESC, last_inbound_at DESC
        LIMIT 100`, clientId).all();
    return json({ client: publicClient(client), threads: results || [] });
  }

  if (action === 'thread' && method === 'GET') {
    const conv = await scoped(db,
      'SELECT * FROM conversations WHERE client_id = ? AND id = ?', clientId, ref).first();
    if (!conv) return json({ error: 'not found' }, 404);
    const { results } = await scoped(db,
      `SELECT direction, body, author, intent, confidence, status, error_code, created_at
         FROM messages WHERE client_id = ? AND conversation_id = ? ORDER BY created_at ASC`,
      clientId, ref).all();
    const lead = conv.lead_id
      ? await scoped(db, 'SELECT * FROM leads WHERE client_id = ? AND id = ?', clientId, conv.lead_id).first()
      : null;
    return json({ conversation: conv, messages: results || [], lead });
  }

  // "Take over" - pauses the AI on one thread so a human can type.
  if (action === 'takeover' && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const paused = b.paused === false ? 0 : 1;
    await db
      .prepare('UPDATE conversations SET ai_paused = ?, needs_human = 0 WHERE client_id = ? AND id = ?')
      .bind(paused, clientId, ref)
      .run();
    return json({ ok: true, ai_paused: !!paused });
  }

  // Human reply from the inbox.
  if (action === 'reply' && method === 'POST') {
    const b = await request.json();
    if (!b.body) return json({ error: 'body required' }, 400);
    const conv = await scoped(db,
      'SELECT * FROM conversations WHERE client_id = ? AND id = ?', clientId, ref).first();
    if (!conv) return json({ error: 'not found' }, 404);

    const sent = await sendSms(env, client, conv.phone, b.body);
    await db.prepare(`INSERT INTO messages
        (id, conversation_id, client_id, direction, body, author, twilio_sid, status, error_code)
        VALUES (?,?,?,?,?,'human',?,?,?)`)
      .bind(uid('ms_'), conv.id, clientId, 'out', b.body,
        sent.sid || null, sent.ok ? sent.status : 'failed', sent.code || null).run();
    if (sent.ok) await bumpLedger(db, clientId, client.timezone, 'sent');
    await db.prepare("UPDATE conversations SET needs_human=0, ai_paused=1, last_outbound_at=datetime('now') WHERE id=?")
      .bind(conv.id).run();
    return json({ ok: sent.ok, error: sent.error });
  }

  // KILL SWITCH. Halts all outbound for this client immediately.
  if (action === 'pause' && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const paused = b.paused === false ? 0 : 1;
    await db.prepare('UPDATE clients SET paused=?, updated_at=datetime(\'now\') WHERE id=?')
      .bind(paused, clientId).run();
    await logEvent(db, clientId, 'paused', null, { paused: !!paused });
    return json({ ok: true, paused: !!paused });
  }

  if (action === 'stats' && method === 'GET') {
    const { results } = await scoped(db,
      'SELECT * FROM send_ledger WHERE client_id = ? ORDER BY day DESC LIMIT 30', clientId).all();
    const funnel = await scoped(db,
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status='booked' THEN 1 ELSE 0 END) AS booked,
              SUM(CASE WHEN status='opted_out' THEN 1 ELSE 0 END) AS opted_out,
              SUM(CASE WHEN needs_human=1 THEN 1 ELSE 0 END) AS needs_human
         FROM conversations WHERE client_id = ?`, clientId).first();
    return json({ daily: results || [], funnel });
  }

  return json({ error: 'not found' }, 404);
}

function publicClient(c) {
  const { twilio_subaccount_token, google_refresh_token, ...safe } = c;
  return safe;
}
