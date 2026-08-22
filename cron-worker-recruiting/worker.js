// Cron Worker for the driver-recruiting follow-ups.
// Fires twice a day (see wrangler.toml) and pokes the nudge endpoint, which
// chases drivers stuck on the carrier's application, the lease form, missing
// documents, a closing drug-test window or an inspection about to age out —
// and sends the team a short digest of what only a human can move.
//
// Deploy:
//   cd cron-worker-recruiting
//   npx wrangler deploy
//   npx wrangler secret put CRON_KEY     # same value as the Pages CRON_KEY secret
//
// Set TICK_URL as a var if the app moves to a custom domain.

export default {
  async scheduled(event, env, ctx) {
    const url = env.TICK_URL || 'https://aiw-recruiting.pages.dev/api/cron/nudge';
    ctx.waitUntil(
      fetch(url, { headers: { 'x-cron-key': env.CRON_KEY || '' } })
        .then((r) => r.text())
        .catch(() => {})
    );
  },
};
