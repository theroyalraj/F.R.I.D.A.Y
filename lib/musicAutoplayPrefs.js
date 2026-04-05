/**
 * Music autoplay pref (scheduler, ambient songs, gateway auto friday-play): Redis,
 * temp file (for sync reads from gateway fridayPlay), then FRIDAY_AUTOPLAY.
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient } from 'redis';

export const MUSIC_AUTOPLAY_REDIS_KEY = 'openclaw:music:autoplay';
const AUTOPLAY_FILE = path.join(tmpdir(), 'openclaw-music-autoplay.txt');

function redisUrl(env = process.env) {
  return (
    (env.OPENCLAW_REDIS_URL || '').trim() ||
    (env.FRIDAY_AMBIENT_REDIS_URL || '').trim() ||
    'redis://127.0.0.1:6379'
  );
}

function envAutoplayDefault(env = process.env) {
  const v = String(env.FRIDAY_AUTOPLAY ?? 'true')
    .toLowerCase()
    .split('#')[0]
    .trim();
  return !(v === 'false' || v === '0' || v === 'off' || v === 'no');
}

function parseStored(val) {
  const s = String(val ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return null;
}

/** Sync read for gateway fridayPlay / celebration (same machine as Listen UI). */
export function readMusicAutoplayEnabledSync(env = process.env) {
  if (existsSync(AUTOPLAY_FILE)) {
    try {
      const raw = readFileSync(AUTOPLAY_FILE, 'utf8').trim();
      const p = parseStored(raw);
      if (p !== null) return p;
    } catch {
      /* */
    }
  }
  return envAutoplayDefault(env);
}

export function writeMusicAutoplayFileMirror(enabled) {
  try {
    writeFileSync(AUTOPLAY_FILE, enabled ? '1' : '0', 'utf8');
  } catch {
    /* */
  }
}

export async function getMusicAutoplayEnabled(env = process.env) {
  let c;
  try {
    c = createClient({ url: redisUrl(env), socket: { connectTimeout: 2000 } });
    await c.connect();
    const got = await c.get(MUSIC_AUTOPLAY_REDIS_KEY);
    if (got != null && String(got).trim() !== '') {
      const p = parseStored(got);
      if (p !== null) return p;
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
  return readMusicAutoplayEnabledSync(env);
}

export async function setMusicAutoplayEnabled(enabled, env = process.env) {
  const on = Boolean(enabled);
  try {
    writeMusicAutoplayFileMirror(on);
  } catch {
    return { ok: false, enabled: on };
  }
  let c;
  try {
    c = createClient({ url: redisUrl(env), socket: { connectTimeout: 2000 } });
    await c.connect();
    await c.set(MUSIC_AUTOPLAY_REDIS_KEY, on ? '1' : '0');
  } catch {
    /* file mirror is enough for same-machine gateway + Python readers when Redis returns */
  } finally {
    if (c) {
      try {
        await c.quit();
      } catch {
        /* */
      }
    }
  }
  return { ok: true, enabled: on };
}

/** On boot: copy Redis value to file so sync readers match without a prior PUT. */
export async function mirrorMusicAutoplayFromRedisToFile(env = process.env) {
  const v = await getMusicAutoplayEnabled(env);
  writeMusicAutoplayFileMirror(v);
}
