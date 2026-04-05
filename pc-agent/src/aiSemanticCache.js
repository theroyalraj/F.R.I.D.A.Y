/**
 * Semantic cache: embed prompt (+ system) and nearest-neighbour match on ai_generation_log.
 */

import crypto from 'node:crypto';
import { createClient } from 'redis';
import { normalizeOpenRouterApiKey } from './openRouterApi.js';
import { searchSimilarGeneration } from './aiGenerationDb.js';
import { isAiCacheMasterEnabled } from './aiCache.js';
import { getExpectedEmbeddingDim } from './perceptionDb.js';

const EMBED_KEY_PREFIX = 'openclaw:ai_embed:';
const MAX_EMBED_INPUT = 8000;

let _client = null;

function _redisUrl() {
  return (process.env.OPENCLAW_REDIS_URL || '').trim() || 'redis://127.0.0.1:6379';
}

async function _getRedis() {
  if (_client?.isOpen) return _client;
  const c = createClient({
    url: _redisUrl(),
    socket: {
      connectTimeout: 1500,
      reconnectStrategy: false,
    },
  });
  c.on('error', () => {});
  try {
    await c.connect();
    _client = c;
    return _client;
  } catch {
    try {
      await c.quit();
    } catch {
      /* ignore */
    }
    return null;
  }
}

/** @returns {boolean} */
export function isSemanticCacheEnabled() {
  if (!isAiCacheMasterEnabled()) return false;
  const v = (process.env.AI_CACHE_SEMANTIC_ENABLED ?? 'true').toString().trim().toLowerCase();
  return !['false', '0', 'off', 'no'].includes(v);
}

export function semanticThreshold() {
  const t = parseFloat(process.env.AI_CACHE_SEMANTIC_THRESHOLD || '0.95');
  if (Number.isNaN(t)) return 0.95;
  return Math.min(0.999, Math.max(0.5, t));
}

export function embeddingProvider() {
  return (process.env.AI_CACHE_EMBEDDING_PROVIDER || 'openai').toLowerCase().trim();
}

export function semanticMaxAgeDays() {
  const n = parseInt(process.env.AI_CACHE_SEMANTIC_MAX_AGE_DAYS || '7', 10);
  return Number.isNaN(n) ? 7 : Math.min(365, Math.max(1, n));
}

function embedCacheTtlSec() {
  const n = parseInt(process.env.AI_CACHE_EMBED_TTL_SEC || '300', 10);
  return Number.isNaN(n) || n < 30 ? 300 : Math.min(n, 3600);
}

function truncateEmbedInput(text) {
  const s = String(text || '');
  if (s.length <= MAX_EMBED_INPUT) return s;
  return s.slice(0, MAX_EMBED_INPUT);
}

/**
 * OpenAI text-embedding-3-small (1536 dimensions by default).
 * @param {string} text
 * @param {import('pino').Logger} [log]
 * @returns {Promise<number[]|null>}
 */
async function embedOpenAi(text, log) {
  const key = (process.env.OPENAI_API_KEY || '').trim();
  if (!key) return null;
  const model = (process.env.AI_CACHE_OPENAI_EMBED_MODEL || 'text-embedding-3-small').trim();
  const t0 = Date.now();
  try {
    const resp = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: text,
        ...(/text-embedding-3/i.test(model)
          ? { dimensions: Number(process.env.OPENCLAW_EMBEDDING_DIM || 1536) }
          : {}),
      }),
    });
    const raw = await resp.text().catch(() => '');
    if (!resp.ok) {
      log?.warn({ status: resp.status, snippet: raw.slice(0, 200) }, 'OpenAI embeddings failed');
      return null;
    }
    const data = JSON.parse(raw);
    const arr = data?.data?.[0]?.embedding;
    if (!Array.isArray(arr)) return null;
    log?.debug({ ms: Date.now() - t0, dims: arr.length }, 'OpenAI embeddings ok');
    return arr.map((n) => Number(n));
  } catch (e) {
    log?.warn({ err: String(e?.message || e).slice(0, 200) }, 'OpenAI embeddings error');
    return null;
  }
}

/**
 * OpenRouter OpenAI-compatible embeddings (works with OpenRouter key).

 * @param {string} text
 * @param {import('pino').Logger} [log]
 * @returns {Promise<number[]|null>}
 */
async function embedOpenRouter(text, log) {
  const key = normalizeOpenRouterApiKey();
  if (!key) return null;
  const model =
    (process.env.AI_CACHE_OPENROUTER_EMBED_MODEL || 'openai/text-embedding-3-small').trim();
  const t0 = Date.now();
  try {
    const resp = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...(process.env.OPENROUTER_HTTP_REFERER?.trim()
          ? { 'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER.trim() }
          : {}),
        ...(process.env.OPENROUTER_APP_NAME?.trim()
          ? { 'X-Title': process.env.OPENROUTER_APP_NAME.trim() }
          : { 'X-Title': 'OpenClaw Friday' }),
      },
      body: JSON.stringify({ model, input: text }),
    });
    const raw = await resp.text().catch(() => '');
    if (!resp.ok) {
      log?.warn({ status: resp.status, snippet: raw.slice(0, 200) }, 'OpenRouter embeddings failed');
      return null;
    }
    const data = JSON.parse(raw);
    const arr = data?.data?.[0]?.embedding;
    if (!Array.isArray(arr)) return null;
    log?.debug({ ms: Date.now() - t0, dims: arr.length }, 'OpenRouter embeddings ok');
    return arr.map((n) => Number(n));
  } catch (e) {
    log?.warn({ err: String(e?.message || e).slice(0, 200) }, 'OpenRouter embeddings error');
    return null;
  }
}

/**
 * Provider "anthropic" in .env: OpenClaw has no first-party Anthropic embeddings in this stack;
 * use OpenRouter embeddings first, then OpenAI if configured.
 * @param {string} text
 * @param {import('pino').Logger} [log]
 * @returns {Promise<number[]|null>}
 */
async function embedByProvider(text, log) {
  const p = embeddingProvider();
  if (p === 'openai') {
    let v = await embedOpenAi(text, log);
    if (!v) v = await embedOpenRouter(text, log);
    return v;
  }
  /* anthropic | openrouter — prefer OpenRouter, then OpenAI */
  let v = await embedOpenRouter(text, log);
  if (!v) v = await embedOpenAi(text, log);
  return v;
}

/**
 * @param {string} text full string to embed (already truncated upstream if needed)
 * @param {import('pino').Logger} [log]
 * @returns {Promise<number[]|null>}
 */
export async function generateEmbedding(text, log) {
  const input = truncateEmbedInput(text);
  if (!input.trim()) return null;

  const hash = crypto.createHash('sha256').update(input, 'utf8').digest('hex');
  const rkey = `${EMBED_KEY_PREFIX}${hash}`;

  const redis = await _getRedis();
  if (redis) {
    try {
      const cached = await redis.get(rkey);
      if (cached) {
        const arr = JSON.parse(cached);
        if (Array.isArray(arr) && arr.length > 0) return arr.map((n) => Number(n));
      }
    } catch {
      /* ignore */
    }
  }

  const vec = await embedByProvider(input, log);
  if (!vec?.length) return null;

  const dim = getExpectedEmbeddingDim();
  if (vec.length !== dim) {
    log?.warn({ got: vec.length, want: dim }, 'embedding dimension mismatch — fix model or OPENCLAW_EMBEDDING_DIM');
    return null;
  }

  if (redis && vec.length) {
    try {
      await redis.set(rkey, JSON.stringify(vec), { EX: embedCacheTtlSec() });
    } catch {
      /* ignore */
    }
  }

  return vec;
}

/**
 * Build text for embedding (system + user prompt) so different instructions don't collide.
 * @param {string} system
 * @param {string} prompt
 */
export function buildEmbeddingInput(system, prompt) {
  return truncateEmbedInput(`${String(system || '')}\n\n${String(prompt || '')}`);
}

/**
 * @param {{ system: string, prompt: string, cacheModelKey: string, log?: import('pino').Logger }} args
 * @returns {Promise<{ text: string, model: string, mode: string, provider: string, similarity: number } | null>}
 */
export async function trySemanticCachedResponse(args) {
  if (!isSemanticCacheEnabled()) return null;
  const cacheModelKey = String(args.cacheModelKey || '').trim();
  if (!cacheModelKey) return null;

  const embedText = buildEmbeddingInput(args.system, args.prompt);
  const emb = await generateEmbedding(embedText, args.log);
  if (!emb) return null;

  const hit = await searchSimilarGeneration(emb, {
    cacheModelKey,
    threshold: semanticThreshold(),
    maxAgeDays: semanticMaxAgeDays(),
    log: args.log,
  });
  if (!hit || !(hit.responseText || '').trim()) return null;

  return {
    text: hit.responseText.trim(),
    model: hit.model,
    mode: hit.mode,
    provider: hit.provider,
    similarity: hit.similarity,
  };
}
