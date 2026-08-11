// ONE-TIME setup helper to get your Spotify refresh token.
// Requires SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET secrets to be set first.
//
// Usage: after setting those two secrets and deploying, visit
//   https://<your-site>/api/spotify-auth
// Log in / approve, and this page will show your refresh token to copy into a
// third secret named SPOTIFY_REFRESH_TOKEN. You only do this once.
//
// IMPORTANT: register this exact URL as a Redirect URI in your Spotify app:
//   https://<your-site>/api/spotify-auth

const SCOPES = "streaming user-read-email user-read-private user-modify-playback-state user-read-playback-state";

export async function onRequest({ request, env }) {
  const id = env.SPOTIFY_CLIENT_ID, secret = env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret)
    return new Response("Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET secrets first, then redeploy.", { status: 501 });

  const url = new URL(request.url);
  const redirect_uri = url.origin + "/api/spotify-auth";
  const code = url.searchParams.get("code");

  if (!code) {
    const auth = "https://accounts.spotify.com/authorize?" + new URLSearchParams({
      client_id: id, response_type: "code", redirect_uri, scope: SCOPES,
    });
    return Response.redirect(auth, 302);
  }

  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "authorization": "Basic " + btoa(id + ":" + secret) },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri }),
  });
  const d = await r.json();
  if (!r.ok) return new Response("Error from Spotify: " + JSON.stringify(d), { status: 502 });

  const html = `<!doctype html><meta charset="utf-8">
  <body style="font-family:system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 20px;line-height:1.55;color:#1b1620">
  <h2>✅ Spotify connected</h2>
  <p>Copy this <b>refresh token</b> and add it as a Cloudflare Pages secret named
  <code style="background:#f3eff6;padding:1px 6px;border-radius:5px">SPOTIFY_REFRESH_TOKEN</code>, then redeploy your site:</p>
  <textarea readonly style="width:100%;height:96px;font-family:monospace;font-size:13px;padding:10px;border-radius:8px;border:1px solid #ddd">${(d.refresh_token || "").replace(/</g,"&lt;")}</textarea>
  <p style="color:#6f6675">You only need to do this once. After adding that secret and redeploying, your CRM record player will stream full songs from your Premium account — no per-browser login needed.</p>
  </body>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
