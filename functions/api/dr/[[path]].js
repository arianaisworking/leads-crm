// functions/api/dr/[[path]].js
// Driver-recruiting API (team-gated by _middleware.js).
// Carriers, drivers, the document checklist, screening, submit-to-carrier and
// the placement money dashboard.

import { json } from '../../_lib/tenant.js';
import { sendEmail, emailShell, teamEmail, replyToEmail, brandName, esc } from '../../_lib/email.js';
import { screen, parseRules, screenSummary, addBusinessDays, VIOLATIONS } from '../../_lib/screening.js';
import { seedDocs, ensurePlacement, leasePacketHtml, openSecure, secret as mkSecret,
  carrierApplyUrl, recruiterFor } from '../../_lib/recruiting.js';
import { redact } from '../../_lib/vault.js';

function token() {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
const int = (v) => (v == null || v === '' ? null : parseInt(v, 10));
const num = (v) => (v == null || v === '' ? null : Number(v));

// Columns a driver record accepts from the CRM UI.
const DRIVER_COLS = [
  'name', 'phone', 'email', 'city', 'state', 'status', 'carrier_id', 'dob',
  'work_authorized', 'us_citizen', 'cdl_class', 'cdl_state', 'cdl_expires', 'endorsements',
  'dot_medical_expires', 'exp_months_5yr', 'exp_months_3yr', 'flatbed_months_1yr',
  'can_verify_employers', 'has_1099s', 'sap_completed_at', 'positive_test_at',
  'felony', 'misdemeanor', 'background_note', 'truck_year', 'truck_make', 'truck_color',
  'truck_vin', 'truck_plate', 'truck_plate_state', 'owns_truck', 'lienholder',
  'wants_carrier_plates', 'wants_ifta', 'inspection_date', 'has_business', 'business_name',
  'confirmation_no', 'clearinghouse_ok', 'experience_verified', 'preapproved_at',
  'drug_test_scheduled_at', 'drug_test_done_at', 'lease_sent_at', 'lease_signed_at',
  'startup_packet_at', 'orientation_at', 'started_at', 'lost_reason', 'next_touch',
  'recruiter_id', 'gender', 'address', 'home_phone', 'truck_unit_no', 'truck_value',
  'lienholder_address', 'lienholder_phone', 'lienholder_email', 'wants_maintenance',
  'maintenance_weekly', 'maintenance_max', 'business_ein', 'business_owner',
  'business_address', 'business_phone', 'business_email',
];

// Re-screen a driver against their carrier's rubric and persist the verdict.
export async function rescreen(db, driverId) {
  const d = await db.prepare('SELECT * FROM leads WHERE id=?').bind(driverId).first();
  if (!d) return null;
  let rules = null;
  if (d.carrier_id) {
    const c = await db.prepare('SELECT qual_rules FROM carriers WHERE id=?').bind(d.carrier_id).first();
    rules = c ? c.qual_rules : null;
  }
  const s = screen(d, parseRules(rules));
  await db.prepare(`UPDATE leads SET screen_result=?, screen_points=?, screen_detail=?, screened_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
    .bind(s.result, s.points, JSON.stringify(s), driverId).run();
  return s;
}

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;
  const seg = context.params.path || [];
  const [res, id, sub] = seg;
  const method = request.method;

  // ---------- CARRIERS ----------
  if (res === 'carriers') {
    if (method === 'GET' && !id) {
      const { results } = await db.prepare(`
        SELECT c.*, (SELECT COUNT(*) FROM leads l WHERE l.carrier_id=c.id) AS driver_count
          FROM carriers c ORDER BY c.active DESC, c.name`).all();
      return json({ carriers: results || [] });
    }
    if (method === 'GET' && id) {
      const c = await db.prepare('SELECT * FROM carriers WHERE id=?').bind(id).first();
      return json({ carrier: c || null });
    }
    if (method === 'POST' && !id) {
      const b = await request.json();
      if (!b.name) return json({ error: 'name required' }, 400);
      const cid = b.id || 'car_' + token().slice(0, 8);
      await db.prepare(`INSERT INTO carriers (id,name,terminal,mc_number,dot_number,scac,address,city,state,postcode,
          contact_name,contact_email,contact_phone,haul_type,driver_type,needs_own_truck,needs_own_trailer,
          apply_url,orientation_info,qual_rules,doc_checklist,fee_type,fee_amount,fee_trigger,terms,notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        cid, b.name, b.terminal || null, b.mc_number || null, b.dot_number || null, b.scac || null,
        b.address || null, b.city || null, b.state || null, b.postcode || null,
        b.contact_name || null, b.contact_email || null, b.contact_phone || null,
        b.haul_type || null, b.driver_type || 'owner_operator',
        b.needs_own_truck == null ? 1 : (b.needs_own_truck ? 1 : 0),
        b.needs_own_trailer ? 1 : 0,
        b.apply_url || null, b.orientation_info || null,
        b.qual_rules ? JSON.stringify(b.qual_rules) : null,
        b.doc_checklist ? JSON.stringify(b.doc_checklist) : null,
        b.fee_type || 'flat', num(b.fee_amount), b.fee_trigger || 'seated',
        b.terms || null, b.notes || null).run();
      return json({ ok: true, id: cid });
    }
    if (method === 'PATCH' && id) {
      const b = await request.json();
      const cols = ['name', 'terminal', 'mc_number', 'dot_number', 'scac', 'address', 'city', 'state', 'postcode',
        'contact_name', 'contact_email', 'contact_phone', 'haul_type', 'driver_type', 'needs_own_truck',
        'needs_own_trailer', 'apply_url', 'apply_source_param', 'orientation_info', 'fee_type',
        'fee_amount', 'fee_trigger', 'terms', 'active', 'notes', 'billing_email', 'payment_terms'];
      const sets = [], vals = [];
      for (const c of cols) if (c in b) { sets.push(`${c}=?`); vals.push(b[c]); }
      for (const jcol of ['qual_rules', 'doc_checklist'])
        if (jcol in b) { sets.push(`${jcol}=?`); vals.push(b[jcol] ? (typeof b[jcol] === 'string' ? b[jcol] : JSON.stringify(b[jcol])) : null); }
      if (!sets.length) return json({ error: 'nothing to update' }, 400);
      vals.push(id);
      await db.prepare(`UPDATE carriers SET ${sets.join(', ')} WHERE id=?`).bind(...vals).run();
      return json({ ok: true });
    }
    if (method === 'DELETE' && id) { await db.prepare('DELETE FROM carriers WHERE id=?').bind(id).run(); return json({ ok: true }); }
  }

  // ---------- REFERENCE: the violation chart (so the UI never hardcodes it) ----------
  if (res === 'violations' && method === 'GET') {
    return json({ violations: Object.entries(VIOLATIONS).map(([code, v]) => ({ code, ...v })) });
  }

  // ---------- DRIVERS ----------
  if (res === 'drivers' && !sub) {
    if (method === 'GET' && !id) {
      const { results } = await db.prepare(`
        SELECT l.*, c.name AS carrier_name,
               (SELECT COUNT(*) FROM driver_docs d WHERE d.driver_id=l.id AND d.status='needed') AS docs_needed
          FROM leads l LEFT JOIN carriers c ON c.id=l.carrier_id
         ORDER BY l.created_at DESC LIMIT 1000`).all();
      return json({ drivers: results || [] });
    }
    if (method === 'GET' && id) {
      const d = await db.prepare('SELECT * FROM leads WHERE id=?').bind(int(id)).first();
      if (!d) return json({ error: 'not found' }, 404);
      const docs = await db.prepare('SELECT * FROM driver_docs WHERE driver_id=? ORDER BY created_at').bind(d.id).all();
      const notes = await db.prepare('SELECT * FROM notes WHERE lead_id=? ORDER BY created_at DESC').bind(d.id).all();
      return json({ driver: d, docs: docs.results || [], notes: notes.results || [] });
    }
    if (method === 'POST' && !id) {
      const b = await request.json();
      if (!b.name) return json({ error: 'name required' }, 400);
      const cols = DRIVER_COLS.filter((c) => c in b);
      const r = await db.prepare(
        `INSERT INTO leads (${['client_id', 'source', ...cols].join(',')}) VALUES (${['?', '?', ...cols.map(() => '?')].join(',')})`
      ).bind('house', b.source || 'manual', ...cols.map((c) => b[c])).run();
      const newId = r.meta.last_row_id;
      if (b.violations) await db.prepare('UPDATE leads SET violations=? WHERE id=?').bind(JSON.stringify(b.violations), newId).run();
      await rescreen(db, newId);
      return json({ ok: true, id: newId });
    }
    if (method === 'PATCH' && id) {
      const b = await request.json();
      const sets = [], vals = [];
      for (const c of DRIVER_COLS) if (c in b) { sets.push(`${c}=?`); vals.push(b[c]); }
      if ('violations' in b) { sets.push('violations=?'); vals.push(typeof b.violations === 'string' ? b.violations : JSON.stringify(b.violations || [])); }
      // Scheduling the drug test starts the carrier's business-day clock.
      if (b.drug_test_scheduled_at) {
        const d = await db.prepare('SELECT carrier_id FROM leads WHERE id=?').bind(int(id)).first();
        let days = 7;
        if (d && d.carrier_id) {
          const c = await db.prepare('SELECT qual_rules FROM carriers WHERE id=?').bind(d.carrier_id).first();
          days = parseRules(c && c.qual_rules).drug_test_business_days || 7;
        }
        sets.push('drug_test_due=?'); vals.push(addBusinessDays(b.drug_test_scheduled_at, days));
      }
      if (!sets.length) return json({ error: 'nothing to update' }, 400);
      sets.push("updated_at=datetime('now')");
      vals.push(int(id));
      await db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id=?`).bind(...vals).run();
      // Seating the driver is what we actually get paid for — open the placement
      // as soon as they start, so Money reflects reality without extra clicks.
      if (b.started_at || b.status === 'Rolling') {
        const d = await db.prepare('SELECT * FROM leads WHERE id=?').bind(int(id)).first();
        if (d && d.carrier_id) {
          const c = await db.prepare('SELECT * FROM carriers WHERE id=?').bind(d.carrier_id).first();
          if (c && c.fee_trigger !== 'submitted')
            await ensurePlacement(db, d, c, c.fee_trigger || 'seated', { seated_at: b.started_at || new Date().toISOString().slice(0, 10) });
        }
      }
      const s = await rescreen(db, int(id));
      return json({ ok: true, screen: s });
    }
    if (method === 'DELETE' && id) {
      await db.prepare('DELETE FROM driver_docs WHERE driver_id=?').bind(int(id)).run();
      await db.prepare('DELETE FROM placements WHERE driver_id=?').bind(int(id)).run();
      await db.prepare('DELETE FROM leads WHERE id=?').bind(int(id)).run();
      return json({ ok: true });
    }
  }

  // ---------- RE-SCREEN ON DEMAND ----------
  if (res === 'drivers' && sub === 'screen' && method === 'POST') {
    const s = await rescreen(db, int(id));
    if (!s) return json({ error: 'driver not found' }, 404);
    return json({ ok: true, screen: s, summary: screenSummary(s) });
  }

  // ---------- APPLICATION LINK (send the driver our own application) ----------
  if (res === 'drivers' && sub === 'apply-link' && method === 'POST') {
    const d = await db.prepare('SELECT id, apply_token FROM leads WHERE id=?').bind(int(id)).first();
    if (!d) return json({ error: 'driver not found' }, 404);
    let tok = d.apply_token;
    if (!tok) { tok = token(); await db.prepare('UPDATE leads SET apply_token=? WHERE id=?').bind(tok, d.id).run(); }
    const origin = new URL(request.url).origin;
    return json({ ok: true, token: tok, url: `${origin}/apply.html?token=${tok}` });
  }

  // ---------- EMAIL THE APPLICATION TO THE DRIVER ----------
  if (res === 'drivers' && sub === 'email-apply' && method === 'POST') {
    const d = await db.prepare('SELECT id, name, email, apply_token FROM leads WHERE id=?').bind(int(id)).first();
    if (!d) return json({ error: 'driver not found' }, 404);
    if (!d.email) return json({ error: 'This driver has no email on file. Add one first, or use “Get application link”.' }, 400);
    let tok = d.apply_token;
    if (!tok) { tok = token(); await db.prepare('UPDATE leads SET apply_token=? WHERE id=?').bind(tok, d.id).run(); }
    const link = `${new URL(request.url).origin}/apply.html?token=${tok}`;
    const first = (d.name || '').split(' ')[0];
    const r = await sendEmail(env, {
      to: d.email,
      replyTo: replyToEmail(env),
      subject: 'Your driver application',
      html: emailShell('Driver application', `
        <p style="margin:0 0 6px;font-size:16px">Hi${first ? ' ' + esc(first) : ''},</p>
        <p style="margin:0 0 14px;color:#3a4353">Here's your application. It takes about five minutes — CDL, experience, your truck, and your driving record. We check it against the carrier's qualification standards straight away, so you'll know where you stand before anything is submitted.</p>
        <p style="margin:0 0 18px"><a href="${link}" style="display:inline-block;background:#2f6fed;color:#fff;text-decoration:none;padding:12px 24px;border-radius:11px;font-weight:700">Start your application →</a></p>
        <p style="margin:0;color:#5b6472;font-size:13px">Answer honestly — everything gets verified against your MVR and the Clearinghouse, so a surprise later costs you the seat. Questions? Just reply to this email.</p>`, brandName(env)),
    });
    if (!r.ok && !r.skipped) return json({ error: 'Could not send the email. ' + (r.error || '') }, 502);
    return json({ ok: true, sent_to: d.email, emailed: !!r.ok, url: link });
  }

  // ---------- DOCUMENT CHECKLIST ----------
  if (res === 'drivers' && sub === 'docs') {
    const driverId = int(id);
    if (method === 'GET') {
      const { results } = await db.prepare('SELECT * FROM driver_docs WHERE driver_id=? ORDER BY created_at').bind(driverId).all();
      return json({ docs: results || [] });
    }
    if (method === 'POST') {                       // seed from the carrier template
      const d = await db.prepare('SELECT * FROM leads WHERE id=?').bind(driverId).first();
      if (!d) return json({ error: 'driver not found' }, 404);
      const c = d.carrier_id ? await db.prepare('SELECT * FROM carriers WHERE id=?').bind(d.carrier_id).first() : null;
      if (!c) return json({ error: 'Assign a carrier first — the checklist comes from the carrier.' }, 400);
      const added = await seedDocs(db, d, c);
      const { results } = await db.prepare('SELECT * FROM driver_docs WHERE driver_id=? ORDER BY created_at').bind(driverId).all();
      return json({ ok: true, added, docs: results || [] });
    }
  }
  if (res === 'docs' && id && method === 'PATCH') {
    const b = await request.json();
    const sets = [], vals = [];
    for (const c of ['status', 'doc_date', 'note', 'label', 'file_key', 'file_name']) if (c in b) { sets.push(`${c}=?`); vals.push(b[c]); }
    if (!sets.length) return json({ error: 'nothing to update' }, 400);
    sets.push("updated_at=datetime('now')"); vals.push(id);
    await db.prepare(`UPDATE driver_docs SET ${sets.join(', ')} WHERE id=?`).bind(...vals).run();
    // The federal inspection date is also a screening input — keep them in sync.
    if (b.doc_date) {
      const row = await db.prepare('SELECT driver_id, kind FROM driver_docs WHERE id=?').bind(id).first();
      if (row && row.kind === 'inspection') {
        await db.prepare('UPDATE leads SET inspection_date=? WHERE id=?').bind(b.doc_date, row.driver_id).run();
        await rescreen(db, row.driver_id);
      }
    }
    return json({ ok: true });
  }
  if (res === 'docs' && id && method === 'DELETE') {
    await db.prepare('DELETE FROM driver_docs WHERE id=?').bind(id).run();
    return json({ ok: true });
  }

  // ---------- SUBMIT TO CARRIER ----------
  if (res === 'drivers' && sub === 'submit' && method === 'POST') {
    const driverId = int(id);
    const d = await db.prepare('SELECT * FROM leads WHERE id=?').bind(driverId).first();
    if (!d) return json({ error: 'driver not found' }, 404);
    if (!d.carrier_id) return json({ error: 'Assign a carrier first.' }, 400);
    const c = await db.prepare('SELECT * FROM carriers WHERE id=?').bind(d.carrier_id).first();
    if (!c) return json({ error: 'carrier not found' }, 404);
    if (!c.contact_email) return json({ error: 'That carrier has no contact email on file. Add one on the Carriers tab.' }, 400);

    const s = await rescreen(db, driverId);
    const body = await request.json().catch(() => ({}));
    // Never submit a disqualified driver by accident — it costs the relationship.
    if (s.result === 'disqualified' && !body.force)
      return json({ error: 'This driver does not meet the carrier’s standards: ' + s.blockers[0], blockers: s.blockers, needs_force: true }, 400);

    const rules = parseRules(c.qual_rules);
    const row = (k, v) => v ? `<tr><td style="padding:4px 12px 4px 0;color:#5b6472;white-space:nowrap">${esc(k)}</td><td style="padding:4px 0;font-weight:600">${esc(v)}</td></tr>` : '';
    const truck = [d.truck_year, d.truck_make, d.truck_color].filter(Boolean).join(' ');
    const verdict = s.result === 'qualified'
      ? `<div style="background:#e9f7f0;border:1px solid #b7e4cd;color:#136c47;border-radius:10px;padding:10px 14px;margin:0 0 16px"><b>Pre-qualified</b> against your criteria — ${s.points} point${s.points === 1 ? '' : 's'} on a ${rules.points.moving_violation_years}-year moving violation / ${rules.points.accident_years}-year accident review.</div>`
      : `<div style="background:#fff6e5;border:1px solid #f5d9a0;color:#8a5a00;border-radius:10px;padding:10px 14px;margin:0 0 16px"><b>${s.points} points — needs Safety Management review.</b><br>${s.reviews.map(esc).join('<br>')}</div>`;

    const inner = `
      <p style="margin:0 0 6px;font-size:16px">Hi${c.contact_name ? ' ' + esc(c.contact_name.split(' ')[0]) : ''}, we'd like to submit a driver for onboarding.</p>
      ${verdict}
      <table style="font-size:14px;margin:0 0 16px">
        ${row('Driver', d.name)}${row('Phone', d.phone)}${row('Email', d.email)}
        ${row('Location', [d.city, d.state].filter(Boolean).join(', '))}
        ${row('CDL', d.cdl_class ? `Class ${d.cdl_class}${d.cdl_state ? ' · ' + d.cdl_state : ''}${d.cdl_expires ? ' · exp ' + d.cdl_expires : ''}` : '')}
        ${row('Endorsements', d.endorsements)}
        ${row('DOT medical', d.dot_medical_expires ? 'valid to ' + d.dot_medical_expires : '')}
        ${row('Class A experience', d.exp_months_5yr ? `${d.exp_months_5yr} months in 5 years (${d.exp_months_3yr || 0} in the last 3)` : '')}
        ${row('Work authorised', d.work_authorized ? 'Yes' : '')}
        ${row('Truck', truck)}${row('VIN', d.truck_vin)}${row('Plate', d.truck_plate ? `${d.truck_plate}${d.truck_plate_state ? ' (' + d.truck_plate_state + ')' : ''}` : '')}
        ${row('Federal inspection', d.inspection_date)}
        ${row('Plate program', d.wants_carrier_plates ? 'Yes — title & 2290 to follow' : '')}
        ${row('IFTA', d.wants_ifta ? 'Yes' : '')}
        ${row('Business entity', d.has_business ? (d.business_name || 'Yes — lease in the business name') : '')}
      </table>
      ${s.reviews.length && s.result === 'qualified' ? '' : ''}
      ${d.background_note ? `<p style="margin:0 0 14px;color:#3a4353"><b>Background note:</b> ${esc(d.background_note)}</p>` : ''}
      ${body.message ? `<p style="margin:0 0 14px;color:#3a4353">${esc(body.message)}</p>` : ''}
      <p style="margin:0;color:#5b6472;font-size:13px">We've screened this driver against your published qualification criteria before sending. Reply with a confirmation number and we'll walk them through the Clearinghouse query, the drug test and the document pack.</p>`;

    const r = await sendEmail(env, {
      to: c.contact_email,
      replyTo: replyToEmail(env),
      subject: `Driver submission — ${d.name || ''}`,
      html: emailShell('Driver submission', inner, brandName(env)),
    });
    if (!r.ok && !r.skipped) return json({ error: 'Could not send the email. ' + (r.error || '') }, 502);

    await db.prepare("UPDATE leads SET status='Application submitted', submitted_at=datetime('now'), updated_at=datetime('now') WHERE id=?").bind(driverId).run();
    const carrierRow = c;
    if (carrierRow.fee_trigger === 'submitted') await ensurePlacement(db, d, carrierRow, 'submitted');
    await seedDocs(db, d, c);
    return json({ ok: true, sent_to: c.contact_email, emailed: !!r.ok, screen: s });
  }

  // ---------- PLACEMENTS ----------
  if (res === 'placements') {
    if (method === 'GET' && !id) {
      const { results } = await db.prepare(`
        SELECT p.*, l.name AS driver_name, c.name AS carrier_name
          FROM placements p
          LEFT JOIN leads l ON l.id=p.driver_id
          LEFT JOIN carriers c ON c.id=p.carrier_id
         ORDER BY p.created_at DESC LIMIT 500`).all();
      return json({ placements: results || [] });
    }
    if (method === 'POST') {
      const b = await request.json();
      if (!b.driver_id || !b.carrier_id) return json({ error: 'driver_id and carrier_id required' }, 400);
      const d = await db.prepare('SELECT * FROM leads WHERE id=?').bind(int(b.driver_id)).first();
      const c = await db.prepare('SELECT * FROM carriers WHERE id=?').bind(b.carrier_id).first();
      if (!d || !c) return json({ error: 'driver or carrier not found' }, 404);
      const p = await ensurePlacement(db, d, c, b.trigger_met || c.fee_trigger || 'seated', b);
      return json({ ok: true, id: p });
    }
    if (method === 'PATCH' && id) {
      const b = await request.json();
      const sets = [], vals = [];
      for (const c of ['fee_type', 'fee_amount', 'status', 'trigger_met', 'seated_at', 'notes']) if (c in b) { sets.push(`${c}=?`); vals.push(b[c]); }
      if (b.status === 'invoiced') sets.push("invoiced_at=datetime('now')");
      if (b.status === 'paid') sets.push("paid_at=datetime('now')");
      if (!sets.length) return json({ error: 'nothing to update' }, 400);
      vals.push(id);
      await db.prepare(`UPDATE placements SET ${sets.join(', ')} WHERE id=?`).bind(...vals).run();
      return json({ ok: true });
    }
    if (method === 'DELETE' && id) { await db.prepare('DELETE FROM placements WHERE id=?').bind(id).run(); return json({ ok: true }); }
  }

  // ---------- MONEY ----------
  if (res === 'money' && method === 'GET') {
    const tot = await db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN status='pending'  THEN fee_amount ELSE 0 END),0) AS pending,
        COALESCE(SUM(CASE WHEN status='invoiced' THEN fee_amount ELSE 0 END),0) AS invoiced,
        COALESCE(SUM(CASE WHEN status='paid'     THEN fee_amount ELSE 0 END),0) AS paid,
        COUNT(*) AS placements
      FROM placements`).first();
    const byCarrier = await db.prepare(`SELECT c.name AS carrier, COUNT(*) AS n,
        COALESCE(SUM(p.fee_amount),0) AS total,
        COALESCE(SUM(CASE WHEN p.status='paid' THEN p.fee_amount ELSE 0 END),0) AS paid
      FROM placements p LEFT JOIN carriers c ON c.id=p.carrier_id GROUP BY p.carrier_id ORDER BY total DESC`).all();
    const funnel = await db.prepare(`SELECT status, COUNT(*) AS n FROM leads GROUP BY status`).all();
    // What each of you is owed and has been paid, from the per-placement splits.
    const byRecruiter = await db.prepare(`SELECT r.id, r.name, r.share_pct,
        COALESCE(SUM(CASE WHEN s.status='pending' THEN s.amount ELSE 0 END),0) AS owed,
        COALESCE(SUM(CASE WHEN s.status='paid'    THEN s.amount ELSE 0 END),0) AS paid,
        COUNT(s.id) AS placements
      FROM recruiters r LEFT JOIN placement_splits s ON s.recruiter_id=r.id
      GROUP BY r.id ORDER BY r.name`).all();
    return json({ totals: tot || {}, by_carrier: byCarrier.results || [],
      by_recruiter: byRecruiter.results || [], funnel: funnel.results || [] });
  }

  // ---------- STATS (nav counters + the "needs attention" queue) ----------
  if (res === 'stats' && method === 'GET') {
    const s = await db.prepare(`SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN screen_result='qualified'    THEN 1 ELSE 0 END),0) AS qualified,
        COALESCE(SUM(CASE WHEN screen_result='review'       THEN 1 ELSE 0 END),0) AS review,
        COALESCE(SUM(CASE WHEN screen_result='disqualified' THEN 1 ELSE 0 END),0) AS disqualified,
        COALESCE(SUM(CASE WHEN status='Rolling'             THEN 1 ELSE 0 END),0) AS rolling,
        COALESCE(SUM(CASE WHEN applied_at IS NOT NULL       THEN 1 ELSE 0 END),0) AS applied
      FROM leads`).first();
    // Anything with a clock running out.
    const alerts = await db.prepare(`SELECT id, name, status, drug_test_due, inspection_date, dot_medical_expires
        FROM leads
       WHERE (drug_test_due IS NOT NULL AND drug_test_done_at IS NULL AND date(drug_test_due) <= date('now','+2 day'))
          OR (inspection_date IS NOT NULL AND started_at IS NULL AND date(inspection_date) <= date('now','-23 day'))
          OR (dot_medical_expires IS NOT NULL AND date(dot_medical_expires) <= date('now','+30 day'))
       ORDER BY drug_test_due LIMIT 50`).all();
    // The quiet failure mode: they opened the carrier's application and never
    // came back with a confirmation number. Nothing else surfaces these.
    const stalled = await db.prepare(`SELECT id, name, carrier_app_sent_at, carrier_app_clicked_at, carrier_app_clicks
        FROM leads
       WHERE screen_result IN ('qualified','review') AND confirmation_no IS NULL AND started_at IS NULL
         AND ((carrier_app_clicked_at IS NOT NULL AND date(carrier_app_clicked_at) <= date('now','-3 day'))
           OR (carrier_app_sent_at IS NOT NULL AND carrier_app_clicked_at IS NULL AND date(carrier_app_sent_at) <= date('now','-2 day')))
       ORDER BY carrier_app_sent_at LIMIT 50`).all();
    // Orientation has been and gone and nobody recorded whether they started.
    // Each unanswered row is a fee we may have earned and never billed.
    const unseated = await db.prepare(`SELECT id, name, orientation_at, lease_signed_at, carrier_id
        FROM leads
       WHERE started_at IS NULL AND status NOT IN ('Not qualified')
         AND ((orientation_at IS NOT NULL AND date(orientation_at) <= date('now','-1 day'))
           OR (lease_signed_at IS NOT NULL AND date(lease_signed_at) <= date('now','-7 day')))
         AND (seat_checked_at IS NULL OR date(seat_checked_at) <= date('now','-7 day'))
       ORDER BY orientation_at LIMIT 50`).all();
    // Money sitting in the CRM waiting to be billed.
    const bill = await db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(fee_amount),0) AS amount
        FROM placements WHERE status='pending' AND invoice_id IS NULL`).first();
    return json({ ...(s || {}), alerts: alerts.results || [], stalled: stalled.results || [],
      unseated: unseated.results || [], billable: bill || { n: 0, amount: 0 } });
  }

  // ---------- RECRUITERS + THE SPLIT ----------
  if (res === 'recruiters') {
    if (method === 'GET' && !id) {
      const { results } = await db.prepare(`
        SELECT r.*,
          (SELECT COALESCE(SUM(s.amount),0) FROM placement_splits s WHERE s.recruiter_id=r.id AND s.status='pending') AS owed,
          (SELECT COALESCE(SUM(s.amount),0) FROM placement_splits s WHERE s.recruiter_id=r.id AND s.status='paid')    AS earned
        FROM recruiters r ORDER BY r.name`).all();
      return json({ recruiters: results || [] });
    }
    if (method === 'POST') {
      const b = await request.json();
      if (!b.name) return json({ error: 'name required' }, 400);
      const nid = b.id || mkSecret().slice(0, 8);
      await db.prepare('INSERT INTO recruiters (id,name,email,share_pct,source_tag,notes) VALUES (?,?,?,?,?,?)')
        .bind(nid, b.name, b.email || null, b.share_pct != null ? Number(b.share_pct) : 50, b.source_tag || null, b.notes || null).run();
      return json({ ok: true, id: nid });
    }
    if (method === 'PATCH' && id) {
      const b = await request.json();
      const sets = [], vals = [];
      for (const c of ['name', 'email', 'share_pct', 'source_tag', 'active', 'notes']) if (c in b) { sets.push(`${c}=?`); vals.push(b[c]); }
      if (!sets.length) return json({ error: 'nothing to update' }, 400);
      vals.push(id);
      await db.prepare(`UPDATE recruiters SET ${sets.join(', ')} WHERE id=?`).bind(...vals).run();
      return json({ ok: true });
    }
    if (method === 'DELETE' && id) { await db.prepare('DELETE FROM recruiters WHERE id=?').bind(id).run(); return json({ ok: true }); }
  }

  if (res === 'splits') {
    if (method === 'GET') {
      const { results } = await db.prepare(`
        SELECT s.*, r.name AS recruiter_name, l.name AS driver_name, c.name AS carrier_name, p.status AS placement_status
          FROM placement_splits s
          LEFT JOIN recruiters r ON r.id=s.recruiter_id
          LEFT JOIN placements p ON p.id=s.placement_id
          LEFT JOIN leads l ON l.id=p.driver_id
          LEFT JOIN carriers c ON c.id=p.carrier_id
         ORDER BY s.created_at DESC LIMIT 500`).all();
      return json({ splits: results || [] });
    }
    if (method === 'PATCH' && id) {
      const b = await request.json();
      const sets = [], vals = [];
      for (const c of ['amount', 'share_pct', 'status']) if (c in b) { sets.push(`${c}=?`); vals.push(b[c]); }
      if (b.status === 'paid') sets.push("paid_at=datetime('now')");
      if (!sets.length) return json({ error: 'nothing to update' }, 400);
      vals.push(id);
      await db.prepare(`UPDATE placement_splits SET ${sets.join(', ')} WHERE id=?`).bind(...vals).run();
      return json({ ok: true });
    }
  }

  // ---------- LEASE FORM: link, send, review ----------
  if (res === 'drivers' && sub === 'lease-link' && method === 'POST') {
    const d = await db.prepare('SELECT id, lease_token FROM leads WHERE id=?').bind(int(id)).first();
    if (!d) return json({ error: 'driver not found' }, 404);
    let t = d.lease_token;
    if (!t) { t = mkSecret(); await db.prepare('UPDATE leads SET lease_token=? WHERE id=?').bind(t, d.id).run(); }
    return json({ ok: true, url: `${new URL(request.url).origin}/lease.html?token=${t}` });
  }

  if (res === 'drivers' && sub === 'send-lease' && method === 'POST') {
    const d = await db.prepare('SELECT * FROM leads WHERE id=?').bind(int(id)).first();
    if (!d) return json({ error: 'driver not found' }, 404);
    if (!d.email) return json({ error: 'This driver has no email on file. Add one, or use “Get lease link”.' }, 400);
    const c = d.carrier_id ? await db.prepare('SELECT * FROM carriers WHERE id=?').bind(d.carrier_id).first() : null;
    if (!c) return json({ error: 'Assign a carrier first — the document list comes from them.' }, 400);
    let t = d.lease_token;
    if (!t) { t = mkSecret(); await db.prepare('UPDATE leads SET lease_token=? WHERE id=?').bind(t, d.id).run(); }
    await seedDocs(db, d, c);
    const link = `${new URL(request.url).origin}/lease.html?token=${t}`;
    const first = (d.name || '').split(' ')[0];
    const r = await sendEmail(env, {
      to: d.email, replyTo: replyToEmail(env),
      subject: 'Your lease information & documents',
      html: emailShell('Next step: lease info & documents', `
        <p style="margin:0 0 6px;font-size:16px">Hi${first ? ' ' + esc(first) : ''},</p>
        <p style="margin:0 0 14px;color:#3a4353">Here's everything we need to get your lease agreement prepared. It's one page — your details, your truck, and a few documents you can photograph with your phone.</p>
        <p style="margin:0 0 18px"><a href="${link}" style="display:inline-block;background:#2f6fed;color:#fff;text-decoration:none;padding:12px 24px;border-radius:11px;font-weight:700">Open your onboarding page →</a></p>
        <p style="margin:0 0 10px;color:#5b6472;font-size:13.5px"><b>Documents needed:</b> truck registration, a photo of your ECM port, a federal inspection dated within the last 30 days, and a voided check for direct deposit.</p>
        <p style="margin:0;color:#5b6472;font-size:13px">Do what you can now — the link stays live, so you can come back for the rest. Questions? Just reply.</p>`, brandName(env)),
    });
    if (!r.ok && !r.skipped) return json({ error: 'Could not send the email. ' + (r.error || '') }, 502);
    await db.prepare("UPDATE leads SET onboarding_sent_at=datetime('now'), updated_at=datetime('now') WHERE id=?").bind(d.id).run();
    return json({ ok: true, emailed: !!r.ok, sent_to: d.email, url: link });
  }

  // ---------- THE CARRIER'S OWN APPLICATION (tracked hand-off) ----------
  if (res === 'drivers' && sub === 'carrier-app' && method === 'POST') {
    const d = await db.prepare('SELECT * FROM leads WHERE id=?').bind(int(id)).first();
    if (!d) return json({ error: 'driver not found' }, 404);
    const c = d.carrier_id ? await db.prepare('SELECT * FROM carriers WHERE id=?').bind(d.carrier_id).first() : null;
    if (!c || !c.apply_url) return json({ error: 'This carrier has no application URL on file. Add one on the Carriers tab.' }, 400);
    let t = d.lease_token;
    if (!t) { t = mkSecret(); await db.prepare('UPDATE leads SET lease_token=? WHERE id=?').bind(t, d.id).run(); }
    const origin = new URL(request.url).origin;
    const tracked = `${origin}/api/apply/go?token=${t}`;
    const rec = await recruiterFor(db, d);
    let emailed = false;
    if (d.email && !(await request.json().catch(() => ({}))).link_only) {
      const first = (d.name || '').split(' ')[0];
      const r = await sendEmail(env, {
        to: d.email, replyTo: replyToEmail(env),
        subject: `Your application with ${c.name}`,
        html: emailShell("The carrier's application", `
          <p style="margin:0 0 6px;font-size:16px">Hi${first ? ' ' + esc(first) : ''},</p>
          <p style="margin:0 0 14px;color:#3a4353">Here's the application that goes to ${esc(c.name)}'s Safety team. It's about 20 minutes — have your employment history handy, since they verify it. When you're done you'll get a confirmation number; send it to us and we'll take it from there.</p>
          <p style="margin:0 0 18px"><a href="${tracked}" style="display:inline-block;background:#2f6fed;color:#fff;text-decoration:none;padding:12px 24px;border-radius:11px;font-weight:700">Open the application →</a></p>
          <p style="margin:0;color:#5b6472;font-size:13px">Any trouble with it, just reply — we'll walk you through it.</p>`, brandName(env)),
      });
      emailed = !!r.ok;
    }
    await db.prepare("UPDATE leads SET carrier_app_sent_at=datetime('now'), updated_at=datetime('now') WHERE id=?").bind(d.id).run();
    return json({ ok: true, url: tracked, target: carrierApplyUrl(c, rec), emailed, sent_to: d.email || null,
      attributed: !!(rec && rec.source_tag) });
  }

  // What the team may see of the lease form: everything except the vault.
  if (res === 'drivers' && sub === 'lease' && method === 'GET') {
    const d = await db.prepare('SELECT * FROM leads WHERE id=?').bind(int(id)).first();
    if (!d) return json({ error: 'driver not found' }, 404);
    const sec = await openSecure(env, d);
    return json({ ok: true, done: !!d.lease_info_at, secure: redact(sec), purged: !!d.secure_purged_at });
  }

  // ---------- SEND THE FULL PACKET TO THE CARRIER ----------
  // The completed lease form plus every collected document, in one email.
  if (res === 'drivers' && sub === 'packet' && method === 'POST') {
    const driverId = int(id);
    const d = await db.prepare('SELECT * FROM leads WHERE id=?').bind(driverId).first();
    if (!d) return json({ error: 'driver not found' }, 404);
    if (!d.carrier_id) return json({ error: 'Assign a carrier first.' }, 400);
    const c = await db.prepare('SELECT * FROM carriers WHERE id=?').bind(d.carrier_id).first();
    if (!c || !c.contact_email) return json({ error: 'That carrier has no contact email on file.' }, 400);
    if (!d.lease_info_at) return json({ error: 'The driver has not completed their lease form yet.' }, 400);

    const docsQ = await db.prepare('SELECT * FROM driver_docs WHERE driver_id=? ORDER BY created_at').bind(driverId).all();
    const docs = docsQ.results || [];
    const missing = docs.filter((x) => x.status !== 'received');
    const body = await request.json().catch(() => ({}));
    if (missing.length && !body.force)
      return json({ error: `Still missing: ${missing.map((m) => m.label || m.kind).join(', ')}.`, missing: missing.map((m) => m.label || m.kind), needs_force: true }, 400);

    // Flag a stale federal inspection before the carrier has to.
    const insp = docs.find((x) => x.kind === 'inspection');
    let staleNote = '';
    if (insp && insp.doc_date) {
      const days = Math.floor((Date.now() - new Date(insp.doc_date + 'T00:00:00Z')) / 86400000);
      if (days > 30) staleNote = `<div style="background:#fdecec;border:1px solid #f5c2c2;color:#9b2c2c;border-radius:10px;padding:10px 14px;margin:0 0 14px"><b>Note:</b> the federal inspection on file is dated ${esc(insp.doc_date)} (${days} days old). A fresh one is being obtained.</div>`;
    }

    const sec = await openSecure(env, d);
    const origin = new URL(request.url).origin;
    const docRows = docs.map((x) => `<tr>
        <td style="padding:5px 12px 5px 0;font-size:13px">${esc(x.label || x.kind)}</td>
        <td style="padding:5px 12px 5px 0;font-size:13px;color:${x.status === 'received' ? '#137a52' : '#9b2c2c'};font-weight:600">${x.status === 'received' ? 'attached' : 'outstanding'}</td>
        <td style="padding:5px 0;font-size:13px">${x.file_key ? `<a href="${origin}/api/dr/file?key=${encodeURIComponent(x.file_key)}">${esc(x.file_name || 'view')}</a>` : ''}${x.doc_date ? ` <span style="color:#8a95a6">${esc(x.doc_date)}</span>` : ''}</td></tr>`).join('');

    const r = await sendEmail(env, {
      to: c.contact_email, replyTo: replyToEmail(env),
      subject: `Lease packet — ${d.name || ''}`,
      html: emailShell('Driver lease packet', `
        <p style="margin:0 0 6px;font-size:16px">Hi${c.contact_name ? ' ' + esc(c.contact_name.split(' ')[0]) : ''}, here's the completed packet for <b>${esc(d.name || '')}</b>.</p>
        ${staleNote}
        ${leasePacketHtml(d, sec, c)}
        <div style="margin:16px 0 0">
          <div style="font-weight:800;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#2f6fed;border-bottom:1px solid #e3e8ef;padding-bottom:5px;margin-bottom:8px">Documents</div>
          <table style="width:100%">${docRows}</table>
        </div>
        ${body.message ? `<p style="margin:16px 0 0;color:#3a4353">${esc(body.message)}</p>` : ''}
        <p style="margin:16px 0 0;color:#5b6472;font-size:13px">Document links open the file directly. Reply here if anything else is needed and we'll chase it with the driver.</p>`, brandName(env)),
    });
    if (!r.ok && !r.skipped) return json({ error: 'Could not send the email. ' + (r.error || '') }, 502);
    await db.prepare("UPDATE leads SET packet_sent_at=datetime('now'), status=CASE WHEN status IN ('Documents','Pre-approved','Drug test') THEN 'Lease sent' ELSE status END, updated_at=datetime('now') WHERE id=?").bind(driverId).run();
    return json({ ok: true, sent_to: c.contact_email, emailed: !!r.ok, missing: missing.length });
  }

  // Destroy the sealed fields once the lease is signed — we have no further use
  // for them and no reason to keep holding them.
  if (res === 'drivers' && sub === 'purge-secure' && method === 'POST') {
    await db.prepare("UPDATE leads SET lease_secure=NULL, secure_purged_at=datetime('now') WHERE id=?").bind(int(id)).run();
    return json({ ok: true });
  }

  // ---------- INVOICING THE CARRIER ----------
  // Built entirely from our own records: the drivers we seated, at the fee each
  // placement was opened with. The carrier's systems are corroboration, not the
  // source of truth.
  if (res === 'invoices') {
    if (method === 'GET' && !id) {
      const { results } = await db.prepare(`
        SELECT i.*, c.name AS carrier_name FROM carrier_invoices i
        LEFT JOIN carriers c ON c.id=i.carrier_id
        ORDER BY i.created_at DESC LIMIT 200`).all();
      return json({ invoices: results || [] });
    }
    if (method === 'GET' && id) {
      const inv = await db.prepare('SELECT * FROM carrier_invoices WHERE id=?').bind(id).first();
      if (!inv) return json({ error: 'not found' }, 404);
      return json({ invoice: inv });
    }
    if (method === 'PATCH' && id) {
      const b = await request.json();
      const sets = [], vals = [];
      for (const c of ['status', 'notes', 'number', 'amount']) if (c in b) { sets.push(`${c}=?`); vals.push(b[c]); }
      if (b.status === 'paid') sets.push("paid_at=datetime('now')");
      if (!sets.length) return json({ error: 'nothing to update' }, 400);
      vals.push(id);
      await db.prepare(`UPDATE carrier_invoices SET ${sets.join(', ')} WHERE id=?`).bind(...vals).run();
      // Paying the invoice pays the placements on it, and the splits with them.
      if (b.status === 'paid') {
        await db.prepare("UPDATE placements SET status='paid', paid_at=datetime('now') WHERE invoice_id=?").bind(id).run();
        await db.prepare(`UPDATE placement_splits SET status='paid', paid_at=datetime('now')
          WHERE placement_id IN (SELECT id FROM placements WHERE invoice_id=?)`).bind(id).run();
      }
      return json({ ok: true });
    }
  }

  // What's billable right now: seated drivers whose placement hasn't gone out.
  if (res === 'billable' && method === 'GET') {
    const { results } = await db.prepare(`
      SELECT p.id AS placement_id, p.fee_amount, p.seated_at, p.carrier_id,
             l.id AS driver_id, l.name AS driver_name, l.confirmation_no, l.started_at,
             c.name AS carrier_name, c.billing_email, c.contact_email
        FROM placements p
        LEFT JOIN leads l ON l.id=p.driver_id
        LEFT JOIN carriers c ON c.id=p.carrier_id
       WHERE p.status='pending' AND p.invoice_id IS NULL
       ORDER BY p.carrier_id, COALESCE(p.seated_at, p.created_at)`).all();
    return json({ billable: results || [] });
  }

  if (res === 'invoice' && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const carrierId = b.carrier_id;
    if (!carrierId) return json({ error: 'carrier_id required' }, 400);
    const c = await db.prepare('SELECT * FROM carriers WHERE id=?').bind(carrierId).first();
    if (!c) return json({ error: 'carrier not found' }, 404);

    // Only placements that are actually ours to bill: seated, unbilled.
    let sql = `SELECT p.*, l.name AS driver_name, l.confirmation_no, l.started_at
                 FROM placements p LEFT JOIN leads l ON l.id=p.driver_id
                WHERE p.carrier_id=? AND p.status='pending' AND p.invoice_id IS NULL`;
    const binds = [carrierId];
    if (Array.isArray(b.placement_ids) && b.placement_ids.length) {
      sql += ` AND p.id IN (${b.placement_ids.map(() => '?').join(',')})`;
      binds.push(...b.placement_ids);
    }
    const { results } = await db.prepare(sql + ' ORDER BY COALESCE(p.seated_at, p.created_at)').bind(...binds).all();
    const rows = results || [];
    if (!rows.length) return json({ error: 'Nothing to invoice for this carrier right now.' }, 400);

    let amount = 0;
    const lineItems = rows.map((p) => {
      const line = Number(p.fee_amount) || 0;
      amount += line;
      return { placement_id: p.id, driver: p.driver_name || 'Driver', driver_id: p.driver_id,
        seated_at: p.seated_at || p.started_at || null, confirmation_no: p.confirmation_no || null,
        amount: Math.round(line * 100) / 100 };
    });
    amount = Math.round(amount * 100) / 100;

    const seq = await db.prepare('SELECT COUNT(*) AS n FROM carrier_invoices').first();
    const year = new Date().getUTCFullYear();
    const number = b.number || `AIW-${year}-${String(((seq && seq.n) || 0) + 1).padStart(4, '0')}`;
    const invId = 'inv_' + mkSecret().slice(0, 10);
    const dates = lineItems.map((l) => l.seated_at).filter(Boolean).sort();
    const ps = dates[0] || null, pe = dates[dates.length - 1] || null;

    const money = (n) => '$' + (Math.round((n || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const to = c.billing_email || c.contact_email || null;
    let emailed = false;
    if (to && !b.draft) {
      const rowsHtml = lineItems.map((li) => `<tr>
        <td style="padding:6px 12px 6px 0;font-size:14px">${esc(li.driver)}${li.confirmation_no ? `<div style="color:#8a95a6;font-size:12px">confirmation ${esc(li.confirmation_no)}</div>` : ''}</td>
        <td style="padding:6px 12px 6px 0;font-size:13px;color:#5b6472;white-space:nowrap">${esc(li.seated_at || '')}</td>
        <td style="padding:6px 0;text-align:right;font-weight:600;font-size:14px">${money(li.amount)}</td></tr>`).join('');
      const r = await sendEmail(env, {
        from: env.INVOICE_FROM || 'Office <office@arianaisworking.com>',
        replyTo: env.INVOICE_REPLY_TO || 'office@arianaisworking.com',
        to,
        subject: `Invoice ${number} — ${rows.length} driver${rows.length === 1 ? '' : 's'} placed`,
        html: emailShell(`Invoice ${number}`, `
          <p style="margin:0 0 6px;font-size:16px">Hi${c.contact_name ? ' ' + esc(c.contact_name.split(' ')[0]) : ''},</p>
          <p style="margin:0 0 16px;color:#3a4353">Invoice for ${rows.length} driver${rows.length === 1 ? '' : 's'} placed and seated with ${esc(c.name)}${ps ? ` between ${esc(ps)} and ${esc(pe)}` : ''}.</p>
          <table style="width:100%;border-collapse:collapse">
            <tr><th style="text-align:left;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#8a95a6;padding-bottom:6px;border-bottom:1px solid #e3e8ef">Driver</th>
                <th style="text-align:left;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#8a95a6;padding-bottom:6px;border-bottom:1px solid #e3e8ef">Seated</th>
                <th style="text-align:right;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#8a95a6;padding-bottom:6px;border-bottom:1px solid #e3e8ef">Amount</th></tr>
            ${rowsHtml}
            <tr><td colspan="2" style="padding:10px 12px 4px 0;border-top:2px solid #1a2230;font-weight:800">Total due</td>
                <td style="padding:10px 0 4px;border-top:2px solid #1a2230;text-align:right;font-weight:800;color:#2f6fed;font-size:17px">${money(amount)}</td></tr>
          </table>
          <p style="margin:16px 0 0;color:#5b6472;font-size:13px">${esc(c.payment_terms || 'Net 15')}. Reply to this email with any questions and we'll sort it out same day.</p>`,
          brandName(env)),
      });
      emailed = !!r.ok;
    }

    await db.prepare(`INSERT INTO carrier_invoices (id, number, carrier_id, period_start, period_end, drivers, amount, status, line_items, sent_to, sent_at)
      VALUES (?,?,?,?,?,?,?,?,?,?, ${emailed ? "datetime('now')" : 'NULL'})`)
      .bind(invId, number, carrierId, ps, pe, rows.length, amount, emailed ? 'sent' : 'draft',
        JSON.stringify(lineItems), emailed ? to : null).run();
    for (const p of rows) {
      await db.prepare("UPDATE placements SET invoice_id=?, status='invoiced', invoiced_at=datetime('now') WHERE id=?").bind(invId, p.id).run();
    }
    return json({ ok: true, invoice: { id: invId, number, drivers: rows.length, amount, line_items: lineItems,
      status: emailed ? 'sent' : 'draft', sent_to: emailed ? to : null }, emailed, has_billing_email: !!to });
  }

  // ---------- "DID THEY START?" — the answer that turns work into money ----------
  // The carrier never tells us. Marking a driver seated is what opens the
  // placement, so an unanswered question here is an uninvoiced fee.
  if (res === 'drivers' && sub === 'seated' && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const driverId = int(id);
    const d = await db.prepare('SELECT * FROM leads WHERE id=?').bind(driverId).first();
    if (!d) return json({ error: 'driver not found' }, 404);
    if (b.started === false) {
      // Not seated: record that we asked, so it stops nagging but isn't lost.
      await db.prepare("UPDATE leads SET seat_checked_at=datetime('now'), lost_reason=COALESCE(?,lost_reason), status=CASE WHEN ? IS NOT NULL THEN 'Not qualified' ELSE status END, updated_at=datetime('now') WHERE id=?")
        .bind(b.reason || null, b.reason || null, driverId).run();
      return json({ ok: true, seated: false });
    }
    const started = b.started_at || new Date().toISOString().slice(0, 10);
    await db.prepare(`UPDATE leads SET started_at=?, status='Rolling', seat_checked_at=datetime('now'),
        seat_confirmed_by=?, updated_at=datetime('now') WHERE id=?`)
      .bind(started, b.by || 'us', driverId).run();
    let placement = null;
    if (d.carrier_id) {
      const c = await db.prepare('SELECT * FROM carriers WHERE id=?').bind(d.carrier_id).first();
      if (c && c.fee_trigger !== 'submitted')
        placement = await ensurePlacement(db, { ...d, started_at: started }, c, c.fee_trigger || 'seated', { seated_at: started });
    }
    return json({ ok: true, seated: true, started_at: started, placement });
  }

  // ---------- SERVE A COLLECTED DOCUMENT (team-gated by _middleware) ----------
  if (res === 'file' && method === 'GET') {
    const key = new URL(request.url).searchParams.get('key');
    if (!key) return json({ error: 'missing key' }, 400);
    if (!env.DOCS) return json({ error: 'file storage not configured' }, 404);
    const obj = await env.DOCS.get(key);
    if (!obj) return json({ error: 'not found' }, 404);
    return new Response(obj.body, { headers: {
      'content-type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'cache-control': 'private, max-age=60' } });
  }

  return json({ error: 'not found' }, 404);
}
