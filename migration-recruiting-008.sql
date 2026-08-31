-- Two more ways in, both landing in the CRM rather than an inbox.
--
-- Referrals: a driver sending us another driver. The referred person becomes a
-- normal lead so they show up in the pipeline where the team already works;
-- this table records who sent them, which is what a referral fee is paid on.
-- Kept separate from `leads` because leads is at 94 of D1's 100 columns and
-- because "who referred whom" is its own fact, not an attribute of a driver.
CREATE TABLE IF NOT EXISTS referrals (
  id              TEXT PRIMARY KEY,
  referrer_name   TEXT NOT NULL,
  referrer_phone  TEXT,
  referrer_email  TEXT,
  driver_name     TEXT NOT NULL,      -- who they're sending us
  driver_phone    TEXT,
  driver_email    TEXT,
  lead_id         INTEGER,            -- the leads row we created for them
  status          TEXT DEFAULT 'new', -- new | contacted | placed | closed
  payout_status   TEXT DEFAULT 'none',-- none | owed | paid
  payout_amount   REAL,
  source          TEXT,
  notes           TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status);
CREATE INDEX IF NOT EXISTS idx_referrals_lead ON referrals(lead_id);

-- Recruiters: someone applying to recruit for us, 1099 and commission only.
-- They go in the same table the working recruiters live in, so an accepted
-- applicant is a status change rather than a re-typing. active=0 keeps an
-- applicant out of every split and payout path until someone says yes.
ALTER TABLE recruiters ADD COLUMN phone TEXT;
ALTER TABLE recruiters ADD COLUMN city TEXT;
ALTER TABLE recruiters ADD COLUMN experience TEXT;
ALTER TABLE recruiters ADD COLUMN status TEXT DEFAULT 'active';  -- applicant | active | declined
ALTER TABLE recruiters ADD COLUMN source TEXT;

-- The two of you are already active; only new applicants come in as pending.
UPDATE recruiters SET status='active' WHERE status IS NULL;
