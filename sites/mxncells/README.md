# mxncells.com — public marketing site

The public landing page for **MXN Cells** (peptide & regenerative cell therapy).
It is intentionally separate from the CRM app so visitors never touch CRM code.

## What it does
`index.html` is a self-contained page (no build step, no dependencies). Its
interest form POSTs to the **Patients CRM** capture endpoint, creating a new
patient row automatically:

```
mxncells.com form  ->  POST /api/capture/lead  ->  New patient in aiw-patients CRM
```

The POST target is set at the top of the inline `<script>`:

```js
const API = "https://aiw-patients.pages.dev";  // where leads land
const SOURCE = "mxncells.com";                  // tags the lead's source
```

CORS is open on that endpoint, so this page can be hosted on any origin.

## Deploy (Cloudflare Pages, push-to-deploy)
This folder is meant to back its **own** Cloudflare Pages project, separate
from the CRM project(s) that deploy from the repo root:

1. Cloudflare → **Pages → Create → Connect to Git** → this repo, branch `main`.
2. Framework preset: **None**. Build command: *(leave empty)*.
   **Build output directory:** `sites/mxncells`
3. After it deploys, **Custom domains → add `mxncells.com`**.

Every push to `main` that changes this folder redeploys the site.

## Editing later
When the "real" site is built (Framer/Webflow/etc.), keep the same form fields
and point them at `POST {API}/api/capture/lead` — the backend never changes.
