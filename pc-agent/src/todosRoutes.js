/**
 * todosRoutes.js — Express router for /todos and /todos/reminders.
 *
 * Reminder routes are registered BEFORE /:id so PATCH /reminders/... is not captured as :id.
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
import { markLinkedActionItemsDone, actionItemsDbAvailable } from './actionItemsDb.js';

export function createTodosRouter(broadcastFn) {
  const router = express.Router();

  function broadcast(type, data) {
    if (typeof broadcastFn === 'function') broadcastFn(type, data);
  }

  // ── Reminders (before /:id) ───────────────────────────────────────────────

  router.get('/reminders', async (_req, res, next) => {
    try {
      const all = _req.query.all === 'true';
      const reminders = await getReminders({ includeFired: all });
      res.json({ ok: true, reminders });
    } catch (e) {
      next(e);
    }
  });

  router.post('/reminders', async (req, res, next) => {
    try {
      const { title, dueIso, dueNatural, todoId } = req.body || {};
      if (!title || typeof title !== 'string' || !title.trim()) {
        return res.status(400).json({ error: 'title is required' });
      }
      const reminder = await addReminder({ title, dueIso, dueNatural, todoId });
      broadcast('reminder_added', { reminder });
      res.status(201).json({ ok: true, reminder });
    } catch (e) {
      next(e);
    }
  });

  router.patch('/reminders/:id/fire', async (req, res, next) => {
    try {
      const { id } = req.params;
      const reminder = await markReminderFired(id);
      if (!reminder) return res.status(404).json({ error: 'Reminder not found' });
      broadcast('reminder_fired', { reminder });
      res.json({ ok: true, reminder });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/reminders/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      const deleted = await deleteReminder(id);
      if (!deleted) return res.status(404).json({ error: 'Reminder not found' });
      broadcast('reminder_deleted', { id });
      res.json({ ok: true, id });
    } catch (e) {
      next(e);
    }
  });

  // ── Todos ──────────────────────────────────────────────────────────────────

  router.get('/', async (_req, res, next) => {
    try {
      const filter = (_req.query.done ?? 'all').toLowerCase();
      let todos = await getTodos();
      if (filter === 'true') todos = todos.filter((t) => t.done);
      else if (filter === 'false') todos = todos.filter((t) => !t.done);
      res.json({ ok: true, todos });
    } catch (e) {
      next(e);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const { title, detail, priority, source } = req.body || {};
      if (!title || typeof title !== 'string' || !title.trim()) {
        return res.status(400).json({ error: 'title is required' });
      }
      const todo = await addTodo({ title, detail, priority, source });
      broadcast('todo_added', { todo });
      res.status(201).json({ ok: true, todo });
    } catch (e) {
      next(e);
    }
  });

  router.patch('/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      const patch = {};
      const { title, detail, priority, done } = req.body || {};
      if (title !== undefined) patch.title = title;
      if (detail !== undefined) patch.detail = detail;
      if (priority !== undefined) patch.priority = priority;
      if (done !== undefined) patch.done = Boolean(done);
      const updated = await updateTodo(id, patch);
      if (!updated) return res.status(404).json({ error: 'Todo not found' });
      if (patch.done === true && actionItemsDbAvailable()) {
        try {
          await markLinkedActionItemsDone(id);
        } catch {
          /* non-fatal */
        }
      }
      broadcast('todo_updated', { todo: updated });
      res.json({ ok: true, todo: updated });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      const deleted = await deleteTodo(id);
      if (!deleted) return res.status(404).json({ error: 'Todo not found' });
      broadcast('todo_deleted', { id });
      res.json({ ok: true, id });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
