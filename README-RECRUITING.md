# Driver Recruiting — the trucker division

Third division of the AIW CRM, alongside Lead Reactivation and Doctor Patients.
Same codebase, its own Cloudflare Pages project and its own D1 database.

**Model:** owner-operator recruiting. Drivers bring their own tractor and lease
onto a carrier's authority. Carriers are the payers; we earn a placement fee.

```
Your website  ->  application  ->  screening  ->  lease form + documents
              ->  packet to the carrier  ->  orientation  ->  seated  ->  fee split
```

Each arrow after the first is automatic. See **The automation chain** below.

## What's in here

```
schema-recruiting-extra.sql      drivers + carriers + docs + placements (run after schema-full.sql)
migration-recruiting-002.sql     revenue split + the lease/document workflow
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

1. **Create the database**

   ```bash
   npx wrangler d1 create aiw-recruiting
   npx wrangler d1 execute aiw-recruiting --remote --file=schema-full.sql
   npx wrangler d1 execute aiw-recruiting --remote --file=schema-recruiting-extra.sql
   ```

   The second file seeds Evans Delivery (Dallas/DND) with their real
   qualification rubric, so screening works the moment you deploy.

2. **Create the Pages project** — connect the same repo, no build command,
   output directory `/`. Point it at `aiw-recruiting.pages.dev`; the front end
   switches profile on that hostname.

3. **Bind the database** — Settings → Bindings → D1 → variable name `DB`
   → database `aiw-recruiting`. Redeploy.

4. **Secrets** — `RESEND_API_KEY` (submission + application emails),
   `FROM_EMAIL`, `TEAM_EMAIL`, optionally `BRAND_NAME`. Everything still
   functions without them; email just no-ops.

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

## Extra deploy steps for the workflow

On top of the base deploy above:

```bash
npx wrangler d1 execute aiw-recruiting --remote --file=migration-recruiting-002.sql
```

| Binding / secret | Why |
|---|---|
| `DOCS` (R2 bucket) | driver document uploads — without it the lease page tells drivers to email documents instead |
| `LEASE_KEY` | `openssl rand -base64 32` — enables the encrypted lease fields |
| `RESEND_API_KEY` | every automated email in the chain |

Losing `LEASE_KEY` makes existing sealed fields unrecoverable — drivers would
have to re-enter them. Keep a copy somewhere safe.
