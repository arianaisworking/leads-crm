// functions/api/intake/[[path]].js
// PUBLIC (exempt from the auth gate in _middleware.js).
//   GET  /api/intake/form?token=...     -> { form, patient_name, doctor_name, submitted }   (patient fills)
//   POST /api/intake/submit?token=...   -> { answers }  saves to the patient record, emails the team
//   GET  /api/intake/review?token=...   -> { form, answers, patient_name, doctor_name, status } (doctor reads)

import { json } from '../../_lib/tenant.js';
import { sendEmail, emailShell, teamEmail, brandName, esc } from '../../_lib/email.js';

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

  const lead = await db.prepare('SELECT id, name, assigned_doctor, questionnaire, status, phone, email FROM leads WHERE intake_token=?').bind(tok).first();
  if (!lead) return json({ error: 'This link is invalid or has expired.' }, 404);

  let doctorName = null, doctorForm = null;
  if (lead.assigned_doctor) {
    const doc = await db.prepare('SELECT name, intake_form FROM doctors WHERE id=?').bind(lead.assigned_doctor).first();
    if (doc) { doctorName = doc.name; try { doctorForm = doc.intake_form ? JSON.parse(doc.intake_form) : null; } catch { doctorForm = null; } }
  }

  if (action === 'form' && request.method === 'GET') {
    return json({ patient_name: lead.name, doctor_name: doctorName, form: doctorForm, submitted: !!lead.questionnaire });
  }

  if (action === 'review' && request.method === 'GET') {
    let answers = {};
    try { answers = lead.questionnaire ? JSON.parse(lead.questionnaire) : {}; } catch { answers = {}; }
    return json({ patient_name: lead.name, doctor_name: doctorName, form: doctorForm, answers, status: lead.status, submitted: !!lead.questionnaire });
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
