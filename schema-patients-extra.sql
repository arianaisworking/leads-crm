-- ============================================================
-- PATIENTS environment — extra tables/columns on top of schema-full.sql.
-- Run schema-full.sql FIRST, then this. (Own database: aiw-patients)
--
-- Model:
--   - Patients reuse the `leads` table (name/phone/email/status/notes/import
--     all work already) + the patient-specific columns below.
--   - `doctors`  = the practices you send patients to (your payers).
--   - `partners` = hotels / Airbnbs / meal & aftercare services you refer
--                  patients to and earn a commission/flat fee from.
--   - `patient_referrals` = each patient->partner referral + what you earn.
-- No SMS/Twilio needed here.
-- ============================================================

-- Patient-specific fields on the shared leads table.
ALTER TABLE leads ADD COLUMN questionnaire TEXT;            -- JSON of their answers
ALTER TABLE leads ADD COLUMN assigned_doctor TEXT;         -- doctors.id
ALTER TABLE leads ADD COLUMN acquisition_date TEXT;        -- when we got them
ALTER TABLE leads ADD COLUMN doctor_fee REAL;              -- what the doctor pays us for this patient
ALTER TABLE leads ADD COLUMN doctor_fee_status TEXT DEFAULT 'pending';  -- pending | invoiced | paid

CREATE TABLE IF NOT EXISTS doctors (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  specialty     TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  fee_type      TEXT DEFAULT 'flat',     -- flat | percent
  fee_amount    REAL,                     -- $ per patient, or % if percent
  terms         TEXT,
  notes         TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS partners (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  type            TEXT,                    -- hotel | airbnb | meals | aftercare | transport | other
  contact_email   TEXT,
  contact_phone   TEXT,
  commission_type TEXT DEFAULT 'flat',     -- flat | percent
  commission_rate REAL,                     -- $ per referral, or %
  terms           TEXT,
  active          INTEGER DEFAULT 1,
  notes           TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS patient_referrals (
  id          TEXT PRIMARY KEY,
  patient_id  INTEGER NOT NULL,            -- leads.id
  partner_id  TEXT NOT NULL,               -- partners.id
  service     TEXT,                        -- what they booked (e.g. "7-night stay", "meal plan")
  amount      REAL,                        -- our commission on this referral
  status      TEXT DEFAULT 'pending',      -- pending | confirmed | paid
  created_at  TEXT DEFAULT (datetime('now')),
  paid_at     TEXT,
  notes       TEXT
);
CREATE INDEX IF NOT EXISTS idx_pref_patient ON patient_referrals(patient_id);
CREATE INDEX IF NOT EXISTS idx_pref_partner ON patient_referrals(partner_id);
CREATE INDEX IF NOT EXISTS idx_pref_status  ON patient_referrals(status);
