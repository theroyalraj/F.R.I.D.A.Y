/**
 * Global speak style — mood toggles + custom prompt, persisted in Redis.
 * Used for Claude voice/mic/WhatsApp replies and TTS rate/pitch hints.
 * Keep delivery deltas in sync with _apply_speak_style_rate_pitch_from_redis in friday-speak.py.
 */

import { createClient } from 'redis';

export const REDIS_SPEAK_STYLE_KEY = 'friday:speak_style';

export const DEFAULT_SPEAK_STYLE = {
  funny: false,
  snarky: false,
  bored: false,
  dry: false,
  warm: false,
  customPrompt: '',
};

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

function parseEnvStyleJson() {
  const raw = (process.env.FRIDAY_SPEAK_STYLE_JSON || '').trim();
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    return typeof o === 'object' && o && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

export function normalizeSpeakStyle(partial) {
  const o = { ...DEFAULT_SPEAK_STYLE, ...partial };
  o.funny = Boolean(o.funny);
  o.snarky = Boolean(o.snarky);
  o.bored = Boolean(o.bored);
  o.dry = Boolean(o.dry);
  o.warm = Boolean(o.warm);
  o.customPrompt = typeof o.customPrompt === 'string' ? o.customPrompt.slice(0, 2000) : '';
  return o;
}

/** @param {Record<string, unknown>} style */
export function speakStyleDeliveryDeltas(style) {
  const s = normalizeSpeakStyle(style);
  let ratePct = 0;
  let pitchHz = 0;
  if (s.funny) {
    ratePct += 3;
    pitchHz += 2;
  }
  if (s.snarky) {
    ratePct += 4;
    pitchHz += 3;
  }
  if (s.bored) {
    ratePct -= 10;
    pitchHz -= 3;
  }
  if (s.dry) {
    ratePct -= 3;
    pitchHz -= 2;
  }
  if (s.warm) {
    ratePct -= 2;
    pitchHz += 1;
  }
  ratePct = Math.max(-18, Math.min(18, ratePct));
  pitchHz = Math.max(-8, Math.min(12, pitchHz));
  return { ratePct, pitchHz };
}

function parsePercent(str) {
  const m = String(str || '').match(/^([+-]?\d+(?:\.\d+)?)\s*%$/);
  return m ? parseFloat(m[1], 10) : 7.5;
}

function parseHz(str) {
  const m = String(str || '').match(/^([+-]?\d+(?:\.\d+)?)\s*Hz$/i);
  return m ? parseFloat(m[1], 10) : 2;
}

function fmtPct(n) {
  const r = Math.round(n * 10) / 10;
  const sign = r < 0 ? '' : '+';
  return `${sign}${r}%`;
}

function fmtHz(n) {
  const r = Math.round(n * 10) / 10;
  const sign = r < 0 ? '' : '+';
  return `${sign}${r}Hz`;
}

/**
 * Merge Jarvis greeting rate/pitch with global mood deltas.
 * @param {{ FRIDAY_TTS_RATE?: string, FRIDAY_TTS_PITCH?: string }} greetingEnv
 * @param {Record<string, unknown>} style
 */
export function mergeDeliveryWithSpeakStyle(greetingEnv, style) {
  const d = speakStyleDeliveryDeltas(style);
  const r = Math.max(-50, Math.min(50, parsePercent(greetingEnv.FRIDAY_TTS_RATE) + d.ratePct));
  const p = Math.max(-20, Math.min(20, parseHz(greetingEnv.FRIDAY_TTS_PITCH) + d.pitchHz));
  return {
    FRIDAY_TTS_RATE: fmtPct(r),
    FRIDAY_TTS_PITCH: fmtHz(p),
  };
}

export async function getSpeakStyle() {
  const envBase = normalizeSpeakStyle(parseEnvStyleJson());
  const c = await _getClient();
  if (!c) {
    return normalizeSpeakStyle({ ...DEFAULT_SPEAK_STYLE, ...envBase });
  }
  try {
    const raw = await c.get(REDIS_SPEAK_STYLE_KEY);
    if (!raw) {
      return normalizeSpeakStyle({ ...DEFAULT_SPEAK_STYLE, ...envBase });
    }
    const parsed = JSON.parse(raw);
    return normalizeSpeakStyle({ ...DEFAULT_SPEAK_STYLE, ...envBase, ...parsed });
  } catch {
    return normalizeSpeakStyle({ ...DEFAULT_SPEAK_STYLE, ...envBase });
  }
}

async function getSpeakStyleForWrite() {
  const c = await _getClient();
  if (!c) return normalizeSpeakStyle({ ...DEFAULT_SPEAK_STYLE, ...parseEnvStyleJson() });
  try {
    const raw = await c.get(REDIS_SPEAK_STYLE_KEY);
    if (!raw) {
      return normalizeSpeakStyle({ ...DEFAULT_SPEAK_STYLE, ...parseEnvStyleJson() });
    }
    return normalizeSpeakStyle({ ...DEFAULT_SPEAK_STYLE, ...JSON.parse(raw) });
  } catch {
    return normalizeSpeakStyle({ ...DEFAULT_SPEAK_STYLE, ...parseEnvStyleJson() });
  }
}

/**
 * @param {Partial<typeof DEFAULT_SPEAK_STYLE>} partial
 */
export async function setSpeakStyle(partial) {
  const cur = await getSpeakStyleForWrite();
  const next = normalizeSpeakStyle({ ...cur, ...partial });
  const c = await _getClient();
  if (!c) {
    const err = new Error('Redis unavailable — cannot save speak style');
    err.code = 'REDIS_DOWN';
    throw err;
  }
  await c.set(REDIS_SPEAK_STYLE_KEY, JSON.stringify(next));
  return next;
}

export function buildSpeakStyleInstruction(style) {
  const s = normalizeSpeakStyle(style);
  const parts = [];
  if (s.funny) {
    parts.push(
      '• Lean into clever humour and playful imagery when it fits — still very tight for speech, no long jokes.',
    );
  }
  if (s.snarky) {
    parts.push(
      '• Sharp tongue and affectionate teasing toward Raj only — witty barbs, never cruel, hateful, or abusive.',
    );
  }
  if (s.bored) {
    parts.push(
      '• World-weary, low-energy delivery in your word choice — short clauses, minimal enthusiasm, still actually helpful.',
    );
  }
  if (s.dry) {
    parts.push('• Extra deadpan; understate everything.');
  }
  if (s.warm) {
    parts.push('• Warmer and more encouraging tone; keep it genuine, not saccharine.');
  }
  if (s.customPrompt.trim()) {
    parts.push(s.customPrompt.trim());
  }
  if (!parts.length) return '';
  return `SPEAKING STYLE (global — apply to this entire reply):\n${parts.join('\n')}`;
}
