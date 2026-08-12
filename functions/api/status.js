// functions/api/status.js
// GET /api/status -> which secrets/bindings are configured (team only).
// Returns booleans only, never the secret values.

import { readSession } from '../_lib/auth.js';
import { json } from '../_lib/tenant.js';

export async function onRequest(context) {
  const { env } = context;
  const sess = await readSession(context);
  if (!sess || sess.role !== 'team') return json({ error: 'forbidden' }, 403);

  const has = (k) => !!(env[k] && String(env[k]).length);
  return json({
    checks: {
      DB: !!env.DB,
      ANTHROPIC_API_KEY: has('ANTHROPIC_API_KEY'),
      TWILIO_ACCOUNT_SID: has('TWILIO_ACCOUNT_SID'),
      TWILIO_AUTH_TOKEN: has('TWILIO_AUTH_TOKEN'),
      CRON_KEY: has('CRON_KEY'),
      GOOGLE_CLIENT_ID: has('GOOGLE_CLIENT_ID'),
      GOOGLE_CLIENT_SECRET: has('GOOGLE_CLIENT_SECRET'),
      RESEND_API_KEY: has('RESEND_API_KEY'),
      FROM_EMAIL: has('FROM_EMAIL'),
    },
  });
}
