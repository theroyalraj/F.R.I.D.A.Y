/**
 * todosRoutes.js — Express router for /todos and /todos/reminders.
 *
 * Routes (no auth required — local only):
 *   GET    /todos                  list todos (query: ?done=true/false/all)
 *   POST   /todos                  create todo
 *   PATCH  /todos/:id              update (done, title, detail, priority)
 *   DELETE /todos/:id              delete todo + linked reminders
 *
 *   GET    /todos/reminders        list pending reminders (?all=true includes fired)
 *   POST   /todos/reminders        create reminder
 *   PATCH  /todos/reminders/:id/fire  mark fired
 *   DELETE /todos/reminders/:id    delete reminder
 */

import express from 'express';
import {
  getTodos,
  addTodo,
  updateTodo,
  deleteTodo,
  getReminders,
  addReminder,
  markReminderFired,
  deleteReminder,
} from './todosDb.js';

export function createTodosRouter(broadcastFn) {
  const router = express.Router();

  function broadcast(type, data) {
    if (typeof broadcastFn === 'function') broadcastFn(type, data);
  }

  // ── Todos ──────────────────────────────────────────────────────────────────

  router.get('/', (_req, res) => {
    const filter = (_req.query.done ?? 'all').toLowerCase();
    let todos = getTodos();
    if (filter === 'true') todos = todos.filter((t) => t.done);
    else if (filter === 'false') todos = todos.filter((t) => !t.done);
    res.json({ ok: true, todos });
  });

  router.post('/', (req, res) => {
    const { title, detail, priority, source } = req.body || {};
    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'title is required' });
    }
    const todo = addTodo({ title, detail, priority, source });
    broadcast('todo_added', { todo });
    res.status(201).json({ ok: true, todo });
  });

  router.patch('/:id', (req, res) => {
    const { id } = req.params;
    const patch = {};
    const { title, detail, priority, done } = req.body || {};
    if (title !== undefined) patch.title = title;
    if (detail !== undefined) patch.detail = detail;
    if (priority !== undefined) patch.priority = priority;
    if (done !== undefined) patch.done = Boolean(done);
    const updated = updateTodo(id, patch);
    if (!updated) return res.status(404).json({ error: 'Todo not found' });
    broadcast('todo_updated', { todo: updated });
    res.json({ ok: true, todo: updated });
  });

  router.delete('/:id', (req, res) => {
    const { id } = req.params;
    // Must come before /:id to avoid collision
    if (id === 'reminders') return res.status(400).json({ error: 'Use /todos/reminders/:id' });
    const deleted = deleteTodo(id);
    if (!deleted) return res.status(404).json({ error: 'Todo not found' });
    broadcast('todo_deleted', { id });
    res.json({ ok: true, id });
  });

  // ── Reminders ──────────────────────────────────────────────────────────────

  router.get('/reminders', (_req, res) => {
    const all = _req.query.all === 'true';
    const reminders = getReminders({ includeFired: all });
    res.json({ ok: true, reminders });
  });

  router.post('/reminders', (req, res) => {
    const { title, dueIso, dueNatural, todoId } = req.body || {};
    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'title is required' });
    }
    const reminder = addReminder({ title, dueIso, dueNatural, todoId });
    broadcast('reminder_added', { reminder });
    res.status(201).json({ ok: true, reminder });
  });

  router.patch('/reminders/:id/fire', (req, res) => {
    const { id } = req.params;
    const reminder = markReminderFired(id);
    if (!reminder) return res.status(404).json({ error: 'Reminder not found' });
    broadcast('reminder_fired', { reminder });
    res.json({ ok: true, reminder });
  });

  router.delete('/reminders/:id', (req, res) => {
    const { id } = req.params;
    const deleted = deleteReminder(id);
    if (!deleted) return res.status(404).json({ error: 'Reminder not found' });
    broadcast('reminder_deleted', { id });
    res.json({ ok: true, id });
  });

  return router;
}
