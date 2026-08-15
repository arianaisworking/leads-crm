// functions/_lib/email.js
// Thin Resend wrapper. Best-effort by design: email is a notification layer,
// never the system of record. If RESEND_API_KEY is unset or a send fails, the
// caller keeps working — wrap calls in context.waitUntil() so responses aren't
// delayed and failures can't break the request.
//
// Env (set on the Cloudflare Pages project):
//   RESEND_API_KEY  (secret)  — required for any mail to actually send
//   FROM_EMAIL      optional  — default "AIW Patients <patients@arianaisworking.com>"
//                               (must be a Resend-verified domain)
//   TEAM_EMAIL      optional  — where team notifications go (default below)

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export function fromEmail(env) {
  return env.FROM_EMAIL || 'AIW Patients <patients@arianaisworking.com>';
}

export function teamEmail(env) {
  return env.TEAM_EMAIL || 'arianaisworking@gmail.com';
}

export async function sendEmail(env, { to, subject, html, text, replyTo, from }) {
  if (!env.RESEND_API_KEY) return { ok: false, skipped: true, reason: 'no RESEND_API_KEY' };
  if (!to || (Array.isArray(to) && !to.length)) return { ok: false, skipped: true, reason: 'no recipient' };
  const payload = {
    from: from || fromEmail(env),
    to: Array.isArray(to) ? to : [to],
    subject: subject || '(no subject)',
  };
  if (html) payload.html = html;
  if (text) payload.text = text;
  if (replyTo) payload.reply_to = replyTo;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) return { ok: false, status: r.status, error: await r.text().catch(() => '') };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Simple, email-client-safe layout wrapper (inline styles only).
export function emailShell(title, innerHtml) {
  return `<!doctype html><html><body style="margin:0;background:#f4f6f9;padding:24px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2733">
    <div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #e3e8ef;border-radius:14px;overflow:hidden">
      <div style="background:#111c31;color:#fff;padding:16px 22px;font-weight:700;font-size:15px">${esc(title)}</div>
      <div style="padding:22px">${innerHtml}</div>
    </div></body></html>`;
}
