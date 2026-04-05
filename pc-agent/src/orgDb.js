/**
 * Postgres tenant org + membership (multi-tenant by domain).
 */
import { getPool, usesSqliteBackend } from './perceptionDb.js';

function requirePg() {
  if (usesSqliteBackend()) {
    throw new Error('Organizations require Postgres (OPENCLAW_DATABASE_URL).');
  }
  const pool = getPool();
  if (!pool) throw new Error('Database not configured — set OPENCLAW_DATABASE_URL.');
  return pool;
}

/**
 * @param {string} orgId
 * @returns {Promise<{ id: string, domain: string | null, name: string, created_at?: Date }|null>}
 */
export async function getOrgById(orgId) {
  const pool = requirePg();
  const r = await pool.query(
    'SELECT id, domain, name, created_at FROM openclaw_organizations WHERE id = $1',
    [orgId],
  );
  return r.rows[0] ?? null;
}

/** @deprecated Use getOrgById — alias for existing call sites. */
export const getOrganizationById = getOrgById;

/**
 * @param {string} domain — registrable domain (e.g. lenskart.com)
 * @returns {Promise<{ id: string, domain: string | null, name: string }|null>}
 */
export async function getOrgByDomain(domain) {
  const pool = requirePg();
  const d = String(domain || '').trim().toLowerCase();
  if (!d) return null;
  const r = await pool.query(
    'SELECT id, domain, name, created_at FROM openclaw_organizations WHERE lower(domain) = lower($1)',
    [d],
  );
  return r.rows[0] ?? null;
}

/** @deprecated Use getOrgByDomain */
export const getOrganizationByDomain = getOrgByDomain;

/**
 * Membership for a user (MVP: one org per user).
 * @param {string} userId
 * @returns {Promise<{ orgId: string, role: 'admin' | 'member' }|null>}
 */
export async function getMembership(userId) {
  const pool = requirePg();
  const r = await pool.query(
    'SELECT org_id AS "orgId", role FROM openclaw_org_members WHERE user_id = $1 LIMIT 1',
    [userId],
  );
  if (!r.rows[0]) return null;
  return { orgId: r.rows[0].orgId, role: r.rows[0].role };
}

/** @deprecated Use getMembership */
export const getMembershipForUser = getMembership;

/**
 * First org member for dev auto-login (admin preferred). Used when PC_AGENT_LISTEN_AUTO_LOGIN is on.
 * @returns {Promise<{ id: string, email: string, name: string, orgId: string, role: 'admin'|'member' }|null>}
 */
export async function findFirstUserWithMembershipForAutoLogin() {
  const pool = requirePg();
  const r = await pool.query(
    `SELECT u.id, u.email, u.name, m.org_id AS "orgId", m.role
     FROM openclaw_org_members m
     JOIN openclaw_users u ON u.id = m.user_id
     ORDER BY CASE WHEN m.role = 'admin' THEN 0 ELSE 1 END, u.created_at ASC NULLS LAST
     LIMIT 1`,
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    orgId: row.orgId,
    role: row.role === 'admin' ? 'admin' : 'member',
  };
}
