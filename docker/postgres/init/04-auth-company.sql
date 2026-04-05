-- Multi-user auth + company profile (OpenClaw listen UI).
-- Safe on existing DBs: IF NOT EXISTS. Run manually if volume already initialized:
--   docker compose exec -T openclaw-postgres psql -U openclaw -d openclaw < docker/postgres/init/04-auth-company.sql

CREATE TABLE IF NOT EXISTS openclaw_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS openclaw_users_email_idx ON openclaw_users (lower(email));

CREATE TABLE IF NOT EXISTS openclaw_companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES openclaw_users (id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  mission TEXT NOT NULL DEFAULT '',
  vision TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS openclaw_companies_user_id_idx ON openclaw_companies (user_id);

COMMENT ON TABLE openclaw_users IS 'Listen UI login; JWT auth.';
COMMENT ON TABLE openclaw_companies IS 'One company profile per user; injected into voice/Claude system prompts.';
