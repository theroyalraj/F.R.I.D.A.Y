/**
 * Stop overlapping local music (friday-player / ffplay) and clear music Redis lease.
 * Does not clear TTS locks unless fullPanic=true (uses clear_friday_locks.py without --music-only).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pythonChildExecutable } from './winPython.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLEAR_SCRIPT = path.join(REPO_ROOT, 'skill-gateway', 'scripts', 'clear_friday_locks.py');

function taskkillWin(im) {
  try {
    execFileSync('taskkill', ['/IM', im, '/F'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {import('pino').Logger} [log]
 * @param {{ fullPanic?: boolean }} [opts]
 */
export function stopAllFridayAudioSync(log, opts = {}) {
  const { fullPanic = false } = opts;
  if (process.platform === 'win32') {
    for (const im of ['friday-player.exe', 'ffplay.exe']) {
      if (taskkillWin(im)) log?.info({ im }, 'stopAllFridayAudio: taskkill');
    }
  } else {
    try {
      execFileSync('pkill', ['-f', 'friday-player'], { stdio: 'ignore' });
      log?.info('stopAllFridayAudio: pkill friday-player');
    } catch {
      /* ignore */
    }
    try {
      execFileSync('pkill', ['-f', 'ffplay'], { stdio: 'ignore' });
    } catch {
      /* ignore */
    }
  }

  const args = fullPanic ? [] : ['--music-only'];
  try {
    spawnSync(pythonChildExecutable(), [CLEAR_SCRIPT, ...args], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
      windowsHide: true,
    });
    log?.info({ fullPanic }, 'stopAllFridayAudio: clear_friday_locks');
  } catch (e) {
    log?.warn({ err: String(e?.message || e) }, 'stopAllFridayAudio: clear_friday_locks failed');
  }
}

/**
 * @param {import('pino').Logger} [log]
 * @param {{ fullPanic?: boolean; alexa?: boolean }} [opts]
 */
export async function stopAllFridayAudioAsync(log, opts = {}) {
  const { alexaStopMusic } = await import('./alexaMusic.js');
  stopAllFridayAudioSync(log, { fullPanic: opts.fullPanic });
  if (opts.alexa !== false) {
    try {
      await alexaStopMusic(log);
      log?.info('stopAllFridayAudio: Alexa pause sent');
    } catch (e) {
      log?.debug({ err: String(e?.message || e) }, 'stopAllFridayAudio: Alexa stop skipped');
    }
  }
}
