-- ============================================================
-- aiw-crm : migration 002 - auth (team + client logins)
--   npx wrangler d1 execute aiw-crm --remote --file=migration-002-auth.sql
-- Safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'team',   -- 'team' (admins + reps) | 'client'
  client_id     TEXT,                            -- set for client-portal logins
  name          TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Small key/value store (session signing secret is generated + kept here so it
-- never lives in source control).
CREATE TABLE IF NOT EXISTS app_config (
  key   TEXT PRIMARY KEY,
  value TEXT
);
