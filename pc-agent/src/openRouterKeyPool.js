/**
 * openRouterKeyPool.js — Round-robin API key rotation for OpenRouter.
 *
 * Supports up to 3 API keys. On 429 from one key, the next key in the pool is
 * tried automatically. Per-key cooldowns are tracked in Redis so the hot key
 * isn't hit again until its cooldown expires.
 *
 * Key sources (merged, deduplicated):
 *   1. OPENROUTER_API_KEY           — single legacy key (always included)
 *   2. OPENROUTER_API_KEYS          — comma-separated list (up to 3)
 *
 * Redis keys:
 *   openclaw:or_keys:index                — current round-robin position (int)
 *   openclaw:or_keys:<short>:cooldown     — SET with TTL (key is cooling down)
 *
 * The <short> suffix is the last 8 chars of the normalised key (safe for logs).
 */

import { createClient } from 'redis';
import { normalizeOpenRouterApiKey } from './openRouterApi.js';

const MAX_KEYS = 3;
const KEY_INDEX_REDIS = 'openclaw:or_keys:index';
const KEY_COOLDOWN_PREFIX = 'openclaw:or_keys:';
const DEFAULT_COOLDOWN_SEC = Math.max(
  30,
  Number(process.env.OPENROUTER_KEY_COOLDOWN_SEC) || 90,
);

function _redisUrl() {
  return (process.env.OPENCLAW_REDIS_URL || '').trim() || 'redis://127.0.0.1:6379';
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

function _shortId(key) {
  return key.slice(-8);
}

/**
 * Build the deduplicated key pool from env. Always capped at MAX_KEYS.
 * @returns {string[]}
 */
export function loadKeyPool() {
  const seen = new Set();
  const pool = [];

  const legacy = normalizeOpenRouterApiKey(null);
  if (legacy) {
    seen.add(legacy);
    pool.push(legacy);
  }

  const multi = (process.env.OPENROUTER_API_KEYS || '').trim();
  if (multi) {
    for (const raw of multi.split(',')) {
      const k = normalizeOpenRouterApiKey(raw);
      if (k && !seen.has(k)) {
        seen.add(k);
        pool.push(k);
      }
    }
  }

  return pool.slice(0, MAX_KEYS);
}

/**
 * Get the next usable API key (round-robin, skipping cooled-down keys).
 * Returns null only if every key is in cooldown.
 */
export async function getNextKey() {
  const pool = loadKeyPool();
  if (pool.length === 0) return null;
  if (pool.length === 1) return pool[0];

  const c = await _getClient();
  let idx = 0;
  if (c) {
    try {
      const raw = await c.get(KEY_INDEX_REDIS);
      idx = raw ? Number(raw) : 0;
    } catch { /* */ }
  }

  for (let attempt = 0; attempt < pool.length; attempt++) {
    const pos = (idx + attempt) % pool.length;
    const key = pool[pos];
    const cooled = await _isKeyCoolingDown(key);
    if (!cooled) {
      const nextIdx = (pos + 1) % pool.length;
      if (c) {
        try { await c.set(KEY_INDEX_REDIS, String(nextIdx)); } catch { /* */ }
      }
      return key;
    }
  }

  return null;
}

/**
 * Mark a key as rate-limited. It won't be returned by getNextKey until the
 * cooldown expires.
 * @param {string} key
 * @param {number} [cooldownSec]
 */
export async function markKeyCooldown(key, cooldownSec) {
  const sec = cooldownSec ?? DEFAULT_COOLDOWN_SEC;
  const c = await _getClient();
  if (!c) return;
  const redisKey = `${KEY_COOLDOWN_PREFIX}${_shortId(key)}:cooldown`;
  try {
    await c.set(redisKey, '1', { EX: sec });
  } catch { /* */ }
}

/**
 * Clear cooldown for a key (e.g. after a successful call).
 */
export async function clearKeyCooldown(key) {
  const c = await _getClient();
  if (!c) return;
  try {
    await c.del(`${KEY_COOLDOWN_PREFIX}${_shortId(key)}:cooldown`);
  } catch { /* */ }
}

async function _isKeyCoolingDown(key) {
  const c = await _getClient();
  if (!c) return false;
  try {
    const v = await c.get(`${KEY_COOLDOWN_PREFIX}${_shortId(key)}:cooldown`);
    return v !== null;
  } catch {
    return false;
  }
}

/**
 * Validate a single key by making a minimal completions call.
 * Returns { valid, status, detail }.
 */
export async function validateKey(apiKey) {
  const key = normalizeOpenRouterApiKey(apiKey);
  if (!key) return { valid: false, status: 0, detail: 'empty key' };

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'X-Title': 'OpenClaw key-check',
      },
      body: JSON.stringify({
        model: 'openrouter/free',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    clearTimeout(timer);

    if (resp.ok) return { valid: true, status: resp.status, detail: 'ok' };
    const body = await resp.text().catch(() => '');
    if (resp.status === 401) return { valid: false, status: 401, detail: 'invalid or revoked key' };
    if (resp.status === 429) return { valid: true, status: 429, detail: 'key valid but rate-limited right now' };
    return { valid: false, status: resp.status, detail: body.slice(0, 200) };
  } catch (e) {
    return { valid: false, status: 0, detail: String(e?.message || e).slice(0, 200) };
  }
}

/**
 * Validate every key in the pool. Returns an array of { shortId, valid, status, detail }.
 */
export async function validateAllKeys() {
  const pool = loadKeyPool();
  const results = [];
  for (const key of pool) {
    const r = await validateKey(key);
    results.push({ shortId: _shortId(key), ...r });
  }
  return results;
}

/**
 * Diagnostic snapshot (for /voice/ping, admin).
 */
export async function getKeyPoolSnapshot() {
  const pool = loadKeyPool();
  const entries = [];
  for (const key of pool) {
    const cooled = await _isKeyCoolingDown(key);
    entries.push({ shortId: _shortId(key), coolingDown: cooled });
  }
  const c = await _getClient();
  let idx = 0;
  if (c) {
    try {
      const raw = await c.get(KEY_INDEX_REDIS);
      idx = raw ? Number(raw) : 0;
    } catch { /* */ }
  }
  return { keys: entries, currentIndex: idx, maxKeys: MAX_KEYS };
}
