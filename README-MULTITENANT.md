# Multi-tenant + SMS engine — deploy notes

Drop-in for the existing `leads-crm` repo. **Nothing here touches your current
`functions/api/[[path]].js`, `index.html`, or `schema.sql`.** New files only.

```
migration-001-multitenant.sql
functions/_lib/tenant.js
functions/_lib/twilio.js
functions/_lib/brain.js
functions/_lib/calendar.js
functions/api/sms/inbound.js
functions/api/sms/tick.js
functions/api/tenant/[[path]].js
```

Files/folders under `functions/` starting with `_` are not routed — `_lib` is
shared code, not endpoints. Your existing `/api/[[path]]` catch-all still serves
everything it did; the new specific routes (`/api/sms/*`, `/api/tenant/*`) take
precedence over the catch-all.

---

## 1. Run the migration

```bash
npx wrangler d1 execute aiw-crm --remote --file=migration-001-multitenant.sql
```

The two `ALTER TABLE` lines add `client_id` to `leads` and `notes`. If you've
already run this once, they'll error with *duplicate column name* — delete those
two lines and re-run. Everything else is `IF NOT EXISTS` and safe to repeat.

Existing scraped leads are backfilled to the house tenant `networkboss`, so your
own prospecting list becomes just another client in the same UI.

---

## 2. Cloudflare Pages settings

**Binding** (already set): D1 → variable name `DB` → database `aiw-crm`

**Secrets to add:**

| Name | What it is |
|---|---|
| `ANTHROPIC_API_KEY` | your Claude API key |
| `TWILIO_ACCOUNT_SID` | master account (fallback) |
| `TWILIO_AUTH_TOKEN` | master token — also validates webhooks |
| `GOOGLE_CLIENT_ID` | one OAuth app for all clients |
| `GOOGLE_CLIENT_SECRET` | " |
| `CRON_KEY` | any long random string |
| `RESEND_API_KEY` | already set |
| `FROM_EMAIL` | e.g. `bookings@thenetworkboss.com` |
| `CONFIDENCE_FLOOR` | optional, default `0.8` |
| `MAX_TURNS` | optional, default `6` |

Keep `SERPAPI_KEY`. Don't set `REQUIRE_TWILIO_SIGNATURE=false` outside local testing.

---

## 3. Twilio, per client

1. **Subaccount** per client (Console → Account → Subaccounts). Store the SID and
   token on the `clients` row. Isolated billing, credentials, and reputation.
2. **10DLC** — register a **Standard Brand under the CLIENT's EIN**, not yours.
   The address must match the one tied to that EIN exactly, or the trust score
   drops and so does throughput. Pay for secondary vetting (~$40) on any client
   with real volume. Don't file as Sole Proprietor if they have an EIN.
3. **Messaging Service** → attach the campaign → add the number.
4. **Webhook** — on the number, "A message comes in":
   `POST https://leads-crm-2sv.pages.dev/api/sms/inbound`
   Same URL for every client. The tenant is resolved from the `To` number.

---

## 4. Google Calendar, per client

One OAuth app (yours). Each client authorises once and you store their
`google_refresh_token` on their row. Scope: `calendar.events` + `calendar.readonly`.
`calendar_id` is usually just their front-desk email address.

No refresh token yet? Leave it null — the engine skips slot offers and routes
booking intent to a human instead of inventing times.

---

## 5. The cron

Pages has no native cron. Point any scheduler at, every 5 minutes:

```
GET https://leads-crm-2sv.pages.dev/api/sms/tick
Header: x-cron-key: <CRON_KEY>
```

A Cloudflare Worker with a Cron Trigger is the clean version; cron-job.org is
fine while you're small.

---

## 6. business_brain template

Stored as JSON on the client row. This is the **only** thing the model may quote
from — if a fact isn't here, the AI says it'll check with the team and flags a human.

```json
{
  "about": "Med spa in Plano TX, open since 2019.",
  "services": [
    { "name": "Botox", "price": "$12/unit", "duration": 30 },
    { "name": "Hydrafacial", "price": "$199", "duration": 60 }
  ],
  "booking_hours": { "start": 9, "end": 17 },
  "booking_days": [1, 2, 3, 4, 5],
  "location": "1234 Preston Rd, Plano TX",
  "parking": "Free lot behind the building",
  "tone": "Warm, brief, no hard sell.",
  "never_say": ["guaranteed results", "medical advice", "anything about financing"],
  "escalate_if": ["asks about a refund", "mentions a prior bad result"],
  "sequence": [
    "Hi {first_name}, this is {business}. You reached out a while back and we never got you scheduled — still interested? Reply STOP to opt out.",
    "Hi {first_name}, following up from {business}. Happy to find you a time this week. Reply STOP to opt out.",
    "Last note from {business}, {first_name} — want me to hold a spot? Reply STOP to opt out."
  ]
}
```

---

## 7. Safety behaviour already wired in

- **STOP/UNSUBSCRIBE/QUIT** handled *before* any model call → opt-out row written,
  sequence killed. Also honours a global `'*'` blocklist across all clients.
- **Angry, legal threat, spam accusation, medical** → never auto-answered. Thread
  is paused, you get a text.
- **Confidence floor** (default 0.8) and a **6-turn limit** → human takeover.
- **Quiet hours** per client timezone, default 9am–7pm local.
- **Daily cap** per client, default 100.
- **Kill switch**: `POST /api/tenant/:id/pause` → all outbound stops instantly.
  New clients start `paused = 1` on purpose.
- **Webhook signature validation** so nobody can inject fake inbound texts.
- Booking always reads **live freebusy first** — the model picks from real slots,
  it never invents a time.

---

## 8. Add your first client

```bash
curl -X POST https://leads-crm-2sv.pages.dev/api/tenant/clients \
  -H 'content-type: application/json' \
  -d '{
    "id": "demospa",
    "name": "Demo Med Spa",
    "legal_name": "Demo Med Spa LLC",
    "ein": "00-0000000",
    "timezone": "America/Chicago",
    "twilio_number": "+12145551234",
    "calendar_id": "frontdesk@demospa.com",
    "notify_email": "frontdesk@demospa.com",
    "hot_lead_phone": "+12145559999",
    "door": "A"
  }'
```

Then set `google_refresh_token`, `business_brain`, and `paused = 0` when you're
ready to go live. **Test with your own cell as the only lead first.**

---

## 9. UI still to build

Backend is done; the front end isn't. Next in `index.html`:
1. Client switcher in the sidebar (`GET /api/tenant/clients`)
2. **Inbox** — needs-human first, take-over button, reply box. This is where you'll
   actually live; build it before pipeline or reporting.
3. Settings panel — brain editor + kill switch

Existing views need `client_id` appended to their queries so they filter by tenant.
