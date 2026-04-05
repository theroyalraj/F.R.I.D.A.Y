import bcrypt from 'bcryptjs';
import { AuthDbError } from './authDb.js';
import { emailDomain, isGenericEmailDomain, defaultOrgNameFromDomain } from './tenantLogic.js';
import { getPool, usesSqliteBackend } from './perceptionDb.js';

const SALT_ROUNDS = 10;

function requirePool() {
  if (usesSqliteBackend()) {
    throw new AuthDbError('SQLITE_BACKEND', 'Auth requires Postgres (OPENCLAW_DATABASE_URL).');
  }
  const pool = getPool();
  if (!pool) throw new AuthDbError('NO_DATABASE', 'Database not configured — set OPENCLAW_DATABASE_URL.');
  return pool;
}

/**
 * @param {string} email
 * @param {string} password
 * @param {string} [displayName]
 * @returns {Promise<{ user: { id: string, email: string, name: string }, orgId: string, role: 'admin'|'member' }>}
 */
export async function signupWithOrg(email, password, displayName = '') {
  const pool = requirePool();
  const em = String(email || '').trim().toLowerCase();
  const pw = String(password || '');
  const nm = String(displayName || '').trim();
  if (!em || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
    throw new AuthDbError('INVALID_EMAIL', 'Valid email is required');
  }
  if (pw.length < 8) {
    throw new AuthDbError('WEAK_PASSWORD', 'Password must be at least 8 characters');
  }

  const domain = emailDomain(em);
  const generic = isGenericEmailDomain(domain);

  const passwordHash = await bcrypt.hash(pw, SALT_ROUNDS);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const insUser = await client.query(
      `INSERT INTO openclaw_users (email, password_hash, name)
       VALUES ($1, $2, $3)
       RETURNING id, email, name`,
      [em, passwordHash, nm],
    );
    const user = insUser.rows[0];

    let orgId;
    let role;

    if (generic) {
      const orgName = nm || 'Personal';
      const orgIns = await client.query(
        `INSERT INTO openclaw_organizations (domain, name)
         VALUES (NULL, $1)
         RETURNING id`,
        [orgName],
      );
      orgId = orgIns.rows[0].id;
      role = 'admin';
      await client.query(
        `INSERT INTO openclaw_org_members (org_id, user_id, role) VALUES ($1, $2, $3)`,
        [orgId, user.id, role],
      );
      await client.query(
        `INSERT INTO openclaw_company_profiles (org_id) VALUES ($1) ON CONFLICT (org_id) DO NOTHING`,
        [orgId],
      );
    } else {
      const existing = await client.query(
        `SELECT id FROM openclaw_organizations WHERE domain IS NOT NULL AND lower(domain) = lower($1)`,
        [domain],
      );
      if (existing.rows.length === 0) {
        const orgLabel = defaultOrgNameFromDomain(domain);
        const orgIns = await client.query(
          `INSERT INTO openclaw_organizations (domain, name)
           VALUES ($1, $2)
           RETURNING id`,
          [domain, orgLabel],
        );
        orgId = orgIns.rows[0].id;
        role = 'admin';
      } else {
        orgId = existing.rows[0].id;
        role = 'member';
      }
      await client.query(
        `INSERT INTO openclaw_org_members (org_id, user_id, role) VALUES ($1, $2, $3)`,
        [orgId, user.id, role],
      );
      await client.query(
        `INSERT INTO openclaw_company_profiles (org_id) VALUES ($1) ON CONFLICT (org_id) DO NOTHING`,
        [orgId],
      );
    }

    await client.query('COMMIT');
    return { user, orgId, role };
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') {
      throw new AuthDbError('EMAIL_EXISTS', 'An account with this email already exists');
    }
    throw e;
  } finally {
    client.release();
  }
}
