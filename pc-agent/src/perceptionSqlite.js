/**
 * Embedded SQLite (sql.js / WASM) for perception + openclaw_settings.
 * No native compile — works on Windows/macOS/Linux. Set OPENCLAW_SQLITE_PATH.
 */
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';

const EXPECTED_DIM = Number(process.env.OPENCLAW_EMBEDDING_DIM || 1536);

function getSqlitePath() {
  return (process.env.OPENCLAW_SQLITE_PATH || '').trim();
}

/** @type {import('sql.js').SqlJsStatic | null} */
let SQL = null;
/** @type {import('sql.js').Database | null} */
let db = null;
/** @type {string} */
let dbPathOpened = '';

async function ensureEngine() {
  if (!SQL) {
    SQL = await initSqlJs();
  }
  return SQL;
}

function persist() {
  const p = getSqlitePath();
  if (!db || !p) return;
  const data = db.export();
  writeFileSync(p, Buffer.from(data));
}

export function sqliteBackendConfigured() {
  return Boolean(getSqlitePath());
}

async function openDb() {
  const SQLITE_PATH = getSqlitePath();
  if (!SQLITE_PATH) return null;
  await ensureEngine();
  if (db && dbPathOpened !== SQLITE_PATH) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    db = null;
    dbPathOpened = '';
  }
  if (!db) {
    const dir = path.dirname(SQLITE_PATH);
    if (dir && dir !== '.' && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    let buf = null;
    if (existsSync(SQLITE_PATH)) {
      buf = readFileSync(SQLITE_PATH);
    }
    db = buf ? new SQL.Database(buf) : new SQL.Database();
    dbPathOpened = SQLITE_PATH;
    db.run(`
      CREATE TABLE IF NOT EXISTS perception_capture (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        captured_at TEXT NOT NULL DEFAULT (datetime('now')),
        raw_text TEXT,
        description_text TEXT,
        embedding_json TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        image_mime TEXT,
        image_sha256 TEXT,
        image_bytes BLOB,
        media_path TEXT,
        redis_cache_key TEXT
      );
      CREATE INDEX IF NOT EXISTS perception_capture_captured_at_idx ON perception_capture (captured_at DESC);
      CREATE TABLE IF NOT EXISTS openclaw_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    persist();
  }
  return db;
}

export async function sqliteDbHealth() {
  try {
    const d = await openDb();
    if (!d) return { ok: false, reason: 'OPENCLAW_SQLITE_PATH not set' };
    d.exec('SELECT 1 AS ok');
    return { ok: true, backend: 'sqlite' };
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  }
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * @param {object} row
 */
export async function sqliteInsertPerceptionCapture(row) {
  const d = await openDb();
  if (!d) throw new Error('SQLite not configured');

  const {
    sourceType,
    rawText = null,
    descriptionText = null,
    embedding = null,
    metadata = {},
    imageMime = null,
    imageBytes = null,
    mediaPath = null,
    redisCacheKey = null,
  } = row;

  if (!sourceType || typeof sourceType !== 'string') {
    throw new Error('sourceType is required');
  }
  const allowed = new Set(['screen', 'camera', 'screen_vision', 'multimodal']);
  if (!allowed.has(sourceType)) {
    throw new Error(`sourceType must be one of ${[...allowed].join(', ')}`);
  }

  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  const metaStr = JSON.stringify(meta);
  const hash =
    imageBytes && Buffer.isBuffer(imageBytes) && imageBytes.length ? sha256Hex(imageBytes) : null;

  const id = crypto.randomUUID();
  let embeddingJson = null;
  if (embedding != null && Array.isArray(embedding) && embedding.length > 0) {
    if (embedding.length !== EXPECTED_DIM) {
      throw new Error(`embedding must be a length-${EXPECTED_DIM} number array`);
    }
    embeddingJson = JSON.stringify(embedding.map((n) => Number(n)));
  }

  d.run(
    `INSERT INTO perception_capture (
      id, source_type, raw_text, description_text, embedding_json, metadata,
      image_mime, image_sha256, image_bytes, media_path, redis_cache_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      sourceType,
      rawText,
      descriptionText,
      embeddingJson,
      metaStr,
      imageMime,
      hash,
      imageBytes ?? null,
      mediaPath,
      redisCacheKey,
    ],
  );
  persist();

  const stmt = d.prepare('SELECT id, captured_at FROM perception_capture WHERE id = ?');
  stmt.bind([id]);
  stmt.step();
  const rowOut = stmt.getAsObject();
  stmt.free();
  return { id: rowOut.id, captured_at: rowOut.captured_at };
}

/** @param {number[]} embedding */
export async function sqliteSearchPerceptionByVector(embedding, limit = 10) {
  const d = await openDb();
  if (!d) throw new Error('SQLite not configured');
  if (!Array.isArray(embedding) || embedding.length !== EXPECTED_DIM) {
    throw new Error(`query embedding must be length ${EXPECTED_DIM}`);
  }
  const q = embedding.map((n) => Number(n));

  const res = d.exec(
    `SELECT id, source_type, captured_at, raw_text, description_text, metadata, media_path, embedding_json
     FROM perception_capture
     WHERE embedding_json IS NOT NULL AND embedding_json != ''`,
  );
  const rows = [];
  if (res[0]) {
    const cols = res[0].columns;
    for (const values of res[0].values) {
      const r = {};
      cols.forEach((c, i) => {
        r[c] = values[i];
      });
      rows.push(r);
    }
  }

  const scored = [];
  for (const r of rows) {
    try {
      const vec = JSON.parse(String(r.embedding_json));
      if (!Array.isArray(vec) || vec.length !== EXPECTED_DIM) continue;
      const sim = cosineSimilarity(q, vec);
      scored.push({
        id: r.id,
        source_type: r.source_type,
        captured_at: r.captured_at,
        raw_text: r.raw_text,
        description_text: r.description_text,
        metadata: JSON.parse(String(r.metadata || '{}')),
        media_path: r.media_path,
        cosine_similarity: sim,
      });
    } catch {
      /* skip */
    }
  }
  scored.sort((a, b) => b.cosine_similarity - a.cosine_similarity);
  return scored.slice(0, Math.min(100, Math.max(1, limit)));
}

export async function sqliteListRecentCaptures(limit = 20) {
  const d = await openDb();
  if (!d) throw new Error('SQLite not configured');
  const lim = Math.min(100, Math.max(1, limit));

  const res = d.exec(
    `SELECT id, source_type, captured_at,
            TRIM(SUBSTR(COALESCE(description_text, raw_text, ''), 1, 200)) AS preview,
            metadata, media_path, image_sha256,
            CASE WHEN image_bytes IS NOT NULL THEN 1 ELSE 0 END AS has_image_bytes
     FROM perception_capture
     ORDER BY captured_at DESC
     LIMIT ${lim}`,
  );

  const rows = [];
  if (res[0]) {
    const cols = res[0].columns;
    for (const values of res[0].values) {
      const obj = {};
      cols.forEach((c, i) => {
        obj[c] = values[i];
      });
      rows.push({
        ...obj,
        metadata: typeof obj.metadata === 'string' ? JSON.parse(obj.metadata || '{}') : obj.metadata,
        has_image_bytes: Boolean(obj.has_image_bytes),
      });
    }
  }
  return rows;
}

/** @returns {string|null} */
export async function sqliteGetSetting(key) {
  const d = await openDb();
  if (!d) return null;
  try {
    const stmt = d.prepare('SELECT value FROM openclaw_settings WHERE key = ? LIMIT 1');
    stmt.bind([key]);
    if (stmt.step()) {
      const v = stmt.getAsObject().value;
      stmt.free();
      return v != null ? String(v) : null;
    }
    stmt.free();
    return null;
  } catch {
    return null;
  }
}

export async function sqliteSetSetting(key, value) {
  const d = await openDb();
  if (!d) throw new Error('SQLite not configured');
  d.run(
    `INSERT OR REPLACE INTO openclaw_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
    [key, String(value)],
  );
  persist();
}
