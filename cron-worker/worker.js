// Cron Worker for the Leads CRM SMS engine.
// Fires every 5 minutes (see wrangler.toml) and pokes the Pages tick endpoint,
// which processes the follow-up queue, appointment reminders, and missed-
// appointment nudges.
//
// Deploy:
//   cd cron-worker
//   npx wrangler deploy
//   npx wrangler secret put CRON_KEY      # same value as the Pages CRON_KEY secret
//
// If you move the app to a custom domain, set a TICK_URL var on this Worker
// instead of editing code.

export default {
  async scheduled(event, env, ctx) {
    const url = env.TICK_URL || 'https://leads-crm-2sv.pages.dev/api/sms/tick';
    ctx.waitUntil(
      fetch(url, { headers: { 'x-cron-key': env.CRON_KEY || '' } })
        .then((r) => r.text())
        .catch(() => {})
    );
  },
};
