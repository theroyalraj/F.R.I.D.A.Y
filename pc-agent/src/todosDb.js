/**
 * todosDb.js — Todos + reminders in PostgreSQL (OPENCLAW_DATABASE_URL).
 * Migrates legacy data/todos.json once → data/todos.json.migrated.
 * If Postgres is unavailable, falls back to JSON file (same paths as before).
 *
 * All reads/writes are scoped by { orgId, userId } (see todoRequestContext in authMiddleware).
 * Legacy bucket: both null — shared anonymous/device todos (no JWT, or agent without default env).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';
import { getPool } from './perceptionDb.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'todos.json');
const MIGRATED_PATH = path.join(DATA_DIR, 'todos.json.migrated');

const EMPTY_DB = () => ({ todos: [], reminders: [] });

/** @typedef {{ orgId: string|null, userId: string|null }} TodoScope */

/** Anonymous / legacy file bucket — also used by smoke scripts. */
export const LEGACY_TODO_SCOPE = Object.freeze({ orgId: null, userId: null });

let migrationPromise = null;

function _ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function _readJson() {
  try {
    if (!existsSync(DB_PATH)) return EMPTY_DB();
    const raw = readFileSync(DB_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      todos: Array.isArray(parsed.todos) ? parsed.todos : [],
      reminders: Array.isArray(parsed.reminders) ? parsed.reminders : [],
    };
  } catch {
    return EMPTY_DB();
  }
}

function _writeJson(db) {
  _ensureDir();
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf-8');
}

function _nowIso() {
  return new Date().toISOString();
}

function safeTodoUuid(s) {
  if (!s || typeof s !== 'string') return null;
  const t = s.trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(t)
  ) {
    return null;
  }
  return t;
}

/** @param {TodoScope|undefined|null} scope */
export function normalizeTodoScope(scope) {
  if (!scope) return { orgId: null, userId: null };
  return {
    orgId: scope.orgId != null && scope.orgId !== '' ? String(scope.orgId) : null,
    userId: scope.userId != null && scope.userId !== '' ? String(scope.userId) : null,
  };
}

function matchesJsonScope(item, scope) {
  const s = normalizeTodoScope(scope);
  const o = item.orgId ?? null;
  const u = item.userId ?? null;
  if (s.orgId == null && s.userId == null) {
    return o == null && u == null;
  }
  return o === s.orgId && u === s.userId;
}

/**
 * SQL: legacy (both cols null) OR exact org/user match.
 * @param {number} p1 1-based param index for org_id
 * @param {string} [alias] table alias + dot
 */
function sqlTodoScope(p1, alias = '') {
  const org = `${alias}org_id`;
  const uid = `${alias}user_id`;
  const a = p1;
  const b = p1 + 1;
  return `((($${a}::uuid IS NULL AND $${b}::uuid IS NULL) AND ${org} IS NULL AND ${uid} IS NULL) OR (${org} = $${a} AND ${uid} = $${b}))`;
}

function mapTodoRow(row) {
  if (!row) return null;
  const ca = row.created_at;
  const ua = row.updated_at;
  return {
    id: String(row.id),
    title: row.title,
    detail: row.detail ?? '',
    priority: row.priority,
    done: Boolean(row.done),
    pinned: Boolean(row.pinned),
    silentRemind: Boolean(row.silent_remind),
    source: row.source ?? 'manual',
    createdAt: ca instanceof Date ? ca.toISOString() : ca,
    updatedAt: ua instanceof Date ? ua.toISOString() : ua,
  };
}

function mapReminderRow(row) {
  if (!row) return null;
  const di = row.due_iso;
  const fa = row.fired_at;
  const ca = row.created_at;
  return {
    id: String(row.id),
    title: row.title,
    dueIso: di ? (di instanceof Date ? di.toISOString() : di) : null,
    dueNatural: row.due_natural ?? '',
    fired: Boolean(row.fired),
    firedAt: fa ? (fa instanceof Date ? fa.toISOString() : fa) : undefined,
    todoId: row.todo_id ? String(row.todo_id) : null,
    createdAt: ca instanceof Date ? ca.toISOString() : ca,
  };
}

async function ensureJsonMigrated(pool) {
  if (migrationPromise) return migrationPromise;
  migrationPromise = (async () => {
    if (!existsSync(DB_PATH) || existsSync(MIGRATED_PATH)) return;
    const db = _readJson();
    if (!db.todos.length && !db.reminders.length) {
      try {
        renameSync(DB_PATH, MIGRATED_PATH);
      } catch {
        /* ignore */
      }
      return;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const t of db.todos) {
        const id = t.id && String(t.id).length >= 32 ? t.id : crypto.randomUUID();
        await client.query(
          `INSERT INTO todos (id, title, detail, priority, done, pinned, silent_remind, source, org_id, user_id, created_at, updated_at)
           VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, NULL, NULL, COALESCE($9::timestamptz, now()), COALESCE($10::timestamptz, now()))
           ON CONFLICT (id) DO NOTHING`,
          [
            id,
            String(t.title || '').trim(),
            String(t.detail || '').trim(),
            ['high', 'medium', 'low'].includes(t.priority) ? t.priority : 'medium',
            Boolean(t.done),
            Boolean(t.pinned),
            Boolean(t.silentRemind),
            String(t.source || 'manual').trim(),
            t.createdAt || null,
            t.updatedAt || null,
          ],
        );
      }
      for (const r of db.reminders) {
        const id = r.id && String(r.id).length >= 32 ? r.id : crypto.randomUUID();
        let todoId = safeTodoUuid(r.todoId);
        if (todoId && !db.todos.some((x) => String(x.id) === String(todoId))) todoId = null;
        await client.query(
          `INSERT INTO reminders (id, title, due_iso, due_natural, fired, fired_at, todo_id, org_id, user_id, created_at)
           VALUES ($1::uuid, $2, $3::timestamptz, $4, $5, $6::timestamptz, $7::uuid, NULL, NULL, COALESCE($8::timestamptz, now()))
           ON CONFLICT (id) DO NOTHING`,
          [
            id,
            String(r.title || '').trim(),
            r.dueIso ? new Date(r.dueIso) : null,
            String(r.dueNatural || '').trim(),
            Boolean(r.fired),
            r.firedAt ? new Date(r.firedAt) : null,
            todoId,
            r.createdAt || null,
          ],
        );
      }
      await client.query('COMMIT');
      renameSync(DB_PATH, MIGRATED_PATH);
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    } finally {
      client.release();
    }
  })();
  return migrationPromise;
}

function usePostgres() {
  const pool = getPool();
  return pool;
}

// ── Postgres implementation ─────────────────────────────────────────────────

const TODO_SELECT =
  'SELECT id, title, detail, priority, done, pinned, silent_remind, source, created_at, updated_at FROM todos';
const REM_SELECT =
  'SELECT id, title, due_iso, due_natural, fired, fired_at, todo_id, created_at FROM reminders';

/**
 * @param {TodoScope} [scope]
 */
export async function getTodos(scope = LEGACY_TODO_SCOPE) {
  const s = normalizeTodoScope(scope);
  const pool = usePostgres();
  if (!pool) {
    return _readJson().todos.filter((t) => matchesJsonScope(t, s));
  }
  await ensureJsonMigrated(pool);
  const r = await pool.query(
    `${TODO_SELECT} WHERE ${sqlTodoScope(1)} ORDER BY created_at DESC`,
    [s.orgId, s.userId],
  );
  return r.rows.map(mapTodoRow);
}

/**
 * @param {{ title: string, detail?: string, priority?: 'high'|'medium'|'low', source?: string, pinned?: boolean, silentRemind?: boolean }} item
 * @param {TodoScope} [scope]
 */
export async function addTodo(item, scope = LEGACY_TODO_SCOPE) {
  const s = normalizeTodoScope(scope);
  const pool = usePostgres();
  const pinned = Boolean(item.pinned);
  const silentRemind = Boolean(item.silentRemind);
  if (!pool) {
    const db = _readJson();
    const todo = {
      id: crypto.randomUUID(),
      title: String(item.title || '').trim(),
      detail: String(item.detail || '').trim(),
      priority: ['high', 'medium', 'low'].includes(item.priority) ? item.priority : 'medium',
      done: false,
      pinned,
      silentRemind,
      source: String(item.source || 'manual').trim(),
      orgId: s.orgId,
      userId: s.userId,
      createdAt: _nowIso(),
      updatedAt: _nowIso(),
    };
    db.todos.unshift(todo);
    _writeJson(db);
    return todo;
  }
  await ensureJsonMigrated(pool);
  const pr = ['high', 'medium', 'low'].includes(item.priority) ? item.priority : 'medium';
  const r = await pool.query(
    `INSERT INTO todos (title, detail, priority, done, pinned, silent_remind, source, org_id, user_id)
     VALUES ($1, $2, $3, false, $4, $5, $6, $7::uuid, $8::uuid)
     RETURNING id, title, detail, priority, done, pinned, silent_remind, source, created_at, updated_at`,
    [
      String(item.title || '').trim(),
      String(item.detail || '').trim(),
      pr,
      pinned,
      silentRemind,
      String(item.source || 'manual').trim(),
      s.orgId,
      s.userId,
    ],
  );
  return mapTodoRow(r.rows[0]);
}

/**
 * @param {TodoScope} [scope]
 */
export async function updateTodo(id, patch, scope = LEGACY_TODO_SCOPE) {
  const s = normalizeTodoScope(scope);
  const pool = usePostgres();
  if (!pool) {
    const db = _readJson();
    const idx = db.todos.findIndex((t) => t.id === id && matchesJsonScope(t, s));
    if (idx === -1) return null;
    const allowed = ['title', 'detail', 'priority', 'done', 'pinned', 'silentRemind'];
    for (const k of allowed) {
      if (patch[k] !== undefined) db.todos[idx][k] = patch[k];
    }
    db.todos[idx].updatedAt = _nowIso();
    _writeJson(db);
    return db.todos[idx];
  }
  await ensureJsonMigrated(pool);
  const sets = [];
  const vals = [];
  let n = 1;
  if (patch.title !== undefined) {
    sets.push(`title = $${n++}`);
    vals.push(patch.title);
  }
  if (patch.detail !== undefined) {
    sets.push(`detail = $${n++}`);
    vals.push(patch.detail);
  }
  if (patch.priority !== undefined) {
    sets.push(`priority = $${n++}`);
    vals.push(patch.priority);
  }
  if (patch.done !== undefined) {
    sets.push(`done = $${n++}`);
    vals.push(Boolean(patch.done));
  }
  if (patch.pinned !== undefined) {
    sets.push(`pinned = $${n++}`);
    vals.push(Boolean(patch.pinned));
  }
  if (patch.silentRemind !== undefined) {
    sets.push(`silent_remind = $${n++}`);
    vals.push(Boolean(patch.silentRemind));
  }
  const idParam = n++;
  vals.push(id);
  const scopeA = n;
  n += 2;
  vals.push(s.orgId, s.userId);
  const scopeSql = sqlTodoScope(scopeA);

  if (!sets.length) {
    const cur = await pool.query(
      `${TODO_SELECT} WHERE id = $${idParam}::uuid AND ${scopeSql}`,
      vals,
    );
    return mapTodoRow(cur.rows[0]);
  }
  sets.push(`updated_at = now()`);
  const r = await pool.query(
    `UPDATE todos SET ${sets.join(', ')} WHERE id = $${idParam}::uuid AND ${scopeSql}
     RETURNING id, title, detail, priority, done, pinned, silent_remind, source, created_at, updated_at`,
    vals,
  );
  return mapTodoRow(r.rows[0]);
}

/**
 * @param {TodoScope} [scope]
 */
export async function deleteTodo(id, scope = LEGACY_TODO_SCOPE) {
  const s = normalizeTodoScope(scope);
  const pool = usePostgres();
  if (!pool) {
    const db = _readJson();
    const before = db.todos.length;
    db.todos = db.todos.filter((t) => !(t.id === id && matchesJsonScope(t, s)));
    db.reminders = db.reminders.filter(
      (r) => !(r.todoId === id && matchesJsonScope(r, s)),
    );
    _writeJson(db);
    return db.todos.length < before;
  }
  await ensureJsonMigrated(pool);
  const idParam = 1;
  const scopeA = 2;
  const scopeB = 3;
  const r = await pool.query(
    `DELETE FROM todos WHERE id = $${idParam}::uuid AND ${sqlTodoScope(scopeA)}`,
    [id, s.orgId, s.userId],
  );
  return r.rowCount > 0;
}

/**
 * @param {{ includeFired?: boolean, scope?: TodoScope }} opts
 */
export async function getReminders({ includeFired = false, scope = LEGACY_TODO_SCOPE } = {}) {
  const s = normalizeTodoScope(scope);
  const pool = usePostgres();
  if (!pool) {
    const db = _readJson();
    let list = db.reminders.filter((r) => matchesJsonScope(r, s));
    if (!includeFired) list = list.filter((r) => !r.fired);
    return list;
  }
  await ensureJsonMigrated(pool);
  const base = `${REM_SELECT} WHERE ${sqlTodoScope(1)}`;
  const sql = includeFired
    ? `${base} ORDER BY created_at DESC`
    : `${base} AND fired = false ORDER BY created_at DESC`;
  const r = await pool.query(sql, [s.orgId, s.userId]);
  return r.rows.map(mapReminderRow);
}

/**
 * @param {{ title: string, dueIso?: string|null, dueNatural?: string, todoId?: string }} item
 * @param {TodoScope} [scope]
 */
export async function addReminder(item, scope = LEGACY_TODO_SCOPE) {
  const s = normalizeTodoScope(scope);
  const pool = usePostgres();
  if (!pool) {
    const db = _readJson();
    let todoId = item.todoId || null;
    if (todoId && !db.todos.some((t) => t.id === todoId && matchesJsonScope(t, s))) {
      todoId = null;
    }
    const reminder = {
      id: crypto.randomUUID(),
      title: String(item.title || '').trim(),
      dueIso: item.dueIso || null,
      dueNatural: String(item.dueNatural || '').trim(),
      fired: false,
      todoId,
      orgId: s.orgId,
      userId: s.userId,
      createdAt: _nowIso(),
    };
    db.reminders.unshift(reminder);
    _writeJson(db);
    return reminder;
  }
  await ensureJsonMigrated(pool);
  let tid = safeTodoUuid(item.todoId);
  if (tid) {
    const chk = await pool.query(
      `SELECT 1 FROM todos WHERE id = $1::uuid AND ${sqlTodoScope(2)}`,
      [tid, s.orgId, s.userId],
    );
    if (!chk.rowCount) tid = null;
  }
  const r = await pool.query(
    `INSERT INTO reminders (title, due_iso, due_natural, fired, todo_id, org_id, user_id)
     VALUES ($1, $2::timestamptz, $3, false, $4::uuid, $5::uuid, $6::uuid)
     RETURNING id, title, due_iso, due_natural, fired, fired_at, todo_id, created_at`,
    [
      String(item.title || '').trim(),
      item.dueIso ? new Date(item.dueIso) : null,
      String(item.dueNatural || '').trim(),
      tid,
      s.orgId,
      s.userId,
    ],
  );
  return mapReminderRow(r.rows[0]);
}

/**
 * @param {TodoScope} [scope]
 */
export async function markReminderFired(id, scope = LEGACY_TODO_SCOPE) {
  const s = normalizeTodoScope(scope);
  const pool = usePostgres();
  if (!pool) {
    const db = _readJson();
    const r = db.reminders.find((x) => x.id === id && matchesJsonScope(x, s));
    if (!r) return null;
    r.fired = true;
    r.firedAt = _nowIso();
    _writeJson(db);
    return r;
  }
  await ensureJsonMigrated(pool);
  const r = await pool.query(
    `UPDATE reminders SET fired = true, fired_at = now()
     WHERE id = $1::uuid AND ${sqlTodoScope(2)}
     RETURNING id, title, due_iso, due_natural, fired, fired_at, todo_id, created_at`,
    [id, s.orgId, s.userId],
  );
  return mapReminderRow(r.rows[0]);
}

/**
 * @param {TodoScope} [scope]
 */
export async function deleteReminder(id, scope = LEGACY_TODO_SCOPE) {
  const s = normalizeTodoScope(scope);
  const pool = usePostgres();
  if (!pool) {
    const db = _readJson();
    const before = db.reminders.length;
    db.reminders = db.reminders.filter((r) => !(r.id === id && matchesJsonScope(r, s)));
    _writeJson(db);
    return db.reminders.length < before;
  }
  await ensureJsonMigrated(pool);
  const r = await pool.query(
    `DELETE FROM reminders WHERE id = $1::uuid AND ${sqlTodoScope(2)}`,
    [id, s.orgId, s.userId],
  );
  return r.rowCount > 0;
}

/**
 * @param {number} [windowSec]
 * @param {TodoScope} [scope]
 */
export async function getDueReminders(windowSec = 60, scope = LEGACY_TODO_SCOPE) {
  const s = normalizeTodoScope(scope);
  const pool = usePostgres();
  if (!pool) {
    const db = _readJson();
    const now = Date.now();
    const horizon = now + windowSec * 1000;
    return db.reminders.filter((r) => {
      if (!matchesJsonScope(r, s)) return false;
      if (r.fired) return false;
      if (!r.dueIso) return false;
      const due = new Date(r.dueIso).getTime();
      return due <= horizon;
    });
  }
  await ensureJsonMigrated(pool);
  const sec = Math.max(1, Number(windowSec) || 60);
  const r = await pool.query(
    `${REM_SELECT}
     WHERE fired = false
       AND due_iso IS NOT NULL
       AND due_iso <= (NOW() + ($1::double precision * INTERVAL '1 second'))
       AND ${sqlTodoScope(2)}
     ORDER BY due_iso ASC`,
    [sec, s.orgId, s.userId],
  );
  return r.rows.map(mapReminderRow);
}
