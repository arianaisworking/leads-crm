-- ============================================================
-- aiw-recruiting : migration 007 — carrier enquiries
-- Run after migration-recruiting-006.sql.
--
-- Enquiries from the carriers page. Deliberately its own table rather than a
-- row in `leads`: a carrier is not a driver, nothing in the screening or
-- nudge logic should ever pick one up, and losing one costs far more than
-- losing a driver lead — one carrier is a whole revenue line.
-- ============================================================

CREATE TABLE IF NOT EXISTS carrier_inquiries (
  id            TEXT PRIMARY KEY,
  company       TEXT NOT NULL,
  contact_name  TEXT,
  email         TEXT,
  phone         TEXT,
  dot_number    TEXT,
  terminal      TEXT,          -- where they need drivers
  driver_type   TEXT,          -- owner_operator | company | both | unsure
  need          TEXT,          -- how many drivers, how soon, in their words
  status        TEXT DEFAULT 'new',   -- new | talking | won | lost
  source        TEXT,
  notes         TEXT,
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_carrier_inquiries_status ON carrier_inquiries (status, created_at);
