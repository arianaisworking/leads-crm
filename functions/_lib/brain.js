// functions/_lib/brain.js
// Two-model split: a cheap classifier on every inbound, an expensive responder
// only when we actually need words. Both return JSON, never prose.

const ANTHROPIC = 'https://api.anthropic.com/v1/messages';

const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';
const RESPONDER_MODEL = 'claude-sonnet-5';

// Hard stops. These never reach a model - a model can improvise, and on these
// topics improvising is how you get a complaint, a lawsuit, or a fired client.
const STOP_WORDS = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|optout|opt out|remove me)\s*\.?\s*$/i;

export function isStopKeyword(body) {
  return STOP_WORDS.test(body || '');
}

async function callClaude(env, model, system, userContent, maxTokens = 700) {
  const res = await fetch(ANTHROPIC, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || 'anthropic error');

  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  return safeJson(text);
}

function safeJson(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
    return null;
  }
}

// ---------- 1. CLASSIFY ----------

const CLASSIFY_SYSTEM = `You classify one inbound SMS from a lead replying to a business.
Return ONLY a JSON object. No preamble, no markdown, no explanation.

{
  "intent": one of ["interested","booking","reschedule","price_question","service_question","not_interested","already_customer","wrong_number","opt_out","angry","spam_accusation","legal_threat","medical_or_sensitive","unclear"],
  "sentiment": "positive" | "neutral" | "negative",
  "confidence": 0.0-1.0,
  "escalate": true if a human should handle this instead of an AI,
  "extracted": { "preferred_day": string|null, "preferred_time": string|null, "service": string|null }
}

Set escalate=true for: angry, spam_accusation, legal_threat, medical_or_sensitive,
any mention of a lawyer or reporting, or anything you are less than 0.7 confident about.`;

export async function classify(env, threadText, latestMessage) {
  const out = await callClaude(
    env,
    CLASSIFIER_MODEL,
    CLASSIFY_SYSTEM,
    `Conversation so far:\n${threadText || '(none)'}\n\nLatest inbound message:\n"${latestMessage}"`,
    300
  );
  if (!out || !out.intent) {
    return { intent: 'unclear', sentiment: 'neutral', confidence: 0, escalate: true, extracted: {} };
  }
  return out;
}

// ---------- 2. RESPOND ----------

function responderSystem(client, brain, slots) {
  return `You are a front-desk assistant texting on behalf of ${client.name}. You are NOT an AI assistant persona - you write like a helpful human at the front desk. Match the TONE described in BUSINESS FACTS below - it is set per business (e.g. warm and personable for a med spa, direct and factual for a trade).

BUSINESS FACTS (the only source of truth you may use):
${JSON.stringify(brain, null, 2)}

REAL AVAILABLE APPOINTMENT SLOTS (already checked against the live calendar):
${slots && slots.length ? slots.map((s) => `- ${s.label}`).join('\n') : '(none available - do not offer times)'}

HARD RULES
1. Never state a price, policy, guarantee or medical claim that is not in BUSINESS FACTS above. If asked something you do not have, say you will check with the team and set needs_human to true.
2. Never invent an appointment time. Offer only from the slot list, and offer at most two.
3. Keep replies under 320 characters. One question maximum. Text like a person, not a brochure.
4. No emoji unless the lead used one first. No exclamation-point stacking.
5. If the lead sounds annoyed, apologise once, offer to stop texting, and set needs_human to true.
6. Never claim to be a human if asked directly whether this is a bot. Say a real person can jump in, and set needs_human to true.
7. Never assume the lead's gender. Do not use gendered honorifics (sir, ma'am, Mr., Ms.) unless they state it. Use their first name or neutral phrasing.
8. Add-ons: if BUSINESS FACTS lists "add_ons" AND the lead is booking or clearly interested, you MAY mention ONE relevant add-on, briefly and optionally ("want to add ___ for $__?"). Never pushy, never more than one, and skip it entirely if it doesn't fit the moment.

Return ONLY this JSON object:
{
  "reply": "the SMS text to send",
  "action": "continue" | "book" | "close" | "handoff",
  "book_slot": the exact slot "id" you are booking, or null,
  "context_note": "one line for the CRM record - what this lead wants and where they are",
  "service_interest": string|null,
  "objection": string|null,
  "needs_human": boolean,
  "confidence": 0.0-1.0
}`;
}

export async function respond(env, client, brain, slots, threadText, latestMessage) {
  const out = await callClaude(
    env,
    RESPONDER_MODEL,
    responderSystem(client, brain, slots),
    `Conversation so far:\n${threadText || '(none)'}\n\nLead just said:\n"${latestMessage}"\n\nWrite the next reply.`,
    800
  );

  if (!out || !out.reply) {
    return {
      reply: null,
      action: 'handoff',
      book_slot: null,
      context_note: 'AI failed to produce a reply - needs a human',
      needs_human: true,
      confidence: 0,
    };
  }

  // Confidence floor. Below this, a person answers - the lead never knows.
  const floor = Number(env.CONFIDENCE_FLOOR || 0.8);
  if ((out.confidence ?? 0) < floor) out.needs_human = true;

  // Belt and braces: trim anything the model let run long.
  if (out.reply && out.reply.length > 400) out.reply = out.reply.slice(0, 397) + '...';

  return out;
}
