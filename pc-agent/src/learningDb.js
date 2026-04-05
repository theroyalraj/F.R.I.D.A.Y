import { getPool, usesSqliteBackend, perceptionDbConfigured } from './perceptionDb.js';
import {
  learningMaxAgeDays,
  learningMinSimilarity,
  learningNeighbourPool,
  learningFeedbackScoreWeight,
} from './learningEnv.js';

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
 * @param {{ generationId: string, score: number, label?: string, comment?: string|null, metadata?: Record<string, unknown>, log?: import('pino').Logger }} args
 * @returns {Promise<{ ok: boolean, id?: string, error?: string }>}
 */
export async function insertLearningFeedback(args) {
  const p = requirePool();
  if (!p) return { ok: false, error: 'database not configured' };
  const gid = String(args.generationId || '').trim();
  if (!gid) return { ok: false, error: 'missing generationLogId' };
  const score = Number(args.score);
  if (!Number.isFinite(score)) return { ok: false, error: 'invalid score' };
  const label = String(args.label || 'manual').slice(0, 120);
  const comment = args.comment != null ? String(args.comment).slice(0, 4000) : null;
  const meta =
    args.metadata && typeof args.metadata === 'object' ? JSON.stringify(args.metadata) : '{}';

  try {
    const chk = await p.query('SELECT 1 FROM ai_generation_log WHERE id = $1::uuid LIMIT 1', [gid]);
    if (!chk.rowCount) return { ok: false, error: 'generation not found' };

    const r = await p.query(
      `INSERT INTO learning_feedback (generation_id, score, label, comment, metadata)
       VALUES ($1::uuid, $2, $3, $4, $5::jsonb)
       RETURNING id::text AS id`,
      [gid, score, label, comment, meta],
    );
    return { ok: true, id: r.rows[0]?.id };
  } catch (e) {
    args.log?.warn({ err: String(e?.message || e).slice(0, 200) }, 'insertLearningFeedback failed');
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

/**
 * @param {number[]} embedding
 * @param {{ log?: import('pino').Logger }} [_opts]
 * @returns {Promise<Array<{ id: string, prompt_text: string, response_text: string, sim: number, avg_score: number }>>}
 */
export async function searchWeightedSimilarGenerations(embedding, _opts = {}) {
  const p = requirePool();
  if (!p || !embedding?.length) return [];
  const maxAge = learningMaxAgeDays();
  const minSim = learningMinSimilarity();
  const poolN = learningNeighbourPool();
  const w = learningFeedbackScoreWeight();

  try {
    const vec = toVectorLiteral(embedding);
    const r = await p.query(
      `SELECT ranked.id::text AS id, ranked.prompt_text, ranked.response_text, ranked.sim, ranked.avg_score
       FROM (
         SELECT g.id,
                g.prompt_text,
                g.response_text,
                (1 - (g.embedding <=> $1::vector))::float AS sim,
                COALESCE((
                  SELECT AVG(f.score)::float FROM learning_feedback f WHERE f.generation_id = g.id
                ), 0)::float AS avg_score
         FROM ai_generation_log g
         WHERE g.embedding IS NOT NULL
           AND g.created_at > NOW() - ($2::int * INTERVAL '1 day')
         ORDER BY g.embedding <=> $1::vector
         LIMIT $3
       ) ranked
       WHERE ranked.sim >= $4::float
       ORDER BY (ranked.sim * (1 + $5::float * GREATEST(-1::float, LEAST(1::float, ranked.avg_score)))) DESC
       LIMIT 6`,
      [vec, maxAge, poolN, minSim, w],
    );
    return (r.rows || []).map((row) => ({
      id: String(row.id),
      prompt_text: String(row.prompt_text || ''),
      response_text: String(row.response_text || ''),
      sim: Number(row.sim),
      avg_score: Number(row.avg_score),
    }));
  } catch (e) {
    _opts.log?.warn({ err: String(e?.message || e).slice(0, 200) }, 'searchWeightedSimilarGenerations failed');
    return [];
  }
}

/**
 * @param {string} id
 * @param {{ log?: import('pino').Logger }} [_opts]
 */
export async function getGenerationRowRedacted(id, _opts = {}) {
  const p = requirePool();
  if (!p) return null;
  const gid = String(id || '').trim();
  if (!gid) return null;
  try {
    const r = await p.query(
      `SELECT id::text AS id, created_at, LEFT(prompt_text, 800) AS prompt_preview,
              LEFT(response_text, 800) AS response_preview, model, mode, provider, source,
              metadata
       FROM ai_generation_log WHERE id = $1::uuid LIMIT 1`,
      [gid],
    );
    const row = r.rows[0];
    if (!row) return null;
    const meta = row.metadata;
    let metadataPreview = null;
    if (meta && typeof meta === 'object') {
      metadataPreview = {
        conversationSessionId: meta.conversationSessionId ?? null,
        correlationId: meta.correlationId ?? null,
        tailDigest: meta.tailDigest ?? null,
      };
    }
    const { metadata: _drop, ...rest } = row;
    return { ...rest, metadataPreview };
  } catch {
    return null;
  }
}
