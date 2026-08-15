// functions/_lib/intakedoc.js
// Shared intake helpers:
//   DEFAULT_FORM    — a complete fallback intake used whenever the assigned
//                     doctor has no custom form (so the patient link ALWAYS works).
//   renderIntakeDoc — a standalone, print-ready HTML document of a patient's
//                     completed intake (emailed to the doctor as an attachment;
//                     they can open it and "Save as PDF").
//   b64utf8         — UTF-8-safe base64 for email attachments in Workers.
import { esc } from './email.js';

// Availability fields intake.html always appends (kept in sync with the form page).
export const AVAIL = [
  ['avail_dates', 'Preferred dates'],
  ['avail_time', 'Preferred time of day'],
  ['avail_tz', 'Time zone'],
  ['avail_phone', 'Best phone for the consult'],
];

// A sensible general medical / regenerative-medicine intake. Used when a doctor
// hasn't defined their own form. The section order/shape is deterministic so the
// answer keys (chk_/fam_/hab_/rate_ + section index) line up on review.
export const DEFAULT_FORM = {
  title: 'Patient Medical Intake',
  sections: [
    { title: 'Your details', fields: [
      { k: 'dob', label: 'Date of birth', type: 'date' },
      { k: 'sex', label: 'Sex', type: 'text' },
      { k: 'height', label: 'Height', type: 'text' },
      { k: 'weight', label: 'Weight', type: 'text' },
      { k: 'occupation', label: 'Occupation', type: 'text' },
    ] },
    { title: 'What brings you in', fields: [
      { k: 'main_concern', label: 'Your main health concern or goal', type: 'textarea' },
      { k: 'symptoms_desc', label: 'Describe your symptoms — when they started, how they have changed, and any treatments tried', type: 'textarea' },
      { k: 'diagnoses', label: 'Any diagnoses related to this concern', type: 'textarea' },
    ] },
    { title: 'Current conditions', note: 'Select any that apply to you.',
      checks: ['Diabetes', 'High blood pressure', 'Heart disease', 'Cancer', 'Autoimmune condition', 'Thyroid condition', 'Stroke', 'Blood-clotting disorder', 'Kidney disease', 'Liver disease', 'Asthma / lung condition'] },
    { title: 'Medical history', fields: [
      { k: 'surgeries', label: 'Past surgeries (with approximate dates)', type: 'textarea' },
      { k: 'medications', label: 'Current medications and supplements', type: 'textarea' },
      { k: 'allergies', label: 'Allergies (medications, foods, other)', type: 'textarea' },
    ] },
    { title: 'Family history', note: 'Has a close relative had any of these?',
      family: ['Diabetes', 'Heart disease', 'Cancer', 'Autoimmune disease', 'High blood pressure'] },
    { title: 'Lifestyle', grid: { scale: ['Never', 'Sometimes', 'Often', 'Daily'],
      items: ['Tobacco use', 'Alcohol', 'Exercise', 'Caffeine'] },
      fields: [
        { k: 'sleep_hours', label: 'Average hours of sleep per night', type: 'text' },
        { k: 'diet', label: 'Describe your typical diet', type: 'textarea' },
      ] },
    { title: 'How you have felt over the past month', rate: { scale: ['1', '2', '3', '4', '5'],
      items: ['Energy level', 'Pain level', 'Stress level', 'Sleep quality', 'Overall mood'] } },
    { title: 'Anything else', fields: [
      { k: 'other', label: 'Anything else you would like your care team to know', type: 'textarea' },
    ] },
    { title: 'Consent', consent: true,
      consent_text: 'I give consent to be assessed by the medical team and authorize them to collect, store and use this information to deliver functional health and regenerative-medicine services. I confirm the information provided is accurate to the best of my knowledge.' },
  ],
};

function row(label, val) {
  const empty = val == null || val === '';
  return `<tr><td class="q">${esc(label)}</td><td class="a${empty ? ' e' : ''}">${empty ? '—' : esc(val)}</td></tr>`;
}

function sectionsHtml(form, ans) {
  let out = '';
  (form.sections || []).forEach((s, si) => {
    let rows = '';
    (s.fields || []).forEach((f) => { rows += row(f.label, ans[f.k]); });
    if (s.family) s.family.forEach((x, i) => { rows += row(x, ans['fam_' + si + '_' + i]); });
    if (s.grid) s.grid.items.forEach((x, i) => { rows += row(x, ans['hab_' + si + '_' + i]); });
    if (s.rate) s.rate.items.forEach((x, i) => { rows += row(x, ans['rate_' + si + '_' + i]); });
    let chips = '';
    if (s.checks) {
      const on = s.checks.map((c, i) => ans['chk_' + si + '_' + i]).filter(Boolean);
      chips = `<div class="chips">${on.length ? on.map((c) => `<span class="chip">${esc(c)}</span>`).join('') : '<span class="e">— none —</span>'}</div>`;
    }
    if (rows || chips) out += `<h2>${esc(s.title || 'Section')}</h2>${rows ? `<table class="qa">${rows}</table>` : ''}${chips}`;
  });
  return out;
}

// Full standalone HTML document (its own <html>) — safe to attach to an email.
export function renderIntakeDoc(form, ans, { patient, doctor, brand = 'MXN Cells' } = {}) {
  const availOn = AVAIL.filter(([k]) => ans[k]);
  const availHtml = availOn.length
    ? `<h2>Requested consultation availability</h2><table class="qa">${availOn.map(([k, l]) => row(l, ans[k])).join('')}</table>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(patient || 'Patient')} — Intake</title>
<style>
  body{font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a2230;max-width:820px;margin:26px auto;padding:0 22px}
  .brand{font-size:12px;font-weight:700;color:#2f6fed;letter-spacing:.04em;text-transform:uppercase}
  h1{font-size:23px;margin:4px 0 2px}.org{color:#5b6472;font-size:13px}
  .meta{margin:14px 0 20px;border-top:1px solid #e6ebf2;border-bottom:1px solid #e6ebf2;padding:11px 0;font-size:13px;color:#5b6472}
  .meta b{color:#1a2230}
  h2{font-size:12.5px;text-transform:uppercase;letter-spacing:.03em;color:#5b6472;border-bottom:1px solid #e6ebf2;padding-bottom:6px;margin:22px 0 10px}
  table.qa{width:100%;border-collapse:collapse;margin-bottom:4px}
  .qa td{padding:5px 12px 5px 0;vertical-align:top}
  .qa .q{color:#5b6472;width:250px}.qa .a{font-weight:600}.qa .a.e{font-weight:400;color:#aab3c0}
  .chips{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 6px}
  .chip{background:#eef1f6;border:1px solid #e6ebf2;border-radius:14px;padding:3px 11px;font-size:12.5px}
  .e{color:#aab3c0}
  @media print{body{margin:0;max-width:none}}
</style></head><body>
  <div class="brand">${esc(brand)}</div>
  <h1>${esc(form.title || 'Patient Medical Intake')}</h1><div class="org">${esc(form.org || doctor || '')}</div>
  <div class="meta"><b>Patient:</b> ${esc(patient || '—')} &nbsp;·&nbsp; <b>Assigned doctor:</b> ${esc(doctor || '—')}</div>
  ${availHtml}
  ${sectionsHtml(form, ans)}
</body></html>`;
}

// UTF-8-safe base64 (btoa is latin1-only in Workers).
export function b64utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
