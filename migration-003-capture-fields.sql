-- ============================================================
-- migration 003 - real columns for website-captured intake fields
--   npx wrangler d1 execute aiw-patients --remote --file=migration-003-capture-fields.sql
--
-- Required for the PATIENTS deployment (aiw-patients), which is where
-- mxncells.com sends its intake. Other tenant databases (aiw-crm, ...) can be
-- migrated whenever convenient: /api/capture/lead detects the missing columns
-- and falls back to the old layout, so no lead is lost in the meantime. Run it
-- on them eventually so their messages stop landing in `signals`.
--
-- Run ONCE per database. SQLite has no "ADD COLUMN IF NOT EXISTS", so re-running
-- errors with "duplicate column name" — that error is harmless and means the
-- migration already applied.
--
-- Why:
--   /api/capture/lead used to stuff the visitor's free-text message into
--   `signals`, a comma-separated list of scraped buying-signal flags rendered as
--   badges in the leads table. A sentence with commas in it therefore rendered
--   as several nonsense badges, and there was nowhere in the UI that showed the
--   message as a message. Website forms also had nowhere to put a preferred
--   location, so it was being concatenated into `interest`.
-- ============================================================

ALTER TABLE leads ADD COLUMN message TEXT;             -- free-text note the visitor typed on the website form
ALTER TABLE leads ADD COLUMN preferred_location TEXT;  -- destination/office the visitor asked for (e.g. Guadalajara)

-- Backfill: move prose out of `signals` into `message` for rows where `signals`
-- clearly holds a sentence rather than signal flags. Signal flags are short
-- snake_case tokens (financing, free_consult, multi_location), so anything
-- containing a space is prose. `signals` is left as-is; signalBadges() now
-- ignores non-flag values, so nothing renders from it either way.
UPDATE leads
   SET message = signals
 WHERE message IS NULL
   AND signals IS NOT NULL
   AND TRIM(signals) <> ''
   AND signals LIKE '% %';
