-- ============================================================
-- aiw-recruiting : migration 006 — the driver's language
-- Run after migration-recruiting-005.sql.
--
-- The site, the application and the lease page are all bilingual. A driver who
-- applied in Spanish should be chased in Spanish too, so the choice they made
-- on the form is recorded and every automated email follows it.
-- ============================================================

ALTER TABLE leads ADD COLUMN lang TEXT DEFAULT 'en';   -- 'en' | 'es'
