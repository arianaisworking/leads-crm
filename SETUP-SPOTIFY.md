# Full-song Spotify playback (Premium, no browser login)

This lets your CRM record player stream full songs from **your** Premium account,
without you having to be logged into Spotify in that browser. One-time setup.

You'll deploy 3 files and set 3 secrets.

## Files to deploy (hand these to Claude Code)
- `index.html` — updated player (already uses the SDK, falls back to the embed until setup is done)
- `functions/api/spotify-token.js` — mints a fresh access token from your account
- `functions/api/spotify-auth.js` — one-time helper to get your refresh token

These sit alongside your existing `functions/api/[[path]].js` — they don't replace it.

## Step 1 — Create a free Spotify app
1. Go to **developer.spotify.com/dashboard** and log in with your Spotify account.
2. **Create app**. Name it anything (e.g. "AIW CRM").
3. For **Redirect URI**, add exactly:
   `https://leads-crm-2sv.pages.dev/api/spotify-auth`
4. Save. Open the app's **Settings** and copy the **Client ID** and **Client secret**.

## Step 2 — Add the first two secrets in Cloudflare
In your Pages project → **Settings → Variables and Secrets** (Production), add:
- `SPOTIFY_CLIENT_ID` = your Client ID
- `SPOTIFY_CLIENT_SECRET` = your Client secret

Deploy the 3 files (Step 0) and redeploy so the secrets take effect.

## Step 3 — Get your refresh token (one time)
1. Visit **https://leads-crm-2sv.pages.dev/api/spotify-auth**
2. Approve access. You'll land on a page showing a **refresh token**.
3. Copy it, and add a third secret in Cloudflare:
   - `SPOTIFY_REFRESH_TOKEN` = that value
4. Redeploy once more.

That's it. Reload the CRM and press play on the record — it streams full songs.

## Good to know
- **Premium required** (you have it). Free accounts can't stream via the SDK.
- The player shows up in Spotify as a device called "Ariana is Working — CRM."
  Pressing play moves playback to it (like AirPlay/Connect).
- Until Step 3 is done, the player quietly falls back to the standard embed, so
  nothing looks broken while you set it up.
- **Privacy:** the token endpoint gives whoever loads the page control of your
  Spotify playback. Fine for a private tool you use yourself; if this CRM ever
  becomes widely public, tell me and I'll add a simple access gate.
