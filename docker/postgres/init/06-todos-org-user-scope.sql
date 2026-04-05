-- Per-org, per-user scope for todos + reminders (after 05-multitenant-org.sql).
-- Existing rows: org_id / user_id NULL = legacy anonymous device bucket (same as UI with no JWT).
-- Apply on existing volumes:
--   docker compose exec -T openclaw-postgres psql -U openclaw -d openclaw < docker/postgres/init/06-todos-org-user-scope.sql

ALTER TABLE todos ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES openclaw_organizations (id) ON DELETE CASCADE;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES openclaw_users (id) ON DELETE CASCADE;

ALTER TABLE reminders ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES openclaw_organizations (id) ON DELETE CASCADE;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES openclaw_users (id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS todos_org_user_created_idx ON todos (org_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS reminders_org_user_idx ON reminders (org_id, user_id);

COMMENT ON COLUMN todos.org_id IS 'NULL with user_id NULL = legacy shared scope; both set = tenant user.';
COMMENT ON COLUMN todos.user_id IS 'Owner user within org; paired with org_id.';
COMMENT ON COLUMN reminders.org_id IS 'Matches todo scope; NULL = legacy.';
COMMENT ON COLUMN reminders.user_id IS 'Matches todo scope; NULL = legacy.';
