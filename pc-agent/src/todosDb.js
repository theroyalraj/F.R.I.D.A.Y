/**
 * todosDb.js — Lightweight JSON-file persistence for todos and reminders.
 *
 * Stored at <repo-root>/data/todos.json. Works with no database required.
 * Falls back gracefully if the file is missing or malformed.
 *
 * Schema:
 *   todos: [{ id, title, detail, priority, done, source, createdAt, updatedAt }]
 *   reminders: [{ id, title, dueIso, dueNatural, fired, todoId, createdAt }]
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'todos.json');

const EMPTY_DB = () => ({ todos: [], reminders: [] });

function _ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function _read() {
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

function _write(db) {
  _ensureDir();
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf-8');
}

function _now() {
  return new Date().toISOString();
}

// ── Todos ─────────────────────────────────────────────────────────────────────

export function getTodos() {
  return _read().todos;
}

/**
 * @param {{ title: string, detail?: string, priority?: 'high'|'medium'|'low', source?: string }} item
 */
export function addTodo(item) {
  const db = _read();
  const todo = {
    id: crypto.randomUUID(),
    title: String(item.title || '').trim(),
    detail: String(item.detail || '').trim(),
    priority: ['high', 'medium', 'low'].includes(item.priority) ? item.priority : 'medium',
    done: false,
    source: String(item.source || 'manual').trim(),
    createdAt: _now(),
    updatedAt: _now(),
  };
  db.todos.unshift(todo);
  _write(db);
  return todo;
}

export function updateTodo(id, patch) {
  const db = _read();
  const idx = db.todos.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  const allowed = ['title', 'detail', 'priority', 'done'];
  for (const k of allowed) {
    if (patch[k] !== undefined) db.todos[idx][k] = patch[k];
  }
  db.todos[idx].updatedAt = _now();
  _write(db);
  return db.todos[idx];
}

export function deleteTodo(id) {
  const db = _read();
  const before = db.todos.length;
  db.todos = db.todos.filter((t) => t.id !== id);
  // Also remove reminders linked to this todo
  db.reminders = db.reminders.filter((r) => r.todoId !== id);
  _write(db);
  return db.todos.length < before;
}

// ── Reminders ─────────────────────────────────────────────────────────────────

export function getReminders({ includeFired = false } = {}) {
  const db = _read();
  if (includeFired) return db.reminders;
  return db.reminders.filter((r) => !r.fired);
}

/**
 * @param {{ title: string, dueIso?: string|null, dueNatural?: string, todoId?: string }} item
 */
export function addReminder(item) {
  const db = _read();
  const reminder = {
    id: crypto.randomUUID(),
    title: String(item.title || '').trim(),
    dueIso: item.dueIso || null,
    dueNatural: String(item.dueNatural || '').trim(),
    fired: false,
    todoId: item.todoId || null,
    createdAt: _now(),
  };
  db.reminders.unshift(reminder);
  _write(db);
  return reminder;
}

export function markReminderFired(id) {
  const db = _read();
  const r = db.reminders.find((x) => x.id === id);
  if (!r) return null;
  r.fired = true;
  r.firedAt = _now();
  _write(db);
  return r;
}

export function deleteReminder(id) {
  const db = _read();
  const before = db.reminders.length;
  db.reminders = db.reminders.filter((r) => r.id !== id);
  _write(db);
  return db.reminders.length < before;
}

/** Get all reminders due within the next `windowSec` seconds. */
export function getDueReminders(windowSec = 60) {
  const db = _read();
  const now = Date.now();
  const horizon = now + windowSec * 1000;
  return db.reminders.filter((r) => {
    if (r.fired) return false;
    if (!r.dueIso) return false;
    const due = new Date(r.dueIso).getTime();
    return due <= horizon;
  });
}
