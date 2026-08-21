// functions/api/apply/[[path]].js
// PUBLIC (exempt from the auth gate in _middleware.js) — the driver-facing
// application.
//
//   GET  /api/apply/form?token=...        -> prefilled application for an invited driver
//   GET  /api/apply/form?carrier=<id>     -> blank application (open link for ads/job boards)
//   POST /api/apply/submit?token=...      -> saves answers, screens, notifies the team
//   POST /api/apply/submit?carrier=<id>   -> creates the driver record, then the same
//
// The application deliberately does NOT ask for SSN, bank details or a full
// licence number. Those belong on the carrier's own lease form, filled in
// directly with the carrier — we have no business holding them.

import { json } from '../../_lib/tenant.js';
import { sendEmail, emailShell, teamEmail, replyToEmail, brandName, esc } from '../../_lib/email.js';
import { screen, parseRules, screenSummary, VIOLATIONS } from '../../_lib/screening.js';

function token() {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
const bit = (v) => (v === true || v === 1 || v === '1' || v === 'yes' || v === 'Yes' ? 1 : (v == null || v === '' ? null : 0));
const int = (v) => (v == null || v === '' ? null : parseInt(v, 10) || 0);

// Fields the public form is allowed to write. Anything else is ignored.
const PUBLIC_FIELDS = [
  'name', 'phone', 'email', 'city', 'state', 'dob', 'cdl_class', 'cdl_state', 'cdl_expires',
  'endorsements', 'dot_medical_expires', 'truck_year', 'truck_make', 'truck_color',
  'truck_vin', 'truck_plate', 'truck_plate_state', 'lienholder', 'business_name',
  'inspection_date', 'background_note',
];
const BIT_FIELDS = ['work_authorized', 'us_citizen', 'owns_truck', 'wants_carrier_plates', 'wants_ifta',
  'has_business', 'felony', 'misdemeanor', 'can_verify_employers', 'has_1099s'];
const INT_FIELDS = ['exp_months_5yr', 'exp_months_3yr', 'flatbed_months_1yr'];

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;
  const action = (context.params.path || [])[0];
  const url = new URL(request.url);
  const tok = url.searchParams.get('token') || '';
  const carrierId = url.searchParams.get('carrier') || '';

  const carrierPublic = (c) => c && ({
    id: c.id, name: c.name, terminal: c.terminal, city: c.city, state: c.state,
    haul_type: c.haul_type, driver_type: c.driver_type,
    needs_own_truck: c.needs_own_truck, needs_own_trailer: c.needs_own_trailer,
    orientation_info: c.orientation_info,
  });

  // ---------- LOAD THE FORM ----------
  if (action === 'form' && request.method === 'GET') {
    if (tok) {
      const d = await db.prepare('SELECT id,name,phone,email,city,state,carrier_id,applied_at FROM leads WHERE apply_token=?').bind(tok).first();
      if (!d) return json({ error: 'This link is invalid or has expired.' }, 404);
      const c = d.carrier_id ? await db.prepare('SELECT * FROM carriers WHERE id=?').bind(d.carrier_id).first() : await firstCarrier(db);
      return json({ ok: true, submitted: !!d.applied_at, carrier: carrierPublic(c),
        prefill: { name: d.name, phone: d.phone, email: d.email, city: d.city, state: d.state },
        chart: chart() });
    }
    const c = carrierId
      ? await db.prepare('SELECT * FROM carriers WHERE id=? AND active=1').bind(carrierId).first()
      : await firstCarrier(db);
    if (!c) return json({ error: 'Applications are not open right now.' }, 404);
    return json({ ok: true, submitted: false, carrier: carrierPublic(c), prefill: {}, chart: chart() });
  }

  // ---------- SUBMIT ----------
  if (action === 'submit' && request.method === 'POST') {
    const b = await request.json().catch(() => null);
    if (!b) return json({ error: 'Could not read that submission.' }, 400);
    if (!b.name || !(b.phone || b.email)) return json({ error: 'Please give us your name and a phone number or email.' }, 400);

    let driver = null;
    if (tok) driver = await db.prepare('SELECT * FROM leads WHERE apply_token=?').bind(tok).first();

    let carrier = null;
    if (driver && driver.carrier_id) carrier = await db.prepare('SELECT * FROM carriers WHERE id=?').bind(driver.carrier_id).first();
    if (!carrier) carrier = carrierId ? await db.prepare('SELECT * FROM carriers WHERE id=?').bind(carrierId).first() : await firstCarrier(db);

    // Normalise the payload.
    const rec = {};
    for (const f of PUBLIC_FIELDS) if (f in b) rec[f] = b[f] === '' ? null : b[f];
    for (const f of BIT_FIELDS) if (f in b) rec[f] = bit(b[f]);
    for (const f of INT_FIELDS) if (f in b) rec[f] = int(b[f]);
    // Self-reported record: keep only codes we know, drop anything invented.
    const violations = Array.isArray(b.violations)
      ? b.violations.filter((v) => v && VIOLATIONS[v.code]).map((v) => ({ code: v.code, date: (v.date || '').slice(0, 10) || null, note: (v.note || '').slice(0, 200) || null }))
      : [];
    rec.violations = JSON.stringify(violations);
    if (b.sap_completed_at) rec.sap_completed_at = String(b.sap_completed_at).slice(0, 10);
    if (b.positive_test_at) rec.positive_test_at = String(b.positive_test_at).slice(0, 10);
    rec.application = JSON.stringify(b);
    rec.carrier_id = carrier ? carrier.id : null;

    if (!driver) {
      // Open link: don't create a duplicate if they already applied.
      if (b.phone) driver = await db.prepare('SELECT * FROM leads WHERE phone=? LIMIT 1').bind(b.phone).first();
      if (!driver && b.email) driver = await db.prepare('SELECT * FROM leads WHERE email=? LIMIT 1').bind(b.email).first();
    }

    let driverId;
    if (driver) {
      const cols = Object.keys(rec);
      await db.prepare(`UPDATE leads SET ${cols.map((c) => c + '=?').join(', ')}, applied_at=datetime('now'), status=CASE WHEN status IN ('New','') OR status IS NULL THEN 'Screening' ELSE status END, updated_at=datetime('now') WHERE id=?`)
        .bind(...cols.map((c) => rec[c]), driver.id).run();
      driverId = driver.id;
    } else {
      const cols = Object.keys(rec);
      const r = await db.prepare(`INSERT INTO leads (client_id, source, status, applied_at, apply_token, ${cols.join(',')})
        VALUES (?,?,?,datetime('now'),?,${cols.map(() => '?').join(',')})`)
        .bind('house', 'application', 'Screening', token(), ...cols.map((c) => rec[c])).run();
      driverId = r.meta.last_row_id;
    }

    // Screen immediately against the carrier's rubric.
    const full = await db.prepare('SELECT * FROM leads WHERE id=?').bind(driverId).first();
    const s = screen(full, parseRules(carrier && carrier.qual_rules));
    await db.prepare(`UPDATE leads SET screen_result=?, screen_points=?, screen_detail=?, screened_at=datetime('now') WHERE id=?`)
      .bind(s.result, s.points, JSON.stringify(s), driverId).run();

    // Tell the team. Best-effort — never block the driver's submission on email.
    const detail = [
      ['Phone', full.phone], ['Email', full.email], ['Location', [full.city, full.state].filter(Boolean).join(', ')],
      ['CDL', full.cdl_class ? `Class ${full.cdl_class} · ${full.cdl_state || ''}` : ''],
      ['Experience', full.exp_months_5yr ? `${full.exp_months_5yr} mo / 5 yr (${full.exp_months_3yr || 0} in 3)` : ''],
      ['Truck', [full.truck_year, full.truck_make].filter(Boolean).join(' ')],
      ['Work authorised', full.work_authorized ? 'Yes' : (full.work_authorized === 0 ? 'No' : '')],
    ].filter(([, v]) => v).map(([k, v]) => `<tr><td style="padding:3px 12px 3px 0;color:#5b6472">${esc(k)}</td><td style="padding:3px 0;font-weight:600">${esc(v)}</td></tr>`).join('');
    const tone = s.result === 'qualified' ? ['#e9f7f0', '#b7e4cd', '#136c47'] : s.result === 'review' ? ['#fff6e5', '#f5d9a0', '#8a5a00'] : ['#fdecec', '#f5c2c2', '#9b2c2c'];
    context.waitUntil(sendEmail(env, {
      to: teamEmail(env),
      subject: `${s.result === 'qualified' ? '✅' : s.result === 'review' ? '⚠️' : '⛔'} Driver application — ${full.name}`,
      html: emailShell('New driver application', `
        <div style="background:${tone[0]};border:1px solid ${tone[1]};color:${tone[2]};border-radius:10px;padding:10px 14px;margin:0 0 14px"><b>${esc(screenSummary(s))}</b></div>
        <p style="margin:0 0 10px;font-size:16px"><b>${esc(full.name)}</b>${carrier ? ' → ' + esc(carrier.name) : ''}</p>
        <table style="font-size:14px;margin:0 0 14px">${detail}</table>
        ${s.blockers.length ? `<p style="margin:0 0 6px;color:#9b2c2c"><b>Blockers</b></p><ul style="margin:0 0 12px;padding-left:18px;color:#3a4353">${s.blockers.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${s.reviews.length ? `<p style="margin:0 0 6px;color:#8a5a00"><b>Needs Safety approval</b></p><ul style="margin:0 0 12px;padding-left:18px;color:#3a4353">${s.reviews.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${s.warnings.length ? `<p style="margin:0 0 6px;color:#5b6472"><b>Notes</b></p><ul style="margin:0 0 12px;padding-left:18px;color:#5b6472">${s.warnings.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        <p style="margin:0;color:#5b6472;font-size:13px">Open the CRM to review, then submit to the carrier.</p>`, brandName(env)),
    }));

    // Confirm to the driver — tone depends on the verdict, but never quotes the
    // carrier's internal thresholds back at them.
    if (full.email) {
      const first = (full.name || '').split(' ')[0];
      const msg = s.result === 'disqualified'
        ? `<p style="margin:0 0 14px;color:#3a4353">Thanks for taking the time to apply. Based on what you've told us, we don't have a seat that fits your record right now. Records change — if your situation changes, get back in touch and we'll take another look.</p>`
        : `<p style="margin:0 0 14px;color:#3a4353">Thanks${first ? ', ' + esc(first) : ''} — we've got your application and we're reviewing it now. If it's a fit we'll submit you to the carrier and walk you through what comes next: the Clearinghouse query, a drug test, and a short list of truck documents. We'll be in touch shortly.</p>`;
      context.waitUntil(sendEmail(env, {
        to: full.email, replyTo: replyToEmail(env),
        subject: 'We received your application',
        html: emailShell('Application received', `<p style="margin:0 0 6px;font-size:16px">Hi${first ? ' ' + esc(first) : ''},</p>${msg}<p style="margin:0;color:#5b6472;font-size:13px">Questions? Just reply to this email.</p>`, brandName(env)),
      }));
    }

    // The driver is told it's received — never the internal verdict.
    return json({ ok: true, received: true });
  }

  return json({ error: 'not found' }, 404);
}

async function firstCarrier(db) {
  return await db.prepare('SELECT * FROM carriers WHERE active=1 ORDER BY created_at LIMIT 1').first();
}

// The violation list the form renders, grouped for a human to self-report.
function chart() {
  return Object.entries(VIOLATIONS).map(([code, v]) => ({
    code, label: v.label,
    group: v.prohibit_years ? 'serious' : 'minor',
  }));
}
