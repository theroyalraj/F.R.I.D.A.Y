-- OpenClaw perception store: screen / camera captures, raw text, vision descriptions, embeddings.
-- Requires pgvector image (see docker-compose openclaw-postgres).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE perception_capture (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_text TEXT,
  description_text TEXT,
  embedding vector(1536),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  image_mime TEXT,
  image_sha256 TEXT,
  image_bytes BYTEA,
  media_path TEXT,
  redis_cache_key TEXT,
  CONSTRAINT perception_capture_source_check CHECK (
    source_type IN ('screen', 'camera', 'screen_vision', 'multimodal')
  )
);

CREATE INDEX perception_capture_captured_at_idx ON perception_capture (captured_at DESC);
CREATE INDEX perception_capture_source_time_idx ON perception_capture (source_type, captured_at DESC);
CREATE INDEX perception_capture_metadata_gin ON perception_capture USING gin (metadata);

-- Approximate nearest neighbour (cosine). Build after you have rows, or empty table is fine on pgvector 0.5+.
CREATE INDEX perception_capture_embedding_hnsw ON perception_capture
  USING hnsw (embedding vector_cosine_ops);

COMMENT ON TABLE perception_capture IS
  'Screen/camera observations: raw_text (OCR/transcript), description_text (vision model), embedding for RAG, optional image bytes or media_path on disk.';
