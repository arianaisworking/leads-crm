-- ============================================================
-- aiw-recruiting : migration 002 — revenue split + the lease/document workflow
-- Run after schema-recruiting-extra.sql.
--   npx wrangler d1 execute aiw-recruiting --remote --file=migration-recruiting-002.sql
-- ============================================================

-- ---------- WHO SPLITS THE FEE ----------
CREATE TABLE IF NOT EXISTS recruiters (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT,
  share_pct   REAL DEFAULT 50,           -- default cut of each placement they source
  active      INTEGER DEFAULT 1,
  notes       TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

-- The two of you, 50/50. Edit the names, emails and shares in the CRM.
INSERT OR IGNORE INTO recruiters (id, name, share_pct) VALUES ('ariana','Ariana',50);
INSERT OR IGNORE INTO recruiters (id, name, share_pct) VALUES ('mystica','Mystica',50);

-- Who sourced this driver (informational — the split is per placement).
ALTER TABLE leads ADD COLUMN recruiter_id TEXT;

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

-- ---------- THE LEASE / DOCUMENT WORKFLOW ----------
-- The carrier's Lease Info form, filled on our site instead of on paper.
ALTER TABLE leads ADD COLUMN lease_info TEXT;          -- JSON: the non-sensitive answers
ALTER TABLE leads ADD COLUMN lease_secure TEXT;        -- AES-GCM sealed: SSN, licence #, bank details
ALTER TABLE leads ADD COLUMN lease_info_at TEXT;       -- when the driver completed it
ALTER TABLE leads ADD COLUMN lease_token TEXT;         -- secret for the lease + upload page
ALTER TABLE leads ADD COLUMN packet_sent_at TEXT;      -- when we sent the full packet to the carrier
ALTER TABLE leads ADD COLUMN onboarding_sent_at TEXT;  -- when we sent the driver their "what happens next" pack
ALTER TABLE leads ADD COLUMN secure_purged_at TEXT;    -- when the sealed fields were destroyed
ALTER TABLE leads ADD COLUMN gender TEXT;              -- the lease form asks for it

CREATE INDEX IF NOT EXISTS idx_leads_lease_token ON leads(lease_token);

-- Truck detail the lease form needs beyond what we already store.
ALTER TABLE leads ADD COLUMN truck_unit_no TEXT;
ALTER TABLE leads ADD COLUMN truck_value REAL;
ALTER TABLE leads ADD COLUMN lienholder_address TEXT;
ALTER TABLE leads ADD COLUMN lienholder_phone TEXT;
ALTER TABLE leads ADD COLUMN lienholder_email TEXT;
ALTER TABLE leads ADD COLUMN wants_maintenance INTEGER;    -- maintenance escrow Y/N
ALTER TABLE leads ADD COLUMN maintenance_weekly REAL;
ALTER TABLE leads ADD COLUMN maintenance_max REAL;
ALTER TABLE leads ADD COLUMN business_ein TEXT;
ALTER TABLE leads ADD COLUMN business_owner TEXT;
ALTER TABLE leads ADD COLUMN business_address TEXT;
ALTER TABLE leads ADD COLUMN business_phone TEXT;
ALTER TABLE leads ADD COLUMN business_email TEXT;
ALTER TABLE leads ADD COLUMN home_phone TEXT;

-- The Evans fee as it stands today: $1,000 per seated driver.
-- Raise it here when it moves to $2,000 / $2,500 — placements already created
-- keep the amount they were agreed at.
UPDATE carriers SET fee_amount = 1000, fee_type = 'flat', fee_trigger = 'seated'
 WHERE id = 'evans_dal' AND fee_amount IS NULL;
