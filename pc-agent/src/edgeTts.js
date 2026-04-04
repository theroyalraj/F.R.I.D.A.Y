/**
 * Edge TTS — neural voices via friday-speak.py (Python edge-tts package).
 * Delegates to the Python script which uses Microsoft Edge's TTS WebSocket service
 * with automatic retry and device routing.
 *
 * Env vars:
 *   FRIDAY_TTS_EDGE=false      — explicitly disable (enabled by default when script is present)
 *   FRIDAY_TTS_DISABLED=1      — disables all server-side TTS
 *   FRIDAY_EDGE_TTS_VOICE      — voice short-name (default: inherits FRIDAY_TTS_VOICE → en-GB-RyanNeural)
 *
 * Good voices:
 *   en-GB-RyanNeural      British male    ← default (Jarvis / FRIDAY feel)
 *   en-GB-ThomasNeural    British male, deeper
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

const execFileAsync = promisify(execFile);
const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const SPEAK_SCRIPT  = path.resolve(__dirname, '../../skill-gateway/scripts/friday-speak.py');

export function edgeTtsConfigured(env = process.env) {
  if (env.FRIDAY_TTS_DISABLED === '1' || env.FRIDAY_TTS_DISABLED === 'true') return false;
  if (env.FRIDAY_TTS_EDGE === 'false' || env.FRIDAY_TTS_EDGE === '0') return false;
  return existsSync(SPEAK_SCRIPT);
}

/** Runtime voice override — set via POST /voice/set-voice, resets on server restart. */
let _sessionVoice = null;

export function setSessionVoice(name) {
  _sessionVoice = (typeof name === 'string' && name.trim()) ? name.trim() : null;
}

export function edgeTtsVoice(env = process.env) {
  return _sessionVoice || env.FRIDAY_EDGE_TTS_VOICE?.trim() || env.FRIDAY_TTS_VOICE?.trim() || 'en-GB-RyanNeural';
}

/** Curated Edge TTS voice catalogue with descriptions. */
export const EDGE_TTS_VOICE_CATALOGUE = [
  { voice: 'en-GB-RyanNeural',                  lang: 'en-GB', gender: 'Male',   desc: 'British male — Jarvis / FRIDAY feel (default)' },
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
];

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
          FRIDAY_TTS_RATE:   process.env.FRIDAY_TTS_RATE   || '+0%',
          FRIDAY_TTS_PITCH:  process.env.FRIDAY_TTS_PITCH  || '+0Hz',
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
