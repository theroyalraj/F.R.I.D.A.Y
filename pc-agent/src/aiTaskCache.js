/**
 * Orchestration: exact Redis → semantic pgvector → persist to Postgres + Redis.
 */

import {
  fingerprintSystem,
  aiCacheGet,
  aiCacheSet,
  aiCacheHashKey,
  isAiCacheMasterEnabled,
  isSourceBypassed,
} from './aiCache.js';
import {
  trySemanticCachedResponse,
  generateEmbedding,
  buildEmbeddingInput,
} from './aiSemanticCache.js';
import { insertGenerationLog } from './aiGenerationDb.js';

/** @returns {boolean} */
export function isAiGenerationLogEnabled() {
  const v = (process.env.AI_CACHE_LOG_ENABLED ?? 'true').toString().trim().toLowerCase();
  return !['false', '0', 'off', 'no'].includes(v);
}

/**
 * @param {object} body
 * @param {string} src normalized source
 * @returns {boolean}
 */
export function shouldBypassAiCache(body, src) {
  if (!isAiCacheMasterEnabled()) return true;
  if (!body || typeof body !== 'object') return false;
  if (body.noCache === true || body.no_cache === true) return true;
  return isSourceBypassed(src);
}

/**
 * @param {{ prompt: string, system: string, modelKey: string, source: string, body: object, log?: import('pino').Logger }} args
 * @returns {Promise<{ summary: string, mode: string, model: string, provider?: string, fromCache: 'exact' | 'semantic' } | null>}
 */
export async function tryReadAiCaches(args) {
  if (shouldBypassAiCache(args.body, args.source)) return null;

  const systemFp = fingerprintSystem(args.system);
  const exact = await aiCacheGet({
    modelKey: args.modelKey,
    systemFingerprint: systemFp,
    prompt: args.prompt,
    log: args.log,
  });
  if (exact.ok) {
    return {
      summary: exact.text,
      mode: exact.mode,
      model: exact.model,
      fromCache: 'exact',
    };
  }

  const sem = await trySemanticCachedResponse({
    system: args.system,
    prompt: args.prompt,
    cacheModelKey: args.modelKey,
    log: args.log,
  });
  if (sem) {
    return {
      summary: sem.text,
      mode: sem.mode,
      model: sem.model,
      provider: sem.provider,
      fromCache: 'semantic',
    };
  }

  return null;
}

/**
 * @param {{ prompt: string, system: string, modelKey: string, responseText: string, model: string, mode: string, provider: string, source: string, latencyMs?: number, orgId?: string|null, userId?: string|null, log?: import('pino').Logger, cacheHitType?: 'exact'|'semantic'|null, skipExactRedis?: boolean }} args
 */
export async function persistAiGeneration(args) {
  const text = String(args.responseText || '').trim();
  if (!text) return;

  const systemFp = fingerprintSystem(args.system);
  const promptHash = aiCacheHashKey(args.modelKey, systemFp, args.prompt);

  const isFresh = !args.cacheHitType;
  if (isFresh && !args.skipExactRedis) {
    await aiCacheSet({
      modelKey: args.modelKey,
      systemFingerprint: systemFp,
      prompt: args.prompt,
      text,
      model: args.model,
      mode: args.mode,
      log: args.log,
    });
  } else if (args.cacheHitType === 'semantic' && !args.skipExactRedis) {
    await aiCacheSet({
      modelKey: args.modelKey,
      systemFingerprint: systemFp,
      prompt: args.prompt,
      text,
      model: args.model,
      mode: args.mode,
      log: args.log,
    });
  }

  if (!isAiGenerationLogEnabled()) return;

  let embedding = null;
  if (isFresh) {
    try {
      embedding = await generateEmbedding(buildEmbeddingInput(args.system, args.prompt), args.log);
    } catch {
      embedding = null;
    }
  }

  try {
    await insertGenerationLog({
      promptHash,
      promptText: args.prompt,
      systemFingerprint: systemFp,
      responseText: text,
      model: args.model,
      mode: args.mode,
      provider: args.provider,
      source: args.source || null,
      embedding,
      latencyMs: args.latencyMs ?? null,
      cached: Boolean(args.cacheHitType),
      cacheHitType: args.cacheHitType ?? null,
      orgId: args.orgId ?? null,
      userId: args.userId ?? null,
      cacheModelKey: args.modelKey,
    });
  } catch (e) {
    args.log?.warn({ err: String(e?.message || e).slice(0, 200) }, 'persistAiGeneration: insert failed');
  }
}

export { aiCacheHashKey, fingerprintSystem };
