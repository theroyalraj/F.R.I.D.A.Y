-- Key/value prefs (e.g. ambient timing). Safe to run on existing DBs: IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS openclaw_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS openclaw_settings_updated_at_idx ON openclaw_settings (updated_at DESC);

COMMENT ON TABLE openclaw_settings IS
  'Runtime preferences stored in Postgres; friday-listen updates via pc-agent /settings/ambient (no .env writes).';
