-- The job board.
--
-- A posting is ours, not the carrier's: we write it, we decide what it says,
-- and it points at a carrier row so an application can be routed. Nothing here
-- has to name the carrier publicly. `show_carrier` defaults to 0 because the
-- standing rule is that a driver learns which company they're headed for from
-- us or from the ad they came in on, never from a page that anyone can read.
-- Turn it on per posting when a carrier actually wants their name out there.
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  carrier_id    TEXT,                       -- who it's for; may be null while drafting
  title         TEXT NOT NULL,              -- "Regional dry van, home weekends"
  driver_type   TEXT DEFAULT 'owner_operator',  -- owner_operator | company | both
  location      TEXT,                       -- "Dallas, TX" or "Midwest regional"
  haul_type     TEXT,                       -- dry van, reefer, intermodal, flatbed
  home_time     TEXT,                       -- "Home weekends", "Daily"
  pay_summary   TEXT,                       -- whatever we're willing to say in public
  requirements  TEXT,                       -- short public-facing list, one per line
  description   TEXT,
  openings      INTEGER,
  show_carrier  INTEGER DEFAULT 0,          -- name the carrier on the public page?
  status        TEXT DEFAULT 'draft',       -- draft | open | filled | closed
  sort_order    INTEGER DEFAULT 0,
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_carrier ON jobs(carrier_id);

-- Which posting a driver came in on, so we know what the board is actually
-- producing and which opening to put them against.
ALTER TABLE leads ADD COLUMN job_id TEXT;
CREATE INDEX IF NOT EXISTS idx_leads_job ON leads(job_id);
