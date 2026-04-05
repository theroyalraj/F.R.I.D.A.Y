import { createClient } from 'redis';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REDIS_KEY = 'openclaw:music:play_volume';
const VOL_FILE = path.join(tmpdir(), 'openclaw-music-play-volume.txt');

function redisUrl() {
  return (
    (process.env.OPENCLAW_REDIS_URL || '').trim() ||
    (process.env.FRIDAY_AMBIENT_REDIS_URL || '').trim() ||
    'redis://127.0.0.1:6379'
  );
}

function clampPct(n, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(100, Math.round(v)));
}

function envBase() {
  return clampPct(process.env.FRIDAY_PLAY_VOLUME ?? '20', 20);
}

/**
 * Effective Maestro / friday-play level 0–100 (Redis, then temp file, then FRIDAY_PLAY_VOLUME).
 */
export async function getMusicPlayVolumePercent() {
  const base = envBase();
  let c;
  try {
    c = createClient({ url: redisUrl(), socket: { connectTimeout: 2000 } });
    await c.connect();
    const got = await c.get(REDIS_KEY);
    if (got != null && String(got).trim() !== '') {
      return clampPct(got, base);
    }
  } catch {
    /* */
  } finally {
    if (c) {
      try {
        await c.quit();
      } catch {
        /* */
      }
    }
  }
  if (existsSync(VOL_FILE)) {
    try {
      const t = readFileSync(VOL_FILE, 'ascii').trim();
      if (t) return clampPct(t, base);
    } catch {
      /* */
    }
  }
  return base;
}
