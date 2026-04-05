-- Todos + reminders (replaces data/todos.json), action tracker + message dedup.
-- Safe on existing DBs: IF NOT EXISTS. Run manually if volume already initialized:
--   docker compose exec -T openclaw-postgres psql -U openclaw -d openclaw < docker/postgres/init/03-action-tracker.sql

CREATE TABLE IF NOT EXISTS todos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('high', 'medium', 'low')),
  done BOOLEAN NOT NULL DEFAULT false,
  pinned BOOLEAN NOT NULL DEFAULT false,
  silent_remind BOOLEAN NOT NULL DEFAULT false,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS todos_done_idx ON todos (done);
CREATE INDEX IF NOT EXISTS todos_created_at_idx ON todos (created_at DESC);

CREATE TABLE IF NOT EXISTS reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  due_iso TIMESTAMPTZ,
  due_natural TEXT NOT NULL DEFAULT '',
  fired BOOLEAN NOT NULL DEFAULT false,
  fired_at TIMESTAMPTZ,
  todo_id UUID REFERENCES todos (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reminders_fired_due_idx ON reminders (fired, due_iso);
CREATE INDEX IF NOT EXISTS reminders_created_at_idx ON reminders (created_at DESC);

CREATE TABLE IF NOT EXISTS action_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  detail TEXT,
  title_hash TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  priority TEXT NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('critical', 'high', 'medium', 'low')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'done', 'dismissed')),
  source TEXT NOT NULL,
  source_message_id TEXT,
  source_sender TEXT,
  source_subject TEXT,
  due_at TIMESTAMPTZ,
  due_natural TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  last_reminded_at TIMESTAMPTZ,
  remind_count INT NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  linked_todo_id UUID REFERENCES todos (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS action_items_status_idx ON action_items (status);
CREATE INDEX IF NOT EXISTS action_items_priority_status_idx ON action_items (priority, status);
CREATE INDEX IF NOT EXISTS action_items_title_hash_idx ON action_items (title_hash);
CREATE INDEX IF NOT EXISTS action_items_source_msg_idx ON action_items (source, source_message_id);
CREATE INDEX IF NOT EXISTS action_items_due_pending_idx ON action_items (due_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS message_scan_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  action_count INT NOT NULL DEFAULT 0,
  raw_snippet TEXT,
  UNIQUE (source, source_message_id)
);

CREATE INDEX IF NOT EXISTS message_scan_log_scanned_idx ON message_scan_log (scanned_at DESC);

COMMENT ON TABLE todos IS 'OpenClaw todos; was data/todos.json.';
COMMENT ON TABLE reminders IS 'Time-based reminders linked optionally to todos.';
COMMENT ON TABLE action_items IS 'Cross-channel action items extracted by friday-action-tracker.';
COMMENT ON TABLE message_scan_log IS 'Dedup: which inbound messages were already analyzed.';
