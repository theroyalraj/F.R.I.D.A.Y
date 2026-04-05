/**
 * todosDb.js — Todos + reminders in PostgreSQL (OPENCLAW_DATABASE_URL).
 * Migrates legacy data/todos.json once → data/todos.json.migrated.
 * If Postgres is unavailable, falls back to JSON file (same paths as before).
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
          `INSERT INTO todos (id, title, detail, priority, done, source, created_at, updated_at)
           VALUES ($1::uuid, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()), COALESCE($8::timestamptz, now()))
           ON CONFLICT (id) DO NOTHING`,
          [
            id,
            String(t.title || '').trim(),
            String(t.detail || '').trim(),
            ['high', 'medium', 'low'].includes(t.priority) ? t.priority : 'medium',
            Boolean(t.done),
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
          `INSERT INTO reminders (id, title, due_iso, due_natural, fired, fired_at, todo_id, created_at)
           VALUES ($1::uuid, $2, $3::timestamptz, $4, $5, $6::timestamptz, $7::uuid, COALESCE($8::timestamptz, now()))
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

export async function getTodos() {
  const pool = usePostgres();
  if (!pool) return _readJson().todos;
  await ensureJsonMigrated(pool);
  const r = await pool.query(
    'SELECT id, title, detail, priority, done, source, created_at, updated_at FROM todos ORDER BY created_at DESC',
  );
  return r.rows.map(mapTodoRow);
}

/**
 * @param {{ title: string, detail?: string, priority?: 'high'|'medium'|'low', source?: string }} item
 */
export async function addTodo(item) {
  const pool = usePostgres();
  if (!pool) {
    const db = _readJson();
    const todo = {
      id: crypto.randomUUID(),
      title: String(item.title || '').trim(),
      detail: String(item.detail || '').trim(),
      priority: ['high', 'medium', 'low'].includes(item.priority) ? item.priority : 'medium',
      done: false,
      source: String(item.source || 'manual').trim(),
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
    `INSERT INTO todos (title, detail, priority, done, source)
     VALUES ($1, $2, $3, false, $4)
     RETURNING id, title, detail, priority, done, source, created_at, updated_at`,
    [
      String(item.title || '').trim(),
      String(item.detail || '').trim(),
      pr,
      String(item.source || 'manual').trim(),
    ],
  );
  return mapTodoRow(r.rows[0]);
}

export async function updateTodo(id, patch) {
  const pool = usePostgres();
  if (!pool) {
    const db = _readJson();
    const idx = db.todos.findIndex((t) => t.id === id);
    if (idx === -1) return null;
    const allowed = ['title', 'detail', 'priority', 'done'];
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
  if (!sets.length) {
    const cur = await pool.query(
      'SELECT id, title, detail, priority, done, source, created_at, updated_at FROM todos WHERE id = $1::uuid',
      [id],
    );
    return mapTodoRow(cur.rows[0]);
  }
  sets.push(`updated_at = now()`);
  vals.push(id);
  const r = await pool.query(
    `UPDATE todos SET ${sets.join(', ')} WHERE id = $${n}::uuid
     RETURNING id, title, detail, priority, done, source, created_at, updated_at`,
    vals,
  );
  return mapTodoRow(r.rows[0]);
}

export async function deleteTodo(id) {
  const pool = usePostgres();
  if (!pool) {
    const db = _readJson();
    const before = db.todos.length;
    db.todos = db.todos.filter((t) => t.id !== id);
    db.reminders = db.reminders.filter((r) => r.todoId !== id);
    _writeJson(db);
    return db.todos.length < before;
  }
  await ensureJsonMigrated(pool);
  const r = await pool.query('DELETE FROM todos WHERE id = $1::uuid', [id]);
  return r.rowCount > 0;
}

export async function getReminders({ includeFired = false } = {}) {
  const pool = usePostgres();
  if (!pool) {
    const db = _readJson();
    if (includeFired) return db.reminders;
    return db.reminders.filter((r) => !r.fired);
  }
  await ensureJsonMigrated(pool);
  const sql = includeFired
    ? 'SELECT id, title, due_iso, due_natural, fired, fired_at, todo_id, created_at FROM reminders ORDER BY created_at DESC'
    : 'SELECT id, title, due_iso, due_natural, fired, fired_at, todo_id, created_at FROM reminders WHERE fired = false ORDER BY created_at DESC';
  const r = await pool.query(sql);
  return r.rows.map(mapReminderRow);
}

/**
 * @param {{ title: string, dueIso?: string|null, dueNatural?: string, todoId?: string }} item
 */
export async function addReminder(item) {
  const pool = usePostgres();
  if (!pool) {
    const db = _readJson();
    const reminder = {
      id: crypto.randomUUID(),
      title: String(item.title || '').trim(),
      dueIso: item.dueIso || null,
      dueNatural: String(item.dueNatural || '').trim(),
      fired: false,
      todoId: item.todoId || null,
      createdAt: _nowIso(),
    };
    db.reminders.unshift(reminder);
    _writeJson(db);
    return reminder;
  }
  await ensureJsonMigrated(pool);
  const tid = safeTodoUuid(item.todoId);
  const r = await pool.query(
    `INSERT INTO reminders (title, due_iso, due_natural, fired, todo_id)
     VALUES ($1, $2::timestamptz, $3, false, $4::uuid)
     RETURNING id, title, due_iso, due_natural, fired, fired_at, todo_id, created_at`,
    [
      String(item.title || '').trim(),
      item.dueIso ? new Date(item.dueIso) : null,
      String(item.dueNatural || '').trim(),
      tid,
    ],
  );
  return mapReminderRow(r.rows[0]);
}

export async function markReminderFired(id) {
  const pool = usePostgres();
  if (!pool) {
    const db = _readJson();
    const r = db.reminders.find((x) => x.id === id);
    if (!r) return null;
    r.fired = true;
    r.firedAt = _nowIso();
    _writeJson(db);
    return r;
  }
  await ensureJsonMigrated(pool);
  const r = await pool.query(
    `UPDATE reminders SET fired = true, fired_at = now() WHERE id = $1::uuid
     RETURNING id, title, due_iso, due_natural, fired, fired_at, todo_id, created_at`,
    [id],
  );
  return mapReminderRow(r.rows[0]);
}

export async function deleteReminder(id) {
  const pool = usePostgres();
  if (!pool) {
    const db = _readJson();
    const before = db.reminders.length;
    db.reminders = db.reminders.filter((r) => r.id !== id);
    _writeJson(db);
    return db.reminders.length < before;
  }
  await ensureJsonMigrated(pool);
  const r = await pool.query('DELETE FROM reminders WHERE id = $1::uuid', [id]);
  return r.rowCount > 0;
}

/** Get all reminders due within the next `windowSec` seconds. */
export async function getDueReminders(windowSec = 60) {
  const pool = usePostgres();
  if (!pool) {
    const db = _readJson();
    const now = Date.now();
    const horizon = now + windowSec * 1000;
    return db.reminders.filter((r) => {
      if (r.fired) return false;
      if (!r.dueIso) return false;
      const due = new Date(r.dueIso).getTime();
      return due <= horizon;
    });
  }
  await ensureJsonMigrated(pool);
  const sec = Math.max(1, Number(windowSec) || 60);
  const r = await pool.query(
    `SELECT id, title, due_iso, due_natural, fired, fired_at, todo_id, created_at
     FROM reminders
     WHERE fired = false
       AND due_iso IS NOT NULL
       AND due_iso <= (NOW() + ($1::double precision * INTERVAL '1 second'))
     ORDER BY due_iso ASC`,
    [sec],
  );
  return r.rows.map(mapReminderRow);
}
