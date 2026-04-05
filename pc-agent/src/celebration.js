/**
 * Post-task "done song" flow: ask before playing (default) so TTS summary does not kill friday-play.
 * Modes: off | immediate | ask (FRIDAY_DONE_SONG_MODE).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pythonChildExecutable } from './winPython.js';
import { getSpeakStyle, normalizeSpeakStyle, mergeDeliveryWithSpeakStyle } from './speakStyle.js';
import { buildCelebrationAskText, getFocusDigestOpener } from './listenUiCopy.js';
import { getAllVoiceContexts } from './voiceRedis.js';
import { readMusicAutoplayEnabledSync } from '../../lib/musicAutoplayPrefs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLAY_SCRIPT = path.resolve(__dirname, '../../skill-gateway/scripts/friday-play.py');
const SPEAK_SCRIPT = path.resolve(__dirname, '../../skill-gateway/scripts/friday-speak.py');

const CTX_LABEL = {
  api: 'Listen UI',
  'cursor:main': 'Cursor',
  'cursor:subagent': 'Cursor Task',
  'cursor:reply': 'Cursor Reply',
  'cursor:thinking': 'Thinking',
};

function parseIntEnv(name, defaultVal) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultVal;
  const n = parseInt(String(raw).split('#')[0].trim(), 10);
  return Number.isFinite(n) ? n : defaultVal;
}

/** AC/DC Back in Black entry / done-clip uses a dedicated shorter cap (see FRIDAY_BACK_IN_BLACK_PLAY_SECONDS). */
export function isBackInBlackSongQuery(query) {
  const s = String(query || '').toLowerCase();
  return s.includes('back in black');
}

/**
 * Clip length for friday-play when not using --full (celebration done song, etc.).
 * Back in Black defaults to twenty-four seconds; other phrases use FRIDAY_PLAY_SECONDS.
 */
export function clipSecondsForSongQuery(query) {
  if (isBackInBlackSongQuery(query)) {
    return Math.min(600, Math.max(8, parseIntEnv('FRIDAY_BACK_IN_BLACK_PLAY_SECONDS', 24)));
  }
  return Math.min(600, Math.max(8, parseIntEnv('FRIDAY_PLAY_SECONDS', 26)));
}

/** Same shape as server.js greetingTtsRatePitch (Jarvis-style delivery). */
function greetingTtsRatePitch() {
  const off = ['false', '0', 'no', 'off'];
  const raw = (process.env.FRIDAY_TTS_JARVIS_RANDOM || 'true').toLowerCase();
  if (off.includes(raw)) {
    return {
      FRIDAY_TTS_RATE: process.env.FRIDAY_TTS_JARVIS_RATE || '+10%',
      FRIDAY_TTS_PITCH: process.env.FRIDAY_TTS_JARVIS_PITCH || '+2Hz',
    };
  }
  const rLo = parseIntEnv('FRIDAY_TTS_JARVIS_RATE_MIN_PCT', 3);
  const rHi = parseIntEnv('FRIDAY_TTS_JARVIS_RATE_MAX_PCT', 12);
  const pLo = parseIntEnv('FRIDAY_TTS_JARVIS_PITCH_MIN_HZ', 0);
  const pHi = parseIntEnv('FRIDAY_TTS_JARVIS_PITCH_MAX_HZ', 10);
  const rMin = Math.min(rLo, rHi);
  const rMax = Math.max(rLo, rHi);
  const pMin = Math.min(pLo, pHi);
  const pMax = Math.max(pLo, pHi);
  const rp = rMin + Math.floor(Math.random() * (rMax - rMin + 1));
  const ph = pMin + Math.floor(Math.random() * (pMax - pMin + 1));
  return {
    FRIDAY_TTS_RATE: `${rp >= 0 ? '+' : ''}${rp}%`,
    FRIDAY_TTS_PITCH: `${ph >= 0 ? '+' : ''}${ph}Hz`,
  };
}

function shortVoiceLabel(voiceId) {
  const id = String(voiceId || '');
  const m = id.match(/-(\w+)Neural/);
  return m ? m[1] : id.slice(-14) || 'voice';
}

/**
 * @param {ReturnType<typeof normalizeSpeakStyle>} style
 * @param {Awaited<ReturnType<typeof getAllVoiceContexts>>} contexts
 */
export function buildFocusModeDigest(style, contexts) {
  const s = normalizeSpeakStyle(style);
  const top = Array.isArray(contexts) ? contexts.slice(0, 3) : [];
  const parts = top.map((c) => {
    const lab = CTX_LABEL[c.context] || c.context;
    return `${lab} on ${shortVoiceLabel(c.voice)}`;
  });
  const list = parts.length ? parts.join('. ') : 'voice channels look quiet on my board';

  const opener = getFocusDigestOpener(style);

  let out = `${opener} Last activity touchpoints: ${list}. Carry on when you're ready.`;
  if (s.customPrompt && s.customPrompt.trim()) {
    out += ` ${s.customPrompt.trim().slice(0, 240)}`;
  }
  return out;
}

export function getCelebrationMode() {
  const song = (process.env.FRIDAY_DONE_SONG || '').trim();
  if (!song) return 'off';
  if (!readMusicAutoplayEnabledSync()) return 'off';
  const m = (process.env.FRIDAY_DONE_SONG_MODE || 'ask').trim().toLowerCase();
  if (['off', 'false', '0', 'no'].includes(m)) return 'off';
  if (['immediate', 'now', 'auto'].includes(m)) return 'immediate';
  return 'ask';
}

/**
 * @returns {Promise<Record<string, never> | { celebration: { song: string, askText: string, delayMsBeforeAsk: number } }>}
 */
export async function buildCelebrationOffer() {
  if (getCelebrationMode() !== 'ask') return {};
  const song = (process.env.FRIDAY_DONE_SONG || '').trim();
  if (!song || !existsSync(PLAY_SCRIPT)) return {};
  const style = await getSpeakStyle();
  const askText = buildCelebrationAskText(song, style);
  const rawDelay = process.env.FRIDAY_CELEBRATION_ASK_DELAY_MS;
  const parsedDelay =
    rawDelay === undefined || rawDelay === ''
      ? 4000
      : Number(String(rawDelay).split('#')[0].trim());
  const baseDelay = Math.min(
    120_000,
    Math.max(1500, Number.isFinite(parsedDelay) ? parsedDelay : 4000),
  );
  /** Optional: longer pause before the on-screen ask only when FRIDAY_DONE_SONG is Back in Black. */
  const bibRaw = process.env.FRIDAY_CELEBRATION_ASK_DELAY_BACK_IN_BLACK_MS;
  let delayMsBeforeAsk = baseDelay;
  if (isBackInBlackSongQuery(song) && bibRaw !== undefined && bibRaw !== '') {
    const bibDelay = Number(String(bibRaw).split('#')[0].trim());
    if (Number.isFinite(bibDelay)) {
      delayMsBeforeAsk = Math.min(120_000, Math.max(1500, bibDelay));
    }
  }
  return { celebration: { song, askText, delayMsBeforeAsk } };
}

export function playDoneSong(log) {
  const song = (process.env.FRIDAY_DONE_SONG || '').trim();
  if (!song || !existsSync(PLAY_SCRIPT)) return;
  const clipSec = String(clipSecondsForSongQuery(song));
  const child = spawn(pythonChildExecutable(), [PLAY_SCRIPT, song], {
    env: { ...process.env, FRIDAY_PLAY_SECONDS: clipSec },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
    detached: true,
  });
  child.unref();
  child.stderr?.on('data', (buf) => {
    const line = buf.toString().trim();
    if (line) log?.warn({ line: line.slice(0, 400) }, 'done-song stderr');
  });
  child.on('error', (e) => log?.warn({ err: String(e.message) }, 'done-song spawn failed'));
  log?.info({ song }, 'done-song: spawned friday-play.py');
}

/**
 * Priority TTS (same as /voice/speak-async) with speak-style delivery merge.
 * @param {import('pino').Logger|undefined} log
 */
export async function spawnCelebrationSpeak(text, log) {
  const t = String(text || '').trim();
  if (!t || !existsSync(SPEAK_SCRIPT)) return;
  const style = await getSpeakStyle();
  const base = greetingTtsRatePitch();
  const delivery = mergeDeliveryWithSpeakStyle(base, style);
  const child = spawn(pythonChildExecutable(), [SPEAK_SCRIPT, t], {
    env: {
      ...process.env,
      FRIDAY_TTS_VOICE: process.env.FRIDAY_TTS_VOICE || 'en-US-AvaMultilingualNeural',
      FRIDAY_TTS_DEVICE: process.env.FRIDAY_TTS_DEVICE || 'default',
      FRIDAY_TTS_PRIORITY: 'cooperative',
      FRIDAY_TTS_BYPASS_CURSOR_DEFER: 'true',
      ...delivery,
    },
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  child.unref();
  child.stderr?.on('data', (buf) => {
    const line = buf.toString().trim();
    if (line) log?.warn({ fridaySpeak: line }, 'celebration speak stderr');
  });
  child.on('error', (e) => log?.warn({ err: String(e.message) }, 'celebration speak spawn failed'));
}

/**
 * @param {import('pino').Logger|undefined} log
 * @param {boolean} accept
 */
export async function resolveCelebration(log, accept) {
  if (accept) {
    playDoneSong(log);
    return { played: true, spoke: false };
  }
  const style = await getSpeakStyle();
  const contexts = await getAllVoiceContexts();
  const line = buildFocusModeDigest(style, contexts);
  await spawnCelebrationSpeak(line, log);
  return { played: false, spoke: true };
}
