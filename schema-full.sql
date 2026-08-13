-- ============================================================
-- FULL schema for a fresh Leads-CRM environment (one per business).
-- Apply this to a brand-new D1 database to stand up a new "account"
-- (e.g. driver recruiting, doctor patients) with its own isolated data.
--
--   npx wrangler d1 execute <db-name> --remote --file=schema-full.sql
--
-- This is the consolidated current schema (supersedes schema.sql +
-- migration-001 + migration-002). Safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, trade TEXT, phone TEXT, email TEXT, website TEXT,
  address TEXT, city TEXT, state TEXT, postcode TEXT, lat REAL, lon REAL,
  rating REAL, reviews INTEGER, signals TEXT, enriched INTEGER DEFAULT 0,
  source TEXT DEFAULT 'openstreetmap', source_id TEXT UNIQUE, website_live INTEGER,
  status TEXT NOT NULL DEFAULT 'New', last_contacted TEXT, next_touch TEXT,
  client_id TEXT DEFAULT 'house', interest TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_state ON leads(state);
CREATE INDEX IF NOT EXISTS idx_leads_trade ON leads(trade);
CREATE INDEX IF NOT EXISTS idx_leads_next_touch ON leads(next_touch);
CREATE INDEX IF NOT EXISTS idx_leads_source ON leads(source);
CREATE INDEX IF NOT EXISTS idx_leads_reviews ON leads(reviews);
CREATE INDEX IF NOT EXISTS idx_leads_client ON leads(client_id);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER NOT NULL, body TEXT NOT NULL,
  client_id TEXT DEFAULT 'house', created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(lead_id) REFERENCES leads(id)
);
CREATE INDEX IF NOT EXISTS idx_notes_lead ON notes(lead_id);
CREATE INDEX IF NOT EXISTS idx_notes_client ON notes(client_id);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, legal_name TEXT, ein TEXT, address TEXT, website TEXT,
  timezone TEXT DEFAULT 'America/Chicago', brand_color TEXT DEFAULT '#ed1a78',
  status TEXT DEFAULT 'onboarding', door TEXT DEFAULT 'A',
  twilio_subaccount_sid TEXT, twilio_subaccount_token TEXT, twilio_messaging_service_sid TEXT,
  twilio_number TEXT, tendlc_brand_sid TEXT, tendlc_campaign_sid TEXT, tendlc_status TEXT DEFAULT 'not_started',
  calendar_provider TEXT DEFAULT 'google', calendar_id TEXT, google_refresh_token TEXT,
  appointment_minutes INTEGER DEFAULT 30, booking_window_days INTEGER DEFAULT 14,
  crm_bcc_email TEXT, notify_email TEXT, hot_lead_phone TEXT,
  business_brain TEXT, send_window_start INTEGER DEFAULT 9, send_window_end INTEGER DEFAULT 19,
  daily_send_cap INTEGER DEFAULT 100, paused INTEGER DEFAULT 1,
  auto_send INTEGER DEFAULT 0, reminders_enabled INTEGER DEFAULT 1, ai_opener INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_number ON clients(twilio_number);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, lead_id INTEGER, phone TEXT NOT NULL, contact_name TEXT,
  status TEXT DEFAULT 'queued', intent TEXT, needs_human INTEGER DEFAULT 0, ai_paused INTEGER DEFAULT 0,
  turn_count INTEGER DEFAULT 0, step INTEGER DEFAULT 0, context_note TEXT, interest TEXT,
  appointment_at TEXT, appointment_event_id TEXT,
  reminder_24_sent INTEGER DEFAULT 0, reminder_2_sent INTEGER DEFAULT 0, post_appt_handled INTEGER DEFAULT 0,
  last_inbound_at TEXT, last_outbound_at TEXT, next_send_at TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_client_phone ON conversations(client_id, phone);
CREATE INDEX IF NOT EXISTS idx_conv_due ON conversations(next_send_at, status);
CREATE INDEX IF NOT EXISTS idx_conv_human ON conversations(client_id, needs_human, last_inbound_at);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, client_id TEXT NOT NULL, direction TEXT NOT NULL,
  body TEXT NOT NULL, author TEXT DEFAULT 'ai', twilio_sid TEXT, status TEXT, error_code TEXT,
  intent TEXT, confidence REAL, segments INTEGER, created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_client ON messages(client_id, created_at);

CREATE TABLE IF NOT EXISTS opt_outs (
  client_id TEXT NOT NULL, phone TEXT NOT NULL, reason TEXT, created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (client_id, phone)
);

CREATE TABLE IF NOT EXISTS send_ledger (
  client_id TEXT NOT NULL, day TEXT NOT NULL, sent INTEGER DEFAULT 0, received INTEGER DEFAULT 0,
  booked INTEGER DEFAULT 0, opt_outs INTEGER DEFAULT 0, PRIMARY KEY (client_id, day)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, client_id TEXT, kind TEXT, ref_id TEXT, detail TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_client ON events(client_id, created_at);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'team', client_id TEXT, name TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT);
