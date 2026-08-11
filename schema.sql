-- Leads CRM schema for the "aiw-crm" D1 database.
-- Your live database ALREADY has these tables, so you do NOT need to run this
-- unless you're recreating the database from scratch.

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  trade TEXT,
  phone TEXT,
  email TEXT,
  website TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  postcode TEXT,
  lat REAL,
  lon REAL,
  source TEXT DEFAULT 'openstreetmap',
  source_id TEXT UNIQUE,
  website_live INTEGER,
  status TEXT NOT NULL DEFAULT 'New',
  last_contacted TEXT,
  next_touch TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(lead_id) REFERENCES leads(id)
);

CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_state ON leads(state);
CREATE INDEX IF NOT EXISTS idx_leads_next_touch ON leads(next_touch);
