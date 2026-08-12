-- ============================================================
-- aiw-crm : migration 001 - multi-tenant + SMS engine
-- Run against D1 database "aiw-crm"
--   npx wrangler d1 execute aiw-crm --remote --file=migration-001-multitenant.sql
-- Safe to re-run: every statement is IF NOT EXISTS or guarded.
-- ============================================================

-- ---------- 1. CLIENTS (tenants) ----------
CREATE TABLE IF NOT EXISTS clients (
  id                          TEXT PRIMARY KEY,   -- slug, e.g. 'brightmedspa'
  name                        TEXT NOT NULL,      -- display name
  legal_name                  TEXT,               -- exact name on the EIN filing
  ein                         TEXT,
  address                     TEXT,               -- must match EIN address for 10DLC trust score
  website                     TEXT,
  timezone                    TEXT DEFAULT 'America/Chicago',
  brand_color                 TEXT DEFAULT '#ed1a78',
  status                      TEXT DEFAULT 'onboarding',  -- onboarding|active|paused|offboarded
  door                        TEXT DEFAULT 'A',           -- A = full build, B = we work their stack

  -- Twilio
  twilio_subaccount_sid       TEXT,
  twilio_subaccount_token     TEXT,
  twilio_messaging_service_sid TEXT,
  twilio_number               TEXT,               -- E.164, e.g. +12145551234
  tendlc_brand_sid            TEXT,
  tendlc_campaign_sid         TEXT,
  tendlc_status               TEXT DEFAULT 'not_started',

  -- Booking
  calendar_provider           TEXT DEFAULT 'google',
  calendar_id                 TEXT,               -- usually the front-desk email
  google_refresh_token        TEXT,
  appointment_minutes         INTEGER DEFAULT 30,
  booking_window_days         INTEGER DEFAULT 14,

  -- Handoff / write-back
  crm_bcc_email               TEXT,               -- their CRM's forward-to address
  notify_email                TEXT,               -- front desk
  hot_lead_phone              TEXT,               -- owner cell

  -- Behaviour
  business_brain              TEXT,               -- JSON: services, prices, hours, rules, tone
  send_window_start           INTEGER DEFAULT 9,  -- local hour, inclusive
  send_window_end             INTEGER DEFAULT 19, -- local hour, exclusive
  daily_send_cap              INTEGER DEFAULT 100,
  paused                      INTEGER DEFAULT 1,  -- KILL SWITCH. starts paused on purpose.
  auto_send                   INTEGER DEFAULT 0,  -- 0 = approval-gated (AI drafts, human approves); 1 = autonomous

  created_at                  TEXT DEFAULT (datetime('now')),
  updated_at                  TEXT DEFAULT (datetime('now'))
);

-- House tenant: your own prospecting leads live here too.
INSERT OR IGNORE INTO clients (id, name, legal_name, status, door, paused)
VALUES ('networkboss', 'The Network Boss (house)', 'The Network Boss', 'active', 'A', 1);

-- Fast tenant lookup from an inbound Twilio 'To' number.
CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_number ON clients(twilio_number);


-- ---------- 2. TENANCY ON EXISTING TABLES ----------
-- D1/SQLite has no "ADD COLUMN IF NOT EXISTS". If these two lines error with
-- "duplicate column name", the migration already ran - delete them and continue.
ALTER TABLE leads ADD COLUMN client_id TEXT DEFAULT 'networkboss';
ALTER TABLE notes ADD COLUMN client_id TEXT DEFAULT 'networkboss';
-- If the clients table pre-dates the approval-gating flag, add it once:
-- ALTER TABLE clients ADD COLUMN auto_send INTEGER DEFAULT 0;

UPDATE leads SET client_id = 'networkboss' WHERE client_id IS NULL;
UPDATE notes SET client_id = 'networkboss' WHERE client_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_leads_client  ON leads(client_id);
CREATE INDEX IF NOT EXISTS idx_notes_client  ON notes(client_id);


-- ---------- 3. CONVERSATIONS ----------
CREATE TABLE IF NOT EXISTS conversations (
  id                TEXT PRIMARY KEY,
  client_id         TEXT NOT NULL,
  lead_id           INTEGER,
  phone             TEXT NOT NULL,              -- E.164
  contact_name      TEXT,
  status            TEXT DEFAULT 'queued',      -- queued|active|booked|closed|opted_out|dnc
  intent            TEXT,                       -- last classified intent
  needs_human       INTEGER DEFAULT 0,
  ai_paused         INTEGER DEFAULT 0,          -- set by "take over"
  turn_count        INTEGER DEFAULT 0,
  step              INTEGER DEFAULT 0,          -- position in the follow-up cadence
  context_note      TEXT,                       -- rolling AI-written summary
  appointment_at    TEXT,
  appointment_event_id TEXT,
  last_inbound_at   TEXT,
  last_outbound_at  TEXT,
  next_send_at      TEXT,                       -- the poor-man's queue
  created_at        TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_client_phone ON conversations(client_id, phone);
CREATE INDEX IF NOT EXISTS idx_conv_due     ON conversations(next_send_at, status);
CREATE INDEX IF NOT EXISTS idx_conv_human   ON conversations(client_id, needs_human, last_inbound_at);


-- ---------- 4. MESSAGES ----------
CREATE TABLE IF NOT EXISTS messages (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL,
  client_id         TEXT NOT NULL,
  direction         TEXT NOT NULL,              -- in|out
  body              TEXT NOT NULL,
  author            TEXT DEFAULT 'ai',          -- ai|human|lead|system
  twilio_sid        TEXT,
  status            TEXT,                       -- queued|sent|delivered|failed|undelivered
  error_code        TEXT,
  intent            TEXT,
  confidence        REAL,
  segments          INTEGER,
  created_at        TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_msg_conv   ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_client ON messages(client_id, created_at);


-- ---------- 5. OPT-OUTS (per tenant, and a global blocklist) ----------
CREATE TABLE IF NOT EXISTS opt_outs (
  client_id   TEXT NOT NULL,   -- '*' = global do-not-contact, all clients
  phone       TEXT NOT NULL,
  reason      TEXT,            -- stop_keyword|manual|complaint|dnc_scrub
  created_at  TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (client_id, phone)
);


-- ---------- 6. SEND LEDGER (daily caps + client-facing usage) ----------
CREATE TABLE IF NOT EXISTS send_ledger (
  client_id   TEXT NOT NULL,
  day         TEXT NOT NULL,   -- YYYY-MM-DD in the CLIENT's timezone
  sent        INTEGER DEFAULT 0,
  received    INTEGER DEFAULT 0,
  booked      INTEGER DEFAULT 0,
  opt_outs    INTEGER DEFAULT 0,
  PRIMARY KEY (client_id, day)
);


-- ---------- 7. AUDIT (who did what, incl. the AI) ----------
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  client_id   TEXT,
  kind        TEXT,            -- booked|escalated|paused|opt_out|error|campaign_start
  ref_id      TEXT,
  detail      TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_client ON events(client_id, created_at);
