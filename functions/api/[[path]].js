// Ariana is Working — Leads CRM API
// Cloudflare Pages Function. Catches every /api/* route.
// Requires a D1 binding named DB (bound to the "aiw-crm" database).

const STATUSES = ["New", "Contacted", "Qualified", "Client", "Dead"];

// Which OSM tags represent each trade. Overpass is queried per selector.
const TRADE_TAGS = {
  roofing: [["craft", "roofer"]],
  plumbing: [["craft", "plumber"]],
  electrical: [["craft", "electrician"]],
  hvac: [["craft", "hvac"], ["craft", "heating_ventilation_air_conditioning"]],
};

// State name -> ISO 3166-2 code, so Overpass can scope by area.
const STATE_ISO = {
  "Alabama": "US-AL", "Alaska": "US-AK", "Arizona": "US-AZ", "Arkansas": "US-AR",
  "California": "US-CA", "Colorado": "US-CO", "Connecticut": "US-CT", "Delaware": "US-DE",
  "Florida": "US-FL", "Georgia": "US-GA", "Hawaii": "US-HI", "Idaho": "US-ID",
  "Illinois": "US-IL", "Indiana": "US-IN", "Iowa": "US-IA", "Kansas": "US-KS",
  "Kentucky": "US-KY", "Louisiana": "US-LA", "Maine": "US-ME", "Maryland": "US-MD",
  "Massachusetts": "US-MA", "Michigan": "US-MI", "Minnesota": "US-MN", "Mississippi": "US-MS",
  "Missouri": "US-MO", "Montana": "US-MT", "Nebraska": "US-NE", "Nevada": "US-NV",
  "New Hampshire": "US-NH", "New Jersey": "US-NJ", "New Mexico": "US-NM", "New York": "US-NY",
  "North Carolina": "US-NC", "North Dakota": "US-ND", "Ohio": "US-OH", "Oklahoma": "US-OK",
  "Oregon": "US-OR", "Pennsylvania": "US-PA", "Rhode Island": "US-RI", "South Carolina": "US-SC",
  "South Dakota": "US-SD", "Tennessee": "US-TN", "Texas": "US-TX", "Utah": "US-UT",
  "Vermont": "US-VT", "Virginia": "US-VA", "Washington": "US-WA", "West Virginia": "US-WV",
  "Wisconsin": "US-WI", "Wyoming": "US-WY", "District of Columbia": "US-DC",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const err = (message, status = 400) => json({ error: message }, status);

export async function onRequest(context) {
  const { request, env, params } = context;
  const db = env.DB;
  if (!db) return err("D1 binding 'DB' is missing. Bind the aiw-crm database as DB in Cloudflare Pages settings.", 500);

  const parts = Array.isArray(params.path) ? params.path : (params.path ? [params.path] : []);
  const method = request.method.toUpperCase();

  try {
    // GET /api/stats
    if (parts[0] === "stats" && method === "GET") {
      const row = await db.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status='New' THEN 1 ELSE 0 END) AS new,
          SUM(CASE WHEN status='Contacted' THEN 1 ELSE 0 END) AS contacted,
          SUM(CASE WHEN status='Qualified' THEN 1 ELSE 0 END) AS qualified,
          SUM(CASE WHEN status='Client' THEN 1 ELSE 0 END) AS client,
          SUM(CASE WHEN status='Dead' THEN 1 ELSE 0 END) AS dead,
          SUM(CASE WHEN next_touch IS NOT NULL AND next_touch <= date('now') THEN 1 ELSE 0 END) AS due
        FROM leads
      `).first();
      return json(row || {});
    }

    // /api/leads ...
    if (parts[0] === "leads") {
      // GET /api/leads (list, with filters)
      if (parts.length === 1 && method === "GET") {
        const url = new URL(request.url);
        const wh = [];
        const bind = [];
        const status = url.searchParams.get("status");
        const trade = url.searchParams.get("trade");
        const state = url.searchParams.get("state");
        const q = url.searchParams.get("q");
        const due = url.searchParams.get("due"); // "1" => next_touch due
        if (status) { wh.push("status = ?"); bind.push(status); }
        if (trade) { wh.push("trade = ?"); bind.push(trade); }
        if (state) { wh.push("state = ?"); bind.push(state); }
        if (due === "1") { wh.push("next_touch IS NOT NULL AND next_touch <= date('now')"); }
        if (q) {
          wh.push("(name LIKE ? OR city LIKE ? OR phone LIKE ? OR email LIKE ?)");
          const like = `%${q}%`;
          bind.push(like, like, like, like);
        }
        const sql = `SELECT * FROM leads ${wh.length ? "WHERE " + wh.join(" AND ") : ""} ORDER BY updated_at DESC LIMIT 1000`;
        const { results } = await db.prepare(sql).bind(...bind).all();
        return json(results || []);
      }

      // POST /api/leads (manual create)
      if (parts.length === 1 && method === "POST") {
        const b = await request.json();
        if (!b.name) return err("name is required");
        const r = await db.prepare(`
          INSERT INTO leads (name, trade, phone, email, website, address, city, state, postcode, status)
          VALUES (?,?,?,?,?,?,?,?,?,?)
        `).bind(
          b.name, b.trade || null, b.phone || null, b.email || null, b.website || null,
          b.address || null, b.city || null, b.state || null, b.postcode || null,
          STATUSES.includes(b.status) ? b.status : "New"
        ).run();
        const row = await db.prepare("SELECT * FROM leads WHERE id = ?").bind(r.meta.last_row_id).first();
        return json(row, 201);
      }

      const id = parseInt(parts[1], 10);
      if (parts.length >= 2 && !Number.isInteger(id)) return err("invalid lead id");

      // GET /api/leads/:id/notes  |  POST /api/leads/:id/notes
      if (parts.length === 3 && parts[2] === "notes") {
        if (method === "GET") {
          const { results } = await db.prepare(
            "SELECT * FROM notes WHERE lead_id = ? ORDER BY created_at DESC"
          ).bind(id).all();
          return json(results || []);
        }
        if (method === "POST") {
          const b = await request.json();
          if (!b.body) return err("note body is required");
          await db.prepare("INSERT INTO notes (lead_id, body) VALUES (?, ?)").bind(id, b.body).run();
          await db.prepare("UPDATE leads SET updated_at = datetime('now') WHERE id = ?").bind(id).run();
          const row = await db.prepare(
            "SELECT * FROM notes WHERE lead_id = ? ORDER BY created_at DESC LIMIT 1"
          ).bind(id).first();
          return json(row, 201);
        }
      }

      // PATCH /api/leads/:id  (update editable fields)
      if (parts.length === 2 && method === "PATCH") {
        const b = await request.json();
        const allowed = ["status", "last_contacted", "next_touch", "phone", "email", "website", "trade"];
        const sets = [];
        const bind = [];
        for (const k of allowed) {
          if (k in b) {
            if (k === "status" && !STATUSES.includes(b[k])) return err(`status must be one of ${STATUSES.join(", ")}`);
            sets.push(`${k} = ?`);
            bind.push(b[k]);
          }
        }
        if (!sets.length) return err("no updatable fields provided");
        sets.push("updated_at = datetime('now')");
        bind.push(id);
        await db.prepare(`UPDATE leads SET ${sets.join(", ")} WHERE id = ?`).bind(...bind).run();
        const row = await db.prepare("SELECT * FROM leads WHERE id = ?").bind(id).first();
        return json(row);
      }

      // DELETE /api/leads/:id
      if (parts.length === 2 && method === "DELETE") {
        await db.prepare("DELETE FROM notes WHERE lead_id = ?").bind(id).run();
        await db.prepare("DELETE FROM leads WHERE id = ?").bind(id).run();
        return json({ ok: true });
      }
    }

    // POST /api/scrape  { trades: [...], state: "Texas" }
    if (parts[0] === "scrape" && method === "POST") {
      const b = await request.json();
      const state = (b.state || "").trim();
      const trades = (b.trades || []).filter((t) => TRADE_TAGS[t]);
      if (!STATE_ISO[state]) return err(`Unknown state "${state}". Use a full US state name.`);
      if (!trades.length) return err("Pick at least one trade: roofing, plumbing, electrical, hvac.");

      const iso = STATE_ISO[state];
      const selectors = [];
      for (const t of trades) {
        for (const [k, v] of TRADE_TAGS[t]) {
          selectors.push(`  nwr["${k}"="${v}"](area.a);`);
        }
      }
      const oql = `[out:json][timeout:90];\narea["ISO3166-2"="${iso}"]->.a;\n(\n${selectors.join("\n")}\n);\nout center tags;`;

      const resp = await fetch("https://overpass-api.de/api/interpreter", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(oql),
      });
      if (!resp.ok) return err(`OpenStreetMap query failed (${resp.status}). Try again in a minute.`, 502);
      const data = await resp.json();
      const elements = data.elements || [];

      // Match each element back to the trade that selected it.
      const tagToTrade = {};
      for (const t of trades) for (const [k, v] of TRADE_TAGS[t]) tagToTrade[`${k}=${v}`] = t;

      let inserted = 0, skipped = 0;
      for (const el of elements) {
        const tags = el.tags || {};
        const name = tags.name;
        if (!name) { skipped++; continue; } // skip unnamed businesses

        let trade = null;
        for (const key of Object.keys(tagToTrade)) {
          const [k, v] = key.split("=");
          if (tags[k] === v) { trade = tagToTrade[key]; break; }
        }

        const lat = el.lat ?? el.center?.lat ?? null;
        const lon = el.lon ?? el.center?.lon ?? null;
        const source_id = `osm/${el.type}/${el.id}`;

        const r = await db.prepare(`
          INSERT OR IGNORE INTO leads
            (name, trade, phone, email, website, address, city, state, postcode, lat, lon, source, source_id, status)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).bind(
          name,
          trade,
          tags.phone || tags["contact:phone"] || null,
          tags.email || tags["contact:email"] || null,
          tags.website || tags["contact:website"] || null,
          [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ") || null,
          tags["addr:city"] || null,
          state,
          tags["addr:postcode"] || null,
          lat, lon,
          "openstreetmap",
          source_id,
          "New"
        ).run();
        if (r.meta.changes > 0) inserted++; else skipped++;
      }

      return json({ found: elements.length, inserted, skipped, state, trades });
    }

    return err("Not found", 404);
  } catch (e) {
    return err(`Server error: ${e.message}`, 500);
  }
}
