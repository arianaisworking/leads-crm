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

// The GLOBAL intake form — used for every doctor unless one defines a custom
// override. `org` is intentionally omitted so the header adapts to whichever
// doctor the patient is assigned to (falls back to the doctor's name).
// (Edit this object to change the intake for all doctors at once.)
export const DEFAULT_FORM = {"title":"Personal Medical History","sections":[{"title":"Patient information","fields":[{"k":"full_name","label":"Full name","type":"text"},{"k":"dob","label":"Date of birth","type":"date"},{"k":"age","label":"Age","type":"number"},{"k":"gender","label":"Gender","type":"radio","opts":["Male","Female"]},{"k":"weight","label":"Usual weight","type":"text"},{"k":"height","label":"Height","type":"text"},{"k":"address","label":"Permanent address","type":"text"},{"k":"city","label":"City","type":"text"},{"k":"state","label":"State / Province","type":"text"},{"k":"zip","label":"Zip code","type":"text"},{"k":"country","label":"Country","type":"text"},{"k":"phone","label":"Phone","type":"tel"},{"k":"mobile","label":"Mobile phone","type":"tel"},{"k":"email","label":"E-mail","type":"email"},{"k":"current_doctor","label":"Current doctor / primary health provider","type":"text"}]},{"title":"Consent","consent":true,"fields":[{"k":"signature","label":"Type your full name as signature","type":"text"},{"k":"consent_date","label":"Date","type":"date"}]},{"title":"Personal history","fields":[{"k":"birthplace","label":"Place of birth","type":"text"},{"k":"residence","label":"Current residence","type":"text"},{"k":"marital","label":"Marital status","type":"text"},{"k":"religion","label":"Religion","type":"text"},{"k":"exercise","label":"Exercise level","type":"radio","opts":["Sedentary","Light (1-2x/wk)","Moderate (3-4x/wk)","Active (5x/wk)","Super active (7x/wk)"]},{"k":"animals","label":"Live in contact with animals or insects?","type":"radio","opts":["No","Yes"]},{"k":"animals_kind","label":"If yes, what kind?","type":"text"},{"k":"occupation","label":"Current occupation","type":"text"}]},{"title":"Consuming habits","note":"For each, mark use and how often.","grid":{"items":["Coffee or green tea (caffeine)","Tobacco or vapes","Cannabis","Cocaine / Crystal / Meth","Opioids / Heroin / Morphine / Fentanyl","Mushrooms / Ayahuasca / Kambo & other","Alcohol"],"scale":["No","Daily","Weekly","Occasionally"]}},{"title":"Dietary preferences","checks":["No restrictions","Vegetarian","Vegan","Ketogenic","Gluten-free","Carbs restricted","Lactose restricted","Red meat restricted","Animal fat reduced","No dairy","Paleolithic"]},{"title":"Personal & family medical history","note":"Mark where each applies.","family":["Heart Attack","Stroke","High Blood Pressure","Other Heart Disease / Arrhythmia","Diabetes / Insulin Resistance","Obesity","Cholesterol","Thyroid Disease","Anxiety / Depression","Kidney Disease","Kidney Stones","Prostate Enlargement","Severe allergies","Immune Deficiency","Arthritis / Lupus","Gout","Fibromyalgia / Chronic Fatigue","Osteoporosis","Gastritis / Ulcers","Colitis / Irritable Colon","Liver Disorders","Hepatitis A, B or C","Asthma","Anemia","Any cancer (breast, prostate, colon, lung, etc.)","Thrombosis / Blood Clot"]},{"title":"Allergies","checks":["No allergies to report","Penicillin","Sulfa drugs","Aspirin & other NSAIDs","Codeine","Morphine","Milk & dairy","Seafood","Seasonal (pollen, grass)","Hair dye","Metal jewelry","Chemicals","Foods"],"fields":[{"k":"allergy_detail","label":"Describe any severe allergic reaction and when it happened","type":"textarea"}]},{"title":"Medications & supplements","fields":[{"k":"prescriptions","label":"Prescription medicines taken (name, mg, dose) — or write 'none'","type":"textarea"},{"k":"hormones","label":"Hormone use history (incl. contraceptives, implants, pellets) — or 'none'","type":"textarea"}],"checks":["OTC: Aspirin","OTC: Tylenol","OTC: Ibuprofen","OTC: Naproxen","OTC: Sleeping aid","OTC: Antacids","Supplements: B-Complex","Supplements: Vitamin D","Supplements: Omega 3 / Fish Oil","Supplements: Collagen","Supplements: Probiotics","Herbal: Turmeric","Herbal: Ashwagandha","Herbal: Milk Thistle"]},{"title":"Gynecology history (women only)","women":true,"fields":[{"k":"pregnancies","label":"Number of pregnancies","type":"number"},{"k":"childbirths","label":"Natural childbirths","type":"number"},{"k":"cesareans","label":"Cesarean sections","type":"number"},{"k":"last_menstruation","label":"Date of last menstruation","type":"text"},{"k":"last_papsmear","label":"Date of last Pap smear","type":"text"},{"k":"gyn_notes","label":"Hysterectomy / ovary surgery / other — describe","type":"textarea"}]},{"title":"Vaccines / immunization","checks":["Don't know my history","Polio / Sabin","DPT","Tuberculosis","Measles","Mumps","Rubella","Hepatitis A","Hepatitis B","Chicken Pox","Influenza / Flu","Pneumonia","Shingles","HPV","COVID-19"]},{"title":"Hospital admissions & significant events","fields":[{"k":"hospital","label":"Hospital admissions for significant disease (reason, year) — or 'none'","type":"textarea"},{"k":"trauma","label":"Trauma, accidents, fractures (injury, year, complications) — or 'none'","type":"textarea"}]},{"title":"Your current condition & goals","fields":[{"k":"symptoms_desc","label":"Describe your current symptoms — when they started, how they changed, treatments tried","type":"textarea"},{"k":"goals","label":"Primary health goals & expectations in regenerative medicine (be specific)","type":"textarea"}]},{"title":"Symptom self-rating","note":"Rate how you've been feeling lately.","rate":{"scale":["None","Slight","Moderate","Severe"],"items":["General discomfort","Stress / Anxiety","Fast aging","Sweet cravings","Salt cravings","Always thirsty","Mood changes","Irritability","Nervousness","Decreased libido","Erectile dysfunction / impotence","Decreased muscle mass / strength","Fatigue in the morning","Fatigue in the afternoon","Headaches / migraine","Depression / sadness","Cold intolerance","Swelling of ankles / wrists","Numb limbs","Memory lapses","Brain fog","Hot flashes","Night sweats","Insomnia / sleep disorder","Weight gain (waist)","Heart palpitations","High blood pressure","Dizziness / vertigo","Tinnitus","Hair loss / thinning","Dry / itchy skin","Skin sagging or thinning","Easy bruising","Fragile nails","Abdominal cramps"]}},{"title":"Snoring / sleep apnea assessment","rate":{"scale":["None","Slight","Moderate","Severe"],"items":["Loud, persistent snoring","Breathing pauses witnessed by another","Waking suddenly choking / wheezing","Frequent early-morning awakenings","Need to urinate several times at night","Dry mouth / sore throat on waking","Excessive daytime sleepiness","Morning headaches","Chronic fatigue / non-restorative sleep","Difficulty concentrating / memory loss","Irritability / mood swings"]}}]};

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
