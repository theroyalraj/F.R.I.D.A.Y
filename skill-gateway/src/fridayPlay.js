/**
 * fridayPlay.js — spawn friday-play.py to stream a song via yt-dlp → Echo Dot.
 *
 * No Amazon auth needed. Routes directly through the Echo Dot as a Windows
 * audio output device (same path as friday-speak.py TTS).
 *
 * Env vars:
 *   FRIDAY_PLAY_ENABLED=false  — set to disable
 *   FRIDAY_TTS_DEVICE          — audio device substring (default: Echo Dot)
 *   FRIDAY_PLAY_SECONDS        — how many seconds to play (default: 45)
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pythonChildExecutable } from './winPython.js';
import { stopAllFridayAudioSync } from './stopAllFridayAudio.js';

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const PLAY_SCRIPT  = path.resolve(__dirname, '../scripts/friday-play.py');

export function fridayPlayEnabled(env = process.env) {
  if (env.FRIDAY_PLAY_ENABLED === 'false' || env.FRIDAY_PLAY_ENABLED === '0') return false;
  return existsSync(PLAY_SCRIPT);
}

/** Returns false when FRIDAY_AUTOPLAY=false/0/off/no — gates automatic (non-user-initiated) songs. */
export function autoPlayEnabled(env = process.env) {
  const v = (env.FRIDAY_AUTOPLAY ?? '').toLowerCase();
  return !(v === 'false' || v === '0' || v === 'off' || v === 'no');
}

/**
 * Play a song fire-and-forget via friday-play.py → yt-dlp → Echo Dot.
 * @param {string} searchPhrase   e.g. "Back in Black AC DC"
 * @param {import('pino').Logger} [log]
 * @param {{ onClose?: () => void }} [opts]  fired when friday-play.py exits (song finished or error)
 */
export function playLocalSong(searchPhrase, log, opts = {}) {
  const { onClose } = opts;
  let closeFired = false;

  const fireClose = () => {
    if (closeFired) return;
    closeFired = true;
    try {
      onClose?.();
    } catch (e) {
      log?.warn({ err: String(e?.message || e) }, 'fridayPlay: onClose threw');
    }
  };

  if (!fridayPlayEnabled()) {
    return;
  }
  if (!autoPlayEnabled()) {
    log?.info('autoPlay disabled — skipping auto song');
    return;
  }

  const safePhrase = String(searchPhrase || '').trim();
  if (!safePhrase) {
    return;
  }

  // Pre-empt any other friday-play / stuck player so boot song + scheduler cannot stack.
  stopAllFridayAudioSync(log, { fullPanic: false });

  const child = spawn(pythonChildExecutable(), [PLAY_SCRIPT, safePhrase], {
    env: {
      ...process.env,
      FRIDAY_TTS_DEVICE:    process.env.FRIDAY_TTS_DEVICE    || 'Echo Dot',
      FRIDAY_PLAY_SECONDS:  process.env.FRIDAY_PLAY_SECONDS  || '45',
    },
    stdio:       ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
    detached:    true,
  });
  child.unref();

  log?.info({ searchPhrase }, 'fridayPlay: spawned friday-play.py');

  child.stderr?.on('data', (buf) => {
    const line = buf.toString().trim();
    if (line) log?.warn({ line: line.slice(0, 800) }, 'friday-play stderr');
  });

  child.on('error', (e) => {
    log?.warn({ err: String(e.message) }, 'fridayPlay: spawn failed');
    fireClose();
  });

  child.on('close', (_code) => {
    log?.debug({ code: _code }, 'fridayPlay: friday-play.py exited');
    fireClose();
  });
}
