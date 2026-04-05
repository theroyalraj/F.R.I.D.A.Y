/**
 * openRouterModelPool.js — Redis-backed pool of OpenRouter free models with health tracking.
 *
 * Tracks which models work, cooldowns for 429/404, and auto-refreshes from the
 * OpenRouter /models API. When all free models are exhausted, signals the caller
 * to fall back to Claude Opus via Anthropic.
 *
 * Redis keys (all under openclaw:or_pool:*):
 *   openclaw:or_pool:models         — JSON array of { slug, ok, failCount, lastOk, lastFail, cooldownUntil }
 *   openclaw:or_pool:last_good      — slug of most recently successful model
 *   openclaw:or_pool:refresh_ts     — epoch ms of last /models API refresh
 *
 * Env:
 *   OPENROUTER_FREE_MODELS           — comma-separated seed list (overrides built-in seeds)
 *   OPENROUTER_POOL_REFRESH_SEC      — how often to re-fetch /models (default 1800 = 30 min)
 *   OPENROUTER_POOL_COOLDOWN_429_SEC — per-model 429 cooldown (default 120)
 *   OPENROUTER_POOL_COOLDOWN_404_SEC — per-model 404 cooldown (default 3600)
 *   OPENROUTER_POOL_CLAUDE_FALLBACK  — true (default) to fall back to Claude Opus when pool is empty
 */

import { createClient } from 'redis';

const POOL_KEY = 'openclaw:or_pool:models';
const LAST_GOOD_KEY = 'openclaw:or_pool:last_good';
const REFRESH_TS_KEY = 'openclaw:or_pool:refresh_ts';

const COOLDOWN_429 = Math.max(30, Number(process.env.OPENROUTER_POOL_COOLDOWN_429_SEC) || 120);
const COOLDOWN_404 = Math.max(60, Number(process.env.OPENROUTER_POOL_COOLDOWN_404_SEC) || 3600);
const REFRESH_INTERVAL_MS =
  Math.max(60, Number(process.env.OPENROUTER_POOL_REFRESH_SEC) || 1800) * 1000;
const CLAUDE_FALLBACK_ENABLED =
  !['0', 'false', 'no', 'off'].includes(
    String(process.env.OPENROUTER_POOL_CLAUDE_FALLBACK || 'true').trim().toLowerCase(),
  );

/**
 * Seed list: `openrouter/free` meta-router first, then individual free model slugs.
 * The meta-router auto-picks from available free models on OpenRouter's side.
 */
const BUILT_IN_SEEDS = [
  'openrouter/free',
  'qwen/qwen3-235b-a22b:free',
  'nvidia/llama-3.1-nemotron-ultra-253b:free',
  'deepseek/deepseek-chat-v3-0324:free',
  'meta-llama/llama-4-maverick:free',
  'meta-llama/llama-4-scout:free',
  'google/gemma-3-27b-it:free',
  'mistralai/mistral-small-3.1-24b-instruct:free',
  'nvidia/llama-3.3-nemotron-super-49b-v1:free',
];

function _seedList() {
  const env = (process.env.OPENROUTER_FREE_MODELS || '').trim();
  if (env) {
    return env
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [...BUILT_IN_SEEDS];
}

function _redisUrl() {
  return (
    (process.env.OPENCLAW_REDIS_URL || '').trim() ||
    'redis://127.0.0.1:6379'
  );
}

let _client = null;

async function _getClient() {
  if (_client?.isOpen) return _client;
  const c = createClient({
    url: _redisUrl(),
    socket: { connectTimeout: 2000, reconnectStrategy: false },
  });
  c.on('error', () => {});
  try {
    await c.connect();
    _client = c;
    return _client;
  } catch {
    try { await c.quit(); } catch { /* */ }
    return null;
  }
}

/** @typedef {{ slug: string, ok: boolean, failCount: number, lastOk: number, lastFail: number, cooldownUntil: number }} PoolEntry */

/**
 * Load pool from Redis; if empty, seed it.
 * @returns {Promise<PoolEntry[]>}
 */
async function _loadPool() {
  const c = await _getClient();
  if (!c) return _seedToEntries(_seedList());
  try {
    const raw = await c.get(POOL_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length > 0) return arr;
    }
  } catch { /* */ }
  const entries = _seedToEntries(_seedList());
  await _savePool(entries);
  return entries;
}

/** @param {PoolEntry[]} entries */
async function _savePool(entries) {
  const c = await _getClient();
  if (!c) return;
  try {
    await c.set(POOL_KEY, JSON.stringify(entries));
  } catch { /* */ }
}

/** @param {string[]} slugs @returns {PoolEntry[]} */
function _seedToEntries(slugs) {
  return slugs.map((slug) => ({
    slug,
    ok: true,
    failCount: 0,
    lastOk: 0,
    lastFail: 0,
    cooldownUntil: 0,
  }));
}

/**
 * Get the next model to try. Priority:
 *   1. Last known good (if not in cooldown)
 *   2. Models sorted by: ok > !ok, lowest failCount, most recent lastOk
 *   3. null if all models are in cooldown → caller should fall back to Claude
 * @returns {Promise<string | null>}
 */
export async function getNextFreeModel() {
  const pool = await _loadPool();
  const now = Date.now();

  const c = await _getClient();
  let lastGood = null;
  if (c) {
    try {
      lastGood = await c.get(LAST_GOOD_KEY);
    } catch { /* */ }
  }

  if (lastGood) {
    const entry = pool.find((e) => e.slug === lastGood);
    if (entry && (entry.cooldownUntil <= now)) {
      return entry.slug;
    }
  }

  const available = pool
    .filter((e) => e.cooldownUntil <= now)
    .sort((a, b) => {
      if (a.ok !== b.ok) return a.ok ? -1 : 1;
      if (a.failCount !== b.failCount) return a.failCount - b.failCount;
      return b.lastOk - a.lastOk;
    });

  return available.length > 0 ? available[0].slug : null;
}

/**
 * Get ordered list of models to try (for cascade retry).
 * @param {number} [max=3] — max models to return
 * @returns {Promise<string[]>}
 */
export async function getModelCascade(max = 3) {
  const pool = await _loadPool();
  const now = Date.now();

  const c = await _getClient();
  let lastGood = null;
  if (c) {
    try { lastGood = await c.get(LAST_GOOD_KEY); } catch { /* */ }
  }

  const available = pool
    .filter((e) => e.cooldownUntil <= now)
    .sort((a, b) => {
      if (a.slug === lastGood) return -1;
      if (b.slug === lastGood) return 1;
      if (a.ok !== b.ok) return a.ok ? -1 : 1;
      if (a.failCount !== b.failCount) return a.failCount - b.failCount;
      return b.lastOk - a.lastOk;
    });

  return available.slice(0, max).map((e) => e.slug);
}

/**
 * Mark a model as working.
 * @param {string} slug
 */
export async function markModelOk(slug) {
  const pool = await _loadPool();
  const entry = pool.find((e) => e.slug === slug);
  if (entry) {
    entry.ok = true;
    entry.failCount = 0;
    entry.lastOk = Date.now();
    entry.cooldownUntil = 0;
  } else {
    pool.push({ slug, ok: true, failCount: 0, lastOk: Date.now(), lastFail: 0, cooldownUntil: 0 });
  }
  await _savePool(pool);

  const c = await _getClient();
  if (c) {
    try { await c.set(LAST_GOOD_KEY, slug); } catch { /* */ }
  }
}

/**
 * Mark a model as failed. Applies cooldown based on error type.
 * @param {string} slug
 * @param {number} httpStatus — 429 (rate limit) or 404 (retired) or other
 */
export async function markModelFailed(slug, httpStatus) {
  const pool = await _loadPool();
  const now = Date.now();
  let entry = pool.find((e) => e.slug === slug);
  if (!entry) {
    entry = { slug, ok: true, failCount: 0, lastOk: 0, lastFail: 0, cooldownUntil: 0 };
    pool.push(entry);
  }
  entry.failCount += 1;
  entry.lastFail = now;

  if (httpStatus === 404) {
    entry.ok = false;
    entry.cooldownUntil = now + COOLDOWN_404 * 1000;
  } else if (httpStatus === 429) {
    entry.cooldownUntil = now + COOLDOWN_429 * 1000;
    if (entry.failCount >= 3) entry.ok = false;
  } else {
    entry.cooldownUntil = now + Math.min(COOLDOWN_429, 60) * 1000;
    if (entry.failCount >= 5) entry.ok = false;
  }

  await _savePool(pool);
}

/**
 * Whether to fall back to Claude (Anthropic direct) when pool is empty.
 */
export function isClaudeFallbackEnabled() {
  return CLAUDE_FALLBACK_ENABLED;
}

/**
 * Refresh the model pool from the OpenRouter /models API.
 * Merges new free models into the existing pool (preserving health data).
 * @param {{ log?: import('pino').Logger, force?: boolean }} opts
 */
export async function refreshModelPool(opts = {}) {
  const c = await _getClient();
  if (!opts.force && c) {
    try {
      const ts = await c.get(REFRESH_TS_KEY);
      if (ts && Date.now() - Number(ts) < REFRESH_INTERVAL_MS) return;
    } catch { /* */ }
  }

  let apiModels = [];
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    const resp = await fetch('https://openrouter.ai/api/v1/models', {
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
    });
    clearTimeout(timer);
    if (resp.ok) {
      const json = await resp.json();
      const data = json?.data || json;
      if (Array.isArray(data)) {
        apiModels = data
          .filter((m) => {
            const p = m?.pricing || {};
            return (
              (p.prompt === '0' || p.prompt === 0) &&
              (p.completion === '0' || p.completion === 0)
            );
          })
          .map((m) => m.id)
          .filter(Boolean);
      }
    }
  } catch (e) {
    opts.log?.debug({ err: String(e?.message || e) }, 'openRouterModelPool: /models fetch failed');
  }

  if (apiModels.length === 0) {
    opts.log?.debug('openRouterModelPool: no free models from API, keeping seed list');
    if (c) {
      try { await c.set(REFRESH_TS_KEY, String(Date.now())); } catch { /* */ }
    }
    return;
  }

  const pool = await _loadPool();
  const existing = new Set(pool.map((e) => e.slug));

  let added = 0;
  for (const slug of apiModels) {
    if (!existing.has(slug)) {
      pool.push({ slug, ok: true, failCount: 0, lastOk: 0, lastFail: 0, cooldownUntil: 0 });
      added += 1;
    }
  }

  // Ensure openrouter/free meta-router is always first
  if (!existing.has('openrouter/free')) {
    pool.unshift({ slug: 'openrouter/free', ok: true, failCount: 0, lastOk: 0, lastFail: 0, cooldownUntil: 0 });
  }

  await _savePool(pool);
  if (c) {
    try { await c.set(REFRESH_TS_KEY, String(Date.now())); } catch { /* */ }
  }
  opts.log?.info(
    { totalPool: pool.length, addedFromApi: added, apiTotal: apiModels.length },
    'openRouterModelPool: refreshed from /models API',
  );
}

/**
 * Get a diagnostic snapshot of the pool state (for /voice/ping or admin).
 */
export async function getPoolSnapshot() {
  const pool = await _loadPool();
  const c = await _getClient();
  let lastGood = null;
  if (c) {
    try { lastGood = await c.get(LAST_GOOD_KEY); } catch { /* */ }
  }
  return { models: pool, lastGood, claudeFallback: CLAUDE_FALLBACK_ENABLED };
}
