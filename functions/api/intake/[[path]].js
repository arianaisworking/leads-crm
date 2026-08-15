// functions/api/intake/[[path]].js
// PUBLIC (exempt from the auth gate in _middleware.js). Patients complete their
// assigned doctor's intake form via a per-patient token — no login.
//   GET  /api/intake/form?token=...     -> { form, patient_name, doctor_name, submitted }
//   POST /api/intake/submit?token=...   -> { answers }  saves to the patient record

import { json } from '../../_lib/tenant.js';

export async function onRequest(context) {
  const { request, env, params } = context;
  const db = env.DB;
  const action = (params.path || [])[0];
  const url = new URL(request.url);
  const tok = url.searchParams.get('token') || '';
  if (!tok) return json({ error: 'missing token' }, 400);

  const lead = await db.prepare('SELECT id, name, assigned_doctor, questionnaire, status FROM leads WHERE intake_token=?').bind(tok).first();
  if (!lead) return json({ error: 'This link is invalid or has expired.' }, 404);

  if (action === 'form' && request.method === 'GET') {
    let form = null, doctorName = null;
    if (lead.assigned_doctor) {
      const doc = await db.prepare('SELECT name, intake_form FROM doctors WHERE id=?').bind(lead.assigned_doctor).first();
      if (doc) { doctorName = doc.name; try { form = doc.intake_form ? JSON.parse(doc.intake_form) : null; } catch { form = null; } }
    }
    return json({ patient_name: lead.name, doctor_name: doctorName, form, submitted: !!lead.questionnaire });
  }

  if (action === 'submit' && request.method === 'POST') {
    const b = await request.json().catch(() => ({}));
    if (!b.answers || typeof b.answers !== 'object') return json({ error: 'no answers' }, 400);
    await db.prepare("UPDATE leads SET questionnaire=?, status='Intake returned', updated_at=datetime('now') WHERE id=?")
      .bind(JSON.stringify(b.answers), lead.id).run();
    return json({ ok: true });
  }

  return json({ error: 'not found' }, 404);
}
