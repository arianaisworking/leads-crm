# Leads CRM — Ariana is Working

A lightweight lead CRM for skilled-trades businesses. It reads and writes to your
Cloudflare **D1** database (`aiw-crm`) and can pull real businesses from
OpenStreetMap into your pipeline.

**Views:** Database · Pipeline (drag-and-drop stages) · Clients · Nurture (follow-ups due) · Find Leads (scraper)

## What's in here
```
index.html                 The whole CRM interface (no build step)
functions/api/[[path]].js  The backend API + OpenStreetMap scraper
schema.sql                 The database tables (already live — reference only)
```

## Deploy (Chromebook-friendly — GitHub web + Cloudflare)

### 1. Put these files in the `leads-crm` repo
- Go to github.com → **New repository** → name it `leads-crm` → Create.
- On the repo page, **Add file → Upload files**, then drag in `index.html`,
  `README.md`, `schema.sql`, and the `functions` folder (keep the folder
  structure — `functions/api/[[path]].js`). Commit.

### 2. Connect Cloudflare Pages
- Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**.
- Pick the `leads-crm` repo. **No build command**, output directory `/` (root).
- Deploy.

### 3. Bind the database (the one required step)
- In the new Pages project → **Settings → Bindings → Add → D1 database**.
  - **Variable name:** `DB`  *(must be exactly this)*
  - **Database:** `aiw-crm`
- Redeploy (Deployments → Retry / redeploy) so the binding takes effect.

That's it. Open the site → **Find Leads** → pick trades + a state → it fills your
database. Every other view reads from D1 live.

## Notes
- Your `aiw-crm` tables already exist and are currently empty — running **Find
  Leads** is what populates them.
- Data source is OpenStreetMap (ODbL open data). The scraper imports **named**
  businesses only and skips duplicates automatically.
- Finding a business is not the same as permission to contact it. Outreach is
  still subject to **TCPA / DNC / CAN-SPAM** — this is not legal advice.
