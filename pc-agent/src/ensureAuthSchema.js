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
