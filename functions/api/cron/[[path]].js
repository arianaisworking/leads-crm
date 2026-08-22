// functions/api/cron/[[path]].js
// PUBLIC route, self-authenticated with x-cron-key (exempt in _middleware.js).
//
//   GET /api/cron/nudge          -> run the follow-up pass
//   GET /api/cron/nudge?dry=1    -> report what it WOULD send, send nothing
//
// Drivers rarely stall because they changed their mind. They stall because the
// carrier's application is long, or the inspection expired, or they meant to do
// it Sunday. Each rule below is tied to one stuck state, stops the moment the
// driver moves, and is rate-limited per driver so nobody gets chased twice for
// the same thing.

import { json } from '../../_lib/tenant.js';
import { sendEmail, emailShell, teamEmail, replyToEmail, brandName, esc } from '../../_lib/email.js';
import { rid } from '../../_lib/recruiting.js';

const MIN_GAP_DAYS = 3;   // never repeat the same nudge inside this window
const MAX_PER_KIND = 3;   // and never more than this many times, ever

export async function onRequest(context) {
  const { request, env } = context;
  const action = (context.params.path || [])[0];
  const url = new URL(request.url);

  if (env.CRON_KEY && request.headers.get('x-cron-key') !== env.CRON_KEY)
    return json({ error: 'unauthorized' }, 401);
  if (action !== 'nudge') return json({ error: 'not found' }, 404);

  const db = env.DB;
  const dry = url.searchParams.get('dry') === '1';
  const origin = url.origin;
  const sent = [], skipped = [];

  // A driver is chaseable if they're still live and not muted.
  const LIVE = `l.nudge_paused = 0 AND l.started_at IS NULL
    AND COALESCE(l.status,'') NOT IN ('Not qualified','Rolling')
    AND COALESCE(l.screen_result,'') <> 'disqualified'
    AND l.email IS NOT NULL`;

  // Each rule: who it catches, and what it says.
  const RULES = [
    {
      kind: 'carrier_app_unopened',
      sql: `SELECT l.* FROM leads l WHERE ${LIVE}
              AND l.carrier_app_sent_at IS NOT NULL AND l.carrier_app_clicked_at IS NULL
              AND l.confirmation_no IS NULL
              AND date(l.carrier_app_sent_at) <= date('now','-2 day')`,
      subject: (d, c) => `Your application with ${c ? c.name : 'the carrier'}`,
      body: (d, c, links) => `
        <p style="margin:0 0 14px;color:#3a4353">Just making sure this didn't get buried. The carrier's application is the one step we can't do for you — it goes to their Safety team and gets you a confirmation number.</p>
        <p style="margin:0 0 18px"><a href="${links.carrierApp}" style="display:inline-block;background:#2f6fed;color:#fff;text-decoration:none;padding:12px 24px;border-radius:11px;font-weight:700">Open the application →</a></p>
        <p style="margin:0;color:#5b6472;font-size:13.5px">About 20 minutes, and you'll want your employment history handy. Stuck on any part of it? Reply and we'll walk you through it.</p>`,
    },
    {
      kind: 'carrier_app_unfinished',
      sql: `SELECT l.* FROM leads l WHERE ${LIVE}
              AND l.carrier_app_clicked_at IS NOT NULL AND l.confirmation_no IS NULL
              AND date(l.carrier_app_clicked_at) <= date('now','-3 day')`,
      subject: () => 'Picking up where you left off',
      body: (d, c, links) => `
        <p style="margin:0 0 14px;color:#3a4353">You started the carrier's application — nice work. It looks like it didn't get finished, and it's the piece everything else waits on.</p>
        <p style="margin:0 0 18px"><a href="${links.carrierApp}" style="display:inline-block;background:#2f6fed;color:#fff;text-decoration:none;padding:12px 24px;border-radius:11px;font-weight:700">Finish your application →</a></p>
        <p style="margin:0 0 14px;color:#5b6472;font-size:13.5px">If something in it tripped you up — employment gaps, dates you can't remember — tell us and we'll help you get through it. It's usually not the problem people think it is.</p>
        <p style="margin:0;color:#5b6472;font-size:13.5px">Already finished it and got a confirmation number? <a href="${links.lease}" style="color:#2f6fed">Let us know here</a> so we stop chasing you.</p>`,
    },
    {
      kind: 'lease_form',
      sql: `SELECT l.* FROM leads l WHERE ${LIVE}
              AND l.onboarding_sent_at IS NOT NULL AND l.lease_info_at IS NULL
              AND date(l.onboarding_sent_at) <= date('now','-2 day')`,
      subject: () => 'Your lease details',
      body: (d, c, links) => `
        <p style="margin:0 0 14px;color:#3a4353">We still need your lease information to get your agreement drawn up. It's one page — your details and your truck — and it takes about five minutes.</p>
        <p style="margin:0 0 18px"><a href="${links.lease}" style="display:inline-block;background:#2f6fed;color:#fff;text-decoration:none;padding:12px 24px;border-radius:11px;font-weight:700">Open your onboarding page →</a></p>
        <p style="margin:0;color:#5b6472;font-size:13.5px">You can do part of it now and come back — the link stays live.</p>`,
    },
    {
      kind: 'docs_missing',
      sql: `SELECT l.* FROM leads l WHERE ${LIVE}
              AND l.lease_info_at IS NOT NULL
              AND date(l.lease_info_at) <= date('now','-2 day')
              AND EXISTS (SELECT 1 FROM driver_docs d WHERE d.driver_id=l.id AND d.status='needed' AND d.kind<>'lease_form')`,
      subject: () => 'A couple of documents left',
      body: (d, c, links, extra) => `
        <p style="margin:0 0 12px;color:#3a4353">You're nearly there — we just need ${extra.missing.length === 1 ? 'one more document' : `${extra.missing.length} more documents`}:</p>
        <ul style="margin:0 0 16px;padding-left:18px;color:#3a4353">${extra.missing.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>
        <p style="margin:0 0 18px"><a href="${links.lease}" style="display:inline-block;background:#2f6fed;color:#fff;text-decoration:none;padding:12px 24px;border-radius:11px;font-weight:700">Upload them here →</a></p>
        <p style="margin:0;color:#5b6472;font-size:13.5px">Photos from your phone are fine as long as they're readable.</p>`,
    },
    {
      // They cleared the carrier's application but no drug test date has ever
      // reached us — so the deadline clock below has nothing to count from and
      // would never fire. Ask them for the date rather than assume there isn't one.
      kind: 'drug_test_unscheduled',
      sql: `SELECT l.* FROM leads l WHERE ${LIVE}
              AND l.confirmation_no IS NOT NULL
              AND l.drug_test_scheduled_at IS NULL AND l.drug_test_done_at IS NULL
              AND date(COALESCE(l.carrier_app_clicked_at, l.carrier_app_sent_at, l.created_at)) <= date('now','-3 day')`,
      subject: () => 'When is your drug test?',
      body: (d, c, links) => `
        <p style="margin:0 0 14px;color:#3a4353">Your application is in with ${c ? esc(c.name) : 'the carrier'} — the next step is the DOT drug test, and it's on a clock once you go.</p>
        <p style="margin:0 0 18px"><a href="${links.lease}" style="display:inline-block;background:#2f6fed;color:#fff;text-decoration:none;padding:12px 24px;border-radius:11px;font-weight:700">Tell us your test date →</a></p>
        <p style="margin:0;color:#5b6472;font-size:13.5px">Once we have the date we'll remind you before the window closes. Haven't been given a place to go yet? Reply and we'll chase it up with them.</p>`,
    },
    {
      kind: 'drug_test',
      sql: `SELECT l.* FROM leads l WHERE ${LIVE}
              AND l.drug_test_due IS NOT NULL AND l.drug_test_done_at IS NULL
              AND date(l.drug_test_due) <= date('now','+2 day')`,
      subject: () => 'Your drug test window is closing',
      body: (d) => `
        <p style="margin:0 0 14px;color:#3a4353">Your drug test needs to be completed by <b>${esc(d.drug_test_due)}</b>. This one has a hard deadline on the carrier's side — miss it and the application has to start over, which nobody wants.</p>
        <p style="margin:0;color:#5b6472;font-size:13.5px">If you can't get there in time, reply today and we'll see what can be done about rescheduling.</p>`,
      urgent: true,
    },
    {
      kind: 'inspection_stale',
      sql: `SELECT l.* FROM leads l WHERE ${LIVE}
              AND l.inspection_date IS NOT NULL AND l.packet_sent_at IS NULL
              AND date(l.inspection_date) <= date('now','-25 day')`,
      subject: () => 'Your inspection is about to age out',
      body: (d, c, links) => `
        <p style="margin:0 0 14px;color:#3a4353">Your federal inspection is dated <b>${esc(d.inspection_date)}</b>, and the carrier needs one from within the last 30 days when your file goes in. It's about to fall outside that window.</p>
        <p style="margin:0 0 18px"><a href="${links.lease}" style="display:inline-block;background:#2f6fed;color:#fff;text-decoration:none;padding:12px 24px;border-radius:11px;font-weight:700">Upload a new inspection →</a></p>
        <p style="margin:0;color:#5b6472;font-size:13.5px">Better to get a fresh one now than have the file bounce over a date.</p>`,
    },
    {
      kind: 'orientation_tomorrow',
      sql: `SELECT l.* FROM leads l WHERE l.nudge_paused = 0 AND l.email IS NOT NULL
              AND l.orientation_at IS NOT NULL AND l.started_at IS NULL
              AND date(l.orientation_at) = date('now','+1 day')`,
      subject: () => 'Orientation is tomorrow',
      body: (d, c) => `
        <p style="margin:0 0 14px;color:#3a4353">Quick reminder — orientation is <b>tomorrow</b>${c && c.orientation_info ? `.<br><span style="color:#5b6472">${esc(c.orientation_info)}</span>` : '.'}</p>
        <p style="margin:0;color:#5b6472;font-size:13.5px">Bring your CDL and your medical card. Anything come up? Reply and we'll let them know.</p>`,
    },
  ];

  for (const rule of RULES) {
    const { results } = await db.prepare(rule.sql).all();
    for (const d of (results || [])) {
      // Rate limit: not too soon, and not too many times.
      const hist = await db.prepare(
        `SELECT COUNT(*) AS n, MAX(created_at) AS last FROM driver_nudges WHERE driver_id=? AND kind=?`
      ).bind(d.id, rule.kind).first();
      const n = (hist && hist.n) || 0;
      if (n >= MAX_PER_KIND) { skipped.push({ driver: d.name, kind: rule.kind, why: 'max reached' }); continue; }
      if (hist && hist.last) {
        const days = (Date.now() - new Date(String(hist.last).replace(' ', 'T') + 'Z')) / 86400000;
        if (days < MIN_GAP_DAYS) { skipped.push({ driver: d.name, kind: rule.kind, why: 'too soon' }); continue; }
      }

      const c = d.carrier_id ? await db.prepare('SELECT * FROM carriers WHERE id=?').bind(d.carrier_id).first() : null;
      const links = {
        lease: d.lease_token ? `${origin}/lease.html?token=${d.lease_token}` : `${origin}/`,
        carrierApp: d.lease_token ? `${origin}/api/apply/go?token=${d.lease_token}` : (c && c.apply_url) || `${origin}/`,
      };
      let extra = {};
      if (rule.kind === 'docs_missing') {
        const dq = await db.prepare("SELECT label, kind FROM driver_docs WHERE driver_id=? AND status='needed' AND kind<>'lease_form'").bind(d.id).all();
        extra.missing = (dq.results || []).map((x) => x.label || x.kind);
        if (!extra.missing.length) continue;
      }

      const first = (d.name || '').split(' ')[0];
      const html = emailShell(rule.subject(d, c), `
        <p style="margin:0 0 6px;font-size:16px">Hi${first ? ' ' + esc(first) : ''},</p>
        ${rule.body(d, c, links, extra)}`, brandName(env));

      if (dry) { sent.push({ driver: d.name, kind: rule.kind, to: d.email, dry: true }); continue; }

      const r = await sendEmail(env, { to: d.email, replyTo: replyToEmail(env), subject: rule.subject(d, c), html });
      await db.prepare('INSERT INTO driver_nudges (id, driver_id, kind, channel, sent_to, ok, detail) VALUES (?,?,?,?,?,?,?)')
        .bind(rid('ng'), d.id, rule.kind, 'email', d.email, r.ok ? 1 : 0,
          r.ok ? null : (r.reason || r.error || 'send failed')).run();
      await db.prepare("UPDATE leads SET last_nudge_at=datetime('now') WHERE id=?").bind(d.id).run();
      sent.push({ driver: d.name, kind: rule.kind, to: d.email, ok: !!r.ok });
    }
  }

  // A short digest of what only a human can move. Sent once a day at most.
  let digest = null;
  if (!dry) {
    const already = await db.prepare(
      "SELECT COUNT(*) AS n FROM driver_nudges WHERE kind='team_digest' AND date(created_at)=date('now')").first();
    if (!already || !already.n) {
      const unseated = await db.prepare(`SELECT name, orientation_at FROM leads
        WHERE started_at IS NULL AND status NOT IN ('Not qualified')
          AND ((orientation_at IS NOT NULL AND date(orientation_at) <= date('now','-1 day'))
            OR (lease_signed_at IS NOT NULL AND date(lease_signed_at) <= date('now','-7 day')))
          AND (seat_checked_at IS NULL OR date(seat_checked_at) <= date('now','-7 day')) LIMIT 25`).all();
      const billable = await db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(fee_amount),0) AS amount
        FROM placements WHERE status='pending' AND invoice_id IS NULL`).first();
      const maxed = await db.prepare(`SELECT l.name, n.kind, COUNT(*) AS c FROM driver_nudges n
        JOIN leads l ON l.id=n.driver_id WHERE l.started_at IS NULL
        GROUP BY n.driver_id, n.kind HAVING c >= ${MAX_PER_KIND} LIMIT 25`).all();
      const us = unseated.results || [], mx = maxed.results || [];
      const money = (v) => '$' + Number(v || 0).toLocaleString('en-US');
      if (us.length || mx.length || (billable && billable.n)) {
        const r = await sendEmail(env, {
          to: teamEmail(env),
          subject: `Recruiting — ${us.length} to confirm, ${(billable && billable.n) || 0} to invoice`,
          html: emailShell('What needs you today', `
            ${billable && billable.n ? `<div style="background:#e9f7f0;border:1px solid #b7e4cd;color:#136c47;border-radius:10px;padding:11px 14px;margin:0 0 14px"><b>${money(billable.amount)}</b> ready to invoice — ${billable.n} seated driver${billable.n === 1 ? '' : 's'}.</div>` : ''}
            ${us.length ? `<p style="margin:0 0 6px;font-weight:700">Did they start?</p><ul style="margin:0 0 14px;padding-left:18px;color:#3a4353">${us.map((x) => `<li>${esc(x.name)}${x.orientation_at ? ` — orientation ${esc(x.orientation_at)}` : ''}</li>`).join('')}</ul><p style="margin:0 0 14px;color:#5b6472;font-size:13px">Until these are answered the placement stays closed and the fee never gets billed.</p>` : ''}
            ${mx.length ? `<p style="margin:0 0 6px;font-weight:700">Emails have stopped working on these — worth a call</p><ul style="margin:0 0 8px;padding-left:18px;color:#3a4353">${mx.map((x) => `<li>${esc(x.name)} — ${esc(String(x.kind).replace(/_/g, ' '))}</li>`).join('')}</ul>` : ''}
            <p style="margin:10px 0 0;color:#5b6472;font-size:13px">Open the CRM to work these.</p>`, brandName(env)),
        });
        await db.prepare('INSERT INTO driver_nudges (id, driver_id, kind, channel, sent_to, ok) VALUES (?,?,?,?,?,?)')
          .bind(rid('ng'), 0, 'team_digest', 'email', teamEmail(env), r.ok ? 1 : 0).run();
        digest = { unseated: us.length, billable: (billable && billable.n) || 0, stuck: mx.length, ok: !!r.ok };
      }
    }
  }

  return json({ ok: true, dry, sent: sent.length, skipped: skipped.length, digest, detail: { sent, skipped } });
}
