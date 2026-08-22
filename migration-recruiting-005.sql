-- ============================================================
-- aiw-recruiting : migration 005 — follow-up nudges
-- Run after migration-recruiting-004.sql.
--   npx wrangler d1 execute aiw-recruiting --remote --file=migration-recruiting-005.sql
--
-- Drivers don't stall because they changed their mind. They stall because the
-- application is long, the inspection expired, or they meant to do it Sunday.
-- Every nudge here is tied to a specific stuck state and stops the moment the
-- driver moves — and every send is logged so nobody gets chased twice.
-- ============================================================

CREATE TABLE IF NOT EXISTS driver_nudges (
  id          TEXT PRIMARY KEY,
  driver_id   INTEGER NOT NULL,
  kind        TEXT NOT NULL,          -- carrier_app_unopened | carrier_app_unfinished |
                                      -- lease_form | docs_missing | drug_test |
                                      -- inspection_stale | orientation_tomorrow
  channel     TEXT DEFAULT 'email',
  sent_to     TEXT,
  ok          INTEGER DEFAULT 1,
  detail      TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_nudge_driver ON driver_nudges(driver_id, kind, created_at);

-- Per-driver mute, for when you'd rather handle someone by phone.
ALTER TABLE leads ADD COLUMN nudge_paused INTEGER DEFAULT 0;
ALTER TABLE leads ADD COLUMN last_nudge_at TEXT;
