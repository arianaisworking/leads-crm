// functions/api/dr/[[path]].js
// Driver-recruiting API (team-gated by _middleware.js).
// Carriers, drivers, the document checklist, screening, submit-to-carrier and
// the placement money dashboard.

import { json } from '../../_lib/tenant.js';
import { sendEmail, emailShell, teamEmail, replyToEmail, brandName, esc } from '../../_lib/email.js';
import { screen, parseRules, screenSummary, addBusinessDays, VIOLATIONS } from '../../_lib/screening.js';

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

// Build the per-driver document checklist from the carrier's template.
async function seedDocs(db, driver, carrier) {
  let list = [];
  try { list = carrier && carrier.doc_checklist ? JSON.parse(carrier.doc_checklist) : []; } catch { list = []; }
  if (!Array.isArray(list) || !list.length) return 0;
  const existing = await db.prepare('SELECT kind FROM driver_docs WHERE driver_id=?').bind(driver.id).all();
  const have = new Set((existing.results || []).map((r) => r.kind));
  let n = 0;
  for (const item of list) {
    // Conditional docs (e.g. title + 2290 only on the carrier's plate program).
    if (item.if && !driver[item.if]) continue;
    if (have.has(item.kind)) continue;
    await db.prepare('INSERT INTO driver_docs (id, driver_id, kind, label, status) VALUES (?,?,?,?,?)')
      .bind('dd_' + token().slice(0, 10), driver.id, item.kind, item.label || item.kind, 'needed').run();
    n++;
  }
  return n;
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
        'needs_own_trailer', 'apply_url', 'orientation_info', 'fee_type', 'fee_amount', 'fee_trigger',
        'terms', 'active', 'notes'];
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
    return json({ totals: tot || {}, by_carrier: byCarrier.results || [], funnel: funnel.results || [] });
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
    return json({ ...(s || {}), alerts: alerts.results || [] });
  }

  return json({ error: 'not found' }, 404);
}

// Create the placement row for a driver+carrier if it isn't there yet,
// resolving the fee from the carrier's deal.
async function ensurePlacement(db, driver, carrier, trigger, override = {}) {
  const existing = await db.prepare('SELECT id FROM placements WHERE driver_id=? AND carrier_id=?').bind(driver.id, carrier.id).first();
  if (existing) return existing.id;
  const pid = 'pl_' + Math.random().toString(36).slice(2, 10);
  const feeType = override.fee_type || carrier.fee_type || 'flat';
  const fee = override.fee_amount != null ? Number(override.fee_amount) : (carrier.fee_amount != null ? Number(carrier.fee_amount) : null);
  await db.prepare(`INSERT INTO placements (id, driver_id, carrier_id, fee_type, fee_amount, status, trigger_met, seated_at, notes)
    VALUES (?,?,?,?,?,?,?,?,?)`).bind(
    pid, driver.id, carrier.id, feeType, fee, override.status || 'pending', trigger,
    override.seated_at || null, override.notes || null).run();
  return pid;
}
