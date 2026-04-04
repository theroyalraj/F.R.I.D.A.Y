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

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const PLAY_SCRIPT  = path.resolve(__dirname, '../scripts/friday-play.py');

export function fridayPlayEnabled(env = process.env) {
  if (env.FRIDAY_PLAY_ENABLED === 'false' || env.FRIDAY_PLAY_ENABLED === '0') return false;
  return existsSync(PLAY_SCRIPT);
}

/**
 * Play a song fire-and-forget via friday-play.py → yt-dlp → Echo Dot.
 * @param {string} searchPhrase   e.g. "Back in Black AC DC"
 * @param {import('pino').Logger} [log]
 */
export function playLocalSong(searchPhrase, log) {
  if (!fridayPlayEnabled()) return;

  const safePhrase = String(searchPhrase || '').trim();
  if (!safePhrase) return;

  const child = spawn('python', [PLAY_SCRIPT, safePhrase], {
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
  });
}
