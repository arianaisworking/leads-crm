-- ============================================================
-- RECRUITING environment — extra tables/columns on top of schema-full.sql.
-- Run schema-full.sql FIRST, then this. (Own database: aiw-recruiting)
--
-- Model:
--   - Drivers reuse the `leads` table (name/phone/email/status/notes all work)
--     plus the driver-specific columns below.
--   - `carriers` = the trucking companies we recruit FOR (our payers).
--                  Each carrier owns a `qual_rules` JSON — the screening rubric
--                  its Safety dept actually applies. Seeded with Evans Delivery.
--   - `driver_docs` = the onboarding document checklist, per driver.
--   - `placements` = what we earn per driver seated with a carrier.
--
-- PII NOTE: we deliberately do NOT store SSN, bank routing/account numbers or
-- full driver's-licence numbers. Those live on the carrier's own lease form,
-- filled in directly with the carrier. See README-RECRUITING.md.
-- ============================================================

-- ---------- DRIVER FIELDS (on the shared leads table) ----------
-- Pipeline lives in leads.status. Stages mirror the carrier's real sequence:
--   New -> Screening -> Pre-qualified -> Application submitted -> Clearinghouse
--   -> Experience verify -> Pre-approved -> Drug test -> Documents -> Lease sent
--   -> Lease signed -> Orientation -> Rolling      (or Not qualified)
ALTER TABLE leads ADD COLUMN carrier_id TEXT;                 -- carriers.id
ALTER TABLE leads ADD COLUMN apply_token TEXT;                -- per-driver secret for the public application link
ALTER TABLE leads ADD COLUMN application TEXT;                -- JSON: the driver's completed application answers
ALTER TABLE leads ADD COLUMN applied_at TEXT;                 -- when they submitted our application

-- Identity / eligibility
ALTER TABLE leads ADD COLUMN dob TEXT;                        -- YYYY-MM-DD (age gate: 22+)
ALTER TABLE leads ADD COLUMN work_authorized INTEGER;         -- 1 = legally authorised to work in the US
ALTER TABLE leads ADD COLUMN us_citizen INTEGER;              -- lease form asks; NOT a qualification requirement
ALTER TABLE leads ADD COLUMN cdl_class TEXT;                  -- A | B | C
ALTER TABLE leads ADD COLUMN cdl_state TEXT;                  -- must be state of residence
ALTER TABLE leads ADD COLUMN cdl_expires TEXT;
ALTER TABLE leads ADD COLUMN endorsements TEXT;               -- comma list: twic,hazmat,tanker,doubles
ALTER TABLE leads ADD COLUMN dot_medical_expires TEXT;        -- DOT physical / med card expiry
ALTER TABLE leads ADD COLUMN exp_months_5yr INTEGER;          -- verifiable Class A months in the previous 5 years
ALTER TABLE leads ADD COLUMN exp_months_3yr INTEGER;          -- ...of which, months within the previous 3 years
ALTER TABLE leads ADD COLUMN flatbed_months_1yr INTEGER;      -- flatbed months in the previous 1 year
ALTER TABLE leads ADD COLUMN can_verify_employers INTEGER;    -- 0 => may need 3 years of 1099s instead
ALTER TABLE leads ADD COLUMN has_1099s INTEGER;               -- driver has 3 years of 1099s on hand

-- Self-reported record (drives the points engine)
ALTER TABLE leads ADD COLUMN violations TEXT;                 -- JSON array: [{code, date, note}]
ALTER TABLE leads ADD COLUMN sap_completed_at TEXT;           -- date a Substance Abuse Program was completed
ALTER TABLE leads ADD COLUMN positive_test_at TEXT;           -- date of any positive/refused drug or alcohol test
ALTER TABLE leads ADD COLUMN felony INTEGER DEFAULT 0;        -- non-commercial felony -> case-by-case review
ALTER TABLE leads ADD COLUMN misdemeanor INTEGER DEFAULT 0;   -- allowed, case-by-case
ALTER TABLE leads ADD COLUMN background_note TEXT;

-- Screening verdict (computed by _lib/screening.js against the carrier's rules)
ALTER TABLE leads ADD COLUMN screen_result TEXT;              -- qualified | review | disqualified
ALTER TABLE leads ADD COLUMN screen_points INTEGER;
ALTER TABLE leads ADD COLUMN screen_detail TEXT;              -- JSON: {points, reasons[], blockers[], warnings[]}
ALTER TABLE leads ADD COLUMN screened_at TEXT;

-- Truck (owner-operator: own tractor, carrier supplies the trailer)
ALTER TABLE leads ADD COLUMN truck_year INTEGER;
ALTER TABLE leads ADD COLUMN truck_make TEXT;
ALTER TABLE leads ADD COLUMN truck_color TEXT;
ALTER TABLE leads ADD COLUMN truck_vin TEXT;
ALTER TABLE leads ADD COLUMN truck_plate TEXT;
ALTER TABLE leads ADD COLUMN truck_plate_state TEXT;
ALTER TABLE leads ADD COLUMN owns_truck INTEGER;              -- must be 1 for a lease-on
ALTER TABLE leads ADD COLUMN lienholder TEXT;
ALTER TABLE leads ADD COLUMN wants_carrier_plates INTEGER;    -- Evans Plate Program ($50/wk) -> needs title + 2290
ALTER TABLE leads ADD COLUMN wants_ifta INTEGER;              -- Evans IFTA ($10/wk)
ALTER TABLE leads ADD COLUMN inspection_date TEXT;            -- federal inspection date — must be within 30 days at submission

-- Business entity (decides whether page 2 of the lease form is required)
ALTER TABLE leads ADD COLUMN has_business INTEGER DEFAULT 0;
ALTER TABLE leads ADD COLUMN business_name TEXT;

-- Onboarding milestones (the carrier's sequence, from their welcome email)
ALTER TABLE leads ADD COLUMN submitted_at TEXT;               -- application sent to the carrier
ALTER TABLE leads ADD COLUMN confirmation_no TEXT;            -- carrier's confirmation number
ALTER TABLE leads ADD COLUMN clearinghouse_ok INTEGER DEFAULT 0;
ALTER TABLE leads ADD COLUMN experience_verified INTEGER DEFAULT 0;
ALTER TABLE leads ADD COLUMN preapproved_at TEXT;
ALTER TABLE leads ADD COLUMN drug_test_scheduled_at TEXT;     -- starts a 7-BUSINESS-DAY clock
ALTER TABLE leads ADD COLUMN drug_test_due TEXT;              -- computed deadline
ALTER TABLE leads ADD COLUMN drug_test_done_at TEXT;
ALTER TABLE leads ADD COLUMN lease_sent_at TEXT;
ALTER TABLE leads ADD COLUMN lease_signed_at TEXT;
ALTER TABLE leads ADD COLUMN startup_packet_at TEXT;
ALTER TABLE leads ADD COLUMN orientation_at TEXT;             -- carrier's orientation day (Evans: Wednesdays, Hutchins TX)
ALTER TABLE leads ADD COLUMN started_at TEXT;                 -- first day rolling
ALTER TABLE leads ADD COLUMN lost_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_leads_apply_token ON leads(apply_token);
CREATE INDEX IF NOT EXISTS idx_leads_carrier ON leads(carrier_id);
CREATE INDEX IF NOT EXISTS idx_leads_screen ON leads(screen_result);


-- ---------- CARRIERS (our payers) ----------
CREATE TABLE IF NOT EXISTS carriers (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  terminal        TEXT,                    -- e.g. 'Dallas, TX (DAL)'
  mc_number       TEXT,
  dot_number      TEXT,
  scac            TEXT,
  address         TEXT,
  city            TEXT,
  state           TEXT,
  postcode        TEXT,
  contact_name    TEXT,
  contact_email   TEXT,
  contact_phone   TEXT,
  haul_type       TEXT,                    -- intermodal | dry van | reefer | flatbed | tanker
  driver_type     TEXT DEFAULT 'owner_operator',  -- owner_operator | company | lease_purchase
  needs_own_truck INTEGER DEFAULT 1,
  needs_own_trailer INTEGER DEFAULT 0,
  apply_url       TEXT,                    -- the carrier's own application link
  orientation_info TEXT,                   -- e.g. 'Wednesdays, 1021 Fulghum Rd, Hutchins TX'
  qual_rules      TEXT,                    -- JSON screening rubric (see _lib/screening.js)
  doc_checklist   TEXT,                    -- JSON array of required documents
  fee_type        TEXT DEFAULT 'flat',     -- flat | percent
  fee_amount      REAL,                    -- $ per placement, or % if percent
  fee_trigger     TEXT DEFAULT 'seated',   -- submitted | seated | days_30
  terms           TEXT,
  active          INTEGER DEFAULT 1,
  notes           TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);


-- ---------- DOCUMENT CHECKLIST (per driver) ----------
CREATE TABLE IF NOT EXISTS driver_docs (
  id          TEXT PRIMARY KEY,
  driver_id   INTEGER NOT NULL,            -- leads.id
  kind        TEXT NOT NULL,               -- registration | title | form_2290 | ecm_photo | inspection | voided_check | lease_form | cdl | med_card | other
  label       TEXT,
  status      TEXT DEFAULT 'needed',       -- needed | received | rejected
  file_key    TEXT,                        -- R2 key when uploaded
  file_name   TEXT,
  doc_date    TEXT,                        -- e.g. the inspection date (30-day rule)
  expires_at  TEXT,                        -- computed for time-limited docs
  note        TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ddocs_driver ON driver_docs(driver_id);
CREATE INDEX IF NOT EXISTS idx_ddocs_status ON driver_docs(status);


-- ---------- PLACEMENTS (what we earn) ----------
CREATE TABLE IF NOT EXISTS placements (
  id          TEXT PRIMARY KEY,
  driver_id   INTEGER NOT NULL,            -- leads.id
  carrier_id  TEXT NOT NULL,               -- carriers.id
  fee_type    TEXT DEFAULT 'flat',
  fee_amount  REAL,                        -- resolved $ we earn
  status      TEXT DEFAULT 'pending',      -- pending | invoiced | paid | clawed_back
  trigger_met TEXT,                        -- which trigger fired: submitted | seated | days_30
  seated_at   TEXT,
  invoiced_at TEXT,
  paid_at     TEXT,
  notes       TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_place_driver  ON placements(driver_id);
CREATE INDEX IF NOT EXISTS idx_place_carrier ON placements(carrier_id);
CREATE INDEX IF NOT EXISTS idx_place_status  ON placements(status);


-- ---------- SEED: Evans Delivery (Dallas / DND office) ----------
-- Rubric transcribed from "Driver Qualification Criteria", revised January 2024.
INSERT OR IGNORE INTO carriers (
  id, name, terminal, mc_number, dot_number, scac, address, city, state, postcode,
  contact_name, contact_email, contact_phone, haul_type, driver_type,
  needs_own_truck, needs_own_trailer, orientation_info, fee_trigger, qual_rules, doc_checklist
) VALUES (
  'evans_dal',
  'Evans Delivery Company',
  'Dallas, TX Terminal (DAL) — DND Office',
  '057591', '038111', 'EDFF',
  '1021 East Fulghum Road', 'Hutchins', 'TX', '75141',
  'Daphine Reeves', 'Daphine.Reeves@EvansDelivery.com', '469-688-1352',
  'intermodal', 'owner_operator',
  1, 0,
  'Typically Wednesdays · 1021 Fulghum Rd, Hutchins TX · a few hours · can start as early as the next day',
  'seated',
  '{"min_age":22,"cdl_class":"A","cdl_from_state_of_residence":true,"dot_medical_required":true,"work_authorization_required":true,"citizenship_required":false,"owns_truck_required":true,"owns_trailer_required":false,"experience":{"months_in_5yr":12,"months_in_3yr":8,"flatbed_months_in_1yr":6},"max_crash_or_serious_1yr":1,"handheld_lookback_months":6,"drug_alcohol_lookback_years":10,"sap_lookback_years":10,"points":{"prequalified_max":3,"review_max":5,"disqualify_at":6,"moving_violation_years":3,"accident_years":5},"case_by_case":["felony_non_commercial","misdemeanor","habitual_suspension"],"inspection_max_age_days":30,"drug_test_business_days":7}',
  '[{"kind":"registration","label":"Truck registration"},{"kind":"title","label":"Clean title, front & back (Plate Program)","if":"wants_carrier_plates"},{"kind":"form_2290","label":"Current 2290","if":"wants_carrier_plates"},{"kind":"ecm_photo","label":"Photo of ECM port"},{"kind":"inspection","label":"Federal truck inspection (within 30 days)","max_age_days":30},{"kind":"voided_check","label":"Voided check"},{"kind":"lease_form","label":"Lease info form (page 2 if LLC/EIN)"},{"kind":"form_1099","label":"3 years of 1099s (employment verification)","if_no":"can_verify_employers"}]'
);
