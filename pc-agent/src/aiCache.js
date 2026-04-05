/**
 * Redis exact-match cache for LLM completions (prompt + system fingerprint + model key).
 * Key: openclaw:ai_cache:<sha256>
 */

import crypto from 'node:crypto';
import { createClient } from 'redis';

const KEY_PREFIX = 'openclaw:ai_cache:';

let _client = null;

function _redisUrl() {
  return (process.env.OPENCLAW_REDIS_URL || '').trim() || 'redis://127.0.0.1:6379';
}

async function _getClient() {
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
export function isAiCacheMasterEnabled() {
  const v = (process.env.AI_CACHE_ENABLED ?? 'true').toString().trim().toLowerCase();
  return !['false', '0', 'off', 'no'].includes(v);
}

/** @returns {Set<string>} */
function bypassSourcesSet() {
  const raw = (process.env.AI_CACHE_BYPASS_SOURCES || '').trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * @param {string} [source]
 * @returns {boolean}
 */
export function isSourceBypassed(source) {
  const s = String(source || '').toLowerCase().trim();
  if (!s) return false;
  return bypassSourcesSet().has(s);
}

/**
 * @param {string} modelKey
 * @param {string} systemFingerprint sha256 hex of system prompt
 * @param {string} prompt
 * @returns {string}
 */
export function aiCacheHashKey(modelKey, systemFingerprint, prompt) {
  const payload = `${modelKey}|${systemFingerprint}|${String(prompt)}`;
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function redisCacheKeyForAi(modelKey, systemFingerprint, prompt) {
  return `${KEY_PREFIX}${aiCacheHashKey(modelKey, systemFingerprint, prompt)}`;
}

function cacheTtlSec() {
  const n = parseInt(process.env.AI_CACHE_TTL_SEC || '3600', 10);
  return Number.isNaN(n) || n < 60 ? 3600 : Math.min(n, 86400 * 7);
}

/**
 * @param {{ modelKey: string, systemFingerprint: string, prompt: string, log?: import('pino').Logger }} args
 * @returns {Promise<{ ok: true, text: string, model: string, mode: string } | { ok: false }>}
 */
export async function aiCacheGet(args) {
  if (!isAiCacheMasterEnabled()) return { ok: false };
  const c = await _getClient();
  if (!c) return { ok: false };

  const key = redisCacheKeyForAi(args.modelKey, args.systemFingerprint, args.prompt);
  try {
    const raw = await c.get(key);
    if (!raw) return { ok: false };
    const j = JSON.parse(raw);
    const text = typeof j?.text === 'string' ? j.text : '';
    if (!text.trim()) return { ok: false };
    args.log?.info({ via: 'ai_cache_exact', chars: text.length }, 'ai cache hit (exact)');
    return {
      ok: true,
      text,
      model: String(j?.model || ''),
      mode: String(j?.mode || 'api'),
    };
  } catch {
    return { ok: false };
  }
}

/**
 * @param {{ modelKey: string, systemFingerprint: string, prompt: string, text: string, model: string, mode: string, log?: import('pino').Logger }} args
 */
export async function aiCacheSet(args) {
  if (!isAiCacheMasterEnabled()) return;
  const text = String(args.text || '').trim();
  if (!text) return;

  const c = await _getClient();
  if (!c) return;

  const key = redisCacheKeyForAi(args.modelKey, args.systemFingerprint, args.prompt);
  const ttl = cacheTtlSec();
  const payload = JSON.stringify({
    text,
    model: args.model,
    mode: args.mode,
    cachedAt: Date.now(),
    expiresAt: Date.now() + ttl * 1000,
  });

  try {
    await c.set(key, payload, { EX: ttl });
    args.log?.debug({ via: 'ai_cache_exact', ttl }, 'ai cache set (exact)');
  } catch {
    /* ignore */
  }
}

/**
 * Fingerprint full system string for cache keys (stable hash).
 * @param {string} system
 * @returns {string}
 */
export function fingerprintSystem(system) {
  return crypto.createHash('sha256').update(String(system || ''), 'utf8').digest('hex');
}
