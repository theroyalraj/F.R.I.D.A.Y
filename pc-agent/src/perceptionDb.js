import crypto from 'node:crypto';
import pg from 'pg';
import {
  sqliteBackendConfigured,
  sqliteDbHealth,
  sqliteInsertPerceptionCapture,
  sqliteSearchPerceptionByVector,
  sqliteListRecentCaptures,
} from './perceptionSqlite.js';

const EXPECTED_DIM = Number(process.env.OPENCLAW_EMBEDDING_DIM || 1536);

let pool = null;

export function usesSqliteBackend() {
  return sqliteBackendConfigured();
}

export function perceptionDbConfigured() {
  if (sqliteBackendConfigured()) return true;
  const u = (process.env.OPENCLAW_DATABASE_URL || '').trim();
  return Boolean(u);
}

export function getExpectedEmbeddingDim() {
  return EXPECTED_DIM;
}

export function getPool() {
  if (sqliteBackendConfigured()) return null;
  if (!perceptionDbConfigured()) return null;
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.OPENCLAW_DATABASE_URL.trim(),
      max: 8,
      idleTimeoutMillis: 30_000,
    });
  }
  return pool;
}

export async function perceptionDbHealth() {
  if (sqliteBackendConfigured()) return sqliteDbHealth();
  const p = getPool();
  if (!p) return { ok: false, reason: 'OPENCLAW_DATABASE_URL not set' };
  try {
    const r = await p.query('SELECT 1 AS ok');
    return { ok: r.rows[0]?.ok === 1, backend: 'postgres' };
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  }
}

function toVectorLiteral(arr) {
  if (!Array.isArray(arr) || arr.length !== EXPECTED_DIM) {
    throw new Error(`embedding must be a length-${EXPECTED_DIM} number array`);
  }
  return `[${arr.map((n) => Number(n)).join(',')}]`;
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * @param {object} row
 */
export async function insertPerceptionCapture(row) {
  if (sqliteBackendConfigured()) return sqliteInsertPerceptionCapture(row);

  const p = getPool();
  if (!p) throw new Error('Database not configured');

  const {
    sourceType,
    rawText = null,
    descriptionText = null,
    embedding = null,
    metadata = {},
    imageMime = null,
    imageBytes = null,
    mediaPath = null,
    redisCacheKey = null,
  } = row;

  if (!sourceType || typeof sourceType !== 'string') {
    throw new Error('sourceType is required');
  }

  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  const hash =
    imageBytes && Buffer.isBuffer(imageBytes) && imageBytes.length ? sha256Hex(imageBytes) : null;

  if (embedding != null && Array.isArray(embedding) && embedding.length > 0) {
    const vec = toVectorLiteral(embedding);
    const r = await p.query(
      `INSERT INTO perception_capture (
        source_type, raw_text, description_text, embedding, metadata,
        image_mime, image_sha256, image_bytes, media_path, redis_cache_key
      ) VALUES ($1, $2, $3, $4::vector, $5::jsonb, $6, $7, $8, $9, $10)
      RETURNING id, captured_at`,
      [
        sourceType,
        rawText,
        descriptionText,
        vec,
        meta,
        imageMime,
        hash,
        imageBytes ?? null,
        mediaPath,
        redisCacheKey,
      ],
    );
    return r.rows[0];
  }

  const r2 = await p.query(
    `INSERT INTO perception_capture (
      source_type, raw_text, description_text, embedding, metadata,
      image_mime, image_sha256, image_bytes, media_path, redis_cache_key
    ) VALUES ($1, $2, $3, NULL, $4::jsonb, $5, $6, $7, $8, $9)
    RETURNING id, captured_at`,
    [
      sourceType,
      rawText,
      descriptionText,
      meta,
      imageMime,
      hash,
      imageBytes ?? null,
      mediaPath,
      redisCacheKey,
    ],
  );
  return r2.rows[0];
}

/** @param {number[]} embedding */
export async function searchPerceptionByVector(embedding, limit = 10) {
  if (sqliteBackendConfigured()) return sqliteSearchPerceptionByVector(embedding, limit);

  const p = getPool();
  if (!p) throw new Error('Database not configured');
  const vec = toVectorLiteral(embedding);
  const r = await p.query(
    `SELECT id, source_type, captured_at, raw_text, description_text, metadata, media_path,
            1 - (embedding <=> $1::vector) AS cosine_similarity
     FROM perception_capture
     WHERE embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [vec, Math.min(100, Math.max(1, limit))],
  );
  return r.rows;
}

export async function listRecentCaptures(limit = 20) {
  if (sqliteBackendConfigured()) return sqliteListRecentCaptures(limit);

  const p = getPool();
  if (!p) throw new Error('Database not configured');
  const r = await p.query(
    `SELECT id, source_type, captured_at,
            LEFT(COALESCE(description_text, raw_text, ''), 200) AS preview,
            metadata, media_path, image_sha256,
            (image_bytes IS NOT NULL) AS has_image_bytes
     FROM perception_capture
     ORDER BY captured_at DESC
     LIMIT $1`,
    [Math.min(100, Math.max(1, limit))],
  );
  return r.rows;
}
