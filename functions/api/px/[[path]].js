// functions/api/px/[[path]].js
// Patients-app API (team-gated by _middleware). Doctors, partners, referrals,
// per-patient intake links, and the money dashboard.

import { json, uid } from '../../_lib/tenant.js';
import { sendEmail, emailShell, teamEmail, replyToEmail, brandName, esc } from '../../_lib/email.js';

const AVAIL = [
  ['avail_dates', 'Preferred dates'],
  ['avail_time', 'Preferred time of day'],
  ['avail_tz', 'Time zone'],
  ['avail_phone', 'Best phone for the consult'],
];

function token() {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const db = env.DB;
  const seg = params.path || [];
  const [res, id, sub] = seg;
  const method = request.method;

  // ---------- DOCTORS ----------
  if (res === 'doctors') {
    if (method === 'GET' && !id) {
      const { results } = await db.prepare('SELECT * FROM doctors ORDER BY name').all();
      return json({ doctors: results || [] });
    }
    if (method === 'POST') {
      const b = await request.json();
      if (!b.name) return json({ error: 'name required' }, 400);
      const did = b.id || 'dr_' + token().slice(0, 8);
      await db.prepare(`INSERT INTO doctors (id, name, specialty, contact_email, contact_phone, intake_form, fee_type, fee_amount, terms, notes, address, city)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        did, b.name, b.specialty || null, b.contact_email || null, b.contact_phone || null,
        b.intake_form ? JSON.stringify(b.intake_form) : null, b.fee_type || 'flat', b.fee_amount ?? null, b.terms || null, b.notes || null,
        b.address || null, b.city || null).run();
      return json({ ok: true, id: did });
    }
    if (method === 'PATCH' && id) {
      const b = await request.json();
      const cols = ['name', 'specialty', 'contact_email', 'contact_phone', 'fee_type', 'fee_amount', 'terms', 'notes', 'address', 'city'];
      const sets = [], vals = [];
      for (const c of cols) if (c in b) { sets.push(`${c}=?`); vals.push(b[c]); }
      if ('intake_form' in b) { sets.push('intake_form=?'); vals.push(b.intake_form ? JSON.stringify(b.intake_form) : null); }
      if (!sets.length) return json({ error: 'nothing to update' }, 400);
      vals.push(id);
      await db.prepare(`UPDATE doctors SET ${sets.join(', ')} WHERE id=?`).bind(...vals).run();
      return json({ ok: true });
    }
    if (method === 'DELETE' && id) { await db.prepare('DELETE FROM doctors WHERE id=?').bind(id).run(); return json({ ok: true }); }
  }

  // ---------- PARTNERS ----------
  if (res === 'partners') {
    if (method === 'GET' && !id) {
      const { results } = await db.prepare('SELECT * FROM partners ORDER BY name').all();
      return json({ partners: results || [] });
    }
    if (method === 'POST') {
      const b = await request.json();
      if (!b.name) return json({ error: 'name required' }, 400);
      const pid = 'pt_' + token().slice(0, 8);
      await db.prepare(`INSERT INTO partners (id, name, type, contact_email, contact_phone, commission_type, commission_rate, terms, notes)
        VALUES (?,?,?,?,?,?,?,?,?)`).bind(
        pid, b.name, b.type || null, b.contact_email || null, b.contact_phone || null,
        b.commission_type || 'flat', b.commission_rate ?? null, b.terms || null, b.notes || null).run();
      return json({ ok: true, id: pid });
    }
    if (method === 'PATCH' && id) {
      const b = await request.json();
      const cols = ['name', 'type', 'contact_email', 'contact_phone', 'commission_type', 'commission_rate', 'terms', 'active', 'notes'];
      const sets = [], vals = [];
      for (const c of cols) if (c in b) { sets.push(`${c}=?`); vals.push(b[c]); }
      if (!sets.length) return json({ error: 'nothing to update' }, 400);
      vals.push(id);
      await db.prepare(`UPDATE partners SET ${sets.join(', ')} WHERE id=?`).bind(...vals).run();
      return json({ ok: true });
    }
    if (method === 'DELETE' && id) { await db.prepare('DELETE FROM partners WHERE id=?').bind(id).run(); return json({ ok: true }); }
  }

  // ---------- REFERRALS ----------
  if (res === 'referrals') {
    if (method === 'GET' && !id) {
      const { results } = await db.prepare(`
        SELECT r.*, l.name AS patient_name, p.name AS partner_name
          FROM patient_referrals r
          LEFT JOIN leads l ON l.id = r.patient_id
          LEFT JOIN partners p ON p.id = r.partner_id
         ORDER BY r.created_at DESC LIMIT 500`).all();
      return json({ referrals: results || [] });
    }
    if (method === 'POST') {
      const b = await request.json();
      if (!b.patient_id || !b.partner_id) return json({ error: 'patient_id and partner_id required' }, 400);
      const rid = 'rf_' + token().slice(0, 8);
      await db.prepare(`INSERT INTO patient_referrals (id, patient_id, partner_id, service, amount, status, notes)
        VALUES (?,?,?,?,?,?,?)`).bind(rid, b.patient_id, b.partner_id, b.service || null, b.amount ?? null, b.status || 'pending', b.notes || null).run();
      return json({ ok: true, id: rid });
    }
    if (method === 'PATCH' && id) {
      const b = await request.json();
      const sets = [], vals = [];
      for (const c of ['service', 'amount', 'status', 'notes']) if (c in b) { sets.push(`${c}=?`); vals.push(b[c]); }
      if (b.status === 'paid') { sets.push("paid_at=datetime('now')"); }
      if (!sets.length) return json({ error: 'nothing to update' }, 400);
      vals.push(id);
      await db.prepare(`UPDATE patient_referrals SET ${sets.join(', ')} WHERE id=?`).bind(...vals).run();
      return json({ ok: true });
    }
    if (method === 'DELETE' && id) { await db.prepare('DELETE FROM patient_referrals WHERE id=?').bind(id).run(); return json({ ok: true }); }
  }

  // ---------- PATIENTS (stored in leads) ----------
  if (res === 'patients' && !sub) {
    if (method === 'GET' && !id) {
      const { results } = await db.prepare(`SELECT l.*, d.name AS doctor_name FROM leads l LEFT JOIN doctors d ON d.id=l.assigned_doctor ORDER BY l.created_at DESC LIMIT 1000`).all();
      return json({ patients: results || [] });
    }
    if (method === 'GET' && id) {
      const p = await db.prepare('SELECT * FROM leads WHERE id=?').bind(parseInt(id, 10)).first();
      return json({ patient: p || null });
    }
    if (method === 'POST' && !id) {
      const b = await request.json();
      if (!b.name) return json({ error: 'name required' }, 400);
      const r = await db.prepare(`INSERT INTO leads (name, phone, email, status, client_id, interest, assigned_doctor, acquisition_date, doctor_fee, doctor_fee_status, fee_type, fee_rate, treatment_amount)
        VALUES (?,?,?,?, 'house', ?,?,?,?,?,?,?,?)`).bind(
        b.name, b.phone || null, b.email || null, b.status || 'New', b.interest || null,
        b.assigned_doctor || null, b.acquisition_date || null, b.doctor_fee ?? null, b.doctor_fee_status || 'pending',
        b.fee_type || 'flat', b.fee_rate ?? null, b.treatment_amount ?? null).run();
      return json({ ok: true, id: r.meta.last_row_id });
    }
    if (method === 'PATCH' && id) {
      const b = await request.json();
      const cols = ['name', 'phone', 'email', 'status', 'interest', 'assigned_doctor', 'acquisition_date', 'consult_at', 'paid_upfront', 'doctor_fee', 'doctor_fee_status', 'fee_type', 'fee_rate', 'treatment_amount'];
      const sets = [], vals = [];
      for (const c of cols) if (c in b) { sets.push(`${c}=?`); vals.push(b[c]); }
      if (!sets.length) return json({ error: 'nothing to update' }, 400);
      sets.push("updated_at=datetime('now')"); vals.push(parseInt(id, 10));
      await db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id=?`).bind(...vals).run();
      return json({ ok: true });
    }
    if (method === 'DELETE' && id) { await db.prepare('DELETE FROM leads WHERE id=?').bind(parseInt(id, 10)).run(); return json({ ok: true }); }
  }

  // ---------- PER-PATIENT INTAKE LINK ----------
  if (res === 'patients' && sub === 'intake-link' && method === 'POST') {
    const leadId = parseInt(id, 10);
    const lead = await db.prepare('SELECT id, intake_token FROM leads WHERE id=?').bind(leadId).first();
    if (!lead) return json({ error: 'patient not found' }, 404);
    let tok = lead.intake_token;
    if (!tok) { tok = token(); await db.prepare('UPDATE leads SET intake_token=? WHERE id=?').bind(tok, leadId).run(); }
    const origin = new URL(request.url).origin;
    return json({ ok: true, token: tok, url: `${origin}/intake.html?token=${tok}` });
  }

  // ---------- EMAIL THE INTAKE TO THE PATIENT (optional; only if we have their email) ----------
  if (res === 'patients' && sub === 'email-intake' && method === 'POST') {
    const leadId = parseInt(id, 10);
    const lead = await db.prepare('SELECT id, name, email, intake_token FROM leads WHERE id=?').bind(leadId).first();
    if (!lead) return json({ error: 'patient not found' }, 404);
    if (!lead.email) return json({ error: 'This patient has no email on file. Add one first, or use “Get intake link”.' }, 400);
    let tok = lead.intake_token;
    if (!tok) { tok = token(); await db.prepare('UPDATE leads SET intake_token=? WHERE id=?').bind(tok, leadId).run(); }
    const origin = new URL(request.url).origin;
    const link = `${origin}/intake.html?token=${tok}`;
    const first = (lead.name || '').split(' ')[0];
    const inner = `
      <p style="margin:0 0 6px;font-size:16px">Hi${first ? ' ' + esc(first) : ''},</p>
      <p style="margin:0 0 14px;color:#3a4353">Ahead of your consultation, please complete this short medical intake form. It only takes a few minutes — just answer to the best of your knowledge, and note any dates and times you're available so we can arrange a consultation that works for you.</p>
      <p style="margin:0 0 18px"><a href="${link}" style="display:inline-block;background:#2f6fed;color:#fff;text-decoration:none;padding:12px 24px;border-radius:11px;font-weight:700">Open your intake form →</a></p>
      <p style="margin:0 0 6px;color:#5b6472;font-size:13px">When you press submit, your answers come straight back to our team automatically — nothing to print, scan or send.</p>
      <p style="margin:0;color:#5b6472;font-size:13px">Have a question? Just reply to this email and we'll help.</p>`;
    const r = await sendEmail(env, {
      to: lead.email,
      replyTo: replyToEmail(env),
      subject: 'Your medical intake form',
      html: emailShell('Your intake form', inner, brandName(env)),
    });
    if (!r.ok && !r.skipped) return json({ error: 'Could not send the email. ' + (r.error || '') }, 502);
    return json({ ok: true, sent_to: lead.email, emailed: !!r.ok });
  }

  // ---------- SEND TO PATIENT: protocol + deposit + travel dates (one page) ----------
  if (res === 'patients' && sub === 'send-to-patient' && method === 'POST') {
    const leadId = parseInt(id, 10);
    const lead = await db.prepare('SELECT id, name, email, deposit_total, pricing_confirmed_at, intake_token FROM leads WHERE id=?').bind(leadId).first();
    if (!lead) return json({ error: 'patient not found' }, 404);
    if (!lead.email) return json({ error: 'This patient has no email on file. Add one first.' }, 400);
    if (!lead.pricing_confirmed_at || !(Number(lead.deposit_total) > 0)) return json({ error: 'The doctor needs to set the protocol & deposit first.' }, 400);
    let tok = lead.intake_token;
    if (!tok) { tok = token(); await db.prepare('UPDATE leads SET intake_token=? WHERE id=?').bind(tok, leadId).run(); }
    const origin = new URL(request.url).origin;
    const link = `${origin}/confirm.html?token=${tok}`;
    const money = (n) => '$' + (Math.round((n || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const first = (lead.name || '').split(' ')[0];
    // NOTE: only the single deposit total is shown — never the fee breakdown.
    const r = await sendEmail(env, {
      to: lead.email,
      replyTo: replyToEmail(env),
      subject: 'Your treatment plan & next steps',
      html: emailShell('Move forward with your treatment', `
        <p style="margin:0 0 6px;font-size:16px">Hi${first ? ' ' + esc(first) : ''},</p>
        <p style="margin:0 0 14px;color:#3a4353">Your doctor has prepared your treatment plan. To move forward, review it, choose the travel dates you'd like, and pay your deposit of <b>${money(lead.deposit_total)}</b> — all on one secure page.</p>
        <p style="margin:0 0 18px"><a href="${link}" style="display:inline-block;background:#2f6fed;color:#fff;text-decoration:none;padding:12px 26px;border-radius:11px;font-weight:700">Review &amp; secure your treatment →</a></p>
        <p style="margin:0;color:#5b6472;font-size:13px">Questions? Just reply to this email and we'll help.</p>`, brandName(env)),
    });
    if (!r.ok && !r.skipped) return json({ error: 'Could not send the email. ' + (r.error || '') }, 502);
    await db.prepare("UPDATE leads SET deposit_sent_at=datetime('now'), status='Sent to patient', updated_at=datetime('now') WHERE id=?").bind(leadId).run();
    return json({ ok: true, url: link, emailed: !!r.ok, sent_to: lead.email });
  }

  // ---------- FINAL CONFIRMATION to the patient (after doctor confirms travel) ----------
  if (res === 'patients' && sub === 'final-confirm' && method === 'POST') {
    const leadId = parseInt(id, 10);
    const lead = await db.prepare('SELECT id, name, email, travel_dates, travel_confirmed_at, intake_token FROM leads WHERE id=?').bind(leadId).first();
    if (!lead) return json({ error: 'patient not found' }, 404);
    let tok = lead.intake_token;
    if (!tok) { tok = token(); await db.prepare('UPDATE leads SET intake_token=? WHERE id=?').bind(tok, leadId).run(); }
    const prepUrl = `${new URL(request.url).origin}/prepare.html?token=${tok}`;
    let emailed = false;
    if (lead.email) {
      const first = (lead.name || '').split(' ')[0];
      const r = await sendEmail(env, {
        to: lead.email,
        replyTo: replyToEmail(env),
        subject: "You're all set — your treatment is confirmed",
        html: emailShell('Your treatment is confirmed', `
          <p style="margin:0 0 8px;font-size:16px">Great news${first ? ', ' + esc(first) : ''} — everything is confirmed! 🎉</p>
          ${lead.travel_dates ? `<p style="margin:0 0 12px"><b>Your travel:</b> ${esc(lead.travel_dates)}</p>` : ''}
          <p style="margin:0 0 14px;color:#3a4353">Your doctor has confirmed your dates and your deposit is secured. Next, open your travel &amp; preparedness plan — your clinic location and map, a passport reminder, and one-tap requests for lodging, meals, airport transfers and aftercare.</p>
          <p style="margin:0 0 16px"><a href="${prepUrl}" style="display:inline-block;background:#2f6fed;color:#fff;text-decoration:none;padding:12px 24px;border-radius:11px;font-weight:700">Open your preparedness plan →</a></p>
          <p style="margin:0;color:#5b6472;font-size:13px">Questions? Just reply to this email — we're here to help every step of the way.</p>`, brandName(env)),
      });
      emailed = !!r.ok;
    }
    await db.prepare("UPDATE leads SET final_confirmed_at=datetime('now'), status='Confirmed', updated_at=datetime('now') WHERE id=?").bind(leadId).run();
    return json({ ok: true, emailed, sent_to: lead.email || null, prep_url: prepUrl });
  }

  // ---------- SEND TO DOCTOR ----------
  if (res === 'patients' && sub === 'send-to-doctor' && method === 'POST') {
    const leadId = parseInt(id, 10);
    const lead = await db.prepare('SELECT * FROM leads WHERE id=?').bind(leadId).first();
    if (!lead) return json({ error: 'patient not found' }, 404);
    if (!lead.questionnaire) return json({ error: 'This patient has not completed their intake yet.' }, 400);
    if (!lead.assigned_doctor) return json({ error: 'Assign a doctor first.' }, 400);
    const doc = await db.prepare('SELECT name, contact_email, intake_form FROM doctors WHERE id=?').bind(lead.assigned_doctor).first();
    if (!doc || !doc.contact_email) return json({ error: "The assigned doctor has no email on file. Add one on the Doctors tab." }, 400);

    let tok = lead.intake_token;
    if (!tok) { tok = token(); await db.prepare('UPDATE leads SET intake_token=? WHERE id=?').bind(tok, leadId).run(); }
    const origin = new URL(request.url).origin;
    const reviewUrl = `${origin}/review.html?token=${tok}`;

    let ans = {};
    try { ans = lead.questionnaire ? JSON.parse(lead.questionnaire) : {}; } catch { ans = {}; }
    const availRows = AVAIL.filter(([k]) => ans[k]).map(([k, lbl]) =>
      `<tr><td style="padding:4px 10px 4px 0;color:#5b6472">${esc(lbl)}</td><td style="padding:4px 0;font-weight:600">${esc(ans[k])}</td></tr>`).join('');

    const inner = `
      <p style="margin:0 0 6px;font-size:16px">Hello Dr. ${esc(doc.name || '')}, we'd like to refer a patient to you for a consultation.</p>
      <p style="margin:0 0 16px;color:#5b6472">Patient: <b>${esc(lead.name || '')}</b>${lead.phone ? ' · ' + esc(lead.phone) : ''}${lead.email ? ' · ' + esc(lead.email) : ''}</p>
      ${availRows ? `<div style="background:#eef3fe;border:1px solid #cfe0ff;border-radius:10px;padding:12px 14px;margin:0 0 16px">
        <div style="font-weight:700;font-size:13px;margin-bottom:6px;color:#2f6fed">Their availability for the consultation</div>
        <table style="font-size:14px">${availRows}</table></div>` : ''}
      <a href="${reviewUrl}" style="display:inline-block;background:#2f6fed;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:700">Review intake &amp; pick a time →</a>
      <p style="margin:16px 0 0;color:#5b6472;font-size:13px">The link opens the patient's full intake (printable) with a quick scheduler — just choose a consultation time that works with your calendar and we'll confirm it with the patient and coordinate any travel, lodging or aftercare. Prefer email? Simply reply with a time and we'll handle it.</p>`;

    const r = await sendEmail(env, {
      to: doc.contact_email,
      replyTo: replyToEmail(env),
      subject: `Patient referral — ${lead.name || ''}`,
      html: emailShell('New patient referral', inner, brandName(env)),
    });
    if (!r.ok && !r.skipped) return json({ error: 'Could not send the email. ' + (r.error || '') }, 502);

    await db.prepare("UPDATE leads SET status='Sent to doctor', updated_at=datetime('now') WHERE id=?").bind(leadId).run();
    return json({ ok: true, sent_to: doc.contact_email, emailed: !!r.ok, review_url: reviewUrl });
  }

  // ---------- MONEY DASHBOARD ----------
  if (res === 'money' && method === 'GET') {
    const doc = await db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN doctor_fee_status!='paid' THEN doctor_fee ELSE 0 END),0) AS doc_pending,
        COALESCE(SUM(CASE WHEN doctor_fee_status='paid' THEN doctor_fee ELSE 0 END),0) AS doc_paid
      FROM leads WHERE doctor_fee IS NOT NULL`).first();
    const par = await db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN status!='paid' THEN amount ELSE 0 END),0) AS par_pending,
        COALESCE(SUM(CASE WHEN status='paid' THEN amount ELSE 0 END),0) AS par_paid
      FROM patient_referrals WHERE amount IS NOT NULL`).first();
    return json({ doctor: doc || {}, partner: par || {} });
  }

  return json({ error: 'not found' }, 404);
}
