-- ============================================================
-- aiw-recruiting : migration 004 — invoicing the carrier from our own records
-- Run after migration-recruiting-003.sql.
--   npx wrangler d1 execute aiw-recruiting --remote --file=migration-recruiting-004.sql
--
-- The CRM is the billing record. It knows who we sourced, screened, submitted
-- and seated, what each placement is worth and how it splits — so it should
-- produce the invoice, not just hold the facts that go on one.
--
-- The one thing it cannot know by itself is WHEN a driver actually started,
-- because the carrier doesn't report back. That's the leak this migration
-- closes: every driver past their orientation date with no start date recorded
-- is surfaced as a question, because an unanswered one is an uninvoiced fee.
-- ============================================================

CREATE TABLE IF NOT EXISTS carrier_invoices (
  id            TEXT PRIMARY KEY,
  number        TEXT,                       -- human reference, e.g. AIW-2026-0007
  carrier_id    TEXT NOT NULL,
  period_start  TEXT,
  period_end    TEXT,
  drivers       INTEGER DEFAULT 0,
  amount        REAL DEFAULT 0,
  currency      TEXT DEFAULT 'USD',
  status        TEXT DEFAULT 'draft',       -- draft | sent | paid | void
  line_items    TEXT,                       -- JSON snapshot: driver, seated date, confirmation #, amount
  sent_to       TEXT,
  sent_at       TEXT,
  paid_at       TEXT,
  notes         TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cinv_carrier ON carrier_invoices(carrier_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cinv_status  ON carrier_invoices(status);

-- Which invoice a placement went out on, so nothing is billed twice.
ALTER TABLE placements ADD COLUMN invoice_id TEXT;
CREATE INDEX IF NOT EXISTS idx_place_invoice ON placements(invoice_id);

-- Where the carrier's invoices should go, if it isn't the recruiting contact.
ALTER TABLE carriers ADD COLUMN billing_email TEXT;
ALTER TABLE carriers ADD COLUMN payment_terms TEXT DEFAULT 'Net 15';

-- Seating confirmation: asked, answered, or still open.
ALTER TABLE leads ADD COLUMN seat_checked_at TEXT;   -- when we last asked "did they start?"
ALTER TABLE leads ADD COLUMN seat_confirmed_by TEXT; -- who told us: carrier | driver | us
