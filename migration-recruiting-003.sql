-- ============================================================
-- aiw-recruiting : migration 003 — the carrier's own application (Tenstreet)
-- Run after migration-recruiting-002.sql.
--   npx wrangler d1 execute aiw-recruiting --remote --file=migration-recruiting-003.sql
--
-- Evans' onboarding starts on their Tenstreet IntelliApp, not on our form. We
-- screen first (so nobody wastes a Safety review), then hand the driver a
-- TRACKED link through to the carrier's application. Tracking that click is
-- what tells us the difference between "we sent them" and "they actually
-- started", which is exactly where half-finished applications go to die.
-- ============================================================

-- Which query parameter carries source attribution on the carrier's platform,
-- and which one pins the terminal. Tenstreet uses uri_b for the source and a
-- cq_<id> custom question for the terminal — both live inside apply_url, and
-- only the source value is ever rewritten.
ALTER TABLE carriers ADD COLUMN apply_source_param TEXT DEFAULT 'uri_b';

-- Per-person attribution code on the carrier's platform. Ask the carrier for
-- one source tag each; every driver either of you sends is then provably yours
-- in their system, and the split reconciles without anyone's memory.
ALTER TABLE recruiters ADD COLUMN source_tag TEXT;

-- The carrier-application step, tracked.
ALTER TABLE leads ADD COLUMN carrier_app_sent_at TEXT;     -- we sent them the link
ALTER TABLE leads ADD COLUMN carrier_app_clicked_at TEXT;  -- they clicked through to it
ALTER TABLE leads ADD COLUMN carrier_app_clicks INTEGER DEFAULT 0;

-- Evans Delivery — Dallas (DAL) terminal IntelliApp, from their driver welcome
-- email. cq_1192228=DAL routes the application to the Dallas terminal, so it
-- must survive any rewrite. Replace the uri_b value with our own source tag
-- once the carrier issues one.
UPDATE carriers
   SET apply_url = 'https://intelliapp.driverapponline.com/c/evansdelivery?cq_1192228=DAL&uri_b=ia_evansdelivery_440136800',
       apply_source_param = 'uri_b'
 WHERE id = 'evans_dal' AND (apply_url IS NULL OR apply_url = '');
