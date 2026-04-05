/**
 * actionItemsDb.js — Action items + scan log in PostgreSQL (same pool as perception).
 */

import crypto from 'node:crypto';
import { getPool } from './perceptionDb.js';

function mapRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    title: row.title,
    detail: row.detail ?? '',
    titleHash: row.title_hash,
    category: row.category,
    priority: row.priority,
    status: row.status,
    source: row.source,
    sourceMessageId: row.source_message_id ?? null,
    sourceSender: row.source_sender ?? null,
    sourceSubject: row.source_subject ?? null,
    dueAt: row.due_at ? (row.due_at instanceof Date ? row.due_at.toISOString() : row.due_at) : null,
    dueNatural: row.due_natural ?? null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    completedAt: row.completed_at
      ? row.completed_at instanceof Date
        ? row.completed_at.toISOString()
        : row.completed_at
      : null,
    lastRemindedAt: row.last_reminded_at
      ? row.last_reminded_at instanceof Date
        ? row.last_reminded_at.toISOString()
        : row.last_reminded_at
      : null,
    remindCount: row.remind_count ?? 0,
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
    linkedTodoId: row.linked_todo_id ? String(row.linked_todo_id) : null,
  };
}

function safeUuid(s) {
  if (!s || typeof s !== 'string') return null;
  const t = s.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(t)) {
    return null;
  }
  return t;
}

function titleHash(title) {
  const n = String(title || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return crypto.createHash('sha256').update(n).digest('hex');
}

export function actionItemsDbAvailable() {
  return Boolean(getPool());
}

/** Mark all action items linked to this todo as done (called when todo completed). */
export async function markLinkedActionItemsDone(todoId) {
  const pool = getPool();
  if (!pool) return 0;
  const r = await pool.query(
    `UPDATE action_items
     SET status = 'done', completed_at = COALESCE(completed_at, now()), updated_at = now()
     WHERE linked_todo_id = $1::uuid AND status NOT IN ('done', 'dismissed')`,
    [todoId],
  );
  return r.rowCount ?? 0;
}

export async function listActionItems({ status, priority } = {}) {
  const pool = getPool();
  if (!pool) return [];
  const conds = [];
  const vals = [];
  let n = 1;
  if (status) {
    conds.push(`status = $${n++}`);
    vals.push(status);
  }
  if (priority) {
    conds.push(`priority = $${n++}`);
    vals.push(priority);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const r = await pool.query(
    `SELECT * FROM action_items ${where} ORDER BY
       CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
       created_at DESC`,
    vals,
  );
  return r.rows.map(mapRow);
}

/** Pending items grouped by priority (for GET /action-items/summary). */
export async function summaryByPriority() {
  const items = await listActionItems({ status: 'pending' });
  const groups = { critical: [], high: [], medium: [], low: [] };
  for (const it of items) {
    const p = groups[it.priority] ? it.priority : 'medium';
    groups[p].push(it);
  }
  return { ok: true, pendingCount: items.length, byPriority: groups };
}

export async function getActionItem(id) {
  const pool = getPool();
  if (!pool) return null;
  const r = await pool.query('SELECT * FROM action_items WHERE id = $1::uuid', [id]);
  return mapRow(r.rows[0]);
}

export async function insertActionItem(row) {
  const pool = getPool();
  if (!pool) throw new Error('Database not configured');
  const th = row.titleHash || titleHash(row.title);
  const r = await pool.query(
    `INSERT INTO action_items (
       title, detail, title_hash, category, priority, status, source,
       source_message_id, source_sender, source_subject, due_at, due_natural, metadata, linked_todo_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, $12, $13::jsonb, $14::uuid)
     RETURNING *`,
    [
      String(row.title || '').trim(),
      row.detail != null ? String(row.detail) : null,
      th,
      row.category || 'general',
      ['critical', 'high', 'medium', 'low'].includes(row.priority) ? row.priority : 'medium',
      row.status && ['pending', 'in_progress', 'done', 'dismissed'].includes(row.status)
        ? row.status
        : 'pending',
      String(row.source || 'unknown'),
      row.sourceMessageId ?? null,
      row.sourceSender ?? null,
      row.sourceSubject ?? null,
      row.dueAt ? new Date(row.dueAt) : null,
      row.dueNatural ?? null,
      JSON.stringify(row.metadata && typeof row.metadata === 'object' ? row.metadata : {}),
      safeUuid(row.linkedTodoId),
    ],
  );
  return mapRow(r.rows[0]);
}

export async function updateActionItem(id, patch) {
  const pool = getPool();
  if (!pool) return null;
  const sets = [];
  const vals = [];
  let n = 1;
  const map = {
    title: 'title',
    detail: 'detail',
    category: 'category',
    priority: 'priority',
    status: 'status',
    dueAt: 'due_at',
    dueNatural: 'due_natural',
    metadata: 'metadata',
  };
  for (const [k, col] of Object.entries(map)) {
    if (patch[k] !== undefined) {
      if (k === 'dueAt') {
        sets.push(`due_at = $${n++}::timestamptz`);
        vals.push(patch[k] ? new Date(patch[k]) : null);
      } else if (k === 'metadata') {
        sets.push(`metadata = $${n++}::jsonb`);
        vals.push(JSON.stringify(patch[k] || {}));
      } else if (k === 'title') {
        sets.push(`title = $${n++}`);
        vals.push(patch[k]);
        sets.push(`title_hash = $${n++}`);
        vals.push(titleHash(String(patch[k] || '')));
      } else {
        sets.push(`${col} = $${n++}`);
        vals.push(patch[k]);
      }
    }
  }
  if (!sets.length) return getActionItem(id);
  sets.push('updated_at = now()');
  vals.push(id);
  const r = await pool.query(
    `UPDATE action_items SET ${sets.join(', ')} WHERE id = $${n}::uuid RETURNING *`,
    vals,
  );
  return mapRow(r.rows[0]);
}

export async function markActionItemDone(id) {
  const pool = getPool();
  if (!pool) return null;
  const r = await pool.query(
    `UPDATE action_items
     SET status = 'done', completed_at = COALESCE(completed_at, now()), updated_at = now()
     WHERE id = $1::uuid RETURNING *`,
    [id],
  );
  return mapRow(r.rows[0]);
}

export async function markActionItemDismissed(id) {
  const pool = getPool();
  if (!pool) return null;
  const r = await pool.query(
    `UPDATE action_items SET status = 'dismissed', updated_at = now() WHERE id = $1::uuid RETURNING *`,
    [id],
  );
  return mapRow(r.rows[0]);
}

export async function deleteActionItem(id) {
  const pool = getPool();
  if (!pool) return false;
  const r = await pool.query('DELETE FROM action_items WHERE id = $1::uuid', [id]);
  return r.rowCount > 0;
}

/** Pending items eligible for reminder (cooldown passed). */
export async function listPendingForReminder(cooldownSec) {
  const pool = getPool();
  if (!pool) return [];
  const sec = Math.max(60, Number(cooldownSec) || 3600);
  const r = await pool.query(
    `SELECT * FROM action_items
     WHERE status = 'pending'
       AND (
         last_reminded_at IS NULL
         OR last_reminded_at <= (NOW() - ($1::double precision * INTERVAL '1 second'))
       )
     ORDER BY
       CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
       created_at ASC`,
    [sec],
  );
  return r.rows.map(mapRow);
}

export async function bumpReminderStats(ids) {
  const pool = getPool();
  if (!pool || !ids?.length) return;
  await pool.query(
    `UPDATE action_items
     SET last_reminded_at = now(), remind_count = remind_count + 1, updated_at = now()
     WHERE id = ANY($1::uuid[])`,
    [ids],
  );
}

export async function isMessageScanned(source, sourceMessageId) {
  const pool = getPool();
  if (!pool) return false;
  const r = await pool.query(
    'SELECT 1 FROM message_scan_log WHERE source = $1 AND source_message_id = $2 LIMIT 1',
    [source, String(sourceMessageId)],
  );
  return r.rows.length > 0;
}

export async function logMessageScan(source, sourceMessageId, actionCount, rawSnippet) {
  const pool = getPool();
  if (!pool) return;
  await pool.query(
    `INSERT INTO message_scan_log (source, source_message_id, action_count, raw_snippet)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (source, source_message_id) DO UPDATE SET
       scanned_at = now(), action_count = EXCLUDED.action_count, raw_snippet = EXCLUDED.raw_snippet`,
    [source, String(sourceMessageId), actionCount, rawSnippet ? String(rawSnippet).slice(0, 2000) : null],
  );
}

export async function existsTitleHashPending(titleHashHex) {
  const pool = getPool();
  if (!pool) return false;
  const r = await pool.query(
    `SELECT 1 FROM action_items WHERE title_hash = $1 AND status = 'pending' LIMIT 1`,
    [titleHashHex],
  );
  return r.rows.length > 0;
}

export { titleHash };
