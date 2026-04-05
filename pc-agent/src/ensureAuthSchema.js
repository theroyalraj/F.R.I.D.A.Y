/**
 * If Postgres is configured but auth tables are missing (common when the DB volume
 * predates Listen UI migrations), apply docker/postgres/init/04 + 05 once at startup.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, usesSqliteBackend, perceptionDbConfigured } from './perceptionDb.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INIT_DIR = path.resolve(__dirname, '../../docker/postgres/init');

const INIT_FILES = ['04-auth-company.sql', '05-multitenant-org.sql'];
const AI_LOG_FILE = '07-ai-generation-log.sql';

export async function ensureAuthSchema(log) {
  if (usesSqliteBackend() || !perceptionDbConfigured()) return;
  const pool = getPool();
  if (!pool) return;

  try {
    const chk = await pool.query("SELECT to_regclass('public.openclaw_users') AS reg");
    if (chk.rows[0]?.reg) return;
  } catch (e) {
    log?.warn({ err: String(e.message || e) }, 'ensureAuthSchema: regclass check failed');
    return;
  }

  log?.info('Postgres auth tables missing — applying docker/postgres/init 04 + 05');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const f of INIT_FILES) {
      const fp = path.join(INIT_DIR, f);
      const sql = readFileSync(fp, 'utf8');
      await client.query(sql);
    }
    await client.query('COMMIT');
    log?.info('Auth schema ready (openclaw_users, organizations, company_profiles).');
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    log?.error(
      { err: String(e.message || e), code: e.code, detail: e.detail },
      'ensureAuthSchema: failed to apply init SQL',
    );
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Apply 07-ai-generation-log.sql when `ai_generation_log` is missing (existing DB volumes).
 */
export async function ensureAiGenerationLogSchema(log) {
  if (usesSqliteBackend() || !perceptionDbConfigured()) return;
  const pool = getPool();
  if (!pool) return;

  try {
    const chk = await pool.query("SELECT to_regclass('public.ai_generation_log') AS reg");
    if (chk.rows[0]?.reg) return;
  } catch (e) {
    log?.warn({ err: String(e.message || e) }, 'ensureAiGenerationLogSchema: regclass check failed');
    return;
  }

  log?.info('ai_generation_log missing — applying docker/postgres/init/07-ai-generation-log.sql');

  const client = await pool.connect();
  try {
    const fp = path.join(INIT_DIR, AI_LOG_FILE);
    const sql = readFileSync(fp, 'utf8');
    await client.query(sql);
    log?.info('AI generation log table ready.');
  } catch (e) {
    log?.error(
      { err: String(e.message || e), code: e.code, detail: e.detail },
      'ensureAiGenerationLogSchema: failed to apply init SQL',
    );
  } finally {
    client.release();
  }
}
