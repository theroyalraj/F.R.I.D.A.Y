import { getPool, usesSqliteBackend, perceptionDbConfigured } from './perceptionDb.js';

/**
 * @param {{ userId?: string|null, orgId?: string|null, source: string, clientSessionKey: string, log?: import('pino').Logger }} args
 * @returns {Promise<string|null>} session UUID
 */
export async function upsertConversationSession(args) {
  if (usesSqliteBackend() || !perceptionDbConfigured()) return null;
  const pool = getPool();
  if (!pool) return null;
  const key = String(args.clientSessionKey || '').trim().slice(0, 256);
  if (!key) return null;
  const uid = String(args.userId ?? '').slice(0, 512);
  const src = String(args.source || '').slice(0, 120);
  const org = args.orgId != null && String(args.orgId).trim() ? String(args.orgId).trim().slice(0, 120) : null;

  try {
    const r = await pool.query(
      `INSERT INTO conversation_session (user_id, org_id, source, client_session_key)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, client_session_key) DO UPDATE SET
         source = EXCLUDED.source,
         org_id = COALESCE(EXCLUDED.org_id, conversation_session.org_id)
       RETURNING id::text AS id`,
      [uid, org, src, key],
    );
    return r.rows[0]?.id || null;
  } catch (e) {
    args.log?.warn({ err: String(e?.message || e).slice(0, 200) }, 'upsertConversationSession failed');
    return null;
  }
}
