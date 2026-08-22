// Cron Worker for the driver-recruiting follow-ups.
// Fires twice a day (see wrangler.toml) and pokes the nudge endpoint, which
// chases drivers stuck on the carrier's application, the lease form, missing
// documents, a closing drug-test window or an inspection about to age out —
// and sends the team a short digest of what only a human can move.
//
// Deploy — either route:
//   Dashboard: Workers & Pages -> Create -> Worker, paste this file, then add
//     the cron triggers and a CRON_KEY secret under Settings.
//   Terminal:  cd cron-worker-recruiting && npx wrangler deploy
//              npx wrangler secret put CRON_KEY
//
// CRON_KEY must match the Pages project's CRON_KEY exactly, or the endpoint
// returns 401. Nothing else would tell you — which is why this logs the
// outcome of every run rather than discarding it. Check Workers -> this worker
// -> Logs after a run: "nudge ok" with a JSON summary means the handshake is
// good; "nudge FAILED: HTTP 401" means the two keys differ.
//
// Set TICK_URL as a var only if the app moves off the pages.dev hostname.

export default {
  async scheduled(event, env, ctx) {
    const url = env.TICK_URL || 'https://aiw-recruiting.pages.dev/api/cron/nudge';
    ctx.waitUntil((async () => {
      try {
        const r = await fetch(url, { headers: { 'x-cron-key': env.CRON_KEY || '' } });
        const body = (await r.text()).slice(0, 400);
        if (r.ok) console.log(`nudge ok: ${body}`);
        else console.error(`nudge FAILED: HTTP ${r.status} — ${body}`);
      } catch (e) {
        console.error(`nudge threw: ${String(e)}`);
      }
    })());
  },
};
