/**
 * Postgres persistence for AI generations: analytics + semantic cache source rows.
 */

import { getPool, usesSqliteBackend, perceptionDbConfigured } from './perceptionDb.js';

const EXPECTED_DIM = Number(process.env.OPENCLAW_EMBEDDING_DIM || 1536);

function requirePool() {
  if (usesSqliteBackend() || !perceptionDbConfigured()) return null;
  return getPool();
}

function toVectorLiteral(arr) {
  if (!Array.isArray(arr) || arr.length !== EXPECTED_DIM) {
    throw new Error(`embedding must be a length-${EXPECTED_DIM} number array`);
  }
  return `[${arr.map((n) => Number(n)).join(',')}]`;
}

/**
 * @param {object} row
 * @param {string} row.promptHash
 * @param {string} row.promptText
 * @param {string} [row.systemFingerprint]
 * @param {string} row.responseText
 * @param {string} row.model
 * @param {string} row.mode
 * @param {string} row.provider
 * @param {string} [row.source]
 * @param {number[]|null} [row.embedding]
 * @param {number|null} [row.inputTokens]
 * @param {number|null} [row.outputTokens]
 * @param {number|null} [row.latencyMs]
 * @param {boolean} [row.cached]
 * @param {string|null} [row.cacheHitType]
 * @param {string|null} [row.orgId]
 * @param {string|null} [row.userId]
 * @param {string} [row.cacheModelKey]
 * @param {Record<string, unknown>} [row.extraMetadata]
 */
export async function insertGenerationLog(row) {
  const p = requirePool();
  if (!p) return null;

  const meta = {
    ...(row.extraMetadata && typeof row.extraMetadata === 'object' ? row.extraMetadata : {}),
  };
  if (row.cacheModelKey) meta.cacheModelKey = String(row.cacheModelKey);

  const emb = row.embedding;
  let vecSql = null;
  if (emb != null && Array.isArray(emb) && emb.length === EXPECTED_DIM) {
    vecSql = toVectorLiteral(emb);
  }

  const r = await p.query(
    `INSERT INTO ai_generation_log (
      prompt_hash, prompt_text, system_fingerprint, response_text, model, mode, provider, source,
      embedding, input_tokens, output_tokens, latency_ms, cached, cache_hit_type, org_id, user_id, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, $10, $11, $12, $13, $14, $15, $16, $17::jsonb)
    RETURNING id, created_at`,
    [
      row.promptHash,
      row.promptText,
      row.systemFingerprint ?? null,
      row.responseText,
      row.model,
      row.mode,
      row.provider,
      row.source ?? null,
      vecSql,
      row.inputTokens ?? null,
      row.outputTokens ?? null,
      row.latencyMs ?? null,
      Boolean(row.cached),
      row.cacheHitType ?? null,
      row.orgId ?? null,
      row.userId ?? null,
      meta,
    ],
  );
  return r.rows[0] || null;
}

/**
 * @param {number[]} embedding
 * @param {{ cacheModelKey: string, threshold: number, maxAgeDays?: number, log?: import('pino').Logger }} opts
 * @returns {Promise<{ responseText: string, model: string, mode: string, provider: string, similarity: number } | null>}
 */
export async function searchSimilarGeneration(embedding, opts) {
  const p = requirePool();
  if (!p || !embedding?.length) return null;

  const maxAgeDays = Math.max(1, Math.min(365, Number(opts.maxAgeDays) || 7));
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : 0.95;
  const cacheModelKey = String(opts.cacheModelKey || '');

  try {
    const vec = toVectorLiteral(embedding);
    const r = await p.query(
      `SELECT response_text, model, mode, provider,
              1 - (embedding <=> $1::vector) AS cosine_similarity
       FROM ai_generation_log
       WHERE embedding IS NOT NULL
         AND metadata->>'cacheModelKey' = $2
         AND created_at > NOW() - ($3::int * INTERVAL '1 day')
       ORDER BY embedding <=> $1::vector
       LIMIT 3`,
      [vec, cacheModelKey, maxAgeDays],
    );

    for (const row of r.rows) {
      const sim = Number(row.cosine_similarity);
      if (!Number.isNaN(sim) && sim >= threshold) {
        opts.log?.info({ via: 'ai_cache_semantic', similarity: sim }, 'ai cache hit (semantic)');
        return {
          responseText: String(row.response_text || ''),
          model: String(row.model || ''),
          mode: String(row.mode || ''),
          provider: String(row.provider || ''),
          similarity: sim,
        };
      }
    }
    return null;
  } catch (e) {
    opts.log?.warn({ err: String(e?.message || e).slice(0, 200) }, 'searchSimilarGeneration failed');
    return null;
  }
}

/**
 * @param {string} promptHash
 * @param {{ log?: import('pino').Logger }} [_opts]
 */
export async function findRecentByPromptHash(promptHash, _opts) {
  const p = requirePool();
  if (!p) return null;
  try {
    const r = await p.query(
      `SELECT response_text, model, mode, provider, created_at
       FROM ai_generation_log
       WHERE prompt_hash = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [promptHash],
    );
    return r.rows[0] || null;
  } catch {
    return null;
  }
}

/**
 * @param {number} limit
 * @param {{ log?: import('pino').Logger }} [_opts]
 */
export async function listRecentGenerations(limit = 50, _opts) {
  const p = requirePool();
  if (!p) return [];
  const lim = Math.min(500, Math.max(1, limit));
  try {
    const r = await p.query(
      `SELECT id, created_at, LEFT(prompt_text, 200) AS prompt_preview, LEFT(response_text, 200) AS response_preview,
              model, mode, provider, source, cached, cache_hit_type, latency_ms
       FROM ai_generation_log
       ORDER BY created_at DESC
       LIMIT $1`,
      [lim],
    );
    return r.rows;
  } catch {
    return [];
  }
}

/**
 * Token stats for a time window (BRIN-friendly range on created_at).
 * @param {Date} since
 */
export async function aggregateGenerationStatsSince(since) {
  const p = requirePool();
  if (!p) return null;
  try {
    const r = await p.query(
      `SELECT
         COUNT(*)::int AS n,
         COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
         COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
         COALESCE(SUM(latency_ms), 0)::bigint AS latency_ms_sum
       FROM ai_generation_log
       WHERE created_at >= $1`,
      [since],
    );
    return r.rows[0] || null;
  } catch {
    return null;
  }
}

export function isGenerationLogConfigured() {
  return Boolean(requirePool());
}
