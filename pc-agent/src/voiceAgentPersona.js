/**
 * OpenClaw Labs voice-agent personas — defaults + Postgres (openclaw_settings) + Redis patch for Python daemons.
 * Settings key: voice_agent_personas → JSON object { jarvis: { name?, title?, voice?, personality?, rate? }, ... }
 */
import { createClient } from 'redis';
import { getSetting, setSetting } from './settingsDb.js';
import { perceptionDbConfigured } from './perceptionDb.js';

export const SETTINGS_KEY = 'voice_agent_personas';
export const REDIS_PATCH_KEY = 'openclaw:voice_agent_personas_patch';

/** Canonical defaults (keep aligned with scripts/openclaw_company.py PERSONAS + companyPersonas.ts). */
export const VOICE_AGENT_PERSONA_DEFAULTS = {
  jarvis: {
    name: 'Jarvis',
    title: 'Chief of Staff',
    voice: 'en-US-AvaMultilingualNeural',
    rate: '',
    personality: 'Composed, warm, confident — your primary executive assistant.',
  },
  argus: {
    name: 'Argus',
    title: 'VP, Security and Compliance',
    voice: 'en-US-GuyNeural',
    rate: '+5%',
    personality: 'Dry, watchful, direct; no-nonsense on pending reviews.',
  },
  nova: {
    name: 'Nova',
    title: 'Director of Communications',
    voice: 'en-GB-SoniaNeural',
    rate: '',
    personality: 'Polished, concise; delivers briefings like a news lead.',
  },
  sage: {
    name: 'Sage',
    title: 'Head of Research',
    voice: 'en-US-AndrewMultilingualNeural',
    rate: '-5%',
    personality: 'Measured, academic; narrates reasoning aloud.',
  },
  dexter: {
    name: 'Dexter',
    title: 'Lead Engineer',
    voice: 'en-US-EricNeural',
    rate: '',
    personality: 'Methodical, lightly nerdy; standup-style updates.',
  },
  maestro: {
    name: 'Maestro',
    title: 'Creative Director',
    voice: 'en-US-BrianMultilingualNeural',
    rate: '',
    personality: 'Witty, relaxed; music, culture, and colour commentary.',
  },
  harper: {
    name: 'Harper',
    title: 'Executive Assistant',
    voice: 'en-US-JennyNeural',
    rate: '',
    personality: 'Organised, supportive; reminders without nagging.',
  },
  sentinel: {
    name: 'Sentinel',
    title: 'IT Operations',
    voice: 'en-IE-ConnorNeural',
    rate: '+3%',
    personality: 'Understated relay; reads Composer output when enabled.',
  },
  atlas: {
    name: 'Atlas',
    title: 'VP, Strategy',
    voice: '',
    rate: '',
    personality: 'Listen path only; does not speak independently.',
  },
};

function _redisUrl() {
  return (process.env.OPENCLAW_REDIS_URL || '').trim() || 'redis://127.0.0.1:6379';
}

/**
 * Deep-merge per-role persona fields from patch into base.
 * @param {Record<string, object>} base
 * @param {Record<string, object>} patch
 */
export function mergeVoiceAgentPersonaPatch(base, patch) {
  const out = structuredClone(base);
  if (!patch || typeof patch !== 'object') return out;
  for (const role of Object.keys(patch)) {
    const p = patch[role];
    if (!p || typeof p !== 'object') continue;
    if (!out[role]) out[role] = {};
    for (const f of ['name', 'title', 'voice', 'personality', 'rate']) {
      if (typeof p[f] === 'string') {
        out[role][f] = p[f];
      }
    }
  }
  return out;
}

/** @returns {Promise<boolean>} */
export async function syncPersonaPatchToRedis(jsonString) {
  const c = createClient({ url: _redisUrl() });
  try {
    await c.connect();
    await c.set(REDIS_PATCH_KEY, jsonString);
    return true;
  } catch {
    return false;
  } finally {
    try {
      await c.quit();
    } catch {
      /* ignore */
    }
  }
}

let _memCache = null;
let _memAt = 0;
const MEM_TTL_MS = 15_000;

function _invalidateMem() {
  _memCache = null;
  _memAt = 0;
}

/**
 * Load raw patch JSON from DB (or {}).
 * @returns {Promise<{ patch: Record<string, object>, fromDatabase: boolean }>}
 */
export async function loadVoiceAgentPersonaPatchFromDb() {
  if (!perceptionDbConfigured()) {
    return { patch: {}, fromDatabase: false };
  }
  try {
    const raw = await getSetting(SETTINGS_KEY);
    if (!raw || !String(raw).trim()) {
      return { patch: {}, fromDatabase: true };
    }
    const parsed = JSON.parse(String(raw));
    return { patch: typeof parsed === 'object' && parsed ? parsed : {}, fromDatabase: true };
  } catch {
    return { patch: {}, fromDatabase: true };
  }
}

/**
 * Merged catalog (defaults + DB patch). Short in-memory cache.
 * @returns {Promise<{ merged: Record<string, object>, patch: Record<string, object>, fromDatabase: boolean, redisSynced: boolean }>}
 */
export async function getVoiceAgentPersonasMerged() {
  const now = Date.now();
  if (_memCache && now - _memAt < MEM_TTL_MS) {
    return _memCache;
  }

  const { patch, fromDatabase } = await loadVoiceAgentPersonaPatchFromDb();
  const merged = mergeVoiceAgentPersonaPatch(VOICE_AGENT_PERSONA_DEFAULTS, patch);

  _memCache = { merged, patch, fromDatabase };
  _memAt = now;
  return _memCache;
}

/**
 * Merge into stored patch (per-role fields combine). Set body.replace + body.personas to replace entire patch.
 * @param {Record<string, unknown>} body
 */
export async function putVoiceAgentPersonaPatch(body) {
  if (!perceptionDbConfigured()) {
    throw new Error('Database not configured — set OPENCLAW_DATABASE_URL or OPENCLAW_SQLITE_PATH');
  }
  if (!body || typeof body !== 'object') {
    throw new Error('Body must be JSON: { jarvis: { voice: "..." }, ... } or { replace: true, personas: { ... } }');
  }

  const replaceAll = body.replace === true;
  const rawIn = replaceAll && body.personas && typeof body.personas === 'object' ? body.personas : body;
  const knownRoles = new Set(Object.keys(VOICE_AGENT_PERSONA_DEFAULTS));

  const safe = {};
  for (const role of Object.keys(rawIn)) {
    if (!knownRoles.has(role)) continue;
    if (replaceAll === false && role === 'replace') continue;
    const p = rawIn[role];
    if (!p || typeof p !== 'object') continue;
    safe[role] = {};
    for (const f of ['name', 'title', 'voice', 'personality', 'rate']) {
      if (typeof p[f] === 'string') {
        safe[role][f] = p[f];
      }
    }
    if (Object.keys(safe[role]).length === 0) {
      delete safe[role];
    }
  }

  let stored = safe;
  if (!replaceAll) {
    const curRaw = await getSetting(SETTINGS_KEY);
    let existing = {};
    try {
      existing = curRaw && String(curRaw).trim() ? JSON.parse(String(curRaw)) : {};
      if (typeof existing !== 'object' || !existing) existing = {};
    } catch {
      existing = {};
    }
    stored = { ...existing };
    for (const role of Object.keys(safe)) {
      const prev = typeof stored[role] === 'object' && stored[role] ? stored[role] : {};
      stored[role] = { ...prev, ...safe[role] };
    }
  }

  await setSetting(SETTINGS_KEY, JSON.stringify(stored));
  _invalidateMem();
  const redisSynced = await syncPersonaPatchToRedis(JSON.stringify(stored));
  const merged = mergeVoiceAgentPersonaPatch(VOICE_AGENT_PERSONA_DEFAULTS, stored);
  return { patch: stored, merged, redisSynced };
}

/** Clear DB patch and Redis key. */
export async function resetVoiceAgentPersonaPatch() {
  if (!perceptionDbConfigured()) {
    throw new Error('Database not configured');
  }
  await setSetting(SETTINGS_KEY, '{}');
  _invalidateMem();
  const redisSynced = await syncPersonaPatchToRedis('{}');
  return { patch: {}, merged: VOICE_AGENT_PERSONA_DEFAULTS, redisSynced };
}

/** On boot: push DB patch to Redis so Python daemons see it without hitting Node. */
export async function refreshPersonaPatchRedisFromDb() {
  try {
    const { patch } = await loadVoiceAgentPersonaPatchFromDb();
    await syncPersonaPatchToRedis(JSON.stringify(patch));
    _invalidateMem();
    return true;
  } catch {
    return false;
  }
}

/** @returns {Promise<object>} */
export async function getVoicePersonasRegistrySnapshot() {
  const { merged, patch, fromDatabase } = await getVoiceAgentPersonasMerged();
  return {
    fromDatabase,
    roles: Object.keys(merged),
    patchRoleCount: Object.keys(patch).length,
    tagline: 'OpenClaw Labs — voice-agent roster (defaults + Postgres voice_agent_personas)',
  };
}
