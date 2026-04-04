import { createClient } from 'redis';

let client = null;

export function perceptionRedisConfigured() {
  return Boolean((process.env.OPENCLAW_REDIS_URL || '').trim());
}

async function getClient() {
  if (!perceptionRedisConfigured()) return null;
  if (client?.isOpen) return client;
  const c = createClient({ url: process.env.OPENCLAW_REDIS_URL.trim() });
  c.on('error', () => {});
  try {
    await c.connect();
    client = c;
    return client;
  } catch {
    return null;
  }
}

/** Cache pointer / last capture summary for fast reads (optional). */
export async function cachePerceptionSummary(payload) {
  const c = await getClient();
  if (!c) return;
  try {
    await c.set('openclaw:perception:last', JSON.stringify(payload), { EX: 86_400 });
  } catch {
    /* ignore */
  }
}

export async function perceptionRedisHealth() {
  if (!perceptionRedisConfigured()) return { ok: false, reason: 'OPENCLAW_REDIS_URL not set' };
  const c = await getClient();
  if (!c) return { ok: false, reason: 'connect failed' };
  try {
    const pong = await c.ping();
    return { ok: pong === 'PONG' };
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  }
}
