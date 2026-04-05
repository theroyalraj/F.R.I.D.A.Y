/**
 * After Anthropic rate-limits the fast path, block further Anthropic calls for a TTL in Redis
 * (Retry-After or default). Skips the HTTP request until the key expires — OpenRouter fallback
 * still runs when configured.
 */

import { createClient } from 'redis';

const KEY =
  (process.env.ANTHROPIC_COOLDOWN_REDIS_KEY || 'openclaw:anthropic:cooldown').trim() ||
  'openclaw:anthropic:cooldown';

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

/** For unit tests — when true, treat cooldown as active without Redis. */
let _forceActiveForTest = false;

export function __setAnthropicCooldownActiveForTest(on) {
  _forceActiveForTest = Boolean(on);
}

/**
 * @param {number} status
 * @param {Headers} headers
 * @param {string} bodyText
 * @returns {number} TTL seconds (1..3600)
 */
export function parseAnthropicCooldownSeconds(status, headers, bodyText) {
  const h = headers?.get?.('retry-after');
  if (h) {
    const n = parseInt(String(h).trim(), 10);
    if (!Number.isNaN(n) && n > 0) return Math.min(n, 3600);
  }
  try {
    const j = JSON.parse(bodyText);
    const ra =
      j?.error?.retry_after ??
      j?.retry_after ??
      j?.error?.details?.retry_after ??
      j?.error?.details?.retryAfter;
    if (typeof ra === 'number' && ra > 0) return Math.min(Math.ceil(ra), 3600);
    if (typeof ra === 'string') {
      const n = parseInt(ra, 10);
      if (!Number.isNaN(n) && n > 0) return Math.min(n, 3600);
    }
  } catch {
    /* ignore */
  }
  const def = parseInt(process.env.ANTHROPIC_RATE_LIMIT_COOLDOWN_SEC || '60', 10);
  return Math.min(Math.max(1, Number.isNaN(def) ? 60 : def), 3600);
}

export async function isAnthropicCooldownActive() {
  if (_forceActiveForTest) return true;
  const c = await _getClient();
  if (!c) return false;
  try {
    const n = await c.exists(KEY);
    return n === 1;
  } catch {
    return false;
  }
}

/** Drop cooldown after a successful Anthropic response. */
export async function clearAnthropicCooldown() {
  if (_forceActiveForTest) return;
  const c = await _getClient();
  if (!c) return;
  try {
    await c.del(KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Arm cooldown — SET key with EX so Anthropic fast-path is skipped until expiry.
 * @param {number} seconds
 */
export async function armAnthropicCooldownSeconds(seconds) {
  const sec = Math.min(Math.max(1, Math.ceil(seconds)), 3600);
  if (_forceActiveForTest) return;
  const c = await _getClient();
  if (!c) return;
  try {
    await c.set(KEY, String(Date.now() + sec * 1000), { EX: sec });
  } catch {
    /* ignore */
  }
}

export async function armAnthropicCooldownFromRateLimitResponse(status, headers, bodyText) {
  const sec = parseAnthropicCooldownSeconds(status, headers, bodyText);
  await armAnthropicCooldownSeconds(sec);
}
