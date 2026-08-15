// functions/api/intake/[[path]].js
// PUBLIC (exempt from the auth gate in _middleware.js).
//   GET  /api/intake/form?token=...     -> { form, patient_name, doctor_name, submitted }   (patient fills)
//   POST /api/intake/submit?token=...   -> { answers }  saves to the patient record, emails the team
//   GET  /api/intake/review?token=...   -> { form, answers, patient_name, doctor_name, status } (doctor reads)

import { json } from '../../_lib/tenant.js';
import { sendEmail, emailShell, teamEmail, replyToEmail, brandName, esc } from '../../_lib/email.js';
import { DEFAULT_FORM } from '../../_lib/intakedoc.js';
import { createDepositCheckout } from '../../_lib/stripe.js';

// Availability fields intake.html always appends, surfaced to the team/doctor.
const AVAIL = [
  ['avail_dates', 'Preferred dates'],
  ['avail_time', 'Preferred time of day'],
  ['avail_tz', 'Time zone'],
  ['avail_phone', 'Best phone for the consult'],
];

export async function onRequest(context) {
  const { request, env, params } = context;
  const db = env.DB;
  const action = (params.path || [])[0];
  const url = new URL(request.url);
  const tok = url.searchParams.get('token') || '';
  if (!tok) return json({ error: 'missing token' }, 400);

  const lead = await db.prepare('SELECT id, name, assigned_doctor, questionnaire, status, phone, email, consult_at, consult_note, treatment_amount, material_deposit, consult_fee, wire_fee, deposit_total, doctor_feedback, pricing_confirmed_at, deposit_paid, protocol, travel_dates, travel_confirmed_at, deposit_link FROM leads WHERE intake_token=?').bind(tok).first();
  if (!lead) return json({ error: 'This link is invalid or has expired.' }, 404);

  let doctorName = null, doctorForm = null;
  if (lead.assigned_doctor) {
    const doc = await db.prepare('SELECT name, intake_form FROM doctors WHERE id=?').bind(lead.assigned_doctor).first();
    if (doc) { doctorName = doc.name; try { doctorForm = doc.intake_form ? JSON.parse(doc.intake_form) : null; } catch { doctorForm = null; } }
  }
  // Every patient gets a usable form: the doctor's custom one, or the default.
  const form = doctorForm || DEFAULT_FORM;

  if (action === 'form' && request.method === 'GET') {
    return json({ patient_name: lead.name, doctor_name: doctorName, form, submitted: !!lead.questionnaire });
  }

  if (action === 'review' && request.method === 'GET') {
    let answers = {};
    try { answers = lead.questionnaire ? JSON.parse(lead.questionnaire) : {}; } catch { answers = {}; }
    return json({ patient_name: lead.name, doctor_name: doctorName, form, answers, status: lead.status,
      submitted: !!lead.questionnaire, consult_at: lead.consult_at || null, consult_note: lead.consult_note || null,
      pricing: {
        treatment_amount: lead.treatment_amount, material_deposit: lead.material_deposit,
        consult_fee: lead.consult_fee, wire_fee: lead.wire_fee == null ? 25 : lead.wire_fee,
        deposit_total: lead.deposit_total, doctor_feedback: lead.doctor_feedback,
        confirmed_at: lead.pricing_confirmed_at, deposit_paid: !!lead.deposit_paid,
        protocol: lead.protocol,
      },
      travel: { dates: lead.travel_dates, confirmed_at: lead.travel_confirmed_at } });
  }

  // Patient-facing confirmation page data — ONLY the total, never the fee
  // breakdown (the 20% + $25 are wrapped in and must stay invisible to patients).
  if (action === 'confirm-info' && request.method === 'GET') {
    return json({
      patient_name: lead.name, doctor_name: doctorName,
      protocol: lead.protocol || null,
      deposit_total: lead.deposit_total || null,
      deposit_paid: !!lead.deposit_paid,
      travel_dates: lead.travel_dates || null,
      travel_confirmed_at: lead.travel_confirmed_at || null,
      ready: !!lead.pricing_confirmed_at,
    });
  }

  // Doctor confirms pricing & leaves feedback after the consultation. Saves the
  // treatment total, the fee breakdown (material deposit + 20% consult fee + $25
  // wire), the computed deposit, and notifies the team so they can collect it.
  if (action === 'pricing' && request.method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null; };
    const treatment = num(b.treatment_amount);
    const material = num(b.material_deposit) || 0;
    const consultFee = num(b.consult_fee) != null ? num(b.consult_fee) : (treatment != null ? Math.round(treatment * 20) / 100 : 0);
    const wire = num(b.wire_fee) != null ? num(b.wire_fee) : 25;
    const total = Math.round((material + consultFee + wire) * 100) / 100;
    const feedback = (b.feedback || '').toString().trim().slice(0, 4000) || null;
    const protocol = (b.protocol || '').toString().trim().slice(0, 6000) || null;
    await db.prepare(`UPDATE leads SET protocol=?, treatment_amount=?, material_deposit=?, consult_fee=?, wire_fee=?, deposit_total=?, doctor_feedback=?, pricing_confirmed_at=datetime('now'), status='Protocol set', updated_at=datetime('now') WHERE id=?`)
      .bind(protocol, treatment, material, consultFee, wire, total, feedback, lead.id).run();
    const money = (n) => '$' + (Math.round((n || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    context.waitUntil(sendEmail(env, {
      to: teamEmail(env),
      subject: `Pricing confirmed — ${lead.name || 'patient'}`,
      html: emailShell('Doctor confirmed the protocol', `
        <p style="margin:0 0 10px;font-size:16px"><b>${esc(doctorName || 'The doctor')}</b> set the protocol &amp; pricing for <b>${esc(lead.name || 'the patient')}</b>.</p>
        ${protocol ? `<div style="background:#f4f6f9;border:1px solid #e3e8ef;border-radius:10px;padding:12px 14px;margin:0 0 14px"><div style="font-weight:700;font-size:13px;margin-bottom:4px">Protocol</div><div style="white-space:pre-wrap">${esc(protocol)}</div></div>` : ''}
        <table style="font-size:14px;margin:0 0 12px">
          <tr><td style="padding:3px 14px 3px 0;color:#5b6472">Treatment total</td><td style="font-weight:600">${money(treatment)}</td></tr>
          <tr><td style="padding:3px 14px 3px 0;color:#5b6472">Material deposit</td><td style="font-weight:600">${money(material)}</td></tr>
          <tr><td style="padding:3px 14px 3px 0;color:#5b6472">Our fee (20%)</td><td style="font-weight:600">${money(consultFee)}</td></tr>
          <tr><td style="padding:3px 14px 3px 0;color:#5b6472">Bank wire fee</td><td style="font-weight:600">${money(wire)}</td></tr>
          <tr><td style="padding:6px 14px 3px 0;font-weight:700">Patient deposit (fees wrapped in)</td><td style="font-weight:700;color:#2f6fed;font-size:16px">${money(total)}</td></tr>
        </table>
        ${feedback ? `<p style="margin:0 0 4px;color:#5b6472;font-weight:600">Doctor's feedback</p><p style="margin:0 0 12px">${esc(feedback)}</p>` : ''}
        <p style="margin:0;color:#5b6472">Open the patient in the CRM and use “Send to patient” to collect the deposit &amp; travel dates.</p>`, brandName(env)),
    }));
    return json({ ok: true, deposit_total: total, consult_fee: consultFee, material_deposit: material, wire_fee: wire });
  }

  // Patient submits their travel dates and pays — from the confirmation page.
  // Saves the dates, creates a Stripe deposit checkout, returns the pay URL.
  if (action === 'confirm-travel' && request.method === 'POST') {
    if (!lead.pricing_confirmed_at) return json({ error: 'This isn\'t ready yet.' }, 400);
    const total = Number(lead.deposit_total);
    if (!Number.isFinite(total) || total <= 0) return json({ error: 'No deposit set.' }, 400);
    const b = await request.json().catch(() => ({}));
    const dates = (b.travel_dates || '').toString().trim().slice(0, 500);
    if (!dates) return json({ error: 'Please add the travel dates you\'re interested in.' }, 400);
    await db.prepare("UPDATE leads SET travel_dates=?, updated_at=datetime('now') WHERE id=?").bind(dates, lead.id).run();
    const origin = new URL(request.url).origin;
    const chk = await createDepositCheckout(env, {
      amountCents: Math.round(total * 100),
      label: `Treatment deposit — ${lead.name || 'patient'}`,
      successUrl: `${origin}/paid.html?token=${tok}&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${origin}/confirm.html?token=${tok}&status=cancel`,
      metadata: { lead_id: String(lead.id), patient: lead.name || '' },
    });
    if (chk.skipped) return json({ error: 'Payments are not set up yet. Please contact us.' }, 400);
    if (!chk.ok) return json({ error: 'Could not start the payment. ' + (chk.error || '') }, 502);
    context.waitUntil(db.prepare("UPDATE leads SET deposit_link=? WHERE id=?").bind(chk.url, lead.id).run());
    return json({ ok: true, url: chk.url });
  }

  // Payment success callback (from paid.html). Verifies the Stripe session is
  // actually paid, marks the deposit paid, and alerts the team + doctor.
  if (action === 'paid-check' && request.method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const sessionId = (b.session_id || '').toString().trim();
    if (!sessionId || !env.STRIPE_SECRET_KEY) return json({ ok: false }, 400);
    if (lead.deposit_paid) return json({ ok: true, already: true });
    let paid = false;
    try {
      const r = await fetch('https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(sessionId), {
        headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
      });
      const s = await r.json().catch(() => ({}));
      paid = r.ok && s && s.payment_status === 'paid';
    } catch { paid = false; }
    if (!paid) return json({ ok: false }, 400);
    await db.prepare("UPDATE leads SET deposit_paid=1, status='Deposit paid', updated_at=datetime('now') WHERE id=?").bind(lead.id).run();
    const money = (n) => '$' + (Math.round((n || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    context.waitUntil(sendEmail(env, {
      to: teamEmail(env),
      subject: `Deposit paid — ${lead.name || 'patient'}`,
      html: emailShell('Deposit paid', `
        <p style="margin:0 0 8px;font-size:16px"><b>${esc(lead.name || 'The patient')}</b> paid their deposit of <b>${money(lead.deposit_total)}</b>.</p>
        ${lead.travel_dates ? `<p style="margin:0 0 8px"><b>Travel dates they want:</b> ${esc(lead.travel_dates)}</p>` : ''}
        <p style="margin:0;color:#5b6472">Next: the doctor confirms the travel dates, then you send the final confirmation.</p>`, brandName(env)),
    }));
    return json({ ok: true });
  }

  // Doctor confirms the patient's requested travel dates (from the review page).
  if (action === 'travel-confirm' && request.method === 'POST') {
    if (!lead.travel_dates) return json({ error: 'No travel dates submitted yet.' }, 400);
    await db.prepare("UPDATE leads SET travel_confirmed_at=datetime('now'), status='Travel confirmed', updated_at=datetime('now') WHERE id=?").bind(lead.id).run();
    context.waitUntil(sendEmail(env, {
      to: teamEmail(env),
      subject: `Travel confirmed — ${lead.name || 'patient'}`,
      html: emailShell('Doctor confirmed travel', `
        <p style="margin:0 0 8px;font-size:16px"><b>${esc(doctorName || 'The doctor')}</b> confirmed the travel dates for <b>${esc(lead.name || 'the patient')}</b>.</p>
        <p style="margin:0 0 8px;font-size:16px;font-weight:700;color:#2f6fed">${esc(lead.travel_dates || '')}</p>
        <p style="margin:0;color:#5b6472">Send the patient their final confirmation from the CRM.</p>`, brandName(env)),
    }));
    return json({ ok: true });
  }

  // Doctor confirms a consultation time from the review page. Sets the consult,
  // advances the stage, and notifies the team (+ the patient if we have an email).
  if (action === 'schedule' && request.method === 'POST') {
    if (!lead.questionnaire) return json({ error: 'Intake not completed yet.' }, 400);
    const b = await request.json().catch(() => ({}));
    const when = (b.consult_at || '').toString().trim();
    if (!when) return json({ error: 'Please choose a date and time.' }, 400);
    const note = (b.note || '').toString().trim().slice(0, 1000) || null;
    await db.prepare("UPDATE leads SET consult_at=?, consult_note=?, status='Consult scheduled', updated_at=datetime('now') WHERE id=?")
      .bind(when, note, lead.id).run();

    const pretty = when.replace('T', ' ');
    const noteHtml = note ? `<p style="margin:0 0 16px;color:#5b6472">Note from the doctor: ${esc(note)}</p>` : '';
    // Team: always (patients may be seniors without email — team confirms by phone).
    context.waitUntil(sendEmail(env, {
      to: teamEmail(env),
      subject: `Consult scheduled — ${lead.name || 'patient'}`,
      html: emailShell('Consultation scheduled', `
        <p style="margin:0 0 6px;font-size:16px"><b>${esc(doctorName || 'The doctor')}</b> confirmed a consultation with <b>${esc(lead.name || 'the patient')}</b>.</p>
        <p style="margin:0 0 10px;font-size:18px;font-weight:700;color:#2f6fed">${esc(pretty)}</p>
        ${noteHtml}
        <p style="margin:0;color:#5b6472">Reach out to the patient${lead.phone ? ' at ' + esc(lead.phone) : ''} to confirm and arrange any travel, lodging or aftercare.</p>`, brandName(env)),
    }));
    // Patient: only if we have an email on file.
    if (lead.email) {
      context.waitUntil(sendEmail(env, {
        to: lead.email,
        replyTo: replyToEmail(env),
        subject: `Your consultation is scheduled`,
        html: emailShell('Your consultation is scheduled', `
          <p style="margin:0 0 6px;font-size:16px">Good news${lead.name ? ', ' + esc(lead.name.split(' ')[0]) : ''} — your consultation with ${esc(doctorName || 'your doctor')} is set for:</p>
          <p style="margin:0 0 14px;font-size:18px;font-weight:700;color:#2f6fed">${esc(pretty)}</p>
          ${noteHtml}
          <p style="margin:0;color:#5b6472">We'll be in touch to confirm the details and help arrange anything you need for your visit.</p>`, brandName(env)),
      }));
    }
    return json({ ok: true, consult_at: when });
  }

  if (action === 'submit' && request.method === 'POST') {
    const b = await request.json().catch(() => ({}));
    if (!b.answers || typeof b.answers !== 'object') return json({ error: 'no answers' }, 400);
    await db.prepare("UPDATE leads SET questionnaire=?, status='Intake returned', updated_at=datetime('now') WHERE id=?")
      .bind(JSON.stringify(b.answers), lead.id).run();

    // Notify the team (best-effort, non-blocking).
    const a = b.answers;
    const availRows = AVAIL.filter(([k]) => a[k]).map(([k, lbl]) =>
      `<tr><td style="padding:4px 10px 4px 0;color:#5b6472">${esc(lbl)}</td><td style="padding:4px 0;font-weight:600">${esc(a[k])}</td></tr>`).join('');
    const reviewUrl = `${url.origin}/review.html?token=${tok}`;
    const inner = `
      <p style="margin:0 0 6px;font-size:16px"><b>${esc(lead.name || 'A patient')}</b> just completed their intake form.</p>
      <p style="margin:0 0 16px;color:#5b6472">Doctor: ${esc(doctorName || 'unassigned')}${lead.phone ? ' · ' + esc(lead.phone) : ''}${lead.email ? ' · ' + esc(lead.email) : ''}</p>
      ${availRows ? `<div style="background:#f4f6f9;border:1px solid #e3e8ef;border-radius:10px;padding:12px 14px;margin:0 0 16px">
        <div style="font-weight:700;font-size:13px;margin-bottom:6px">Availability for the consultation</div>
        <table style="font-size:14px">${availRows}</table></div>` : ''}
      <a href="${reviewUrl}" style="display:inline-block;background:#2f6fed;color:#fff;text-decoration:none;padding:11px 20px;border-radius:10px;font-weight:700">Open the intake document →</a>
      <p style="margin:16px 0 0;color:#8a95a6;font-size:12px">Open it in the CRM to review, then use “Send to doctor.”</p>`;
    context.waitUntil(sendEmail(env, {
      to: teamEmail(env),
      subject: `Intake completed — ${lead.name || 'patient'}`,
      html: emailShell('New intake completed', inner, brandName(env)),
    }));

    return json({ ok: true });
  }

  return json({ error: 'not found' }, 404);
}
