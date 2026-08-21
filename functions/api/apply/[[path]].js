// functions/api/apply/[[path]].js
// PUBLIC (exempt from the auth gate in _middleware.js) — the driver-facing
// application.
//
//   GET  /api/apply/form?token=...        -> prefilled application for an invited driver
//   GET  /api/apply/form?carrier=<id>     -> blank application (open link for ads/job boards)
//   POST /api/apply/submit?token=...      -> saves answers, screens, notifies the team
//   POST /api/apply/submit?carrier=<id>   -> creates the driver record, then the same
//   POST /api/apply/lead                  -> website funnel: drops a driver in and
//                                            emails them the application (CORS open)
//   GET  /api/apply/lease?token=...       -> the lease form + what documents are missing
//   POST /api/apply/lease?token=...       -> saves it; sensitive fields are sealed
//   POST /api/apply/upload?token=...&kind= -> driver uploads a required document
//
// The application deliberately does NOT ask for SSN, bank details or a full
// licence number. Those belong on the carrier's own lease form, filled in
// directly with the carrier — we have no business holding them.

import { json } from '../../_lib/tenant.js';
import { sendEmail, emailShell, teamEmail, replyToEmail, brandName, esc } from '../../_lib/email.js';
import { screen, parseRules, screenSummary, VIOLATIONS } from '../../_lib/screening.js';
import { seal, vaultReady } from '../../_lib/vault.js';
import { seedDocs, secret as mkSecret } from '../../_lib/recruiting.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Max-Age': '86400',
};
function cors(r) { for (const [k, v] of Object.entries(CORS)) r.headers.set(k, v); return r; }

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

    // If they clear screening, move them straight on: build the document
    // checklist and issue the lease-form link. This is the hand-off that used to
    // be a person remembering to send two attachments.
    let leaseUrl = null;
    if (s.result !== 'disqualified' && carrier) {
      let lt = full.lease_token;
      if (!lt) { lt = token(); await db.prepare('UPDATE leads SET lease_token=? WHERE id=?').bind(lt, driverId).run(); }
      await seedDocs(db, full, carrier);
      leaseUrl = `${url.origin}/lease.html?token=${lt}`;
      await db.prepare("UPDATE leads SET status=CASE WHEN status IN ('New','Screening') THEN 'Pre-qualified' ELSE status END, onboarding_sent_at=datetime('now') WHERE id=?").bind(driverId).run();
    }

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
        <p style="margin:0;color:#5b6472;font-size:13px">${leaseUrl ? 'Their lease form and document checklist have gone out automatically — nothing to do until they come back.' : 'Open the CRM to review, then submit to the carrier.'}</p>`, brandName(env)),
    }));

    // Confirm to the driver — tone depends on the verdict, but never quotes the
    // carrier's internal thresholds back at them.
    if (full.email) {
      const first = (full.name || '').split(' ')[0];
      const msg = s.result === 'disqualified'
        ? `<p style="margin:0 0 14px;color:#3a4353">Thanks for taking the time to apply. Based on what you've told us, we don't have a seat that fits your record right now. Records change — if your situation changes, get back in touch and we'll take another look.</p>`
        : leaseUrl
          ? `<p style="margin:0 0 14px;color:#3a4353">Good news${first ? ', ' + esc(first) : ''} — your application looks like a fit, so let's keep moving. The next step is your lease information and a short list of truck documents. It's all on one page, and you can upload photos straight from your phone.</p>
             <p style="margin:0 0 18px"><a href="${leaseUrl}" style="display:inline-block;background:#2f6fed;color:#fff;text-decoration:none;padding:12px 24px;border-radius:11px;font-weight:700">Continue your onboarding →</a></p>
             <p style="margin:0 0 14px;color:#5b6472;font-size:13.5px">You'll need: your truck registration, a photo of your ECM port, a federal inspection dated within the last 30 days, and a voided check. Do what you can now and come back to the same link for the rest.</p>`
          : `<p style="margin:0 0 14px;color:#3a4353">Thanks${first ? ', ' + esc(first) : ''} — we've got your application and we're reviewing it now. We'll be in touch shortly.</p>`;
      context.waitUntil(sendEmail(env, {
        to: full.email, replyTo: replyToEmail(env),
        subject: 'We received your application',
        html: emailShell('Application received', `<p style="margin:0 0 6px;font-size:16px">Hi${first ? ' ' + esc(first) : ''},</p>${msg}<p style="margin:0;color:#5b6472;font-size:13px">Questions? Just reply to this email.</p>`, brandName(env)),
      }));
    }

    // The driver is told it's received — never the internal verdict.
    return json({ ok: true, received: true });
  }

  // ---------- WEBSITE FUNNEL ----------
  // Your site (and Mystica's) POSTs here. The driver lands in the CRM and the
  // application goes out automatically — no one has to notice the lead first.
  if (action === 'lead') {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'POST') return cors(json({ error: 'method not allowed' }, 405));
    const b = await request.json().catch(() => ({}));
    if (b._hp) return cors(json({ ok: true }));            // honeypot: look successful, store nothing
    const name = String(b.name || '').trim().slice(0, 200);
    const phone = String(b.phone || '').trim().slice(0, 40) || null;
    const email = String(b.email || '').trim().slice(0, 200) || null;
    if (!name || !(phone || email)) return cors(json({ error: 'Name and a phone number or email are required.' }, 400));

    const carrier = carrierId ? await db.prepare('SELECT * FROM carriers WHERE id=? AND active=1').bind(carrierId).first() : await firstCarrier(db);
    // Don't create a second record for someone who already came through.
    let existing = null;
    if (phone) existing = await db.prepare('SELECT * FROM leads WHERE phone=? LIMIT 1').bind(phone).first();
    if (!existing && email) existing = await db.prepare('SELECT * FROM leads WHERE email=? LIMIT 1').bind(email).first();

    const tok = mkSecret();
    let driverId, applyToken = tok;
    if (existing) {
      driverId = existing.id;
      applyToken = existing.apply_token || tok;
      await db.prepare(`UPDATE leads SET name=COALESCE(NULLIF(?,''),name), phone=COALESCE(?,phone), email=COALESCE(?,email),
          city=COALESCE(?,city), state=COALESCE(?,state), apply_token=?, updated_at=datetime('now') WHERE id=?`)
        .bind(name, phone, email, String(b.city || '').trim() || null, String(b.state || '').trim().slice(0, 2).toUpperCase() || null, applyToken, driverId).run();
    } else {
      const r = await db.prepare(`INSERT INTO leads (name, phone, email, city, state, status, client_id, source, carrier_id, apply_token, recruiter_id, interest)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        name, phone, email, String(b.city || '').trim() || null, String(b.state || '').trim().slice(0, 2).toUpperCase() || null,
        'New', 'house', String(b.source || 'website').slice(0, 120), carrier ? carrier.id : null, applyToken,
        String(b.recruiter || '').trim().slice(0, 40) || null, String(b.interest || b.message || '').trim().slice(0, 300) || null).run();
      driverId = r.meta.last_row_id;
    }

    // Send the application straight away — this is the "prompt the system" step.
    const link = `${url.origin}/apply.html?token=${applyToken}`;
    let emailed = false;
    if (email) {
      const first = name.split(' ')[0];
      const r = await sendEmail(env, {
        to: email, replyTo: replyToEmail(env),
        subject: 'Your driver application — next step',
        html: emailShell('Start your application', `
          <p style="margin:0 0 6px;font-size:16px">Hi ${esc(first)},</p>
          <p style="margin:0 0 14px;color:#3a4353">Thanks for reaching out about driving${carrier ? ' with ' + esc(carrier.name) : ''}. Here's your application — about five minutes: your CDL, your experience, your truck and your driving record.</p>
          <p style="margin:0 0 18px"><a href="${link}" style="display:inline-block;background:#2f6fed;color:#fff;text-decoration:none;padding:12px 24px;border-radius:11px;font-weight:700">Start your application →</a></p>
          <p style="margin:0;color:#5b6472;font-size:13px">We check it against the carrier's qualification standards right away, so you'll know where you stand fast. Questions? Just reply to this email.</p>`, brandName(env)),
      });
      emailed = !!r.ok;
    }
    context.waitUntil(sendEmail(env, {
      to: teamEmail(env),
      subject: `New driver lead — ${name}`,
      html: emailShell('New driver lead', `
        <p style="margin:0 0 10px;font-size:16px"><b>${esc(name)}</b></p>
        <table style="font-size:14px">
          ${phone ? `<tr><td style="padding:3px 12px 3px 0;color:#5b6472">Phone</td><td style="font-weight:600">${esc(phone)}</td></tr>` : ''}
          ${email ? `<tr><td style="padding:3px 12px 3px 0;color:#5b6472">Email</td><td style="font-weight:600">${esc(email)}</td></tr>` : ''}
          <tr><td style="padding:3px 12px 3px 0;color:#5b6472">Source</td><td style="font-weight:600">${esc(String(b.source || 'website'))}</td></tr>
        </table>
        <p style="margin:12px 0 0;color:#5b6472;font-size:13px">${emailed ? 'Their application has been emailed to them automatically.' : 'No email on file — send them the application link from the CRM.'}</p>`, brandName(env)),
    }));
    return cors(json({ ok: true, application_sent: emailed, url: link }));
  }

  // ---------- THE LEASE FORM + DOCUMENT RETURN ----------
  if (action === 'lease') {
    if (!tok) return json({ error: 'missing token' }, 400);
    const d = await db.prepare('SELECT * FROM leads WHERE lease_token=?').bind(tok).first();
    if (!d) return json({ error: 'This link is invalid or has expired.' }, 404);
    const c = d.carrier_id ? await db.prepare('SELECT * FROM carriers WHERE id=?').bind(d.carrier_id).first() : null;
    const docsQ = await db.prepare('SELECT id, kind, label, status, doc_date, file_name FROM driver_docs WHERE driver_id=? ORDER BY created_at').bind(d.id).all();

    if (request.method === 'GET') {
      let L = {};
      try { L = d.lease_info ? JSON.parse(d.lease_info) : {}; } catch { L = {}; }
      return json({ ok: true, done: !!d.lease_info_at,
        carrier: c && { name: c.name, terminal: c.terminal, orientation_info: c.orientation_info },
        secure_enabled: vaultReady(env),
        prefill: {
          name: d.name, phone: d.phone, home_phone: d.home_phone, email: d.email, address: d.address,
          city: d.city, state: d.state, postcode: L.postcode || d.postcode, gender: d.gender, dob: d.dob,
          us_citizen: d.us_citizen, cdl_state: d.cdl_state, cdl_expires: d.cdl_expires,
          truck_year: d.truck_year, truck_make: d.truck_make, truck_color: d.truck_color,
          truck_plate: d.truck_plate, truck_plate_state: d.truck_plate_state, truck_vin: d.truck_vin,
          truck_unit_no: d.truck_unit_no, truck_value: d.truck_value, lienholder: d.lienholder,
          lienholder_address: d.lienholder_address, lienholder_phone: d.lienholder_phone, lienholder_email: d.lienholder_email,
          wants_carrier_plates: d.wants_carrier_plates, wants_ifta: d.wants_ifta,
          wants_maintenance: d.wants_maintenance, maintenance_weekly: d.maintenance_weekly, maintenance_max: d.maintenance_max,
          has_business: d.has_business, business_name: d.business_name, business_ein: d.business_ein,
          business_owner: d.business_owner, business_address: d.business_address,
          business_phone: d.business_phone, business_email: d.business_email,
        },
        docs: (docsQ.results || []).map((x) => ({ id: x.id, kind: x.kind, label: x.label, status: x.status, file_name: x.file_name, doc_date: x.doc_date })),
        uploads_enabled: !!env.DOCS });
    }

    if (request.method === 'POST') {
      const b = await request.json().catch(() => ({}));
      const plain = {}, PF = ['gender', 'address', 'city', 'state', 'home_phone', 'truck_year', 'truck_make',
        'truck_color', 'truck_plate', 'truck_plate_state', 'truck_vin', 'truck_unit_no', 'truck_value',
        'lienholder', 'lienholder_address', 'lienholder_phone', 'lienholder_email', 'maintenance_weekly',
        'maintenance_max', 'business_name', 'business_ein', 'business_owner', 'business_address',
        'business_phone', 'business_email'];
      for (const f of PF) if (f in b) plain[f] = b[f] === '' ? null : b[f];
      for (const f of ['us_citizen', 'wants_carrier_plates', 'wants_ifta', 'wants_maintenance', 'has_business'])
        if (f in b) plain[f] = bit(b[f]);

      // The sensitive four go into the vault, never into a readable column.
      const secureIn = {};
      for (const f of ['ssn', 'dl_number', 'bank_name', 'account_name', 'routing', 'account', 'ein'])
        if (b[f]) secureIn[f] = String(b[f]).trim().slice(0, 60);
      let sealed = null;
      if (Object.keys(secureIn).length) {
        if (!vaultReady(env)) return json({ error: 'Secure fields are not enabled on this deployment. Contact us and we will collect these another way.' }, 400);
        sealed = await seal(env, secureIn);
      }

      const cols = Object.keys(plain);
      const sets = cols.map((c) => c + '=?');
      const vals = cols.map((c) => plain[c]);
      sets.push('lease_info=?'); vals.push(JSON.stringify({ postcode: b.postcode || null, submitted: true }));
      if (sealed) { sets.push('lease_secure=?'); vals.push(sealed); }
      sets.push("lease_info_at=datetime('now')", "updated_at=datetime('now')");
      vals.push(d.id);
      await db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id=?`).bind(...vals).run();

      // Electing the plate program adds the title and 2290 to their checklist.
      if (c) { const fresh = await db.prepare('SELECT * FROM leads WHERE id=?').bind(d.id).first(); await seedDocs(db, fresh, c); }

      context.waitUntil(sendEmail(env, {
        to: teamEmail(env),
        subject: `Lease form returned — ${d.name}`,
        html: emailShell('Lease form returned', `
          <p style="margin:0 0 10px;font-size:16px"><b>${esc(d.name)}</b> completed their lease information${sealed ? ' including direct deposit details' : ''}.</p>
          <p style="margin:0;color:#5b6472;font-size:13.5px">Open their file in the CRM to review and send the packet to the carrier.</p>`, brandName(env)),
      }));
      return json({ ok: true, saved: true });
    }
  }

  // ---------- DOCUMENT UPLOAD (driver side) ----------
  if (action === 'upload' && request.method === 'POST') {
    if (!tok) return json({ error: 'missing token' }, 400);
    if (!env.DOCS) return json({ error: 'File uploads are not enabled yet — email them to us instead.' }, 400);
    const d = await db.prepare('SELECT id, name FROM leads WHERE lease_token=?').bind(tok).first();
    if (!d) return json({ error: 'This link is invalid or has expired.' }, 404);
    const fd = await request.formData().catch(() => null);
    const file = fd && fd.get('file');
    if (!file || typeof file === 'string') return json({ error: 'No file received.' }, 400);
    if (file.size > 15 * 1024 * 1024) return json({ error: 'That file is too large (15 MB max).' }, 400);
    const docId = url.searchParams.get('doc') || '';
    const row = docId ? await db.prepare('SELECT * FROM driver_docs WHERE id=? AND driver_id=?').bind(docId, d.id).first() : null;
    if (!row) return json({ error: 'Unknown document.' }, 400);
    const clean = (file.name || 'file').replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '_').slice(-80) || 'file';
    const key = `${tok}/${row.kind}-${crypto.randomUUID()}-${clean}`;
    await env.DOCS.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type || 'application/octet-stream' } });
    const docDate = url.searchParams.get('date') || null;
    await db.prepare("UPDATE driver_docs SET status='received', file_key=?, file_name=?, doc_date=COALESCE(?,doc_date), updated_at=datetime('now') WHERE id=?")
      .bind(key, clean, docDate, row.id).run();
    if (row.kind === 'inspection' && docDate)
      await db.prepare('UPDATE leads SET inspection_date=? WHERE id=?').bind(docDate, d.id).run();
    return json({ ok: true, file: clean });
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
