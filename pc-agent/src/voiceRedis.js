/**
 * Voice context persistence and status tracking in Redis.
 *
 * Each "context" represents an independent voice consumer:
 *   api             — voice set via POST /voice/set-voice (pc-agent runtime override)
 *   cursor:main     — Cursor chat main voice (pick-session-voice.py)
 *   cursor:subagent — Cursor Task subagent voice (pick-session-voice.py --subagent)
 *
 * Redis schema (Hash per context):
 *   friday:voice:context:{name} → { voice, set_at, last_used, status }
 *
 * Status is computed dynamically: 'active' if last_used < IDLE_AFTER_MS ago, else 'idle'.
 */

import { createClient } from 'redis';

const KEY_PREFIX  = 'friday:voice:context:';
const IDLE_AFTER_MS = 5 * 60 * 1000; // 5 minutes without use → idle

let _client = null;

function _redisUrl() {
  return (process.env.OPENCLAW_REDIS_URL || '').trim() || 'redis://127.0.0.1:6379';
}

async function _getClient() {
  if (_client?.isOpen) return _client;
  const c = createClient({ url: _redisUrl() });
  c.on('error', () => {});
  try {
    await c.connect();
    _client = c;
    return _client;
  } catch {
    return null;
  }
}

function _computeStatus(lastUsedIso) {
  if (!lastUsedIso) return 'idle';
  const ageMs = Date.now() - new Date(lastUsedIso).getTime();
  return ageMs < IDLE_AFTER_MS ? 'active' : 'idle';
}

/**
 * Write (or overwrite) the voice for a named context.
 * Resets set_at and last_used to now.
 * @param {string} context
 * @param {string} voice
 */
export async function setVoiceContext(context, voice) {
  const c = await _getClient();
  if (!c) return;
  const now = new Date().toISOString();
  try {
    await c.hSet(`${KEY_PREFIX}${context}`, {
      voice,
      set_at:    now,
      last_used: now,
      status:    'active',
    });
  } catch { /* ignore */ }
}

/**
 * Update last_used timestamp for a context (called when voice is used for TTS).
 * Creates the entry if it doesn't exist yet.
 * @param {string} context
 * @param {string} voice
 */
export async function touchVoiceContext(context, voice) {
  const c = await _getClient();
  if (!c) return;
  const now = new Date().toISOString();
  try {
    const existing = await c.hGetAll(`${KEY_PREFIX}${context}`);
    if (!existing?.voice) {
      await c.hSet(`${KEY_PREFIX}${context}`, {
        voice,
        set_at:    now,
        last_used: now,
        status:    'active',
      });
    } else {
      await c.hSet(`${KEY_PREFIX}${context}`, {
        last_used: now,
        status:    'active',
      });
    }
  } catch { /* ignore */ }
}

/**
 * Read voice data for a named context.
 * Returns { voice, set_at, last_used, status } or null if not found.
 * @param {string} context
 */
export async function getVoiceContext(context) {
  const c = await _getClient();
  if (!c) return null;
  try {
    const data = await c.hGetAll(`${KEY_PREFIX}${context}`);
    if (!data?.voice) return null;
    return { ...data, status: _computeStatus(data.last_used) };
  } catch {
    return null;
  }
}

/**
 * Return all tracked voice contexts.
 * @returns {Promise<Array<{context: string, voice: string, set_at: string, last_used: string, status: string}>>}
 */
export async function getAllVoiceContexts() {
  const c = await _getClient();
  if (!c) return [];
  try {
    const results = [];
    // SCAN to avoid blocking with KEYS in production
    let cursor = 0;
    do {
      const reply = await c.scan(cursor, { MATCH: `${KEY_PREFIX}*`, COUNT: 50 });
      cursor = reply.cursor;
      for (const key of reply.keys) {
        const data = await c.hGetAll(key);
        if (data?.voice) {
          results.push({
            context: key.slice(KEY_PREFIX.length),
            voice:     data.voice,
            set_at:    data.set_at    || null,
            last_used: data.last_used || null,
            status:    _computeStatus(data.last_used),
          });
        }
      }
    } while (cursor !== 0);
    // Sort by last_used descending (most recently active first)
    results.sort((a, b) => {
      const ta = a.last_used ? new Date(a.last_used).getTime() : 0;
      const tb = b.last_used ? new Date(b.last_used).getTime() : 0;
      return tb - ta;
    });
    return results;
  } catch {
    return [];
  }
}

/**
 * Restore the last-saved API session voice from Redis.
 * Returns the voice string or null.
 */
export async function restoreApiVoice() {
  const data = await getVoiceContext('api');
  return data?.voice || null;
}
