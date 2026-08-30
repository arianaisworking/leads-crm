-- ============================================================
-- aiw-recruiting : migration 007 — carriers we're still chasing
-- Run after migration-recruiting-006.sql.
--
-- A carrier has a lifecycle: someone we're pitching, then someone who pays us.
-- Both belong in `carriers` — same company, same contact details, one record
-- that gains qualification rules and a fee when they sign. A second table for
-- prospects would mean copying the row across at the exact moment things get
-- busy, which is when data gets lost.
--
-- `status` marks which half of the life they're in. `active` stays the guard
-- on the recruiting side: a prospect is active=0, so firstCarrier() can never
-- assign a driver to a company that hasn't agreed to anything.
-- ============================================================

ALTER TABLE carriers ADD COLUMN status TEXT DEFAULT 'partner';   -- prospect | partner
ALTER TABLE carriers ADD COLUMN website TEXT;
ALTER TABLE carriers ADD COLUMN need TEXT;      -- what they said they're short of

CREATE INDEX IF NOT EXISTS idx_carriers_status ON carriers (status, active);

-- Everything already in the table is a real partner.
UPDATE carriers SET status = 'partner' WHERE status IS NULL;
