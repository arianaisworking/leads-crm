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
-- Intake pipeline lives in leads.status, e.g.:
--   New -> Assigned -> Intake sent -> Intake returned -> Sent to doctor
--       -> Consult scheduled -> Paid -> Active   (or Lost)
ALTER TABLE leads ADD COLUMN questionnaire TEXT;            -- JSON of the patient's COMPLETED answers
ALTER TABLE leads ADD COLUMN assigned_doctor TEXT;         -- doctors.id
ALTER TABLE leads ADD COLUMN acquisition_date TEXT;        -- when we got them
ALTER TABLE leads ADD COLUMN consult_at TEXT;              -- scheduled consult date/time
ALTER TABLE leads ADD COLUMN paid_upfront INTEGER DEFAULT 0; -- patient has paid for services/consult
ALTER TABLE leads ADD COLUMN doctor_fee REAL;              -- resolved $ the doctor pays us (flat amount, or treatment_amount * fee_rate/100)
ALTER TABLE leads ADD COLUMN doctor_fee_status TEXT DEFAULT 'pending';  -- pending | invoiced | paid
ALTER TABLE leads ADD COLUMN fee_type TEXT DEFAULT 'flat'; -- flat | percent  (per-patient override of the doctor default)
ALTER TABLE leads ADD COLUMN fee_rate REAL;                -- commission % when fee_type='percent' (e.g. 20)
ALTER TABLE leads ADD COLUMN treatment_amount REAL;        -- total treatment cost, the basis for a percent fee
-- Deposit / pricing the doctor confirms after the consultation (patient pays this deposit via Stripe)
ALTER TABLE leads ADD COLUMN material_deposit REAL;        -- material deposit portion
ALTER TABLE leads ADD COLUMN consult_fee REAL;             -- 20% consultation fee portion
ALTER TABLE leads ADD COLUMN wire_fee REAL DEFAULT 25;     -- $25 bank wire fee (pass-through)
ALTER TABLE leads ADD COLUMN deposit_total REAL;           -- material_deposit + consult_fee + wire_fee
ALTER TABLE leads ADD COLUMN doctor_feedback TEXT;         -- doctor's post-consult feedback for our team
ALTER TABLE leads ADD COLUMN pricing_confirmed_at TEXT;    -- when the doctor confirmed pricing
ALTER TABLE leads ADD COLUMN deposit_paid INTEGER DEFAULT 0; -- 1 once the deposit is paid
ALTER TABLE leads ADD COLUMN deposit_link TEXT;            -- Stripe Checkout URL for the deposit
-- Protocol + travel workflow
ALTER TABLE leads ADD COLUMN protocol TEXT;               -- doctor's treatment protocol (shown to the patient)
ALTER TABLE leads ADD COLUMN travel_dates TEXT;           -- travel window the patient requested
ALTER TABLE leads ADD COLUMN travel_confirmed_at TEXT;    -- when the doctor confirmed the travel dates
ALTER TABLE leads ADD COLUMN deposit_sent_at TEXT;        -- when we sent the patient the confirm/pay page
ALTER TABLE leads ADD COLUMN final_confirmed_at TEXT;     -- when we sent the final confirmation
ALTER TABLE leads ADD COLUMN concierge TEXT;              -- JSON: requested prep services (lodging/meals/airport/aftercare/nurse + notes)
ALTER TABLE leads ADD COLUMN prep_at TEXT;                -- when the patient submitted their preparedness plan
-- Clinic location for the patient preparedness map
ALTER TABLE doctors ADD COLUMN address TEXT;             -- clinic street address (shown on the patient's map)
ALTER TABLE doctors ADD COLUMN city TEXT;                -- clinic city (e.g. Nuevo Vallarta, Guadalajara)
ALTER TABLE leads ADD COLUMN intake_token TEXT;           -- per-patient secret for the public intake link
CREATE INDEX IF NOT EXISTS idx_leads_intake_token ON leads(intake_token);
ALTER TABLE leads ADD COLUMN consult_note TEXT;           -- note the doctor leaves when scheduling the consult

CREATE TABLE IF NOT EXISTS doctors (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  specialty     TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  intake_form   TEXT,                     -- JSON: the questions THIS doctor wants on the intake form
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
