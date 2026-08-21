# Driver Recruiting — the trucker division

Third division of the AIW CRM, alongside Lead Reactivation and Doctor Patients.
Same codebase, its own Cloudflare Pages project and its own D1 database.

**Model:** owner-operator recruiting. Drivers bring their own tractor and lease
onto a carrier's authority. Carriers are the payers; we earn a placement fee.

```
Driver applies (apply.html)
   -> screened automatically against the carrier's own qualification criteria
   -> submitted to the carrier by email, with the screening result attached
   -> onboarding tracked to orientation and the first day rolling
   -> placement fee appears in Money
```

## What's in here

```
schema-recruiting-extra.sql      drivers + carriers + docs + placements (run after schema-full.sql)
functions/_lib/screening.js      the qualification engine — points chart + prohibitions
functions/api/dr/[[path]].js     CRM API (team-gated)
functions/api/apply/[[path]].js  PUBLIC driver application API
apply.html                       the driver-facing application
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

## What we deliberately don't collect

The carrier's lease form asks for **SSN, bank routing and account numbers, and
the full driver's licence number**. Our application does **not**, and the schema
has no columns for them. Drivers give those directly to the carrier on the
carrier's own paperwork.

Holding that data would make this CRM a breach target and drag it into a
compliance regime it isn't built for, for no operational gain — we don't need a
routing number to decide whether to submit somebody. If you ever do need to
collect it, that's a deliberate decision with real obligations attached, not a
column to quietly add.

## Getting applications in

Every carrier card in **Carriers** has a public link:

```
https://aiw-recruiting.pages.dev/apply.html?carrier=evans_dal
```

Share it anywhere — ads, Facebook groups, truck stops, a QR code. Anyone who
completes it lands in the CRM already screened, and both you and the driver get
an email. For a specific driver you're already talking to, open their file and
use **Get application link** or **Email to driver** for a prefilled version.
