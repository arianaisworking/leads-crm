// functions/_lib/brain.js
// Reads a carrier's qualification criteria — a pasted document or a PDF — and
// drafts the rule set the screening engine runs on.
//
// This is the piece that makes "send us your standards and we'll be screening
// against them" true rather than aspirational. Doing it by hand means someone
// transcribing a points table into JSON, which takes an afternoon and is where
// a typo becomes a driver told they qualify when they don't.
//
// Two design decisions worth keeping:
//
//   1. It DRAFTS. It never saves. Every field comes back with the model's
//      confidence and the sentence it came from, and a human approves before
//      anything reaches a driver. A screening rule is a promise to someone
//      about their livelihood; it does not get set by a model unreviewed.
//
//   2. The output schema is DEFAULT_RULES, field for field. Anything the model
//      returns is therefore already valid input to screen() — no translation
//      layer to drift out of step with the engine.
//
// Raw fetch rather than the Anthropic SDK, deliberately: this project has no
// package.json and no build step, and it already calls Resend the same way.
// Adding the first npm dependency would change how a live site builds, which
// is not a trade worth making for one endpoint.

const API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-5';

// Mirrors DEFAULT_RULES in screening.js. Every rule the engine reads, and
// nothing it doesn't — a field the engine ignores is a field that silently
// does nothing, which is worse than an absent one.
const RULES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rules', 'documents', 'unknowns', 'notes'],
  properties: {
    rules: {
      type: 'object',
      additionalProperties: false,
      required: ['min_age', 'cdl_class', 'experience', 'points'],
      properties: {
        min_age: { type: 'integer', description: 'Minimum driver age. 21 or 22 typically.' },
        cdl_class: { type: 'string', description: 'Usually "A".' },
        cdl_from_state_of_residence: { type: 'boolean' },
        dot_medical_required: { type: 'boolean' },
        work_authorization_required: { type: 'boolean' },
        citizenship_required: { type: 'boolean', description: 'True ONLY if the document requires US citizenship, not merely work authorisation.' },
        owns_truck_required: { type: 'boolean' },
        owns_trailer_required: { type: 'boolean' },
        experience: {
          type: 'object',
          additionalProperties: false,
          required: ['months_in_5yr'],
          properties: {
            months_in_5yr: { type: 'integer', description: 'Months of CDL-A experience required within the last 5 years.' },
            months_in_3yr: { type: 'integer' },
            flatbed_months_in_1yr: { type: 'integer' },
          },
        },
        max_crash_or_serious_1yr: { type: 'integer', description: 'How many crashes or serious violations are tolerated in the last year.' },
        handheld_lookback_months: { type: 'integer', description: 'Months back a handheld/texting citation disqualifies.' },
        drug_alcohol_lookback_years: { type: 'integer' },
        sap_lookback_years: { type: 'integer', description: 'Substance Abuse Professional programme lookback, in years.' },
        points: {
          type: 'object',
          additionalProperties: false,
          required: ['prequalified_max', 'review_max', 'disqualify_at'],
          properties: {
            prequalified_max: { type: 'integer', description: 'At or below this total, the driver is clear.' },
            review_max: { type: 'integer', description: 'Above prequalified_max and at or below this, a human reviews.' },
            disqualify_at: { type: 'integer', description: 'At or above this total, the driver is out.' },
            moving_violation_years: { type: 'integer', description: 'How many years back moving violations count.' },
            accident_years: { type: 'integer', description: 'How many years back accidents count.' },
          },
        },
        case_by_case: {
          type: 'array', items: { type: 'string' },
          description: 'Items the carrier reviews individually rather than auto-rejecting. Use only these tokens where they apply: felony_non_commercial, misdemeanor, habitual_suspension.',
        },
        inspection_max_age_days: { type: 'integer', description: 'How recent the federal inspection must be.' },
        drug_test_business_days: { type: 'integer', description: 'Business days the driver has to complete the drug test.' },
      },
    },
    documents: {
      type: 'array',
      description: 'Documents the carrier requires from the driver, in the order the document lists them.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'label'],
        properties: {
          kind: { type: 'string', description: 'A short snake_case identifier, e.g. registration, title, form_2290, ecm_photo, inspection, voided_check.' },
          label: { type: 'string', description: 'How the carrier names it, in their words.' },
          note: { type: 'string', description: 'Any condition attached — "within 30 days", "front and back", "only if on the plate programme".' },
        },
      },
    },
    unknowns: {
      type: 'array', items: { type: 'string' },
      description: 'Rules the screening engine needs that this document does NOT state. Be thorough here — a missing rule that gets guessed is how a driver is wrongly told they qualify.',
    },
    notes: {
      type: 'string',
      description: 'Anything a recruiter should know that does not fit the rules above — endorsements, TWIC, lanes, quirks.',
    },
  },
};

const SYSTEM = `You read trucking carriers' driver qualification criteria and turn them into a rule set for an automated screening engine.

The rules you produce decide whether a real driver is told they qualify for a job. A rule you invent, or a threshold you round, can send someone into an application they were always going to fail — costing them an afternoon and the recruiter their reputation.

So:
- Extract ONLY what the document actually states. Do not infer a value because it is common in the industry.
- If the document does not state a rule, leave that field out and list it in "unknowns". A field left out falls back to a sensible default the recruiter can review; a field you guessed looks confirmed and gets trusted.
- Points tables: read the thresholds exactly. Note which is "prequalified", which is "review" and which is "disqualify" — carriers word these differently.
- Watch for citizenship specifically. "Legally authorised to work" is NOT a citizenship requirement. Getting this wrong excludes drivers a carrier would have hired.
- Lookback periods matter as much as the thresholds. A 3-year window and a 5-year window are different rules.
- For "case_by_case", only use the tokens listed in the schema, and only where the document says that item is reviewed individually rather than auto-rejected.`;

// Returns { ok, draft, usage } or { ok:false, error }.
// `doc` is either { text } or { pdfBase64, filename }.
export async function draftRules(env, doc, carrierName) {
  if (!env.ANTHROPIC_API_KEY) {
    return { ok: false, error: 'No ANTHROPIC_API_KEY set on this project — add it in Cloudflare and redeploy.' };
  }
  const content = [];
  if (doc && doc.pdfBase64) {
    content.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: doc.pdfBase64 },
    });
  }
  const intro = carrierName ? `These are the driver qualification criteria for ${carrierName}.` : 'These are a carrier\'s driver qualification criteria.';
  content.push({
    type: 'text',
    text: doc && doc.text
      ? `${intro}\n\n---\n${doc.text}\n---\n\nExtract the rule set. List anything the engine needs that this document does not state.`
      : `${intro} Extract the rule set from the attached document. List anything the engine needs that it does not state.`,
  });

  let r;
  try {
    r = await fetch(API, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM,
        thinking: { type: 'adaptive' },
        output_config: {
          effort: 'high',
          format: { type: 'json_schema', schema: RULES_SCHEMA },
        },
        messages: [{ role: 'user', content }],
      }),
    });
  } catch (e) {
    return { ok: false, error: 'Could not reach the model: ' + String(e).slice(0, 200) };
  }

  if (!r.ok) {
    const body = await r.text().catch(() => '');
    return { ok: false, error: `Model returned ${r.status}. ${body.slice(0, 300)}` };
  }
  const d = await r.json().catch(() => null);
  if (!d) return { ok: false, error: 'Model returned something that was not JSON.' };

  // A safety classifier can decline with HTTP 200 — check before reading content.
  if (d.stop_reason === 'refusal') {
    return { ok: false, error: 'The model declined to process this document. Send it through manually.' };
  }
  const block = (d.content || []).find((b) => b.type === 'text');
  if (!block) return { ok: false, error: 'Model returned no text to read.' };

  let draft;
  try { draft = JSON.parse(block.text); } catch {
    return { ok: false, error: 'Model output was not valid JSON. Try again, or paste the criteria as text.' };
  }
  return {
    ok: true,
    draft,
    usage: d.usage ? { in: d.usage.input_tokens, out: d.usage.output_tokens } : null,
  };
}
