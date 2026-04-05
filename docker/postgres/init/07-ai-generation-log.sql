-- AI generation log: completions, embeddings for semantic cache, analytics.
-- Requires pgvector (same image as perception). Safe to re-run: use IF NOT EXISTS patterns via ensureAuthSchema for runtime; this file is for fresh volumes.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS ai_generation_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  prompt_hash TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  system_fingerprint TEXT,
  response_text TEXT NOT NULL,
  model TEXT NOT NULL,
  mode TEXT NOT NULL,
  provider TEXT NOT NULL,
  source TEXT,
  embedding vector(1536),
  input_tokens INT,
  output_tokens INT,
  latency_ms INT,
  cached BOOLEAN NOT NULL DEFAULT false,
  cache_hit_type TEXT,
  org_id TEXT,
  user_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS ai_gen_log_created_brin
  ON ai_generation_log USING brin (created_at)
  WITH (pages_per_range = 32);

CREATE INDEX IF NOT EXISTS ai_gen_log_embedding_hnsw
  ON ai_generation_log USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS ai_gen_log_prompt_hash_idx ON ai_generation_log (prompt_hash);
CREATE INDEX IF NOT EXISTS ai_gen_log_model_idx ON ai_generation_log (model);
CREATE INDEX IF NOT EXISTS ai_gen_log_source_idx ON ai_generation_log (source);

CREATE INDEX IF NOT EXISTS ai_gen_log_metadata_gin ON ai_generation_log USING gin (metadata);

COMMENT ON TABLE ai_generation_log IS
  'LLM completions from pc-agent: exact + semantic cache source, analytics, pgvector similarity search.';
