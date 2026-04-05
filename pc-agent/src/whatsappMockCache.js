/**
 * Ephemeral WhatsApp rows for Listen UI when OPENCLAW_WHATSAPP_MOCK=1.
 * Merged into GET /integrations/whatsapp/messages (shown under Recent inbound).
 */
import { createClient } from 'redis';

const KEY = 'openclaw:whatsapp:mock_inbound';
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

  let arr = [];
  try {
    const raw = await r.get(KEY);
    arr = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) arr = [];
  } catch {
    arr = [];
  }
  arr.unshift(entry);
  if (arr.length > MAX_ROWS) arr = arr.slice(0, MAX_ROWS);
  await r.set(KEY, JSON.stringify(arr), { EX: ttlSec() });
  return entry;
}

/** @returns {Promise<Array<{ id: string; from: string; text: string; ts: string }>>} */
export async function listMockInbound() {
  const r = await getRedis();
  if (!r) return [];
  try {
    const raw = await r.get(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x) => x && typeof x.id === 'string' && x.from && x.text);
  } catch {
    return [];
  }
}

/** @returns {Promise<number>} */
export async function clearMockInbound() {
  const r = await getRedis();
  if (!r) return 0;
  return r.del(KEY);
}
