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
