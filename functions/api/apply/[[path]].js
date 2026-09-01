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
//   GET  /api/apply/jobs                  -> the public job board (CORS open); only
//                                            open postings, carrier named only if
//                                            that posting says so
//   POST /api/apply/carrier-inquiry       -> a carrier asking us to recruit; lands in
//                                            `carriers` as a prospect (active=0)
//   POST /api/apply/referral              -> a driver sending us a driver; creates the
//                                            lead and a `referrals` row for the fee
//   POST /api/apply/recruiter             -> someone applying to recruit with us; lands
//                                            in `recruiters` as an applicant (active=0)
//   GET  /api/apply/lease?token=...       -> the lease form + what documents are missing
//   POST /api/apply/lease?token=...       -> saves it; sensitive fields are sealed
//   POST /api/apply/upload?token=...&kind= -> driver uploads a required document
//
// The application deliberately does NOT ask for SSN, bank details or a full
// licence number. Those belong on the carrier's own lease form, filled in
// directly with the carrier — we have no business holding them.

import { json } from '../../_lib/tenant.js';
import { sendEmail, emailShell, recruitingTeamEmail, replyToEmail, brandName, esc } from '../../_lib/email.js';
import { screen, parseRules, screenSummary, addBusinessDays, VIOLATIONS } from '../../_lib/screening.js';
import { seal, vaultReady } from '../../_lib/vault.js';
import { seedDocs, secret as mkSecret, carrierApplyUrl, recruiterFor, leaseRow, rid } from '../../_lib/recruiting.js';

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
// Which language the driver filled the form in — every later email follows it.
const LANG = (v) => (String(v || '').toLowerCase().startsWith('es') ? 'es' : 'en');
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
    rec.lang = LANG(b.lang);

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
    let leaseUrl = null, carrierAppUrl = null;
    if (s.result !== 'disqualified' && carrier) {
      let lt = full.lease_token;
      if (!lt) { lt = token(); await db.prepare('UPDATE leads SET lease_token=? WHERE id=?').bind(lt, driverId).run(); }
      await seedDocs(db, full, carrier);
      leaseUrl = `${url.origin}/lease.html?token=${lt}`;
      // Step 1 of the carrier's own process: their application platform. Sent
      // through our tracked redirect so we know who actually started it.
      if (carrier.apply_url) carrierAppUrl = `${url.origin}/api/apply/go?token=${lt}`;
      await db.prepare(`UPDATE leads SET status=CASE WHEN status IN ('New','Screening') THEN 'Pre-qualified' ELSE status END,
          onboarding_sent_at=datetime('now'), carrier_app_sent_at=CASE WHEN ? IS NULL THEN carrier_app_sent_at ELSE datetime('now') END
        WHERE id=?`).bind(carrierAppUrl, driverId).run();
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
      to: recruitingTeamEmail(env),
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
      const es = rec.lang === 'es';
      const msg = s.result === 'disqualified'
        ? (es
          ? `<p style="margin:0 0 14px;color:#3a4353">Gracias por tomarte el tiempo de aplicar. Con lo que nos platicaste, ahorita no tenemos un puesto que le quede a tu récord. Las cosas cambian — si tu situación cambia, búscanos otra vez y lo revisamos de nuevo.</p>`
          : `<p style="margin:0 0 14px;color:#3a4353">Thanks for taking the time to apply. Based on what you've told us, we don't have a seat that fits your record right now. Records change — if your situation changes, get back in touch and we'll take another look.</p>`)
        : es && leaseUrl
          ? `<p style="margin:0 0 14px;color:#3a4353">Buenas noticias${first ? ', ' + esc(first) : ''} — pareces ser un buen ajuste${carrier ? ' para ' + esc(carrier.name) : ''}, así que vamos a seguir. Son dos pasos y puedes empezar con cualquiera.</p>
             ${carrierAppUrl ? `<div style="border:1px solid #e3e8ef;border-radius:12px;padding:14px 16px;margin:0 0 12px">
               <div style="font-weight:700;font-size:14px;margin-bottom:4px">Paso 1 — la solicitud de la compañía</div>
               <p style="margin:0 0 12px;color:#5b6472;font-size:13.5px">Esta va directo a su departamento de seguridad y te da un número de confirmación. Aparta unos 20 minutos y ten a la mano tu historial de trabajo.</p>
               <a href="${carrierAppUrl}" style="display:inline-block;background:#2f6fed;color:#fff;text-decoration:none;padding:11px 22px;border-radius:10px;font-weight:700">Abrir la solicitud →</a>
             </div>` : ''}
             <div style="border:1px solid #e3e8ef;border-radius:12px;padding:14px 16px;margin:0 0 14px">
               <div style="font-weight:700;font-size:14px;margin-bottom:4px">Paso ${carrierAppUrl ? '2' : '1'} — tus datos del contrato y documentos</div>
               <p style="margin:0 0 12px;color:#5b6472;font-size:13.5px">Tus datos, tu troca, y cuatro documentos que puedes fotografiar con el teléfono: la registración, el puerto ECM, una inspección federal de menos de 30 días, y un cheque anulado.</p>
               <a href="${leaseUrl}" style="display:inline-block;background:#fff;color:#2f6fed;border:1px solid #2f6fed;text-decoration:none;padding:11px 22px;border-radius:10px;font-weight:700">Abrir tu página →</a>
             </div>
             <p style="margin:0 0 14px;color:#5b6472;font-size:13.5px">Los dos enlaces se quedan activos, así que puedes hacerlo por partes. Nosotros le damos seguimiento con la compañía.</p>`
        : leaseUrl
          ? `<p style="margin:0 0 14px;color:#3a4353">Good news${first ? ', ' + esc(first) : ''} — you look like a fit${carrier ? ' for ' + esc(carrier.name) : ''}, so let's keep moving. There are two steps, and you can start either one now.</p>
             ${carrierAppUrl ? `<div style="border:1px solid #e3e8ef;border-radius:12px;padding:14px 16px;margin:0 0 12px">
               <div style="font-weight:700;font-size:14px;margin-bottom:4px">Step 1 — the carrier's application</div>
               <p style="margin:0 0 12px;color:#5b6472;font-size:13.5px">This one goes straight to their Safety team and gets you a confirmation number. Set aside about 20 minutes and have your employment history handy.</p>
               <a href="${carrierAppUrl}" style="display:inline-block;background:#2f6fed;color:#fff;text-decoration:none;padding:11px 22px;border-radius:10px;font-weight:700">Open the carrier application →</a>
             </div>` : ''}
             <div style="border:1px solid #e3e8ef;border-radius:12px;padding:14px 16px;margin:0 0 14px">
               <div style="font-weight:700;font-size:14px;margin-bottom:4px">Step ${carrierAppUrl ? '2' : '1'} — your lease info &amp; documents</div>
               <p style="margin:0 0 12px;color:#5b6472;font-size:13.5px">Your details, your truck, and four documents you can photograph with your phone: truck registration, your ECM port, a federal inspection dated within the last 30 days, and a voided check.</p>
               <a href="${leaseUrl}" style="display:inline-block;background:#fff;color:#2f6fed;border:1px solid #2f6fed;text-decoration:none;padding:11px 22px;border-radius:10px;font-weight:700">Open your onboarding page →</a>
             </div>
             <p style="margin:0 0 14px;color:#5b6472;font-size:13.5px">Both links stay live, so you can finish in pieces. We'll chase the carrier on your behalf once these are in.</p>`
          : `<p style="margin:0 0 14px;color:#3a4353">Thanks${first ? ', ' + esc(first) : ''} — we've got your application and we're reviewing it now. We'll be in touch shortly.</p>`;
      context.waitUntil(sendEmail(env, {
        to: full.email, replyTo: replyToEmail(env),
        subject: es ? 'Recibimos tu solicitud' : 'We received your application',
        html: emailShell(es ? 'Solicitud recibida' : 'Application received',
          `<p style="margin:0 0 6px;font-size:16px">${es ? 'Hola' : 'Hi'}${first ? ' ' + esc(first) : ''},</p>${msg}
           <p style="margin:0;color:#5b6472;font-size:13px">${es ? '¿Preguntas? Contesta este correo y te ayudamos.' : 'Questions? Just reply to this email.'}</p>`, brandName(env)),
      }));
    }

    // Hand the next two steps back to the driver right now, while they still
    // have the phone in their hand. Email is a reminder, not the delivery
    // mechanism — a driver with no email address, or whose mail lands in spam,
    // would otherwise reach a dead end here.
    // Still no internal verdict: a disqualified driver gets no links, and is
    // told kindly by email rather than on screen.
    return json({ ok: true, received: true,
      next: (leaseUrl || carrierAppUrl)
        ? { carrier_app: carrierAppUrl, lease: leaseUrl, carrier: carrier ? carrier.name : null }
        : null });
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

    // A posting decides the carrier when the driver came in on one, which is
    // the whole point of the board: the right application, not the default one.
    const jobId = String(b.job || url.searchParams.get('job') || '').trim().slice(0, 40) || null;
    const job = jobId ? await db.prepare("SELECT * FROM jobs WHERE id=? AND status='open'").bind(jobId).first() : null;
    const wantCarrier = (job && job.carrier_id) || carrierId;
    const carrier = wantCarrier
      ? await db.prepare('SELECT * FROM carriers WHERE id=? AND active=1').bind(wantCarrier).first()
      : await firstCarrier(db);
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
      const r = await db.prepare(`INSERT INTO leads (name, phone, email, city, state, status, client_id, source, carrier_id, apply_token, recruiter_id, interest, job_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        name, phone, email, String(b.city || '').trim() || null, String(b.state || '').trim().slice(0, 2).toUpperCase() || null,
        'New', 'house', String(b.source || 'website').slice(0, 120), carrier ? carrier.id : null, applyToken,
        String(b.recruiter || '').trim().slice(0, 40) || null,
        [String(b.interest || b.message || '').trim(), job ? 'job: ' + job.title : '']
          .filter(Boolean).join(' · ').slice(0, 300) || null,
        job ? job.id : null).run();
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
      to: recruitingTeamEmail(env),
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

  // ---- A carrier asking us to recruit for them. Same public surface as the
  // driver form (CORS + honeypot), but it lands in its own table: a carrier
  // must never be picked up by the driver screening or the nudge rules.
  if (action === 'carrier-inquiry') {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'POST') return cors(json({ error: 'method not allowed' }, 405));
    const b = await request.json().catch(() => ({}));
    if (b._hp) return cors(json({ ok: true }));
    const t = (v, n) => String(v || '').trim().slice(0, n) || null;
    const company = t(b.company, 200);
    const email = t(b.email, 200), phone = t(b.phone, 40);
    if (!company || !(email || phone)) {
      return cors(json({ error: 'Company name and an email or phone number are required.' }, 400));
    }
    // A website enquiry becomes a prospect row in `carriers` -- same table the
    // signed partners live in, so it never has to be copied across when they
    // sign. active=0 keeps it out of firstCarrier() and every screening path.
    const id = rid('ca');
    await db.prepare(`INSERT INTO carriers
        (id, name, contact_name, contact_email, contact_phone, dot_number, terminal,
         driver_type, need, status, active, notes)
        VALUES (?,?,?,?,?,?,?,?,?,'prospect',0,?)`).bind(
      id, company, t(b.contact_name, 200), email, phone, t(b.dot_number, 40), t(b.terminal, 200),
      t(b.driver_type, 40), t(b.need, 1000), 'Came in through ' + (t(b.source, 120) || 'the carriers page')).run();

    const row = (k, v) => v ? `<tr><td style="padding:3px 12px 3px 0;color:#5b6472">${esc(k)}</td><td style="font-weight:600">${esc(v)}</td></tr>` : '';
    context.waitUntil(sendEmail(env, {
      to: recruitingTeamEmail(env), replyTo: email || undefined,
      subject: `Carrier enquiry — ${company}`,
      html: emailShell('A carrier wants to talk', `
        <p style="margin:0 0 10px;font-size:16px"><b>${esc(company)}</b></p>
        <table style="font-size:14px">
          ${row('Contact', b.contact_name)}${row('Email', email)}${row('Phone', phone)}
          ${row('DOT #', b.dot_number)}${row('Terminal', b.terminal)}${row('Driver type', b.driver_type)}
        </table>
        ${b.need ? `<p style="margin:12px 0 0;color:#3a4353"><b>What they need:</b><br>${esc(String(b.need).slice(0, 1000))}</p>` : ''}
        <p style="margin:14px 0 0;color:#5b6472;font-size:13px">Reply straight to this email to reach them.</p>`, brandName(env)),
    }));
    return cors(json({ ok: true }));
  }

  // ---- A driver sending us another driver.
  //
  // The referred driver becomes an ordinary lead, so they land in the pipeline
  // the team already works rather than in a list nobody opens. The referral row
  // records who sent them, which is the fact a referral fee is paid on.
  if (action === 'referral') {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'POST') return cors(json({ error: 'method not allowed' }, 405));
    const b = await request.json().catch(() => ({}));
    if (b._hp) return cors(json({ ok: true }));
    const t = (v, n) => String(v || '').trim().slice(0, n) || null;
    const from = t(b.referrer_name, 200), who = t(b.driver_name, 200);
    const fromPhone = t(b.referrer_phone, 40), whoPhone = t(b.driver_phone, 40);
    if (!from || !fromPhone) {
      return cors(json({ error: 'We need your name and your phone number.' }, 400));
    }
    if (!who || !whoPhone) {
      return cors(json({ error: "We need your friend's name and phone number." }, 400));
    }

    const carrierId = url.searchParams.get('carrier');
    const carrier = carrierId
      ? await db.prepare('SELECT * FROM carriers WHERE id=? AND active=1').bind(carrierId).first()
      : await firstCarrier(db);
    const applyToken = token();
    const lead = await db.prepare(`INSERT INTO leads
        (name, phone, email, status, client_id, source, carrier_id, apply_token, interest)
        VALUES (?,?,?, 'New', 'house', 'referral', ?, ?, ?)`).bind(
      who, whoPhone, t(b.driver_email, 200), carrier ? carrier.id : null, applyToken,
      'Referred by ' + from + ' (' + fromPhone + ')').run();
    const leadId = lead && lead.meta ? lead.meta.last_row_id : null;

    await db.prepare(`INSERT INTO referrals
        (id, referrer_name, referrer_phone, referrer_email, driver_name, driver_phone,
         driver_email, lead_id, source, notes)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
      rid('rf'), from, fromPhone, t(b.referrer_email, 200), who, whoPhone,
      t(b.driver_email, 200), leadId, t(b.source, 120) || 'referral page', t(b.note, 1000)).run();

    context.waitUntil(sendEmail(env, {
      to: recruitingTeamEmail(env), replyTo: t(b.referrer_email, 200) || undefined,
      subject: `Referral: ${who}, from ${from}`,
      html: emailShell('A driver sent us someone', `
        <p style="margin:0 0 12px;font-size:16px"><b>${esc(who)}</b> &middot; ${esc(whoPhone)}</p>
        <p style="margin:0 0 12px;color:#3a4353">Referred by <b>${esc(from)}</b> (${esc(fromPhone)}).</p>
        ${b.note ? `<p style="margin:0 0 12px;color:#3a4353">${esc(String(b.note).slice(0, 1000))}</p>` : ''}
        <p style="margin:14px 0 0;color:#5b6472;font-size:13px">Both are in the CRM. The referred driver is a new lead.</p>`,
        brandName(env)),
    }));
    return cors(json({ ok: true }));
  }

  // ---- Someone applying to recruit for us.
  //
  // They go into the same table the working recruiters live in, as status
  // 'applicant' with active=0. Saying yes is then a status change rather than
  // re-typing everything, and active=0 keeps an applicant out of every split
  // and payout path in the meantime.
  if (action === 'recruiter') {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'POST') return cors(json({ error: 'method not allowed' }, 405));
    const b = await request.json().catch(() => ({}));
    if (b._hp) return cors(json({ ok: true }));
    const t = (v, n) => String(v || '').trim().slice(0, n) || null;
    const name = t(b.name, 200), email = t(b.email, 200), phone = t(b.phone, 40);
    if (!name || !(email || phone)) {
      return cors(json({ error: 'We need your name and either an email or a phone number.' }, 400));
    }
    const id = rid('rc');
    await db.prepare(`INSERT INTO recruiters
        (id, name, email, phone, city, experience, share_pct, active, status, source, notes)
        VALUES (?,?,?,?,?,?, 0, 0, 'applicant', ?, ?)`).bind(
      id, name, email, phone, t(b.city, 120), t(b.experience, 200),
      t(b.source, 120) || 'join page', t(b.about, 1000)).run();

    context.waitUntil(sendEmail(env, {
      to: recruitingTeamEmail(env), replyTo: email || undefined,
      subject: `Recruiter application: ${name}`,
      html: emailShell('Someone wants to recruit with us', `
        <p style="margin:0 0 10px;font-size:16px"><b>${esc(name)}</b></p>
        <table style="font-size:14px">
          ${email ? `<tr><td style="padding:3px 12px 3px 0;color:#5b6472">Email</td><td style="font-weight:600">${esc(email)}</td></tr>` : ''}
          ${phone ? `<tr><td style="padding:3px 12px 3px 0;color:#5b6472">Phone</td><td style="font-weight:600">${esc(phone)}</td></tr>` : ''}
          ${b.city ? `<tr><td style="padding:3px 12px 3px 0;color:#5b6472">Where</td><td style="font-weight:600">${esc(String(b.city))}</td></tr>` : ''}
          ${b.experience ? `<tr><td style="padding:3px 12px 3px 0;color:#5b6472">Experience</td><td style="font-weight:600">${esc(String(b.experience))}</td></tr>` : ''}
        </table>
        ${b.about ? `<p style="margin:12px 0 0;color:#3a4353">${esc(String(b.about).slice(0, 1000))}</p>` : ''}
        <p style="margin:14px 0 0;color:#5b6472;font-size:13px">They are in the CRM under Recruiters, pending. Set their share and mark them active to take them on.</p>`,
        brandName(env)),
    }));
    return cors(json({ ok: true }));
  }

  // ---- The public job board.
  //
  // Only open postings, and only the fields meant for the public. The carrier's
  // name is withheld unless that posting says otherwise, which is the same rule
  // the rest of the site follows: a driver learns who they're headed for from
  // us, not from a page anyone can read.
  if (action === 'jobs') {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const { results } = await db.prepare(`
      SELECT j.id, j.title, j.driver_type, j.location, j.haul_type, j.home_time,
             j.pay_summary, j.requirements, j.description, j.openings,
             CASE WHEN j.show_carrier = 1 THEN c.name ELSE NULL END AS carrier_name
      FROM jobs j LEFT JOIN carriers c ON c.id = j.carrier_id
      WHERE j.status = 'open'
      ORDER BY j.sort_order, j.created_at DESC`).all();
    return cors(json({ jobs: results || [] }));
  }

  // ---------- THE LEASE FORM + DOCUMENT RETURN ----------
  if (action === 'lease') {
    if (!tok) return json({ error: 'missing token' }, 400);
    const d = await db.prepare('SELECT * FROM leads WHERE lease_token=?').bind(tok).first();
    if (!d) return json({ error: 'This link is invalid or has expired.' }, 404);
    const c = d.carrier_id ? await db.prepare('SELECT * FROM carriers WHERE id=?').bind(d.carrier_id).first() : null;
    const docsQ = await db.prepare('SELECT id, kind, label, status, doc_date, file_name FROM driver_docs WHERE driver_id=? ORDER BY created_at').bind(d.id).all();

    if (request.method === 'GET') {
      const X = (await leaseRow(db, d.id)) || {};
      const rec = await recruiterFor(db, d);
      return json({ ok: true, done: !!d.lease_info_at,
        carrier: c && { name: c.name, terminal: c.terminal, orientation_info: c.orientation_info },
        carrier_app: c && c.apply_url ? {
          url: `${url.origin}/api/apply/go?token=${tok}`,
          started: !!d.carrier_app_clicked_at,
          confirmed: !!d.confirmation_no,
        } : null,
        secure_enabled: vaultReady(env),
        prefill: {
          name: d.name, phone: d.phone, home_phone: X.home_phone, email: d.email, address: d.address,
          city: d.city, state: d.state, postcode: X.postcode || d.postcode, gender: X.gender, dob: d.dob,
          us_citizen: d.us_citizen, cdl_state: d.cdl_state, cdl_expires: d.cdl_expires,
          truck_year: d.truck_year, truck_make: d.truck_make, truck_color: d.truck_color,
          truck_plate: d.truck_plate, truck_plate_state: d.truck_plate_state, truck_vin: d.truck_vin,
          truck_unit_no: X.truck_unit_no, truck_value: X.truck_value, lienholder: d.lienholder,
          lienholder_address: X.lienholder_address, lienholder_phone: X.lienholder_phone, lienholder_email: X.lienholder_email,
          wants_carrier_plates: d.wants_carrier_plates, wants_ifta: d.wants_ifta,
          wants_maintenance: X.wants_maintenance, maintenance_weekly: X.maintenance_weekly, maintenance_max: X.maintenance_max,
          has_business: d.has_business, business_name: d.business_name, business_ein: X.business_ein,
          business_owner: X.business_owner, business_address: X.business_address,
          business_phone: X.business_phone, business_email: X.business_email,
        },
        docs: (docsQ.results || []).map((x) => ({ id: x.id, kind: x.kind, label: x.label, status: x.status, file_name: x.file_name, doc_date: x.doc_date })),
        // What the driver has already told us about the carrier's own steps.
        progress: {
          confirmation_no: d.confirmation_no || null,
          clearinghouse_ok: d.clearinghouse_ok,
          drug_test_scheduled_at: d.drug_test_scheduled_at || null,
          drug_test_due: d.drug_test_due || null,
          drug_test_done_at: d.drug_test_done_at || null,
        },
        uploads_enabled: !!env.DOCS });
    }

    if (request.method === 'POST') {
      const b = await request.json().catch(() => ({}));
      // Fields that live on `leads` (queried elsewhere)...
      const onLead = {}, LF = ['address', 'city', 'state', 'truck_year', 'truck_make', 'truck_color',
        'truck_plate', 'truck_plate_state', 'truck_vin', 'lienholder', 'business_name'];
      for (const f of LF) if (f in b) onLead[f] = b[f] === '' ? null : b[f];
      for (const f of ['us_citizen', 'wants_carrier_plates', 'wants_ifta', 'has_business'])
        if (f in b) onLead[f] = bit(b[f]);
      // ...and the lease form's own fields, which live on `driver_lease`.
      const onLease = {}, XF = ['gender', 'home_phone', 'postcode', 'truck_unit_no', 'truck_value',
        'lienholder_address', 'lienholder_phone', 'lienholder_email', 'maintenance_weekly',
        'maintenance_max', 'business_ein', 'business_owner', 'business_address', 'business_phone',
        'business_email'];
      for (const f of XF) if (f in b) onLease[f] = b[f] === '' ? null : b[f];
      if ('wants_maintenance' in b) onLease.wants_maintenance = bit(b.wants_maintenance);

      // The sensitive fields go into the vault, never into a readable column.
      const secureIn = {};
      for (const f of ['ssn', 'dl_number', 'bank_name', 'account_name', 'routing', 'account', 'ein'])
        if (b[f]) secureIn[f] = String(b[f]).trim().slice(0, 60);
      let sealed = null;
      if (Object.keys(secureIn).length) {
        if (!vaultReady(env)) return json({ error: 'Secure fields are not enabled on this deployment. Contact us and we will collect these another way.' }, 400);
        sealed = await seal(env, secureIn);
      }

      if (Object.keys(onLead).length) {
        const cols = Object.keys(onLead);
        await db.prepare(`UPDATE leads SET ${cols.map((c) => c + '=?').join(', ')}, updated_at=datetime('now') WHERE id=?`)
          .bind(...cols.map((c) => onLead[c]), d.id).run();
      }
      onLease.lease_info = JSON.stringify({ submitted: true });
      if (sealed) onLease.lease_secure = sealed;
      // Upsert: the driver may come back and change an answer.
      const xcols = Object.keys(onLease);
      await db.prepare(`INSERT INTO driver_lease (driver_id, ${xcols.join(', ')}) VALUES (?${xcols.map(() => ', ?').join('')})
        ON CONFLICT(driver_id) DO UPDATE SET ${xcols.map((c) => `${c}=excluded.${c}`).join(', ')}, updated_at=datetime('now')`)
        .bind(d.id, ...xcols.map((c) => onLease[c])).run();
      // The carrier never reports back to us, so the driver is the one person
      // who actually knows these. Let them tell us directly.
      const prog = {}, PROG = ['confirmation_no', 'drug_test_scheduled_at', 'drug_test_done_at'];
      for (const f of PROG) if (b[f]) prog[f] = String(b[f]).slice(0, 60);
      if ('clearinghouse_ok' in b) prog.clearinghouse_ok = bit(b.clearinghouse_ok);
      if (prog.drug_test_scheduled_at) {
        // Scheduling starts the carrier's business-day clock.
        let days = 7;
        if (c) days = parseRules(c.qual_rules).drug_test_business_days || 7;
        prog.drug_test_due = addBusinessDays(prog.drug_test_scheduled_at, days);
      }
      const pcols = Object.keys(prog);
      const sets = ["lease_info_at=datetime('now')", "updated_at=datetime('now')", ...pcols.map((k) => k + '=?')];
      await db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id=?`).bind(...pcols.map((k) => prog[k]), d.id).run();

      // Electing the plate program adds the title and 2290 to their checklist.
      if (c) { const fresh = await db.prepare('SELECT * FROM leads WHERE id=?').bind(d.id).first(); await seedDocs(db, fresh, c); }

      context.waitUntil(sendEmail(env, {
        to: recruitingTeamEmail(env),
        subject: `Lease form returned — ${d.name}`,
        html: emailShell('Lease form returned', `
          <p style="margin:0 0 10px;font-size:16px"><b>${esc(d.name)}</b> completed their lease information${sealed ? ' including direct deposit details' : ''}.</p>
          <p style="margin:0;color:#5b6472;font-size:13.5px">Open their file in the CRM to review and send the packet to the carrier.</p>`, brandName(env)),
      }));
      return json({ ok: true, saved: true });
    }
  }

  // ---------- TRACKED HAND-OFF TO THE CARRIER'S OWN APPLICATION ----------
  // Redirects the driver to the carrier's platform (Evans -> Tenstreet) and
  // records that they actually went. "Sent" and "started" are different facts,
  // and the gap between them is where applications quietly die.
  if (action === 'go' && request.method === 'GET') {
    if (!tok) return json({ error: 'missing token' }, 400);
    const d = await db.prepare('SELECT * FROM leads WHERE apply_token=? OR lease_token=?').bind(tok, tok).first();
    if (!d) return json({ error: 'This link is invalid or has expired.' }, 404);
    const c = d.carrier_id ? await db.prepare('SELECT * FROM carriers WHERE id=?').bind(d.carrier_id).first() : await firstCarrier(db);
    const rec = await recruiterFor(db, d);
    const target = carrierApplyUrl(c, rec);
    if (!target) return json({ error: 'No carrier application is configured yet.' }, 404);
    await db.prepare(`UPDATE leads SET carrier_app_clicked_at=COALESCE(carrier_app_clicked_at, datetime('now')),
        carrier_app_clicks=COALESCE(carrier_app_clicks,0)+1, updated_at=datetime('now') WHERE id=?`).bind(d.id).run();
    return new Response(null, { status: 302, headers: { location: target, 'cache-control': 'no-store' } });
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
  // Drivers see plain English; the carrier's official wording stays on `label`
  // for the CRM and the packet.
  return Object.entries(VIOLATIONS).map(([code, v]) => ({
    code, label: v.short || v.label, label_es: v.es || v.short || v.label,
    group: v.prohibit_years ? 'serious' : 'minor',
  }));
}
