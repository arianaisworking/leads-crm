// functions/_lib/stripe.js
// Minimal Stripe Checkout helper (no SDK — Workers-friendly fetch to the REST API).
// Requires env.STRIPE_SECRET_KEY (set on the Cloudflare Pages project, like RESEND_API_KEY).

// Create a one-off hosted Checkout page for a deposit. Returns { ok, url, id }.
export async function createDepositCheckout(env, { amountCents, currency = 'usd', label, successUrl, cancelUrl, metadata }) {
  if (!env.STRIPE_SECRET_KEY) return { ok: false, skipped: true, reason: 'no STRIPE_SECRET_KEY' };
  if (!Number.isFinite(amountCents) || amountCents < 50) return { ok: false, error: 'Deposit amount is too low to charge.' };
  const body = new URLSearchParams();
  body.set('mode', 'payment');
  body.set('success_url', successUrl);
  body.set('cancel_url', cancelUrl);
  body.set('line_items[0][quantity]', '1');
  body.set('line_items[0][price_data][currency]', currency);
  body.set('line_items[0][price_data][unit_amount]', String(Math.round(amountCents)));
  body.set('line_items[0][price_data][product_data][name]', label || 'Consultation deposit');
  if (metadata) for (const [k, v] of Object.entries(metadata)) body.set(`metadata[${k}]`, String(v == null ? '' : v));
  let r, j;
  try {
    r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    j = await r.json().catch(() => ({}));
  } catch (e) {
    return { ok: false, error: String(e) };
  }
  if (!r.ok) return { ok: false, status: r.status, error: (j.error && j.error.message) || 'Stripe error' };
  return { ok: true, url: j.url, id: j.id };
}
