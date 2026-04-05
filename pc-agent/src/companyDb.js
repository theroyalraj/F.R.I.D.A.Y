/**
 * Org-scoped company profile (Postgres) + Claude/voice context cache by org_id.
 * Admin-only writes are enforced in organizationRoutes (requireAdmin).
 */
import { getPool, usesSqliteBackend } from './perceptionDb.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
/** @type {Map<string, { text: string, at: number }>} */
const _companyContextCacheByOrgId = new Map();

function requirePg() {
  if (usesSqliteBackend()) {
    throw new Error('Company profiles require Postgres (OPENCLAW_DATABASE_URL).');
  }
  const pool = getPool();
  if (!pool) throw new Error('Database not configured — set OPENCLAW_DATABASE_URL.');
  return pool;
}

/**
 * @param {{ name?: string, description?: string, mission?: string, vision?: string } | null} row
 */
export function buildCompanyContextPrompt(row) {
  if (!row) return '';
  const name = String(row.name || '').trim();
  const description = String(row.description || '').trim();
  const mission = String(row.mission || '').trim();
  const vision = String(row.vision || '').trim();
  if (!name && !description && !mission && !vision) return '';
  const lines = [
    'COMPANY CONTEXT (use this to inform your identity and responses):',
    name || description
      ? `Company: ${name || 'Organization'}${description ? ` — ${description}` : ''}`
      : '',
    mission ? `Mission: ${mission}` : '',
    vision ? `Vision: ${vision}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

/** Drop cached voice/Claude context for an org (call after profile updates). */
export function invalidateCompanyContextCache(orgId) {
  if (orgId) _companyContextCacheByOrgId.delete(String(orgId));
}

/**
 * @param {string} orgId
 * @returns {Promise<{ orgId: string, name: string, description: string, mission: string, vision: string, updatedAt?: Date }|null>}
 */
export async function getCompanyProfileByOrgId(orgId) {
  const pool = requirePg();
  const r = await pool.query(
    `SELECT org_id AS "orgId", name, description, mission, vision, updated_at AS "updatedAt"
     FROM openclaw_company_profiles WHERE org_id = $1`,
    [orgId],
  );
  if (!r.rows[0]) return null;
  return r.rows[0];
}

/**
 * @param {string} orgId
 */
export async function ensureCompanyProfileRow(orgId) {
  const pool = requirePg();
  await pool.query(
    `INSERT INTO openclaw_company_profiles (org_id) VALUES ($1)
     ON CONFLICT (org_id) DO NOTHING`,
    [orgId],
  );
}

/**
 * Merge patch into existing profile; invalidates org_id voice cache.
 * @param {string} orgId
 * @param {{ name?: string, description?: string, mission?: string, vision?: string }} patch
 */
export async function upsertCompanyProfile(orgId, patch) {
  const pool = requirePg();
  await ensureCompanyProfileRow(orgId);
  const cur = await getCompanyProfileByOrgId(orgId);
  const name = patch.name !== undefined ? String(patch.name) : cur?.name ?? '';
  const description = patch.description !== undefined ? String(patch.description) : cur?.description ?? '';
  const mission = patch.mission !== undefined ? String(patch.mission) : cur?.mission ?? '';
  const vision = patch.vision !== undefined ? String(patch.vision) : cur?.vision ?? '';
  await pool.query(
    `UPDATE openclaw_company_profiles
     SET name = $2, description = $3, mission = $4, vision = $5, updated_at = NOW()
     WHERE org_id = $1`,
    [orgId, name, description, mission, vision],
  );
  invalidateCompanyContextCache(orgId);
  return getCompanyProfileByOrgId(orgId);
}

/**
 * Cached COMPANY CONTEXT string for Claude / voice hot path (keyed by org_id, TTL 5 min).
 * @param {string} orgId
 */
export async function getCachedCompanyContextString(orgId) {
  if (!orgId) return '';
  const key = String(orgId);
  const now = Date.now();
  const hit = _companyContextCacheByOrgId.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) {
    return hit.text;
  }
  const profile = await getCompanyProfileByOrgId(orgId);
  const text = buildCompanyContextPrompt(profile);
  _companyContextCacheByOrgId.set(key, { text, at: now });
  return text;
}
