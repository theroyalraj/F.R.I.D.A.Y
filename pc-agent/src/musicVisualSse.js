/**
 * SSE payloads for the Listen UI Siri orb during local music (friday-play).
 */
import { clipSecondsForSongQuery } from './celebration.js';

function parseIntEnv(name, defaultVal) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultVal;
  const n = parseInt(String(raw).split('#')[0].trim(), 10);
  return Number.isFinite(n) ? n : defaultVal;
}

/** Full-length user "play …" — orb stays up for a capped window (not full track length). */
export function musicOrbSecondsFullPlay() {
  const n = parseIntEnv('FRIDAY_MUSIC_ORB_SECONDS', 90);
  return Math.min(600, Math.max(20, n));
}

/**
 * @param {string} query yt-dlp search phrase
 * @param {'full' | 'clip'} kind
 */
export function buildMusicPlaySsePayload(query, kind) {
  const q = String(query || '').trim() || 'Music';
  const text = `Playing: ${q}`;
  if (kind === 'clip') {
    const seconds = clipSecondsForSongQuery(q);
    return { text, seconds, kind: 'clip' };
  }
  return { text, seconds: musicOrbSecondsFullPlay(), kind: 'full' };
}
