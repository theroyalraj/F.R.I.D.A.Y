/**
 * Windows Text-to-Speech via edge-tts neural voices (Microsoft Edge engine).
 * Speaks through Echo Dot (or any WaveOut device) using the friday-speak.py script.
 *
 * Env vars:
 *   FRIDAY_WIN_TTS=true                           — enable (default: false)
 *   FRIDAY_WIN_TTS_VOICE=en-IN-NeerjaExpressiveNeural  — edge-tts voice name
 *   FRIDAY_WIN_TTS_DEVICE=Echo Dot                — audio device substring (default: Echo Dot)
 *   FRIDAY_WIN_TTS_RATE=+7.5%                     — speed (default matches main TTS ~1.075×)
 *   FRIDAY_WIN_TTS_PITCH=+2Hz                     — pitch (slightly bright)
 *   FRIDAY_WIN_TTS_VOLUME=+0%                     — volume adjustment
 *
 * Voices (good for Hinglish / Indian English):
 *   en-IN-NeerjaExpressiveNeural   Indian English female  (best Hinglish, default)
 *   en-IN-NeerjaNeural             Indian English female  (calmer tone)
 *   en-IN-PrabhatNeural            Indian English male
 *   hi-IN-SwaraNeural              Hindi female
 *   hi-IN-MadhurNeural             Hindi male
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const IS_WINDOWS = process.platform === 'win32';
const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const SPEAK_PY   = path.resolve(__dirname, '../scripts/friday-speak.py');

export function winTtsEnabled() {
  return IS_WINDOWS && String(process.env.FRIDAY_WIN_TTS || 'false').toLowerCase() === 'true';
}

/**
 * Speak text via edge-tts neural voice on Echo Dot (or fallback device). Fire-and-forget.
 * @param {string} text
 * @param {import('pino').Logger} [log]
 */
export function speakWinTts(text, log) {
  if (!IS_WINDOWS) return;

  const safeText = String(text || '').trim().slice(0, 500);
  if (!safeText) return;

  const env = {
    ...process.env,
    FRIDAY_TTS_VOICE:  process.env.FRIDAY_WIN_TTS_VOICE  || 'en-IN-NeerjaExpressiveNeural',
    FRIDAY_TTS_DEVICE: process.env.FRIDAY_WIN_TTS_DEVICE || 'Echo Dot',
    FRIDAY_TTS_RATE:   process.env.FRIDAY_WIN_TTS_RATE   || '+7.5%',
    FRIDAY_TTS_PITCH:  process.env.FRIDAY_WIN_TTS_PITCH  || '+2Hz',
    FRIDAY_TTS_VOLUME: process.env.FRIDAY_WIN_TTS_VOLUME || '+0%',
  };

  const child = spawn('python', [SPEAK_PY, safeText], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: true,
    env,
  });

  child.stdout?.on('data', (d) => log?.info({ tts: d.toString().trim() }, 'winTts'));
  child.stderr?.on('data', (d) => log?.warn({ tts: d.toString().trim() }, 'winTts: err'));
  child.on('error', (e) => log?.warn({ err: String(e.message) }, 'winTts: spawn failed'));
  child.unref();
}
