/**
 * Redis cache for GET /integrations/gmail — reduces IMAP load (default TTL 10 minutes).
 * Falls back gracefully if Redis is unavailable.
 */
import { createClient } from 'redis';

let _client = null;

function _redisUrl() {
  return (process.env.OPENCLAW_REDIS_URL || '').trim() || 'redis://127.0.0.1:6379';
}

function cacheTtlSec() {
  const n = Number(process.env.GMAIL_SNAPSHOT_CACHE_TTL_SEC ?? '600');
  return Math.min(86_400, Math.max(60, Number.isFinite(n) ? n : 600));
}

function cacheEnabled() {
  const v = (process.env.GMAIL_SNAPSHOT_CACHE_ENABLED ?? 'true').toString().trim().toLowerCase();
  return !['false', '0', 'off', 'no'].includes(v);
}

/** @returns {Promise<import('redis').RedisClientType | null>} */
async function _getRedis() {
  if (!cacheEnabled()) return null;
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

/**
 * @param {{ unreadCount: number, recentCount: number, unreadOffset: number, recentOffset: number }} q
 */
export function gmailCacheKeySuffix(q) {
  const stable = JSON.stringify({
    u: q.unreadCount,
    r: q.recentCount,
    uo: q.unreadOffset,
    ro: q.recentOffset,
  });
  return stable;
}

/** @param {string} suffix */
function keyFor(suffix) {
  return `openclaw:gmail:snapshot:${Buffer.from(suffix).toString('base64url')}`;
}

/**
 * @param {{ unreadCount: number, recentCount: number, unreadOffset: number, recentOffset: number }} q
 * @returns {Promise<object | null>}
 */
export async function getCachedGmailSnapshot(q) {
  const redis = await _getRedis();
  if (!redis) return null;
  const k = keyFor(gmailCacheKeySuffix(q));
  try {
    const raw = await redis.get(k);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * @param {{ unreadCount: number, recentCount: number, unreadOffset: number, recentOffset: number }} q
 * @param {object} snap — same shape as fetchGmailSnapshot (ok, ts, unread, recent)
 */
export async function setCachedGmailSnapshot(q, snap) {
  const redis = await _getRedis();
  if (!redis) return;
  const k = keyFor(gmailCacheKeySuffix(q));
  const ttl = cacheTtlSec();
  try {
    const payload = {
      ...snap,
      _cache: { storedAt: new Date().toISOString(), ttlSec: ttl },
    };
    await redis.set(k, JSON.stringify(payload), { EX: ttl });
  } catch {
    /* ignore */
  }
}

/** Invalidate all openclaw:gmail:snapshot:* keys (call when new mail arrives). */
export async function invalidateAllGmailSnapshotCaches() {
  const redis = await _getRedis();
  if (!redis) return 0;
  let n = 0;
  try {
    const keys = [];
    for await (const k of redis.scanIterator({ MATCH: 'openclaw:gmail:snapshot:*', COUNT: 64 })) {
      keys.push(k);
      if (keys.length >= 256) {
        n += await redis.del(keys);
        keys.length = 0;
      }
    }
    if (keys.length) n += await redis.del(keys);
    return n;
  } catch {
    return n;
  }
}
