// Returns a short-lived Spotify access token for the Web Playback SDK,
// refreshed from your account's stored refresh token.
// Requires three Cloudflare Pages secrets:
//   SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN
//
// NOTE: this endpoint hands an access token to whoever loads the page, which lets
// them control YOUR Spotify playback. Fine for a private internal tool; don't put
// this on a widely public site without adding your own gate.

const json = (d, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export async function onRequest({ env }) {
  const id = env.SPOTIFY_CLIENT_ID, secret = env.SPOTIFY_CLIENT_SECRET, refresh = env.SPOTIFY_REFRESH_TOKEN;
  if (!id || !secret || !refresh) return json({ error: "spotify_not_configured" }, 501);

  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "authorization": "Basic " + btoa(id + ":" + secret),
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }),
  });
  const d = await r.json();
  if (!r.ok) return json({ error: d.error_description || "refresh_failed" }, 502);
  return json({ access_token: d.access_token, expires_in: d.expires_in });
}
