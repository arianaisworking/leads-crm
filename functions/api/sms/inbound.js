// functions/api/sms/inbound.js
// ONE webhook URL for every client:
//   https://leads-crm-2sv.pages.dev/api/sms/inbound
// The tenant is resolved from the 'To' number. Never create a webhook per client.
//
// Order of operations matters. Hard stops run BEFORE any model is called.

import {
  getClientByNumber, isOptedOut, logEvent, bumpLedger, uid, toE164,
} from '../../_lib/tenant.js';
import { sendSms, validateTwilioSignature, twiml } from '../../_lib/twilio.js';
import { classify, respond, isStopKeyword } from '../../_lib/brain.js';
import { openSlots, bookSlot } from '../../_lib/calendar.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const db = env.DB;

  const form = await request.formData();
  const params = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));

  const from = toE164(params.From);
  const to = toE164(params.To);
  const body = (params.Body || '').trim();

  const client = await getClientByNumber(db, to);
  if (!client) return twiml(); // unknown number - swallow silently

  // --- 0. AUTHENTICITY -----------------------------------------------------
  const token = client.twilio_subaccount_token || env.TWILIO_AUTH_TOKEN;
  const valid = await validateTwilioSignature(request, token, params);
  if (!valid && env.REQUIRE_TWILIO_SIGNATURE !== 'false') {
    return new Response('invalid signature', { status: 403 });
  }

  const conv = await upsertConversation(db, client, from, params);
  const inboundId = await insertMessage(db, conv, client, 'in', body, 'lead', { twilio_sid: params.MessageSid });
  await bumpLedger(db, client.id, client.timezone, 'received');

  // --- 1. HARD STOPS (no model involved) -----------------------------------
  if (isStopKeyword(body)) {
    await db.prepare("INSERT OR IGNORE INTO opt_outs (client_id, phone, reason) VALUES (?,?,'stop_keyword')")
      .bind(client.id, from).run();
    await db.prepare("UPDATE conversations SET status='opted_out', ai_paused=1, next_send_at=NULL WHERE id=?")
      .bind(conv.id).run();
    await bumpLedger(db, client.id, client.timezone, 'opt_outs');
    await logEvent(db, client.id, 'opt_out', conv.id, { phone: from });
    return twiml(); // Twilio sends the carrier-level confirmation itself
  }

  if (await isOptedOut(db, client.id, from)) return twiml();

  // A human took this thread over - stay out of it.
  if (conv.ai_paused) {
    await flagHuman(db, conv, 'human already handling');
    return twiml();
  }

  if (client.paused) {
    await flagHuman(db, conv, 'client paused - inbound needs a human');
    return twiml();
  }

  // --- 2. CLASSIFY ---------------------------------------------------------
  let thread = await threadText(db, conv.id);
  if (conv.interest) thread = `(Lead originally reached out about: ${conv.interest})\n` + thread;
  let cls;
  try {
    cls = await classify(env, thread, body);
  } catch (e) {
    await flagHuman(db, conv, 'classifier error: ' + e.message);
    return twiml();
  }

  await db.prepare('UPDATE messages SET intent = ?, confidence = ? WHERE id = ?')
    .bind(cls.intent, cls.confidence ?? null, inboundId).run();

  const NEVER_AUTO = ['angry', 'spam_accusation', 'legal_threat', 'medical_or_sensitive', 'opt_out'];
  if (cls.escalate || NEVER_AUTO.includes(cls.intent)) {
    await db.prepare('UPDATE conversations SET intent=?, needs_human=1, ai_paused=1, next_send_at=NULL WHERE id=?')
      .bind(cls.intent, conv.id).run();
    await logEvent(db, client.id, 'escalated', conv.id, { intent: cls.intent, body });
    await notifyOwner(env, client, `Needs you: ${cls.intent} from ${from} - "${body.slice(0, 80)}"`);
    return twiml();
  }

  if (cls.intent === 'not_interested' || cls.intent === 'wrong_number') {
    await db.prepare("UPDATE conversations SET status='closed', intent=?, next_send_at=NULL WHERE id=?")
      .bind(cls.intent, conv.id).run();
    return twiml();
  }

  // --- 3. REAL AVAILABILITY (before the model writes anything) -------------
  let slots = [];
  const wantsTime = ['interested', 'booking', 'reschedule'].includes(cls.intent);
  if (wantsTime && client.calendar_id) {
    try { slots = await openSlots(env, client, { max: 3 }); }
    catch (e) { await logEvent(db, client.id, 'error', conv.id, 'freebusy: ' + e.message); }
  }

  // --- 4. RESPOND ----------------------------------------------------------
  const brain = safeParse(client.business_brain) || {};
  let out;
  try {
    out = await respond(env, client, brain, slots, thread, body);
  } catch (e) {
    await flagHuman(db, conv, 'responder error: ' + e.message);
    return twiml();
  }

  // Runaway guard: too many turns without progress means a person should step in.
  if ((conv.turn_count || 0) >= Number(env.MAX_TURNS || 6) && out.action !== 'book') {
    await flagHuman(db, conv, 'turn limit reached');
    await notifyOwner(env, client, `Long thread with ${from} needs a human.`);
    return twiml();
  }

  // Approval-gated (default) = the AI drafts, a human approves from the inbox.
  // Autonomous (client.auto_send=1) = the AI sends and books on its own.
  const gated = !client.auto_send;

  // --- 5. BOOK -------------------------------------------------------------
  // Autonomous clients book directly. Gated clients never write to the calendar
  // without a human — the proposed time goes out as a draft to approve first.
  let bookedLabel = null;
  if (out.action === 'book' && out.book_slot) {
    const slot = slots.find((s) => s.id === out.book_slot);
    if (slot && !gated) {
      try {
        const ev = await bookSlot(env, client, slot, {
          name: conv.contact_name, phone: from,
          service: out.service_interest, context_note: out.context_note,
        });
        await db.prepare("UPDATE conversations SET status='booked', appointment_at=?, appointment_event_id=? WHERE id=?")
          .bind(slot.startISO, ev.eventId, conv.id).run();
        await bumpLedger(db, client.id, client.timezone, 'booked');
        await logEvent(db, client.id, 'booked', conv.id, { slot: slot.label, phone: from });
        bookedLabel = slot.label;
        await notifyOwner(env, client, `Booked: ${conv.contact_name || from} - ${slot.label}`);
      } catch (e) {
        await flagHuman(db, conv, 'calendar insert failed: ' + e.message);
        await notifyOwner(env, client, `Booking FAILED for ${from} - please call them.`);
        return twiml();
      }
    } else if (slot && gated) {
      out.needs_human = true;
      out.context_note = (out.context_note ? out.context_note + ' ' : '') +
        `[AI proposes booking ${slot.label} — approve the draft to confirm]`;
    }
  }

  // --- 6. SEND (autonomous) or DRAFT (approval-gated) ----------------------
  if (out.reply) {
    if (gated) {
      // Land it in the inbox as a draft. Nothing is sent until a human approves.
      await insertMessage(db, conv, client, 'out', out.reply, 'ai', {
        status: 'draft', intent: cls.intent, confidence: out.confidence,
      });
    } else {
      const sent = await sendSms(env, client, from, out.reply);
      await insertMessage(db, conv, client, 'out', out.reply, 'ai', {
        twilio_sid: sent.sid, status: sent.ok ? sent.status : 'failed',
        error_code: sent.code, intent: cls.intent, confidence: out.confidence,
        segments: sent.segments,
      });
      if (sent.ok) await bumpLedger(db, client.id, client.timezone, 'sent');
    }
  }

  const didSend = !gated && !!out.reply;
  await db.prepare(`UPDATE conversations
       SET intent=?, context_note=?, needs_human=?, turn_count=turn_count+?,
           last_inbound_at=datetime('now'),
           last_outbound_at=CASE WHEN ?=1 THEN datetime('now') ELSE last_outbound_at END,
           status=CASE WHEN status='queued' THEN 'active' ELSE status END,
           next_send_at=NULL
     WHERE id=?`)
    .bind(cls.intent, out.context_note || conv.context_note, out.needs_human ? 1 : 0,
          didSend ? 1 : 0, didSend ? 1 : 0, conv.id)
    .run();

  if (out.needs_human) await notifyOwner(env, client, `Review needed with ${from}.`);

  // Mirror the whole thread to the client's own CRM so the work is findable
  // where they already look - not only in our dashboard.
  if (bookedLabel && client.crm_bcc_email) {
    context.waitUntil(mirrorToCrm(env, client, conv, from, bookedLabel, out.context_note));
  }

  return twiml();
}

// --- helpers --------------------------------------------------------------

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

async function upsertConversation(db, client, phone, params) {
  const existing = await db.prepare('SELECT * FROM conversations WHERE client_id=? AND phone=?')
    .bind(client.id, phone).first();
  if (existing) return existing;

  const lead = await db.prepare('SELECT id, name FROM leads WHERE client_id=? AND phone=? LIMIT 1')
    .bind(client.id, phone).first().catch(() => null);

  const id = uid('cv_');
  await db.prepare(`INSERT INTO conversations
      (id, client_id, lead_id, phone, contact_name, status, last_inbound_at)
      VALUES (?,?,?,?,?, 'active', datetime('now'))`)
    .bind(id, client.id, lead?.id || null, phone, lead?.name || params.ProfileName || null)
    .run();
  return await db.prepare('SELECT * FROM conversations WHERE id=?').bind(id).first();
}

async function insertMessage(db, conv, client, direction, body, author, extra = {}) {
  const id = uid('ms_');
  await db.prepare(`INSERT INTO messages
      (id, conversation_id, client_id, direction, body, author, twilio_sid, status, error_code, intent, confidence, segments)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, conv.id, client.id, direction, body, author,
      extra.twilio_sid || null, extra.status || null, extra.error_code || null,
      extra.intent || null, extra.confidence ?? null, extra.segments || null)
    .run();
  return id;
}

async function threadText(db, convId) {
  const { results } = await db.prepare(
    'SELECT direction, body FROM messages WHERE conversation_id=? ORDER BY created_at ASC LIMIT 20'
  ).bind(convId).all();
  return (results || [])
    .map((m) => `${m.direction === 'in' ? 'Lead' : 'Us'}: ${m.body}`)
    .join('\n');
}

async function flagHuman(db, conv, reason) {
  await db.prepare('UPDATE conversations SET needs_human=1, ai_paused=1, context_note=? WHERE id=?')
    .bind(reason, conv.id).run();
}

async function notifyOwner(env, client, text) {
  if (!client.hot_lead_phone) return;
  try { await sendSms(env, client, client.hot_lead_phone, `[${client.name}] ${text}`); } catch {}
}

async function mirrorToCrm(env, client, conv, phone, when, note) {
  if (!env.RESEND_API_KEY) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: env.FROM_EMAIL || 'bookings@thenetworkboss.com',
      to: [client.crm_bcc_email],
      reply_to: client.notify_email || undefined,
      subject: `Appointment booked - ${conv.contact_name || phone}`,
      text: `Name: ${conv.contact_name || 'unknown'}\nPhone: ${phone}\nWhen: ${when}\n\nContext: ${note || ''}\n\nBooked via Cold Case Revival.`,
    }),
  }).catch(() => {});
}
