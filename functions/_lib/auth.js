// functions/_lib/auth.js
// Password hashing (PBKDF2 via Web Crypto) + signed, stateless session cookies.
// No third-party auth service — everything runs inside the app.

const enc = new TextEncoder();

function buf2hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function hex2buf(hex) {
  const a = new Uint8Array(hex.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16);
  return a;
}
function b64url(bytes) {
  let s = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToStr(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return atob(s);
}

// ---- password hashing ----
async function pbkdf2(password, saltBytes) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return buf2hex(bits);
}
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt);
  return { salt: buf2hex(salt), hash };
}
export async function verifyPassword(password, saltHex, hashHex) {
  if (!saltHex || !hashHex) return false;
  const h = await pbkdf2(password, hex2buf(saltHex));
  if (h.length !== hashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ hashHex.charCodeAt(i);
  return diff === 0;
}

// ---- session signing ----
async function hmac(data, secret) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return b64url(sig);
}

// A signing secret that never lives in source: pulled from env, else generated
// once and stored in the app_config table.
export async function getSessionSecret(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  const db = env.DB;
  let row = await db.prepare("SELECT value FROM app_config WHERE key='session_secret'").first().catch(() => null);
  if (row && row.value) return row.value;
  const secret = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await db.prepare("INSERT OR IGNORE INTO app_config (key, value) VALUES ('session_secret', ?)").bind(secret).run();
  row = await db.prepare("SELECT value FROM app_config WHERE key='session_secret'").first();
  return (row && row.value) || secret;
}

const DAY = 86400;
export async function makeToken(env, user, days = 30) {
  const payload = { uid: user.id, role: user.role, cid: user.client_id || null, exp: Math.floor(Date.now() / 1000) + days * DAY };
  const p = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await hmac(p, await getSessionSecret(env));
  return `${p}.${sig}`;
}
export async function readToken(env, token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [p, sig] = token.split('.');
  const expect = await hmac(p, await getSessionSecret(env));
  if (expect.length !== (sig || '').length) return null;
  let diff = 0;
  for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  let payload;
  try { payload = JSON.parse(b64urlToStr(p)); } catch { return null; }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

export function parseCookies(request) {
  const h = request.headers.get('Cookie') || '';
  const out = {};
  h.split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
export function sessionCookie(token, days = 30) {
  return `sess=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${days * DAY}`;
}
export function clearCookie() {
  return 'sess=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
}

// Returns the decoded session (or null) for the current request.
export async function readSession(context) {
  const token = parseCookies(context.request).sess;
  return token ? readToken(context.env, token) : null;
}
