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

import { getClientById, scoped, json, uid, logEvent, bumpLedger, toE164, isOptedOut } from '../../_lib/tenant.js';
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
        `SELECT c.id, c.name, c.status, c.door, c.brand_color, c.paused, c.auto_send, c.reminders_enabled, c.twilio_number,
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
                ORDER BY created_at DESC LIMIT 1) AS last_message,
              (SELECT status FROM messages m WHERE m.conversation_id = conversations.id
                ORDER BY created_at DESC LIMIT 1) AS last_message_status
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

    const d = await dispatch(env, db, client, conv, b.body, 'human');
    await db.prepare("UPDATE conversations SET needs_human=0, ai_paused=1, last_outbound_at=datetime('now') WHERE id=?")
      .bind(conv.id).run();
    return json({ ok: true, delivered: d.delivered, pending: d.pending, error: d.error });
  }

  // Approve an AI draft (optionally edited) and send it.
  if (action === 'approve' && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const conv = await scoped(db,
      'SELECT * FROM conversations WHERE client_id = ? AND id = ?', clientId, ref).first();
    if (!conv) return json({ error: 'not found' }, 404);

    const draft = b.message_id
      ? await scoped(db, 'SELECT * FROM messages WHERE client_id = ? AND conversation_id = ? AND id = ?', clientId, ref, b.message_id).first()
      : await scoped(db, "SELECT * FROM messages WHERE client_id = ? AND conversation_id = ? AND status = 'draft' ORDER BY created_at DESC LIMIT 1", clientId, ref).first();
    const body = (b.body != null && b.body !== '') ? b.body : (draft ? draft.body : null);
    if (!body) return json({ error: 'nothing to send' }, 400);

    const d = await dispatch(env, db, client, conv, body, 'ai', draft ? draft.id : null);
    await db.prepare("UPDATE conversations SET needs_human=0, ai_paused=0, last_outbound_at=datetime('now') WHERE id=?")
      .bind(conv.id).run();
    await logEvent(db, clientId, 'ai_reply_approved', conv.id, { delivered: d.delivered });
    return json({ ok: true, delivered: d.delivered, pending: d.pending, error: d.error });
  }

  // Flag a thread for a human without typing anything (mock's "Hand off").
  if (action === 'handoff' && method === 'POST') {
    await db.prepare('UPDATE conversations SET needs_human=1, ai_paused=1 WHERE client_id=? AND id=?')
      .bind(clientId, ref).run();
    await logEvent(db, clientId, 'escalated', ref, { by: 'human' });
    return json({ ok: true });
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

  // Per-client settings toggles (approval vs autonomous, pause).
  if (action === 'settings' && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const sets = [], vals = [];
    if ('auto_send' in b) { sets.push('auto_send=?'); vals.push(b.auto_send ? 1 : 0); }
    if ('paused' in b) { sets.push('paused=?'); vals.push(b.paused ? 1 : 0); }
    if ('reminders_enabled' in b) { sets.push('reminders_enabled=?'); vals.push(b.reminders_enabled ? 1 : 0); }
    if (!sets.length) return json({ error: 'no settings provided' }, 400);
    vals.push(clientId);
    await db.prepare(`UPDATE clients SET ${sets.join(', ')}, updated_at=datetime('now') WHERE id=?`).bind(...vals).run();
    if ('auto_send' in b) await logEvent(db, clientId, 'settings', null, { auto_send: !!b.auto_send });
    return json({ ok: true });
  }

  // Enroll leads into the reactivation cadence. Creates a conversation per lead
  // and drops the FIRST message in as a DRAFT for review — bulk enroll never
  // auto-sends, even for autonomous clients. Later steps follow the client's mode.
  if (action === 'enroll' && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    let leads;
    if (Array.isArray(b.lead_ids) && b.lead_ids.length) {
      const qs = b.lead_ids.map(() => '?').join(',');
      const r = await db.prepare(`SELECT id, name, phone FROM leads WHERE client_id=? AND id IN (${qs})`).bind(clientId, ...b.lead_ids).all();
      leads = r.results || [];
    } else {
      const wh = ['client_id=?', "phone IS NOT NULL", "phone != ''"]; const vals = [clientId];
      if (b.status) { wh.push('status=?'); vals.push(b.status); }
      if (b.trade) { wh.push('trade=?'); vals.push(b.trade); }
      const lim = Math.min(Math.max(parseInt(b.limit, 10) || 200, 1), 500);
      const r = await db.prepare(`SELECT id, name, phone FROM leads WHERE ${wh.join(' AND ')} LIMIT ${lim}`).bind(...vals).all();
      leads = r.results || [];
    }

    const brain = safeParse(client.business_brain) || {};
    const seq = (brain.sequence && brain.sequence.length) ? brain.sequence : defaultSequence(client.name);

    let enrolled = 0, skipped_no_phone = 0, skipped_existing = 0, skipped_optout = 0;
    for (const lead of leads) {
      const phone = toE164(lead.phone);
      if (!phone) { skipped_no_phone++; continue; }
      if (await isOptedOut(db, clientId, phone)) { skipped_optout++; continue; }
      const exists = await db.prepare('SELECT id FROM conversations WHERE client_id=? AND phone=?').bind(clientId, phone).first();
      if (exists) { skipped_existing++; continue; }

      const convId = uid('cv_');
      await db.prepare(`INSERT INTO conversations
          (id, client_id, lead_id, phone, contact_name, status, step, next_send_at, context_note)
          VALUES (?,?,?,?,?, 'queued', 1, ?, 'Enrolled in the reactivation sequence.')`)
        .bind(convId, clientId, lead.id, phone, lead.name || null, gapAt(1)).run();
      await db.prepare(`INSERT INTO messages (id, conversation_id, client_id, direction, body, author, status)
          VALUES (?,?,?,?,?, 'ai', 'draft')`)
        .bind(uid('ms_'), convId, clientId, 'out', renderTpl(seq[0], lead.name, client.name)).run();
      enrolled++;
    }
    await logEvent(db, clientId, 'campaign_start', null, { enrolled, considered: leads.length });
    return json({ ok: true, enrolled, skipped_no_phone, skipped_existing, skipped_optout, considered: leads.length });
  }

  // Full client profile + business brain, for the onboarding/setup editor.
  if (action === 'profile' && method === 'GET') {
    const pc = publicClient(client);
    pc.business_brain = safeParse(client.business_brain) || null;
    return json({ client: pc });
  }
  if (action === 'profile' && method === 'POST') {
    const b = await request.json();
    const cols = ['name', 'legal_name', 'ein', 'address', 'website', 'timezone',
      'twilio_number', 'calendar_id', 'notify_email', 'hot_lead_phone', 'crm_bcc_email'];
    const sets = [], vals = [];
    for (const c of cols) if (c in b) { sets.push(`${c}=?`); vals.push(b[c] || null); }
    if ('business_brain' in b) { sets.push('business_brain=?'); vals.push(b.business_brain ? JSON.stringify(b.business_brain) : null); }
    if (!sets.length) return json({ error: 'nothing to update' }, 400);
    sets.push("updated_at=datetime('now')"); vals.push(clientId);
    await db.prepare(`UPDATE clients SET ${sets.join(', ')} WHERE id=?`).bind(...vals).run();
    return json({ ok: true });
  }

  if (action === 'events' && method === 'GET') {
    const { results } = await scoped(db,
      'SELECT kind, detail, created_at FROM events WHERE client_id = ? ORDER BY created_at DESC LIMIT 20', clientId).all();
    return json({ events: results || [] });
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

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
function renderTpl(tpl, name, business) {
  const first = (name || '').split(' ')[0] || 'there';
  return String(tpl || '').replace(/\{first_name\}/g, first).replace(/\{business\}/g, business);
}
function defaultSequence(business) {
  return [
    `Hi {first_name}, this is ${business}. You reached out to us a while back and we never got you scheduled. Still interested? Reply STOP to opt out.`,
    `Hi {first_name} - following up from ${business}. Happy to find you a time this week if you're still looking. Reply STOP to opt out.`,
    `Last note from ${business}, {first_name} - if the timing isn't right no worries at all. Want me to hold a spot? Reply STOP to opt out.`,
  ];
}
// step 1 -> +2 days from now, as a SQLite datetime string.
function gapAt(step) {
  const gaps = [0, 2, 4];
  const d = new Date(Date.now() + (gaps[step] || 4) * 86400000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function hasTwilio(client, env) {
  const sid = client?.twilio_subaccount_sid || env.TWILIO_ACCOUNT_SID;
  const token = client?.twilio_subaccount_token || env.TWILIO_AUTH_TOKEN;
  const from = client?.twilio_messaging_service_sid || client?.twilio_number;
  return !!(sid && token && from);
}

// Sends via Twilio when the client is fully configured; otherwise queues the
// message so the inbox stays clean until Twilio is connected. Writes or updates
// the message row and reports delivery state back to the inbox.
async function dispatch(env, db, client, conv, body, author, existingId) {
  let status = 'queued', sid = null, code = null, delivered = false, error = null;
  if (hasTwilio(client, env)) {
    const sent = await sendSms(env, client, conv.phone, body);
    delivered = sent.ok;
    status = sent.ok ? (sent.status || 'sent') : 'failed';
    sid = sent.sid || null; code = sent.code || null; error = sent.error || null;
    if (sent.ok) await bumpLedger(db, client.id, client.timezone, 'sent');
  }
  if (existingId) {
    await db.prepare('UPDATE messages SET body=?, status=?, twilio_sid=?, error_code=?, author=? WHERE id=?')
      .bind(body, status, sid, code, author, existingId).run();
  } else {
    await db.prepare(`INSERT INTO messages
        (id, conversation_id, client_id, direction, body, author, twilio_sid, status, error_code)
        VALUES (?,?,?,?,?,?,?,?,?)`)
      .bind(uid('ms_'), conv.id, client.id, 'out', body, author, sid, status, code).run();
  }
  return { delivered, pending: !delivered && status === 'queued', status, error };
}
