// functions/api/sms/tick.js
// The poor-man's queue. Hit it every 5 minutes from a scheduler with the header
//   x-cron-key: <CRON_KEY>
// (Cloudflare Pages has no native cron - use a Cron Trigger on a tiny Worker,
//  or cron-job.org while you're small.)
//
// Sends only inside each client's local quiet-hour window, respects the daily
// cap, and never touches a paused client or an opted-out number.

import { withinSendWindow, dayInTz, uid, isOptedOut } from '../../_lib/tenant.js';
import { sendSms } from '../../_lib/twilio.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.headers.get('x-cron-key') !== env.CRON_KEY) {
    return new Response('forbidden', { status: 403 });
  }
  const db = env.DB;
  const batch = Number(env.TICK_BATCH || 25);
  const report = [];

  const { results: clients } = await db
    .prepare("SELECT * FROM clients WHERE paused = 0 AND status = 'active'")
    .all();

  for (const client of clients || []) {
    const gated = !client.auto_send; // gated clients get drafts, not sends
    if (!withinSendWindow(client)) { report.push({ client: client.id, skipped: 'quiet hours' }); continue; }

    const day = dayInTz(client.timezone);
    const led = await db.prepare('SELECT sent FROM send_ledger WHERE client_id=? AND day=?')
      .bind(client.id, day).first();
    const already = led?.sent || 0;
    const remaining = Math.max(0, (client.daily_send_cap || 100) - already);
    if (remaining === 0) { report.push({ client: client.id, skipped: 'daily cap' }); continue; }

    const { results: due } = await db.prepare(
      `SELECT * FROM conversations
        WHERE client_id = ? AND ai_paused = 0 AND needs_human = 0
          AND status IN ('queued','active')
          AND next_send_at IS NOT NULL AND next_send_at <= datetime('now')
        ORDER BY next_send_at ASC LIMIT ?`
    ).bind(client.id, Math.min(batch, remaining)).all();

    let sentCount = 0;
    for (const conv of due || []) {
      if (await isOptedOut(db, client.id, conv.phone)) {
        await db.prepare("UPDATE conversations SET status='opted_out', next_send_at=NULL WHERE id=?")
          .bind(conv.id).run();
        continue;
      }

      const body = renderStep(client, conv);
      if (!body) {
        await db.prepare("UPDATE conversations SET status='closed', next_send_at=NULL WHERE id=?")
          .bind(conv.id).run();
        continue;
      }

      const next = nextSendAt(client, conv.step + 1);

      if (gated) {
        // Draft the follow-up for human approval instead of sending. The cadence
        // still advances so the draft appears on schedule; it costs no send/cap.
        await db.prepare(`INSERT INTO messages
            (id, conversation_id, client_id, direction, body, author, status)
            VALUES (?,?,?,?,?, 'ai', 'draft')`)
          .bind(uid('ms_'), conv.id, client.id, 'out', body).run();
        await db.prepare(`UPDATE conversations
               SET step = step + 1, status = 'active', next_send_at = ?
             WHERE id = ?`)
          .bind(next, conv.id).run();
        continue;
      }

      const sent = await sendSms(env, client, conv.phone, body);
      await db.prepare(`INSERT INTO messages
          (id, conversation_id, client_id, direction, body, author, twilio_sid, status, error_code, segments)
          VALUES (?,?,?,?,?, 'ai', ?,?,?,?)`)
        .bind(uid('ms_'), conv.id, client.id, 'out', body,
          sent.sid || null, sent.ok ? sent.status : 'failed', sent.code || null, sent.segments || null)
        .run();

      await db.prepare(`UPDATE conversations
             SET step = step + 1, status = 'active', last_outbound_at = datetime('now'), next_send_at = ?
           WHERE id = ?`)
        .bind(next, conv.id).run();

      if (sent.ok) sentCount++;
    }

    // --- Appointment lifecycle: 24h + 2h reminders, then a missed-appointment
    // nudge. Gated clients get drafts; autonomous clients get sends. ---
    if (client.reminders_enabled) {
      const { results: appts } = await db.prepare(
        `SELECT * FROM conversations
          WHERE client_id=? AND status='booked' AND ai_paused=0 AND appointment_at IS NOT NULL`
      ).bind(client.id).all();
      for (const conv of appts || []) {
        if (await isOptedOut(db, client.id, conv.phone)) continue;
        let appt = new Date(conv.appointment_at);
        if (isNaN(appt)) appt = new Date((conv.appointment_at || '').replace(' ', 'T') + 'Z');
        if (isNaN(appt)) continue;
        const hrs = (appt.getTime() - Date.now()) / 3600000;
        const first = (conv.contact_name || '').split(' ')[0] || 'there';
        const when = fmtAppt(appt, client.timezone);
        let body = null, mark = null;
        if (hrs > 2 && hrs <= 24 && !conv.reminder_24_sent) { body = `Reminder from ${client.name}: ${first}, your appointment is ${when}. Reply C to confirm or R to reschedule.`; mark = 'reminder_24_sent'; }
        else if (hrs > 0 && hrs <= 2 && !conv.reminder_2_sent) { body = `See you soon, ${first} — your ${client.name} appointment is ${when}.`; mark = 'reminder_2_sent'; }
        else if (hrs <= -2 && !conv.post_appt_handled) { body = `Hi ${first}, we missed you at ${client.name} today. Want to grab another time? Reply YES and I'll find one.`; mark = 'post_appt_handled'; }
        if (!body) continue;

        if (gated) {
          await db.prepare(`INSERT INTO messages (id, conversation_id, client_id, direction, body, author, status)
              VALUES (?,?,?,?,?, 'ai', 'draft')`).bind(uid('ms_'), conv.id, client.id, 'out', body).run();
        } else {
          const sent = await sendSms(env, client, conv.phone, body);
          await db.prepare(`INSERT INTO messages (id, conversation_id, client_id, direction, body, author, twilio_sid, status, error_code, segments)
              VALUES (?,?,?,?,?, 'ai', ?,?,?,?)`)
            .bind(uid('ms_'), conv.id, client.id, 'out', body, sent.sid || null, sent.ok ? sent.status : 'failed', sent.code || null, sent.segments || null).run();
          if (sent.ok) sentCount++;
        }
        await db.prepare(`UPDATE conversations SET ${mark}=1${mark === 'post_appt_handled' ? ", status='active'" : ''} WHERE id=?`).bind(conv.id).run();
      }
    }

    if (sentCount) {
      await db.prepare('INSERT OR IGNORE INTO send_ledger (client_id, day) VALUES (?,?)')
        .bind(client.id, day).run();
      await db.prepare('UPDATE send_ledger SET sent = sent + ? WHERE client_id=? AND day=?')
        .bind(sentCount, client.id, day).run();
    }
    report.push({ client: client.id, sent: sentCount, due: (due || []).length });
  }

  return new Response(JSON.stringify({ ok: true, report }), {
    headers: { 'content-type': 'application/json' },
  });
}

// The reactivation cadence. Every first touch carries opt-out language.
// Edit these per client by putting a `sequence` array in business_brain.
function renderStep(client, conv) {
  const brain = safeParse(client.business_brain) || {};
  const seq = brain.sequence || defaultSequence(client.name);
  const tpl = seq[conv.step];
  if (!tpl) return null;
  const first = (conv.contact_name || '').split(' ')[0] || 'there';
  return tpl.replace(/\{first_name\}/g, first).replace(/\{business\}/g, client.name);
}

function defaultSequence(business) {
  return [
    `Hi {first_name}, this is ${business}. You reached out to us a while back and we never got you scheduled. Still interested? Reply STOP to opt out.`,
    `Hi {first_name} - following up from ${business}. Happy to find you a time this week if you're still looking. Reply STOP to opt out.`,
    `Last note from ${business}, {first_name} - if the timing isn't right no worries at all. Want me to hold a spot? Reply STOP to opt out.`,
  ];
}

// 0 -> +2 days -> +4 days. Slow and polite beats fast and blocked.
function nextSendAt(client, step) {
  const gaps = [0, 2, 4];
  if (step >= gaps.length) return null;
  const d = new Date(Date.now() + gaps[step] * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function fmtAppt(d, tz) {
  try { return d.toLocaleString('en-US', { timeZone: tz || 'America/Chicago', weekday: 'short', hour: 'numeric', minute: '2-digit' }); }
  catch { return d.toISOString().slice(0, 16).replace('T', ' '); }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
