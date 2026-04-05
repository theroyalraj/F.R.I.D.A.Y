-- Multi-tenant organizations + org-scoped company profiles (Listen UI).
-- Run after 04-auth-company.sql. If volume already exists:
--   docker compose exec -T openclaw-postgres psql -U openclaw -d openclaw < docker/postgres/init/05-multitenant-org.sql

CREATE TABLE IF NOT EXISTS openclaw_organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT,
  name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT openclaw_organizations_domain_not_empty CHECK (domain IS NULL OR length(trim(domain)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS openclaw_organizations_domain_lower_idx
  ON openclaw_organizations (lower(domain))
  WHERE domain IS NOT NULL;

CREATE TABLE IF NOT EXISTS openclaw_org_members (
  org_id UUID NOT NULL REFERENCES openclaw_organizations (id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES openclaw_users (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  PRIMARY KEY (org_id, user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS openclaw_org_members_user_unique_idx ON openclaw_org_members (user_id);

CREATE TABLE IF NOT EXISTS openclaw_company_profiles (
  org_id UUID PRIMARY KEY REFERENCES openclaw_organizations (id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  mission TEXT NOT NULL DEFAULT '',
  vision TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE openclaw_organizations IS 'Tenant: corporate domain unique when set; NULL domain = personal org (generic email).';
COMMENT ON TABLE openclaw_org_members IS 'One org per user (MVP); admin can edit company profile.';
COMMENT ON TABLE openclaw_company_profiles IS 'Org voice/Claude context: name, description, mission, vision.';

-- Migrate legacy per-user openclaw_companies → org + profile + admin membership
DO $$
DECLARE
  r RECORD;
  new_org_id UUID;
  u RECORD;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'openclaw_companies'
  ) THEN
    FOR r IN SELECT * FROM openclaw_companies LOOP
      CONTINUE WHEN EXISTS (SELECT 1 FROM openclaw_org_members m WHERE m.user_id = r.user_id);
      INSERT INTO openclaw_organizations (domain, name, created_at)
      VALUES (NULL, COALESCE(NULLIF(trim(r.name), ''), 'Personal'), r.created_at)
      RETURNING id INTO new_org_id;
      INSERT INTO openclaw_org_members (org_id, user_id, role)
      VALUES (new_org_id, r.user_id, 'admin');
      INSERT INTO openclaw_company_profiles (org_id, name, description, mission, vision, updated_at)
      VALUES (new_org_id, r.name, r.description, r.mission, r.vision, r.updated_at);
    END LOOP;
    DROP TABLE IF EXISTS openclaw_companies;
  END IF;

  -- Users without membership: personal org
  FOR u IN SELECT id FROM openclaw_users usr
    WHERE NOT EXISTS (SELECT 1 FROM openclaw_org_members m WHERE m.user_id = usr.id)
  LOOP
    INSERT INTO openclaw_organizations (domain, name)
    VALUES (NULL, 'Personal')
    RETURNING id INTO new_org_id;
    INSERT INTO openclaw_org_members (org_id, user_id, role)
    VALUES (new_org_id, u.id, 'admin');
    INSERT INTO openclaw_company_profiles (org_id)
    VALUES (new_org_id)
    ON CONFLICT (org_id) DO NOTHING;
  END LOOP;
END $$;
