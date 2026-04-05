import { getPool, perceptionDbConfigured, usesSqliteBackend } from './perceptionDb.js';
import { sqliteGetSetting, sqliteSetSetting } from './perceptionSqlite.js';

function envFloat(name, fallback) {
  const v = (process.env[name] || '').split('#')[0].trim();
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** @returns {Promise<string|null>} */
export async function getSetting(key) {
  if (usesSqliteBackend()) {
    return await sqliteGetSetting(key);
  }
  const p = getPool();
  if (!p) return null;
  const r = await p.query('SELECT value FROM openclaw_settings WHERE key = $1', [key]);
  return r.rows[0]?.value ?? null;
}

export async function setSetting(key, value) {
  if (usesSqliteBackend()) {
    await sqliteSetSetting(key, value);
    return;
  }
  const p = getPool();
  if (!p) throw new Error('Database not configured');
  await p.query(
    `INSERT INTO openclaw_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, String(value)],
  );
}

/**
 * Merged ambient timing: DB overrides env for keys that exist.
 * @returns {Promise<{ postTtsGap: number, minSilenceSec: number, maxSilenceSec: number, keysFromDb: string[] }>}
 */
export async function getAmbientMerged() {
  const defPost =
    envFloat('FRIDAY_AMBIENT_POST_TTS_GAP', NaN) ||
    envFloat('FRIDAY_AMBIENT_SILENCE_SEC', 12);
  const defMin = envFloat('FRIDAY_AMBIENT_MIN_SILENCE_SEC', 4);
  const defMax = envFloat('FRIDAY_AMBIENT_MAX_SILENCE_SEC', 25);

  let postTtsGap = defPost;
  let minSilenceSec = defMin;
  let maxSilenceSec = defMax;
  const keysFromDb = [];

  if (!perceptionDbConfigured()) {
    return { postTtsGap, minSilenceSec, maxSilenceSec, keysFromDb };
  }

  const keys = [
    ['FRIDAY_AMBIENT_POST_TTS_GAP', 'postTtsGap'],
    ['FRIDAY_AMBIENT_MIN_SILENCE_SEC', 'minSilenceSec'],
    ['FRIDAY_AMBIENT_MAX_SILENCE_SEC', 'maxSilenceSec'],
  ];

  try {
    for (const [dbKey, field] of keys) {
      const raw = await getSetting(dbKey);
      if (raw == null || raw === '') continue;
      const n = Number(String(raw).split('#')[0].trim());
      if (!Number.isFinite(n)) continue;
      keysFromDb.push(dbKey);
      if (field === 'postTtsGap') postTtsGap = n;
      if (field === 'minSilenceSec') minSilenceSec = n;
      if (field === 'maxSilenceSec') maxSilenceSec = n;
    }
  } catch {
    /* openclaw_settings missing until migration — env defaults only */
  }

  return { postTtsGap, minSilenceSec, maxSilenceSec, keysFromDb };
}

/**
 * @param {{ postTtsGap?: number, minSilenceSec?: number, maxSilenceSec?: number }} body
 */
export async function putAmbientPartial(body) {
  if (!perceptionDbConfigured()) {
    throw new Error('OPENCLAW_DATABASE_URL or OPENCLAW_SQLITE_PATH not set');
  }
  if (!usesSqliteBackend() && !getPool()) throw new Error('Database not configured');

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  if (body.postTtsGap != null && Number.isFinite(Number(body.postTtsGap))) {
    await setSetting('FRIDAY_AMBIENT_POST_TTS_GAP', String(clamp(Number(body.postTtsGap), 3, 600)));
  }
  if (body.minSilenceSec != null && Number.isFinite(Number(body.minSilenceSec))) {
    await setSetting('FRIDAY_AMBIENT_MIN_SILENCE_SEC', String(clamp(Number(body.minSilenceSec), 3, 600)));
  }
  if (body.maxSilenceSec != null && Number.isFinite(Number(body.maxSilenceSec))) {
    await setSetting('FRIDAY_AMBIENT_MAX_SILENCE_SEC', String(clamp(Number(body.maxSilenceSec), 5, 900)));
  }

  return getAmbientMerged();
}
