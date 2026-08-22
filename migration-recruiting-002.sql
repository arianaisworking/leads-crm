-- ============================================================
-- aiw-recruiting : migration 002 — revenue split + the lease/document workflow
-- Run after schema-recruiting-extra.sql.
--   npx wrangler d1 execute aiw-recruiting --remote --file=migration-recruiting-002.sql
--
-- COLUMN BUDGET: D1 caps a table at 100 columns and `leads` is already at 80
-- after the recruiting schema. So the lease form's own fields live in
-- `driver_lease`, one row per driver, rather than widening `leads` further.
-- That's the right shape anyway: they only exist for drivers who reach the
-- lease stage, and it keeps the encrypted blob in its own table.
--
-- Only workflow state that gets filtered on in hot queries (tokens, timestamps
-- the nudge and stats passes read) stays on `leads`. Any NEW driver field
-- belongs on `driver_lease` unless a WHERE clause needs it.
-- ============================================================

-- ---------- WHO SPLITS THE FEE ----------
CREATE TABLE IF NOT EXISTS recruiters (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT,
  share_pct   REAL DEFAULT 50,           -- default cut of each placement
  active      INTEGER DEFAULT 1,
  notes       TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

-- The two of you, 50/50. Edit the names, emails and shares in the CRM.
INSERT OR IGNORE INTO recruiters (id, name, share_pct) VALUES ('ariana','Ariana',50);
INSERT OR IGNORE INTO recruiters (id, name, share_pct) VALUES ('mystica','Mystica',50);

-- ---------- THE SPLIT, PER PLACEMENT ----------
-- Recorded per placement, not read live off `recruiters`, so raising the fee
-- from $1,000 to $2,000 or changing the split never rewrites history.
CREATE TABLE IF NOT EXISTS placement_splits (
  id            TEXT PRIMARY KEY,
  placement_id  TEXT NOT NULL,
  recruiter_id  TEXT NOT NULL,
  share_pct     REAL,
  amount        REAL,
  status        TEXT DEFAULT 'pending',   -- pending | paid
  paid_at       TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_psplit_placement ON placement_splits(placement_id);
CREATE INDEX IF NOT EXISTS idx_psplit_recruiter ON placement_splits(recruiter_id);

-- ---------- THE LEASE FORM ITSELF ----------
-- One row per driver, created when they first return the form.
CREATE TABLE IF NOT EXISTS driver_lease (
  driver_id           INTEGER PRIMARY KEY,   -- leads.id
  gender              TEXT,                  -- the carrier's form asks for it
  home_phone          TEXT,
  postcode            TEXT,
  -- Truck detail the lease needs beyond what `leads` already carries
  truck_unit_no       TEXT,
  truck_value         REAL,
  lienholder_address  TEXT,
  lienholder_phone    TEXT,
  lienholder_email    TEXT,
  -- Weekly elections
  wants_maintenance   INTEGER,
  maintenance_weekly  REAL,
  maintenance_max     REAL,
  -- Page 2: only for drivers leasing under a business
  business_ein        TEXT,
  business_owner      TEXT,
  business_address    TEXT,
  business_phone      TEXT,
  business_email      TEXT,
  -- The rest of the answers, and the sealed fields
  lease_info          TEXT,                  -- JSON: everything else the form collected
  lease_secure        TEXT,                  -- AES-GCM sealed: SSN, licence #, bank details
  created_at          TEXT DEFAULT (datetime('now')),
  updated_at          TEXT DEFAULT (datetime('now'))
);

-- ---------- WORKFLOW STATE ON `leads` (queried, so it stays here) ----------
ALTER TABLE leads ADD COLUMN recruiter_id TEXT;         -- who sourced this driver
ALTER TABLE leads ADD COLUMN lease_token TEXT;          -- secret for the lease + upload page
ALTER TABLE leads ADD COLUMN lease_info_at TEXT;        -- when the driver completed the form
ALTER TABLE leads ADD COLUMN onboarding_sent_at TEXT;   -- when we sent the pack
ALTER TABLE leads ADD COLUMN packet_sent_at TEXT;       -- when the carrier got the full packet
ALTER TABLE leads ADD COLUMN secure_purged_at TEXT;     -- when the sealed fields were destroyed

CREATE INDEX IF NOT EXISTS idx_leads_lease_token ON leads(lease_token);

-- The Evans fee as it stands today: $1,000 per seated driver.
-- Raise it here when it moves to $2,000 / $2,500 — placements already created
-- keep the amount they were agreed at.
UPDATE carriers SET fee_amount = 1000, fee_type = 'flat', fee_trigger = 'seated'
 WHERE id = 'evans_dal' AND fee_amount IS NULL;
