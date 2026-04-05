/**
 * Edge TTS — neural voices via friday-speak.py (Python edge-tts package).
 * Delegates to the Python script which uses Microsoft Edge's TTS WebSocket service
 * with automatic retry and device routing.
 *
 * Env vars:
 *   FRIDAY_TTS_EDGE=false      — explicitly disable (enabled by default when script is present)
 *   FRIDAY_TTS_DISABLED=1      — disables all server-side TTS
 *   FRIDAY_EDGE_TTS_VOICE      — voice short-name (default: inherits FRIDAY_TTS_VOICE → en-US-AvaMultilingualNeural)
 *
 * Good voices (see FRIDAY_TTS_VOICE_BLOCK — blocked ids are rejected by API and clamped at runtime):
 *   en-US-AvaMultilingualNeural — repo default (Jarvis)
 *   en-US-GuyNeural       US male neural
 *   en-US-AriaNeural      US female neural
 *   en-IN-NeerjaExpressiveNeural  Indian English / Hinglish
 */

import { existsSync } from 'node:fs';
import { tmpdir }     from 'node:os';
import path           from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile }   from 'node:child_process';
import { promisify }  from 'node:util';
import crypto         from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { setVoiceContext, touchVoiceContext, restoreApiVoice } from './voiceRedis.js';

const execFileAsync = promisify(execFile);
const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const SPEAK_SCRIPT  = path.resolve(__dirname, '../../skill-gateway/scripts/friday-speak.py');

export function edgeTtsConfigured(env = process.env) {
  if (env.FRIDAY_TTS_DISABLED === '1' || env.FRIDAY_TTS_DISABLED === 'true') return false;
  if (env.FRIDAY_TTS_EDGE === 'false' || env.FRIDAY_TTS_EDGE === '0') return false;
  return existsSync(SPEAK_SCRIPT);
}

/** Runtime voice override — set via POST /voice/set-voice, persisted to Redis. */
let _sessionVoice = null;

/** @param {NodeJS.ProcessEnv} [env] */
export function getVoiceBlockSet(env = process.env) {
  const set = new Set(
    String(env.FRIDAY_TTS_VOICE_BLOCK || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  set.add('en-AU-WilliamNeural');
  set.add('en-AU-WilliamMultilingualNeural');
  set.add('en-GB-RyanNeural');
  set.add('en-GB-ThomasNeural');
  return set;
}

/** @param {string} name */
export function isVoiceBlocked(name, env = process.env) {
  if (!name || typeof name !== 'string') return false;
  return getVoiceBlockSet(env).has(name.trim());
}

export function setSessionVoice(name) {
  const v = (typeof name === 'string' && name.trim()) ? name.trim() : null;
  if (v && isVoiceBlocked(v)) {
    return false;
  }
  _sessionVoice = v;
  // Persist to Redis (fire-and-forget) so the choice survives a server restart
  if (v) {
    setVoiceContext('api', v).catch(() => {});
  }
  return true;
}

export function edgeTtsVoice(env = process.env) {
  if (_sessionVoice && isVoiceBlocked(_sessionVoice, env)) {
    _sessionVoice = null;
  }
  const blocked = getVoiceBlockSet(env);
  const envMain = env.FRIDAY_TTS_VOICE?.trim() || '';
  const fallback =
    (envMain && !blocked.has(envMain) && envMain) || 'en-US-AvaMultilingualNeural';
  const edgeOverride = env.FRIDAY_EDGE_TTS_VOICE?.trim() || '';
  const candidates = [_sessionVoice, edgeOverride, envMain, 'en-US-AvaMultilingualNeural'].filter(Boolean);
  let resolved = fallback;
  for (const c of candidates) {
    if (!blocked.has(c)) { resolved = c; break; }
  }
  // Keep Redis last_used fresh for the api context (fire-and-forget)
  touchVoiceContext('api', resolved).catch(() => {});
  return resolved;
}

/**
 * Restore the API session voice from Redis — call once at server startup.
 * If Redis has a saved voice (and it's not blocked), re-apply it as the session voice.
 */
export async function restoreSessionVoiceFromRedis() {
  try {
    const saved = await restoreApiVoice();
    if (saved && !isVoiceBlocked(saved)) {
      _sessionVoice = saved;
    }
  } catch { /* Redis unavailable — no-op */ }
}

/** Catalogue entries allowed for GET /voice/voices and set-voice. */
export function filteredEdgeTtsCatalogue(env = process.env) {
  const blocked = getVoiceBlockSet(env);
  return EDGE_TTS_VOICE_CATALOGUE.filter((e) => !blocked.has(e.voice));
}

/** Curated Edge TTS voice catalogue with descriptions. */
export const EDGE_TTS_VOICE_CATALOGUE = [
  { voice: 'en-US-AvaMultilingualNeural',       lang: 'en-US', gender: 'Female', desc: 'US female multilingual — Jarvis default' },
  { voice: 'en-US-EmmaMultilingualNeural',      lang: 'en-US', gender: 'Female', desc: 'US female multilingual — natural flow' },
  { voice: 'en-GB-RyanNeural',                  lang: 'en-GB', gender: 'Male',   desc: 'British male — Jarvis / FRIDAY feel' },
  { voice: 'en-GB-ThomasNeural',                lang: 'en-GB', gender: 'Male',   desc: 'British male, deeper tone' },
  { voice: 'en-GB-LibbyNeural',                 lang: 'en-GB', gender: 'Female', desc: 'British female, natural' },
  { voice: 'en-GB-SoniaNeural',                 lang: 'en-GB', gender: 'Female', desc: 'British female, expressive' },
  { voice: 'en-US-GuyNeural',                   lang: 'en-US', gender: 'Male',   desc: 'US male, professional' },
  { voice: 'en-US-ChristopherNeural',           lang: 'en-US', gender: 'Male',   desc: 'US male, articulate' },
  { voice: 'en-US-DavisNeural',                 lang: 'en-US', gender: 'Male',   desc: 'US male, confident' },
  { voice: 'en-US-AriaNeural',                  lang: 'en-US', gender: 'Female', desc: 'US female, natural' },
  { voice: 'en-US-JennyNeural',                 lang: 'en-US', gender: 'Female', desc: 'US female, friendly assistant' },
  { voice: 'en-US-NancyNeural',                 lang: 'en-US', gender: 'Female', desc: 'US female, calm' },
  { voice: 'en-IN-NeerjaExpressiveNeural',      lang: 'en-IN', gender: 'Female', desc: 'Indian English, expressive' },
  { voice: 'en-IN-PrabhatNeural',               lang: 'en-IN', gender: 'Male',   desc: 'Indian English, male' },
  { voice: 'en-AU-WilliamNeural',               lang: 'en-AU', gender: 'Male',   desc: 'Australian male' },
  { voice: 'en-AU-NatashaNeural',               lang: 'en-AU', gender: 'Female', desc: 'Australian female' },
  { voice: 'en-CA-LiamNeural',                  lang: 'en-CA', gender: 'Male',   desc: 'Canadian male' },
  { voice: 'en-CA-ClaraNeural',                 lang: 'en-CA', gender: 'Female', desc: 'Canadian female' },
  { voice: 'ja-JP-NanamiNeural',                lang: 'ja-JP', gender: 'Female', desc: 'Japanese neural — Japanese-English colour on English text' },
  { voice: 'ja-JP-KeitaNeural',                 lang: 'ja-JP', gender: 'Male',   desc: 'Japanese neural — Japanese-English colour on English text' },
  { voice: 'ru-RU-DmitryNeural',                lang: 'ru-RU', gender: 'Male',   desc: 'Russian neural — Russian-English colour on English text' },
  { voice: 'ru-RU-SvetlanaNeural',              lang: 'ru-RU', gender: 'Female', desc: 'Russian neural — Russian-English colour on English text' },
];

const FAST_VOICE_SOURCES = new Set([
  'ui',
  'cursor-ui',
  'voice',
  'mic-daemon',
  'friday-mic-daemon',
  'whatsapp',
]);

/**
 * Primary Edge voice for Haiku-tier replies (Japanese-English timbre on English).
 * Occasionally swaps to alt voice for Russian-English colour (see FRIDAY_TTS_HAIKU_ALT_CHANCE).
 */
export function resolveHaikuTtsVoice(env = process.env) {
  const blocked = getVoiceBlockSet(env);
  const pick = (v) => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s && !blocked.has(s) ? s : '';
  };
  const primary = pick(env.FRIDAY_TTS_HAIKU_VOICE) || pick('ja-JP-NanamiNeural');
  const alt = pick(env.FRIDAY_TTS_HAIKU_ALT_VOICE) || pick('ru-RU-DmitryNeural');
  const rawChance = parseFloat(String(env.FRIDAY_TTS_HAIKU_ALT_CHANCE ?? '0.2').trim());
  const chance = Number.isFinite(rawChance) ? Math.min(1, Math.max(0, rawChance)) : 0.2;
  if (alt && chance > 0 && Math.random() < chance) return alt;
  if (primary) return primary;
  if (alt) return alt;
  return edgeTtsVoice(env);
}

/**
 * Overlay replyVoice when the task ran on Claude Haiku (UI / voice fast path).
 * @param {Record<string, string>} [extras]
 * @param {{ modelKey?: string, resultModel?: string, claudeModel?: string | null | undefined, src?: string }} ctx
 */
export function mergeHaikuReplyVoice(extras = {}, ctx = {}) {
  const src = String(ctx.src || '').toLowerCase();
  if (!FAST_VOICE_SOURCES.has(src)) return { ...extras };
  const cm = ctx.claudeModel != null ? String(ctx.claudeModel).toLowerCase().trim() : '';
  const mk = ctx.modelKey != null ? String(ctx.modelKey).toLowerCase() : '';
  const rm = ctx.resultModel != null ? String(ctx.resultModel) : '';
  const haiku =
    cm === 'haiku' || mk.includes('haiku') || /haiku/i.test(rm);
  if (!haiku) return { ...extras };
  return { ...extras, replyVoice: resolveHaikuTtsVoice() };
}

/**
 * Synthesize text to MP3 buffer via friday-speak.py --output.
 *
 * @param {string} text
 * @param {{ voice?: string, timeoutMs?: number }} [options]
 * @returns {Promise<Buffer>}
 */
export async function synthesizeEdgeTtsMp3(text, options = {}) {
  const voice     = options.voice    || edgeTtsVoice();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const tmpFile   = path.join(tmpdir(), `friday-tts-${crypto.randomUUID()}.mp3`);

  try {
    await execFileAsync(
      'python',
      [SPEAK_SCRIPT, '--output', tmpFile, text],
      {
        timeout: timeoutMs,
        env: {
          ...process.env,
          FRIDAY_TTS_VOICE:  voice,
          FRIDAY_TTS_DEVICE: '',   // no device routing needed — we return bytes
          FRIDAY_TTS_RATE:   process.env.FRIDAY_TTS_RATE   || '+7.5%',
          FRIDAY_TTS_PITCH:  process.env.FRIDAY_TTS_PITCH  || '+2Hz',
          FRIDAY_TTS_VOLUME: process.env.FRIDAY_TTS_VOLUME || '+0%',
        },
      },
    );

    const buf = await readFile(tmpFile);
    if (buf.length === 0) throw new Error('friday-speak.py returned empty audio');
    return buf;
  } finally {
    unlink(tmpFile).catch(() => {});
  }
}
