/**
 * ECHO (silence watcher) personality + timing — DB + Redis mirror for Python daemons.
 * Redis key: openclaw:echo:config (JSON). Python friday-silence-watch reads this live.
 */
import { createClient } from 'redis';
import { getSetting, setSetting } from './settingsDb.js';
import { perceptionDbConfigured } from './perceptionDb.js';

export const ECHO_SETTINGS_DB_KEY = 'echo_settings';
export const REDIS_ECHO_CONFIG_KEY = 'openclaw:echo:config';

/** @type {import('redis').RedisClientType | null} */
let _client = null;

function _redisUrl() {
  return (process.env.OPENCLAW_REDIS_URL || '').trim() || 'redis://127.0.0.1:6379';
}

async function _getRedis() {
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

function envInt(name, fallback) {
  const v = (process.env[name] || '').split('#')[0].trim();
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/** Defaults from .env (seed before UI / DB). */
export function defaultEchoFromEnv() {
  return {
    humor: clamp(envInt('OPENCLAW_ECHO_HUMOR', 40), 0, 100),
    warmth: clamp(envInt('OPENCLAW_ECHO_WARMTH', 70), 0, 100),
    directness: clamp(envInt('OPENCLAW_ECHO_DIRECTNESS', 50), 0, 100),
    curiosity: clamp(envInt('OPENCLAW_ECHO_CURIOSITY', 60), 0, 100),
    formality: clamp(envInt('OPENCLAW_ECHO_FORMALITY', 30), 0, 100),
    idleSec: clamp(envInt('FRIDAY_SILENCE_IDLE_SEC', 120), 30, 86400),
    rearmSec: clamp(envInt('FRIDAY_SILENCE_REARM_SEC', 300), 60, 86400),
    voice: (process.env.OPENCLAW_ECHO_VOICE || 'en-US-MichelleNeural').trim(),
  };
}

/** @param {Record<string, unknown>} o */
export function echoNormalizePatch(o) {
  const out = {};
  for (const k of ['humor', 'warmth', 'directness', 'curiosity', 'formality', 'idleSec', 'rearmSec']) {
    if (o[k] == null || o[k] === '') continue;
    const n = Number(o[k]);
    if (!Number.isFinite(n)) continue;
    if (k === 'idleSec') out.idleSec = clamp(n, 30, 86400);
    else if (k === 'rearmSec') out.rearmSec = clamp(n, 60, 86400);
    else out[k] = clamp(n, 0, 100);
  }
  if (typeof o.voice === 'string' && o.voice.trim()) {
    out.voice = o.voice.trim().slice(0, 120);
  }
  return out;
}

/** Full record with defaults + clamping (for persisted JSON). */
export function normalizeEchoRecord(o) {
  const d = defaultEchoFromEnv();
  if (!o || typeof o !== 'object') return { ...d };
  const m = /** @type {Record<string, unknown>} */ (o);
  return {
    humor: clamp(Number(m.humor ?? d.humor), 0, 100),
    warmth: clamp(Number(m.warmth ?? d.warmth), 0, 100),
    directness: clamp(Number(m.directness ?? d.directness), 0, 100),
    curiosity: clamp(Number(m.curiosity ?? d.curiosity), 0, 100),
    formality: clamp(Number(m.formality ?? d.formality), 0, 100),
    idleSec: clamp(Number(m.idleSec ?? d.idleSec), 30, 86400),
    rearmSec: clamp(Number(m.rearmSec ?? d.rearmSec), 60, 86400),
    voice: typeof m.voice === 'string' && m.voice.trim() ? m.voice.trim().slice(0, 120) : d.voice,
  };
}

/** @param {Awaited<ReturnType<typeof mergeEchoLayers>>} merged */
export async function syncEchoConfigToRedis(merged) {
  const c = await _getRedis();
  if (!c) return false;
  try {
    const payload = {
      humor: merged.humor,
      warmth: merged.warmth,
      directness: merged.directness,
      curiosity: merged.curiosity,
      formality: merged.formality,
      idleSec: merged.idleSec,
      rearmSec: merged.rearmSec,
      voice: merged.voice,
      updatedAt: Date.now(),
    };
    await c.set(REDIS_ECHO_CONFIG_KEY, JSON.stringify(payload), { EX: 60 * 60 * 24 * 14 });
    return true;
  } catch {
    return false;
  }
}

/** @returns {Promise<Record<string, unknown> | null>} */
export async function readEchoFromRedis() {
  const c = await _getRedis();
  if (!c) return null;
  try {
    const raw = await c.get(REDIS_ECHO_CONFIG_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return typeof o === 'object' && o && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

async function mergeEchoLayers() {
  const base = defaultEchoFromEnv();
  let merged = { ...base };

  if (perceptionDbConfigured()) {
    try {
      const raw = await getSetting(ECHO_SETTINGS_DB_KEY);
      if (raw) {
        const o = JSON.parse(raw);
        if (typeof o === 'object' && o && !Array.isArray(o)) {
          merged = { ...merged, ...normalizeEchoRecord(o) };
        }
      }
    } catch {
      /* ignore */
    }
  }

  const hot = await readEchoFromRedis();
  if (hot) {
    merged = { ...merged, ...normalizeEchoRecord(hot) };
  }

  return normalizeEchoRecord(merged);
}

/**
 * Merged ECHO config for UI + API.
 * @returns {Promise<object>}
 */
export async function getEchoMerged() {
  const merged = await mergeEchoLayers();
  const keysFromDb = [];
  if (perceptionDbConfigured()) {
    try {
      const raw = await getSetting(ECHO_SETTINGS_DB_KEY);
      if (raw) keysFromDb.push(ECHO_SETTINGS_DB_KEY);
    } catch {
      /* */
    }
  }
  const fromRedis = Boolean(await readEchoFromRedis());
  return {
    ok: true,
    humor: merged.humor,
    warmth: merged.warmth,
    directness: merged.directness,
    curiosity: merged.curiosity,
    formality: merged.formality,
    idleSec: merged.idleSec,
    rearmSec: merged.rearmSec,
    voice: merged.voice,
    keysFromDb,
    fromRedis,
  };
}

/**
 * @param {Record<string, unknown>} body
 * @returns {Promise<object>}
 */
export async function putEchoPartial(body) {
  const cur = await mergeEchoLayers();
  const patch = echoNormalizePatch(body && typeof body === 'object' ? body : {});
  const merged = normalizeEchoRecord({ ...cur, ...patch });

  if (perceptionDbConfigured()) {
    await setSetting(ECHO_SETTINGS_DB_KEY, JSON.stringify(merged));
  }

  const redisOk = await syncEchoConfigToRedis(merged);
  if (!perceptionDbConfigured() && !redisOk) {
    throw new Error('Redis unavailable and database not configured — cannot persist ECHO settings');
  }

  return {
    ok: true,
    humor: merged.humor,
    warmth: merged.warmth,
    directness: merged.directness,
    curiosity: merged.curiosity,
    formality: merged.formality,
    idleSec: merged.idleSec,
    rearmSec: merged.rearmSec,
    voice: merged.voice,
    redisSynced: redisOk,
    keysFromDb: perceptionDbConfigured() ? [ECHO_SETTINGS_DB_KEY] : [],
  };
}
