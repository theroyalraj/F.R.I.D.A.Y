-- Pinned sticky notes + optional exclusion from POST /todos/remind spoken list.
-- Apply on existing volumes: docker compose exec -T openclaw-postgres psql -U openclaw -d openclaw < docker/postgres/init/04-todos-ui-flags.sql

ALTER TABLE todos ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS silent_remind BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS todos_pinned_idx ON todos (pinned) WHERE pinned = true AND done = false;

COMMENT ON COLUMN todos.pinned IS 'Show on Friday /friday sticky note widget when not done.';
COMMENT ON COLUMN todos.silent_remind IS 'When true, omit from spoken todo remind (POST /todos/remind).';
