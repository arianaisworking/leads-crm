// functions/_lib/vault.js
// AES-GCM encryption for the handful of fields the carrier's lease form needs
// but nobody on our side should ever browse: SSN, bank routing and account
// numbers, driver's licence number.
//
// Why encrypt instead of storing plaintext: the lease form is filled on our
// site, so the data passes through us, but we only ever need it once — to build
// the packet the carrier receives. Encrypted at rest, decrypted in-memory for
// that one send, shown to the team as last-4 only, and purged once the lease is
// signed. A leaked database read is then worthless without the key, which lives
// in the Pages secret store, not the database.
//
// Env: LEASE_KEY — base64 of 32 random bytes. Generate with
//   openssl rand -base64 32
// No key set => the secure fields simply aren't collected (the form hides them
// and the API refuses to store them), so a misconfigured deploy fails closed
// rather than writing plaintext SSNs.

const enc = new TextEncoder();
const dec = new TextDecoder();

export function vaultReady(env) { return !!env.LEASE_KEY; }

async function keyFor(env) {
  if (!env.LEASE_KEY) throw new Error('LEASE_KEY is not configured');
  const raw = Uint8Array.from(atob(env.LEASE_KEY), (c) => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error('LEASE_KEY must be 32 bytes, base64-encoded');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// Returns a compact string: v1.<iv base64>.<ciphertext base64>
export async function seal(env, obj) {
  const key = await keyFor(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return 'v1.' + b64(iv) + '.' + b64(new Uint8Array(ct));
}

export async function open(env, blob) {
  if (!blob || typeof blob !== 'string' || !blob.startsWith('v1.')) return null;
  try {
    const [, ivB, ctB] = blob.split('.');
    const key = await keyFor(env);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(ivB) }, key, unb64(ctB));
    return JSON.parse(dec.decode(pt));
  } catch { return null; }
}

// What the CRM is allowed to see: enough to confirm the driver filled it in,
// never enough to be worth stealing.
export function redact(obj) {
  if (!obj) return null;
  const last4 = (v) => (v ? '••••' + String(v).replace(/\D/g, '').slice(-4) : null);
  return {
    ssn: last4(obj.ssn),
    dl_number: last4(obj.dl_number),
    bank_name: obj.bank_name || null,
    account_name: obj.account_name || null,
    routing: last4(obj.routing),
    account: last4(obj.account),
    has_ssn: !!obj.ssn,
    has_bank: !!(obj.routing && obj.account),
  };
}

const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
