# Driver Recruiting — the trucker division

Third division of the AIW CRM, alongside Lead Reactivation and Doctor Patients.
Same codebase, its own Cloudflare Pages project and its own D1 database.

**Model:** owner-operator recruiting. Drivers bring their own tractor and lease
onto a carrier's authority. Carriers are the payers; we earn a placement fee.

```
Your website  ->  our application  ->  screening
              ->  the carrier's own application (tracked)  +  lease form + documents
              ->  packet to the carrier  ->  orientation  ->  seated  ->  fee split
```

Each arrow after the first is automatic. See **The automation chain** below.

## What's in here

```
schema-recruiting-extra.sql      drivers + carriers + docs + placements (run after schema-full.sql)
migration-recruiting-002.sql     revenue split + the lease/document workflow
migration-recruiting-003.sql     the carrier's own application (Tenstreet) + attribution
migration-recruiting-004.sql     invoicing the carrier + the seating question
migration-recruiting-005.sql     follow-up nudges
functions/api/cron/[[path]].js   the nudge pass (cron-key gated)
cron-worker-recruiting/          Cloudflare Worker that pokes it twice a day
drive.html                       truckersandtrokeros.com — the public site (EN/ES)
functions/_lib/screening.js      the qualification engine — points chart + prohibitions
functions/_lib/recruiting.js     doc checklists, placements + splits, the carrier packet
functions/_lib/vault.js          AES-GCM for the lease form's sensitive fields
functions/api/dr/[[path]].js     CRM API (team-gated)
functions/api/apply/[[path]].js  PUBLIC: website funnel, application, lease form, uploads
apply.html                       the driver-facing application
lease.html                       the driver-facing lease form + document upload
index.html                       PROFILE==="recruiting" swaps in Drivers/Pipeline/Carriers/Money
```

## Deploy

**Already provisioned** (done for you — nothing to re-run):

| Resource | Value |
|---|---|
| D1 database | `aiw-recruiting` · `a6e13b06-0829-4d5a-afeb-7faf63666609` |
| Migrations | schema-full + recruiting-extra + 002–005, all applied |
| Seeded | Evans Delivery (Dallas/DND) with rubric, doc checklist, $1,000 on seated, IntelliApp link |
| Recruiters | Ariana and Mystica, 50/50 |
| R2 bucket | `aiw-recruiting-docs` |

**Still to do in the Cloudflare dashboard** (a Pages project can't be created
from the API):

1. **Workers & Pages → Create → Pages → Connect to Git** → the `leads-crm` repo.
   - Build command: *none*. Output directory: `/`.
   - **Production branch: `claude/trucker-division-aiw-crm-i96spb`** — the trucker
     code is not on `main`, so leaving this at `main` deploys the wrong app.
   - Project name `aiw-recruiting`, so it lands on `aiw-recruiting.pages.dev`.
2. **Settings → Bindings:**
   - D1 → variable `DB` → database `aiw-recruiting`
   - R2 → variable `DOCS` → bucket `aiw-recruiting-docs`
3. **Settings → Variables and Secrets:**

   | Name | Value |
   |---|---|
   | `RESEND_API_KEY` | your existing Resend key |
   | `LEASE_KEY` | `openssl rand -base64 32` — keep a copy somewhere safe |
   | `CRON_KEY` | any long random string |
   | `FROM_EMAIL` | e.g. `Truckers & Trokeros <recruiting@truckersandtrokeros.com>` |
   | `TEAM_EMAIL` | where team notifications land |
   | `BRAND_NAME` | `Truckers & Trokeros` |
4. **Redeploy** so the bindings take effect, then open the site and create your
   login (first visit bootstraps the first user).
5. **Custom domain** → add `truckersandtrokeros.com` and `www` to this same
   project. Middleware serves the public site at `/` for those hostnames.
6. **Cron worker:** `cd cron-worker-recruiting && npx wrangler deploy`, then
   `npx wrangler secret put CRON_KEY` with the same value.

## The screening engine

`functions/_lib/screening.js` holds the chart; each carrier row holds its own
thresholds in `qual_rules` JSON. A second carrier with different standards needs
a new rules blob, **not** a code change.

Evans' rubric as shipped (Driver Qualification Criteria, rev. January 2024):

| | |
|---|---|
| Age | 22+ |
| Licence | Valid Class A from the state of residence |
| Medical | Current DOT physical |
| Experience | 12 months Class A in 5 years, 8 of them in the last 3 |
| Flatbed | 6 months pulling flatbed in the last year |
| Recent record | No more than 1 preventable crash or serious offense in 1 year |
| Handheld / texting | None in the last 6 months |
| Drugs & alcohol | No positive or refused test in 10 years; 10 years from SAP completion |
| Background | Non-commercial felonies, misdemeanors and habitual suspensions — case by case |

Points: 3-year moving-violation review, 5-year accident review.
**≤3 pre-qualified · 4–5 Safety Management approval · 6+ not qualified.**
Speeding 20+, school/work zone, out-of-service order violation and fleeing an
officer are 3-year bars. DUI/DWI, drug or alcohol offenses, a fatality accident,
hit & run, using a CMV in a felony, vehicular homicide and reckless driving are
5-year bars.

A driver who fails cannot be submitted by accident — the API refuses and the UI
asks you to confirm before overriding.

## The two clocks

Both come straight from the carrier's own process, and both quietly kill
applications when nobody is watching:

- **Drug test — 7 business days** from scheduling. Setting the scheduled date
  computes the deadline (business days, not calendar days) and the driver shows
  up in "Clocks running out" two days ahead.
- **Federal inspection — 30 days.** An inspection ages out while paperwork is
  being chased. The driver list and the document checklist both flag a stale one
  before the carrier rejects it.

## Sensitive fields: encrypted, used once, destroyed

The carrier's lease form needs an **SSN, bank routing and account numbers, and a
driver's licence number**. Because the driver now fills that form on our site,
that data passes through us — so it is handled as follows:

- **Encrypted on arrival** with AES-GCM (`functions/_lib/vault.js`) using
  `LEASE_KEY`, which lives in the Pages secret store, never the database. A
  stolen database read is worthless without it.
- **Never browsable.** The CRM shows last-four only (`••••6789`). No endpoint
  returns the plaintext to the team UI.
- **Decrypted exactly once** — in memory, when building the packet the carrier
  receives.
- **Destroyed** once the lease is signed: the driver file offers *Destroy secure
  fields*, which nulls the ciphertext and stamps `secure_purged_at`.
- **Fails closed.** With no `LEASE_KEY` set, the lease page hides those fields
  and the API refuses to store them, rather than quietly writing plaintext.

Everything else on the form — address, truck, plate and IFTA elections,
business details — is ordinary data in ordinary columns.

## The money

Evans pays **$1,000 per seated driver**, split **50/50 between Ariana and
Mystica**. Both are seeded in the `recruiters` table; edit names, emails and
shares under **Money → Edit shares**.

The split is written **when the placement opens**, not read live. So when the
fee moves to $2,000 and then $2,500, you change it once on the carrier card and
every placement already earned keeps the number it was agreed at. Same for
changing the split — history never rewrites itself.

`Money` shows the gross, what each of you is owed, what's been paid out, and a
per-placement ledger you can mark `paid` as it lands.

## Getting applications in

Every carrier card in **Carriers** has a public link:

```
https://aiw-recruiting.pages.dev/apply.html?carrier=evans_dal
```

Share it anywhere — ads, Facebook groups, truck stops, a QR code. Anyone who
completes it lands in the CRM already screened, and both you and the driver get
an email. For a specific driver you're already talking to, open their file and
use **Get application link** or **Email to driver** for a prefilled version.


## The automation chain

The whole point: nobody has to remember to send anything.

```
1  Driver submits the form on your site (or Mystica's)
        POST /api/apply/lead   ->  driver lands in the CRM
                               ->  application emailed to them automatically
2  Driver completes the application
        screened against the carrier's rubric on the spot
        if they pass -> document checklist built, lease link issued,
                        and the "continue your onboarding" email goes out
        if they fail -> a straight, kind no; nothing is sent onward
3  Driver returns the lease form + uploads documents from their phone
        one page, link stays live, they can finish it in pieces
        you get an email when it lands
4  You submit them, then send the packet
        the completed lease form + every document, in one email to the carrier
        blocked if a document is still missing (override with a confirm)
5  Driver is seated
        placement opens, $1,000 splits 50/50, Money updates
```

Steps 1–3 need nobody. Steps 4 and 5 are one button each.

### Putting the form on your website

Point any form at the endpoint — it accepts cross-origin posts and has a
honeypot for bots:

```html
<form id="drive">
  <input name="name" placeholder="Full name" required>
  <input name="phone" placeholder="Cell phone" required>
  <input name="email" type="email" placeholder="Email">
  <input name="city" placeholder="City"><input name="state" maxlength="2" placeholder="ST">
  <input name="_hp" style="display:none" tabindex="-1" autocomplete="off">
  <button>Apply to drive</button>
</form>
<script>
document.getElementById('drive').onsubmit = async (e) => {
  e.preventDefault();
  const b = Object.fromEntries(new FormData(e.target));
  b.source = 'mystica-site';        // or your own site — shows up in the CRM
  b.recruiter = 'mystica';          // who sourced it
  await fetch('https://aiw-recruiting.pages.dev/api/apply/lead?carrier=evans_dal',
    { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(b) });
  e.target.innerHTML = "<p>Thanks — check your email, your application is on its way.</p>";
};
</script>
```

Repeat submissions update the existing driver instead of creating a duplicate.

## The carrier's own application, and getting credit for it

Evans' onboarding starts on **Tenstreet's IntelliApp**, not on our form — that's
Step 1 of their driver welcome email, and it's what produces the confirmation
number and triggers the Clearinghouse query. We screen first so nobody wastes a
Safety review, then hand the driver through.

The link Evans supplies looks like this:

```
https://intelliapp.driverapponline.com/c/evansdelivery?cq_1192228=DAL&uri_b=ia_evansdelivery_440136800
                                       └ company      └ terminal (Dallas)  └ source attribution
```

Two rules the code follows:

1. **The carrier's parameters are preserved exactly.** `cq_1192228=DAL` routes
   the application to the Dallas terminal. Losing it drops the driver into the
   wrong office's queue.
2. **Only the source tag is rewritten**, and only when the recruiter has one.

### Why the source tag matters

`uri_b` is how Evans knows where an application came from. Send drivers through
the generic link and our applications are indistinguishable from walk-ins —
getting paid then depends on someone at the carrier remembering which ones were
ours. **Ask the carrier for a source tag per recruiter** (their platform supports
unlimited ones), then set it under **Money → Edit shares**. Every driver either
of you sends is provably yours in their system, and the split reconciles itself.

Until a tag is set, the CRM says so plainly when you send the link rather than
pretending attribution is handled.

### Sent, opened, confirmed — three different facts

Drivers are handed a tracked redirect (`/api/apply/go?token=…`) that records the
click and forwards to the carrier. That splits a step everyone else treats as
one:

- **sent** — the link went out
- **opened** — they actually started it (with a visit count)
- **confirmed** — a confirmation number came back

The gap between *opened* and *confirmed* is where half-finished applications
die, and nothing else surfaces it. The Drivers view carries a **Stuck on the
carrier's application** queue: opened three or more days ago with no
confirmation number, or sent two days ago and never opened. Those are the phone
calls worth making.

## Extra deploy steps for the workflow

On top of the base deploy above:

All migrations are already applied to the live database (see **Deploy**). The
files are kept for rebuilding from scratch.

| Binding / secret | Why |
|---|---|
| `DOCS` (R2 → `aiw-recruiting-docs`) | driver document uploads — without it the lease page tells drivers to email documents instead |
| `LEASE_KEY` | `openssl rand -base64 32` — enables the encrypted lease fields |
| `RESEND_API_KEY` | every automated email in the chain |
| `CRON_KEY` | gates the nudge endpoint |

Losing `LEASE_KEY` makes existing sealed fields unrecoverable — drivers would
have to re-enter them. Keep a copy somewhere safe.


## Follow-ups

Drivers rarely stall because they changed their mind — they stall because the
carrier's application is long, the inspection expired, or they meant to do it
Sunday. `/api/cron/nudge` runs twice a day and chases exactly seven stuck
states:

| Nudge | Fires when |
|---|---|
| `carrier_app_unopened` | link sent 2+ days ago, never opened |
| `carrier_app_unfinished` | opened 3+ days ago, no confirmation number |
| `lease_form` | onboarding pack sent 2+ days ago, form not returned |
| `docs_missing` | lease returned 2+ days ago, documents still outstanding (names them) |
| `drug_test` | the 7-business-day window closes within 2 days |
| `inspection_stale` | inspection is 25+ days old and the packet hasn't gone |
| `orientation_tomorrow` | orientation is tomorrow |

Every send is logged to `driver_nudges`. **No repeat inside 3 days, three sends
maximum, ever.** A driver who acts stops being chased immediately — the rules
key off the stuck state, not a timer. Muted (`nudge_paused`), disqualified,
seated and no-email drivers are never contacted.

Once a day the team gets a short digest of what only a human can move: drivers
whose seating is unconfirmed, money ready to invoice, and anyone the emails have
stopped working on — those are the phone calls.

Two routes — the dashboard one needs no terminal, which matters on a Chromebook:

**Dashboard:** Workers & Pages → Create → Worker, name it `aiw-recruiting-nudge`,
paste `cron-worker-recruiting/worker.js`, Deploy. Then Settings → Triggers → add
cron `0 9 * * *` and `0 16 * * *`; Settings → Variables and Secrets → add secret
`CRON_KEY`. Leave `TICK_URL` unset — the worker already defaults to the right URL.

**Terminal:**
```bash
cd cron-worker-recruiting && npx wrangler deploy
npx wrangler secret put CRON_KEY     # same value as the Pages CRON_KEY secret
```

`CRON_KEY` must match the Pages project's byte for byte, or the endpoint returns
401 and no nudge ever sends. The worker logs the outcome of every run, so
Workers → `aiw-recruiting-nudge` → Logs tells you which it is: `nudge ok` with a
JSON summary, or `nudge FAILED: HTTP 401`.

Dry-run it any time without sending anything:

```bash
curl -H "x-cron-key: $CRON_KEY" "https://aiw-recruiting.pages.dev/api/cron/nudge?dry=1"
```

## truckersandtrokeros.com

`drive.html` is the public site: hero, why-us, the five-step process, real
qualification requirements, eight FAQs and the lead form. It is **fully
bilingual (EN/ES)** — the name is half Spanish, Dallas drayage runs heavily on
Spanish-speaking owner-operators, and the carrier confirmed citizenship isn't
required. Language follows the browser, is switchable in the header, and sticks
in `localStorage`.

The form posts to `/api/apply/lead`, so a driver who fills it in is in the CRM
and has their application emailed **before anyone reads the lead**.

### Hosting it

The site shares this Pages project — no second deployment, no CORS. Add
`truckersandtrokeros.com` (and `www`) as custom domains on the recruiting Pages
project. `functions/_middleware.js` serves `/drive.html` at `/` for those
hostnames; the CRM stays on the pages.dev host and any admin domain. To add
another site, add a line to `PUBLIC_SITES`.

Tracking parameters the site understands:

| Param | Use |
|---|---|
| `?src=` | overrides the recorded source (default `truckersandtrokeros.com`) |
| `?r=` | recruiter id, so leads land attributed — e.g. `?r=mystica` |
| `?carrier=` | which carrier the lead is for (default `evans_dal`) |

So Mystica's Facebook ad points at
`https://truckersandtrokeros.com/?r=mystica&src=fb-ad-oct`, and every driver from
it shows up in the CRM tagged to her and to that ad.

### One thing to confirm before launch

The site describes the work but doesn't name Evans. `apply.html` does name them,
because the driver is by then applying to a specific carrier. If Daphine is
happy being named publicly it's worth doing — drivers trust a named carrier more
than "our partner carrier" — but that's her call, not ours. Ask before adding it
to the marketing page.


## A note on the `leads` table

D1 caps a table at **100 columns**, and `leads` is at **93**. The lease form's
own fields therefore live in `driver_lease` (one row per driver), not on
`leads` — which is the right shape anyway, since they only exist for drivers who
reach the lease stage and it keeps the encrypted blob in its own table.

**Any new driver field belongs on `driver_lease`** unless a `WHERE` clause needs
it. Only workflow state the nudge and stats passes filter on — tokens,
milestone timestamps — earns a column on `leads`.
