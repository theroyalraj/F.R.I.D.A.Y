-- Conversation learning: sessions + explicit feedback on ai_generation_log rows.
-- Requires ai_generation_log (07-ai-generation-log.sql). Safe to re-run: IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS conversation_session (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id TEXT NOT NULL DEFAULT '',
  org_id TEXT,
  source TEXT NOT NULL DEFAULT '',
  client_session_key TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT conversation_session_client_key_nonempty CHECK (length(trim(client_session_key)) > 0),
  CONSTRAINT conversation_session_user_client_unique UNIQUE (user_id, client_session_key)
);

CREATE INDEX IF NOT EXISTS conversation_session_started_idx ON conversation_session (started_at DESC);
CREATE INDEX IF NOT EXISTS conversation_session_org_idx ON conversation_session (org_id) WHERE org_id IS NOT NULL;

COMMENT ON TABLE conversation_session IS
  'Groups pc-agent turns when the client sends clientSessionId; metadata links to ai_generation_log via JSON.';

CREATE TABLE IF NOT EXISTS learning_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id UUID NOT NULL REFERENCES ai_generation_log (id) ON DELETE CASCADE,
  score REAL NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS learning_feedback_generation_idx ON learning_feedback (generation_id);
CREATE INDEX IF NOT EXISTS learning_feedback_created_idx ON learning_feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS learning_feedback_label_idx ON learning_feedback (label) WHERE label <> '';

COMMENT ON TABLE learning_feedback IS
  'User or heuristic scores for a logged generation; used for weighted retrieval and export.';
