import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { pythonChildExecutable } from './winPython.js';
import { getMusicPlayVolumePercent } from './musicVolume.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PLAY_SCRIPT = path.resolve(__dirname, '../../skill-gateway/scripts/friday-play.py');

/** Too vague to send to yt-dlp search */
const VAGUE_QUERY = /^(it|that|this|something|anything|the song|the track|music)\s*$/i;

/**
 * Extract a YouTube search phrase from common voice patterns, e.g.
 * "can you play Back in Black song", "play the song Bohemian Rhapsody Queen".
 */
export function matchPlayMusicIntent(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const patterns = [
    /^(?:can you|could you|please|will you|would you)\s+play\s+(?:the\s+)?(?:song\s+|track\s+|music\s+)?(.+)$/i,
    /^play\s+(?:me\s+)?(?:the\s+)?(?:song\s+|track\s+|music\s+)?(.+)$/i,
  ];

  for (const re of patterns) {
    const m = raw.match(re);
    if (!m || !m[1]) continue;
    let q = m[1].trim();
    q = q.replace(/\s+song\s*$/i, '').replace(/\s+track\s*$/i, '').trim();
    if (q.length < 2) continue;
    if (VAGUE_QUERY.test(q)) continue;
    return q;
  }
  return null;
}

/**
 * Start friday-play.py detached (yt-dlp + ffplay).
 * Manual user requests always play the full song (no FRIDAY_PLAY_SECONDS cap).
 */
export function playMusicSearch(query) {
  return new Promise((resolve) => {
    void (async () => {
      let vol = 20;
      try {
        vol = await getMusicPlayVolumePercent();
      } catch {
        /* */
      }
      const child = spawn(pythonChildExecutable(), [PLAY_SCRIPT, query, '--full'], {
        env: { ...process.env, FRIDAY_PLAY_VOLUME: String(vol) },
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      child.on('error', (e) => resolve({ ok: false, detail: String(e.message || e) }));
      child.on('spawn', () =>
        resolve({
          ok: true,
          detail: `On it — playing ${query}.`,
        }),
      );
    })();
  });
}

/** Kill friday-play / ffplay via script --stop (same as voice pipeline). */
export function stopMusicPlayback() {
  return new Promise((resolve) => {
    const child = spawn(pythonChildExecutable(), [PLAY_SCRIPT, '--stop'], {
      env: { ...process.env },
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', (e) => resolve({ ok: false, detail: String(e.message || e) }));
    child.on('close', (code) =>
      resolve({
        ok: code === 0,
        detail: code === 0 ? 'Playback stopped.' : `Stop exited ${code}`,
      }),
    );
  });
}

/** Persist volume and retune live friday-play Windows mixer session (see friday-play --set-volume). */
export function setMusicPlayVolumeCli(volume) {
  const v = Math.max(0, Math.min(100, Math.round(Number(volume))));
  return new Promise((resolve) => {
    const child = spawn(pythonChildExecutable(), [PLAY_SCRIPT, `--set-volume=${v}`], {
      env: { ...process.env, FRIDAY_PLAY_VOLUME: String(v) },
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', (e) => resolve({ ok: false, volume: v, detail: String(e.message || e) }));
    child.on('close', (code) =>
      resolve({
        ok: code === 0,
        volume: v,
        detail: code === 0 ? `Level ${v} percent.` : `Volume command exited ${code}`,
      }),
    );
  });
}
