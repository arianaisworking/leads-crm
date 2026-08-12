// functions/_lib/twilio.js
// Per-client subaccount sending + webhook signature validation.

const API = 'https://api.twilio.com/2010-04-01';

function authFor(client, env) {
  // Prefer the client's own subaccount so billing, credentials and reputation
  // are isolated. Fall back to the master account during setup.
  const sid = client?.twilio_subaccount_sid || env.TWILIO_ACCOUNT_SID;
  const token = client?.twilio_subaccount_token || env.TWILIO_AUTH_TOKEN;
  return { sid, token, basic: 'Basic ' + btoa(`${sid}:${token}`) };
}

export async function sendSms(env, client, to, body) {
  const { sid, basic } = authFor(client, env);
  const form = new URLSearchParams();
  form.set('To', to);
  form.set('Body', body);

  // Messaging Service handles number pooling + 10DLC campaign association.
  if (client.twilio_messaging_service_sid) {
    form.set('MessagingServiceSid', client.twilio_messaging_service_sid);
  } else {
    form.set('From', client.twilio_number);
  }

  const res = await fetch(`${API}/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: basic, 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });

  const data = await res.json();
  if (!res.ok) {
    return { ok: false, error: data?.message || 'twilio error', code: data?.code, raw: data };
  }
  return { ok: true, sid: data.sid, status: data.status, segments: Number(data.num_segments || 1) };
}

// Validate X-Twilio-Signature: HMAC-SHA1 over the full URL + sorted POST params.
// Without this, anyone who finds the webhook URL can inject fake inbound texts.
export async function validateTwilioSignature(request, authToken, params, urlOverride) {
  const sig = request.headers.get('X-Twilio-Signature');
  if (!sig || !authToken) return false;

  const url = urlOverride || request.url;
  let data = url;
  for (const key of Object.keys(params).sort()) data += key + params[key];

  const keyMat = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', keyMat, new TextEncoder().encode(data));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));

  // constant-time-ish compare
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

export function twiml(message) {
  const body = message
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`
    : `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
  return new Response(body, { headers: { 'content-type': 'text/xml' } });
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c])
  );
}
