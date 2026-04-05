/**
 * Ephemeral WhatsApp rows for Listen UI when OPENCLAW_WHATSAPP_MOCK=1.
 * Merged into GET /integrations/whatsapp/messages (shown under Recent inbound).
 *
 * Storage: Redis LIST (atomic LPUSH+LTRIM). Legacy STRING JSON array is read once for migration.
 */
import { createClient } from 'redis';

const KEY = 'openclaw:whatsapp:mock_inbound';
const LEGACY_KEY = 'openclaw:whatsapp:mock_inbound_legacy';
const DEFAULT_TTL_SEC = 86_400;
const MAX_ROWS = 30;

function redisUrl() {
  return (process.env.OPENCLAW_REDIS_URL || '').trim() || 'redis://127.0.0.1:6379';
}

let _client = null;

/** @returns {Promise<import('redis').RedisClientType | null>} */
async function getRedis() {
  if (_client?.isOpen) return _client;
  const c = createClient({
    url: redisUrl(),
    socket: { connectTimeout: 1500, reconnectStrategy: false },
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

function ttlSec() {
  const n = Number(process.env.OPENCLAW_WHATSAPP_MOCK_TTL_SEC ?? String(DEFAULT_TTL_SEC));
  return Math.min(604_800, Math.max(120, Number.isFinite(n) ? n : DEFAULT_TTL_SEC));
}

/**
 * Move old JSON-at-key payload to list + rename key so we do not collide.
 * @param {import('redis').RedisClientType} r
 */
async function migrateLegacyStringIfPresent(r) {
  const t = await r.type(KEY);
  if (t !== 'string') return;
  const raw = await r.get(KEY);
  let arr = [];
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    arr = Array.isArray(parsed) ? parsed : [];
  } catch {
    arr = [];
  }
  await r.del(LEGACY_KEY);
  await r.rename(KEY, LEGACY_KEY);
  /** arr is newest-first; rPush in that order so index 0 stays newest after lRange. */
  for (const row of arr) {
    if (row && typeof row.id === 'string' && row.from && row.text) {
      await r.rPush(KEY, JSON.stringify(row));
    }
  }
  await r.lTrim(KEY, -MAX_ROWS, -1);
  await r.expire(KEY, ttlSec());
}

/**
 * @param {{ from: string, text: string }} row
 * @returns {Promise<{ id: string; from: string; text: string; ts: string } | null>}
 */
export async function pushMockInbound(row) {
  const r = await getRedis();
  if (!r) return null;
  const from = String(row.from || '').replace(/\D/g, '') || '0000000000';
  const text = String(row.text || '').trim().slice(0, 2000);
  if (!text) return null;
  const ts = new Date().toISOString();
  const id = `mock:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  const entry = { id, from, text, ts };

  await migrateLegacyStringIfPresent(r);

  const ex = ttlSec();
  const blob = JSON.stringify(entry);
  await r.lPush(KEY, blob);
  await r.lTrim(KEY, 0, MAX_ROWS - 1);
  await r.expire(KEY, ex);
  return entry;
}

/** @returns {Promise<Array<{ id: string; from: string; text: string; ts: string }>>} */
export async function listMockInbound() {
  const r = await getRedis();
  if (!r) return [];
  try {
    await migrateLegacyStringIfPresent(r);
    const rows = await r.lRange(KEY, 0, MAX_ROWS - 1);
    const out = [];
    for (const s of rows) {
      try {
        const x = JSON.parse(s);
        if (x && typeof x.id === 'string' && x.from && x.text) out.push(x);
      } catch {
        /* skip */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** @returns {Promise<number>} */
export async function clearMockInbound() {
  const r = await getRedis();
  if (!r) return 0;
  const a = await r.del(KEY);
  await r.del(LEGACY_KEY);
  return a;
}
