// functions/_lib/screening.js
// Driver qualification engine.
//
// The rubric is DATA, not code: every carrier row owns a `qual_rules` JSON blob
// and this file just applies it. The default below is Evans Delivery's
// "Driver Qualification Criteria" (revised January 2024), transcribed exactly.
// A second carrier with different thresholds needs a new rules blob, not a code
// change.
//
// Verdicts mirror what the carrier's Safety dept actually does:
//   qualified    -> 3 points or less, nothing else wrong: pre-qualified
//   review       -> 4-5 points, or a case-by-case item (felony, habitual
//                   suspensions): needs Safety Management approval
//   disqualified -> 6+ points, an active prohibition, or a hard requirement missed
//
// We screen BEFORE submitting so we never burn a carrier relationship (or a
// driver's time) on an application that was always going to bounce.

// ---- The violation chart. `kind` decides which lookback window applies:
//      'moving' -> the 3-year moving-violation review
//      'accident' -> the 5-year accident review
//      `serious` marks an FMCSA Serious Traffic Offense (1-year combination rule).
export const VIOLATIONS = {
  // 1 point
  speeding_1_10:          { points: 1, kind: 'moving',   label: 'Speeding 1–10 mph' },
  seatbelt:               { points: 1, kind: 'moving',   label: 'Seatbelt' },
  traffic_control_device: { points: 1, kind: 'moving',   label: 'Failure to obey a traffic control device' , short: 'Disobeyed a traffic signal or sign'},
  lane_usage:             { points: 1, kind: 'moving',   label: 'Restricted lane usage / failure to maintain lane' , short: 'Failure to keep in lane'},
  failure_to_yield:       { points: 1, kind: 'moving',   label: 'Failure to yield' },
  misc_traffic:           { points: 1, kind: 'moving',   label: 'Other miscellaneous traffic conviction' , short: 'Another traffic ticket'},
  oos_inspection:         { points: 1, kind: 'moving',   label: 'Out of Service roadside inspection' , short: 'Out-of-service roadside inspection'},
  // 2 points
  speeding_11_14:         { points: 2, kind: 'moving',   label: 'Speeding 11–14 mph' },
  improper_turn:          { points: 2, kind: 'moving',   label: 'Improper turn / U-turn' },
  improper_passing:       { points: 2, kind: 'moving',   label: 'Improper passing' },
  failure_to_signal:      { points: 2, kind: 'moving',   label: 'Failing to signal' },
  preventable_crash:      { points: 2, kind: 'accident', label: 'Preventable crash', crash: true },
  // 3 points
  speeding_15_19:         { points: 3, kind: 'moving',   label: 'Speeding 15–19 mph', serious: true },
  following_too_closely:  { points: 3, kind: 'moving',   label: 'Following too closely', serious: true },
  handheld_texting:       { points: 3, kind: 'moving',   label: 'Handheld mobile phone or texting', serious: true, handheld: true , short: 'Phone or texting while driving'},
  railroad:               { points: 3, kind: 'moving',   label: 'Violation involving a railroad' , short: 'Railroad crossing violation'},
  radar_detector:         { points: 3, kind: 'moving',   label: 'Using or equipping a CMV with a radar detector' , short: 'Radar detector in the truck'},
  erratic_lane_change:    { points: 3, kind: 'moving',   label: 'Improper / erratic lane changing', serious: true , short: 'Unsafe lane change'},
  // 3-year prohibition — not scored, an outright bar while inside the window
  speeding_20_plus:       { prohibit_years: 3, label: 'Speeding 20+ mph', serious: true },
  school_or_work_zone:    { prohibit_years: 3, label: 'Passing a school bus / speeding through a school, work or construction zone', serious: true , short: 'School bus, school or work zone'},
  oos_order_violation:    { prohibit_years: 3, label: 'Violation of a driver or vehicle out-of-service order', serious: true , short: 'Broke an out-of-service order'},
  fleeing_police:         { prohibit_years: 3, label: 'Fleeing or eluding a police officer', serious: true , short: 'Fleeing or eluding police'},
  // 5-year prohibition
  dui_dwi:                { prohibit_years: 5, label: 'DUI / DWI', serious: true },
  drug_alcohol_offense:   { prohibit_years: 5, label: 'Drug or alcohol use / possession / intent', serious: true , short: 'Drug or alcohol offense'},
  fatality_accident:      { prohibit_years: 5, label: 'Preventable DOT recordable accident resulting in a fatality', serious: true, crash: true , short: 'Accident involving a fatality'},
  hit_and_run:            { prohibit_years: 5, label: 'Leaving the scene of an accident / hit & run', serious: true , short: 'Left the scene / hit & run'},
  cmv_felony:             { prohibit_years: 5, label: 'Using a CMV in the commission of a felony', serious: true , short: 'Used a truck in a felony'},
  negligent_homicide:     { prohibit_years: 5, label: 'Negligent homicide, manslaughter or assault involving a vehicle', serious: true , short: 'Vehicular homicide or assault'},
  reckless_careless:      { prohibit_years: 5, label: 'Reckless / careless driving', serious: true },
};

export const DEFAULT_RULES = {
  min_age: 22,
  cdl_class: 'A',
  cdl_from_state_of_residence: true,
  dot_medical_required: true,
  work_authorization_required: true,
  citizenship_required: false,
  owns_truck_required: true,
  owns_trailer_required: false,
  experience: { months_in_5yr: 12, months_in_3yr: 8, flatbed_months_in_1yr: 6 },
  max_crash_or_serious_1yr: 1,
  handheld_lookback_months: 6,
  drug_alcohol_lookback_years: 10,
  sap_lookback_years: 10,
  points: { prequalified_max: 3, review_max: 5, disqualify_at: 6, moving_violation_years: 3, accident_years: 5 },
  case_by_case: ['felony_non_commercial', 'misdemeanor', 'habitual_suspension'],
  inspection_max_age_days: 30,
  drug_test_business_days: 7,
};

export function parseRules(raw) {
  if (!raw) return DEFAULT_RULES;
  try {
    const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return { ...DEFAULT_RULES, ...r,
      experience: { ...DEFAULT_RULES.experience, ...(r.experience || {}) },
      points: { ...DEFAULT_RULES.points, ...(r.points || {}) } };
  } catch { return DEFAULT_RULES; }
}

const day = 86400000;
const parseDate = (s) => { if (!s) return null; const d = new Date(String(s).slice(0, 10) + 'T00:00:00Z'); return isNaN(d) ? null : d; };
const monthsSince = (d, now) => d ? (now - d) / (day * 30.4375) : Infinity;
const yearsSince = (d, now) => d ? (now - d) / (day * 365.25) : Infinity;

export function ageOn(dob, now = new Date()) {
  const d = parseDate(dob); if (!d) return null;
  let a = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) a--;
  return a;
}

// Adds N business days (Mon–Fri) to a date. Used for the carrier's drug-test
// window, which is quoted in business days, not calendar days.
export function addBusinessDays(from, n) {
  const d = new Date(from instanceof Date ? from.getTime() : parseDate(from) || Date.now());
  let left = n;
  while (left > 0) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) left--; }
  return d.toISOString().slice(0, 10);
}

/**
 * Screen a driver against a carrier's rules.
 * @param driver  a leads row (or an application payload with the same field names)
 * @param rules   parsed qual_rules
 * @returns {{result, points, blockers[], reviews[], warnings[], passed[], scored[]}}
 */
export function screen(driver = {}, rules = DEFAULT_RULES, now = new Date()) {
  const R = parseRules(rules);
  const blockers = [];   // hard fails -> disqualified
  const reviews = [];    // needs Safety Management approval -> review
  const warnings = [];   // not disqualifying, but the recruiter should know
  const passed = [];
  const t = now.getTime();

  // ---- Age
  const age = ageOn(driver.dob, now);
  if (age == null) warnings.push('No date of birth on file — age not verified.');
  else if (age < R.min_age) blockers.push(`Under the minimum age (${age} years old; ${R.min_age}+ required).`);
  else passed.push(`Age ${age}`);

  // ---- Work authorization (citizenship explicitly NOT required)
  if (R.work_authorization_required && driver.work_authorized != null && !driver.work_authorized)
    blockers.push('Not legally authorised to work in the US.');
  else if (driver.work_authorized) passed.push('Authorised to work in the US');

  // ---- CDL
  if (R.cdl_class && driver.cdl_class && driver.cdl_class !== R.cdl_class)
    blockers.push(`Holds a Class ${driver.cdl_class} CDL; Class ${R.cdl_class} required.`);
  else if (driver.cdl_class === R.cdl_class) passed.push(`Class ${R.cdl_class} CDL`);
  if (R.cdl_from_state_of_residence && driver.cdl_state && driver.state && driver.cdl_state !== driver.state)
    reviews.push(`CDL is from ${driver.cdl_state} but the driver lives in ${driver.state} — the CDL must be issued by the state of residence.`);
  if (driver.cdl_expires && parseDate(driver.cdl_expires) && parseDate(driver.cdl_expires) < now)
    blockers.push('CDL has expired.');

  // ---- DOT medical
  if (R.dot_medical_required) {
    const med = parseDate(driver.dot_medical_expires);
    if (!med) warnings.push('No DOT medical card expiry on file.');
    else if (med < now) blockers.push('DOT medical certification has expired.');
    else if ((med - t) / day < 30) warnings.push('DOT medical card expires within 30 days.');
    else passed.push('DOT medical current');
  }

  // ---- Experience
  const e5 = Number(driver.exp_months_5yr), e3 = Number(driver.exp_months_3yr);
  if (Number.isFinite(e5)) {
    if (e5 < R.experience.months_in_5yr)
      blockers.push(`Only ${e5} months of verifiable Class A experience in the last 5 years (${R.experience.months_in_5yr} required).`);
    else passed.push(`${e5} months Class A experience in 5 years`);
  } else warnings.push('Class A experience (5-year total) not captured.');
  if (Number.isFinite(e3) && e3 < R.experience.months_in_3yr)
    blockers.push(`Only ${e3} months of that experience falls within the last 3 years (${R.experience.months_in_3yr} required).`);
  if (String(driver.haul_type || '').toLowerCase().includes('flatbed')) {
    const f = Number(driver.flatbed_months_1yr);
    if (Number.isFinite(f) && f < R.experience.flatbed_months_1yr)
      blockers.push(`Flatbed work requires ${R.experience.flatbed_months_1yr} months pulling flatbed in the previous year (has ${f}).`);
  }
  if (driver.can_verify_employers === 0 && !driver.has_1099s)
    warnings.push('Previous employers may not be reachable — the carrier will ask for 3 years of 1099s instead.');

  // ---- Owner-operator equipment
  if (R.owns_truck_required && driver.owns_truck != null && !driver.owns_truck)
    blockers.push('Does not own a truck — this carrier leases on owner-operators only.');
  else if (driver.owns_truck) passed.push('Owns a tractor');

  // ---- Drug & alcohol history
  const pos = parseDate(driver.positive_test_at);
  if (pos && yearsSince(pos, t) < R.drug_alcohol_lookback_years)
    blockers.push(`Positive or refused drug/alcohol test within the last ${R.drug_alcohol_lookback_years} years.`);
  const sap = parseDate(driver.sap_completed_at);
  if (sap && yearsSince(sap, t) < R.sap_lookback_years)
    blockers.push(`Not eligible until ${R.sap_lookback_years} years after completing a Substance Abuse Program (completed ${driver.sap_completed_at}).`);

  // ---- Background: felonies and misdemeanors are case-by-case, never auto-fail
  if (driver.felony) reviews.push('Non-commercial felony on record — carrier reviews case by case.');
  if (driver.misdemeanor) reviews.push('Misdemeanor on record — allowed, reviewed case by case.');
  if (driver.habitual_suspension) reviews.push('Habitual suspension history — carrier reviews case by case.');

  // ---- Violations: prohibitions, then points
  let list = [];
  try { list = typeof driver.violations === 'string' ? JSON.parse(driver.violations || '[]') : (driver.violations || []); }
  catch { list = []; }
  if (!Array.isArray(list)) list = [];

  let points = 0;
  const scored = [];
  let seriousOrCrash1yr = 0;

  for (const v of list) {
    const def = VIOLATIONS[v.code]; if (!def) continue;
    const when = parseDate(v.date);
    const yrs = yearsSince(when, t);

    if (def.prohibit_years) {
      if (yrs < def.prohibit_years)
        blockers.push(`${def.label} — ${def.prohibit_years}-year prohibition (${v.date || 'date unknown'}).`);
      continue;                       // prohibition items are never also scored
    }

    const window = def.kind === 'accident' ? R.points.accident_years : R.points.moving_violation_years;
    if (when && yrs <= window) {
      points += def.points;
      scored.push({ code: v.code, label: def.label, points: def.points, date: v.date });
    } else if (!when) {
      warnings.push(`${def.label} has no date — not scored. Add the date to screen accurately.`);
    }
    // 1-year combination rule: preventable crashes + serious traffic offenses
    if (when && yrs <= 1 && (def.crash || def.serious)) seriousOrCrash1yr++;
    // Handheld/texting has its own short lookback
    if (def.handheld && when && monthsSince(when, t) < R.handheld_lookback_months)
      blockers.push(`Handheld mobile / texting violation within the last ${R.handheld_lookback_months} months.`);
  }

  if (seriousOrCrash1yr > R.max_crash_or_serious_1yr)
    blockers.push(`${seriousOrCrash1yr} preventable crashes or serious traffic offenses in the last year (limit is ${R.max_crash_or_serious_1yr}).`);

  // ---- Points verdict
  if (points >= R.points.disqualify_at) blockers.push(`${points} points — ${R.points.disqualify_at} or more is not qualified.`);
  else if (points > R.points.prequalified_max) reviews.push(`${points} points — 4 or 5 points needs Safety Management approval.`);
  else passed.push(`${points} points (pre-qualified at ${R.points.prequalified_max} or less)`);

  // ---- Federal inspection freshness (matters at submission time, not before)
  if (driver.inspection_date) {
    const insp = parseDate(driver.inspection_date);
    const ageDays = insp ? (t - insp) / day : null;
    if (ageDays != null && ageDays > R.inspection_max_age_days)
      warnings.push(`Federal inspection is ${Math.round(ageDays)} days old — the carrier requires one dated within ${R.inspection_max_age_days} days. A new inspection is needed before submitting.`);
  }

  const result = blockers.length ? 'disqualified' : (reviews.length ? 'review' : 'qualified');
  return { result, points, blockers, reviews, warnings, passed, scored };
}

// Convenience: the summary line a recruiter reads at a glance.
export function screenSummary(s) {
  if (s.result === 'disqualified') return `Not qualified — ${s.blockers[0]}`;
  if (s.result === 'review') return `Needs Safety approval — ${s.reviews[0]}`;
  return `Pre-qualified · ${s.points} point${s.points === 1 ? '' : 's'}`;
}
