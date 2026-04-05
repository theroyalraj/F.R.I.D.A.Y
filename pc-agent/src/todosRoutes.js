/**
 * todosRoutes.js — Express router for /todos and /todos/reminders.
 *
 * Reminder routes are registered BEFORE /:id so PATCH /reminders/... is not captured as :id.
 */

import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
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
import { todoRequestContext } from './authMiddleware.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPEAK_SCRIPT = path.resolve(__dirname, '../../skill-gateway/scripts/friday-speak.py');

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

function buildRemindText(todos, userName) {
  const name = (userName || '').trim();
  const pendingAll = todos.filter((t) => !t.done);
  const undone = pendingAll.filter((t) => !t.silentRemind);
  if (!pendingAll.length) {
    return name ? `All clear, ${name} — no pending tasks right now.` : 'All clear — no pending tasks right now.';
  }
  if (!undone.length) {
    const n = pendingAll.length;
    return name
      ? `${name}, you have ${n} pending task${n === 1 ? '' : 's'} marked quiet — nothing to read aloud.`
      : `You have ${n} pending task${n === 1 ? '' : 's'} marked quiet — nothing to read aloud.`;
  }
  undone.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1));
  const groups = { high: [], medium: [], low: [] };
  for (const t of undone) {
    const p = ['high', 'medium', 'low'].includes(t.priority) ? t.priority : 'medium';
    groups[p].push(t.title);
  }
  const parts = [];
  const intro = name
    ? `${name}, you have ${undone.length} task${undone.length === 1 ? '' : 's'} pending.`
    : `You have ${undone.length} task${undone.length === 1 ? '' : 's'} pending.`;
  parts.push(intro);
  if (groups.high.length) {
    parts.push(`High priority: ${groups.high.join(', ')}.`);
  }
  if (groups.medium.length) {
    parts.push(`Medium priority: ${groups.medium.join(', ')}.`);
  }
  if (groups.low.length) {
    parts.push(`Low priority: ${groups.low.join(', ')}.`);
  }
  return parts.join(' ');
}

function spawnRemindSpeak(text, log) {
  if (!existsSync(SPEAK_SCRIPT)) {
    log?.warn('remind: friday-speak.py not found — skipping TTS');
    return;
  }
  const child = spawn('python', [SPEAK_SCRIPT, text], {
    env: {
      ...process.env,
      FRIDAY_TTS_PRIORITY: '1',
      FRIDAY_TTS_BYPASS_CURSOR_DEFER: 'true',
    },
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  child.stderr?.on('data', (buf) => {
    const line = buf.toString().trim();
    if (line) log?.warn({ fridaySpeak: line }, 'todos/remind speak stderr');
  });
  child.unref();
}

/**
 * @param {string} [agentSecret] PC_AGENT_SECRET — agent Bearer uses optional OPENCLAW_TODO_DEFAULT_* env for scope
 */
export function createTodosRouter(broadcastFn, agentSecret = '') {
  const router = express.Router();
  router.use(todoRequestContext(agentSecret));

  function broadcast(type, data) {
    if (typeof broadcastFn === 'function') broadcastFn(type, data);
  }

  // ── Reminders (before /:id) ───────────────────────────────────────────────

  router.get('/reminders', async (req, res, next) => {
    try {
      const all = req.query.all === 'true';
      const reminders = await getReminders({ includeFired: all, scope: req.todoScope });
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
      const reminder = await addReminder({ title, dueIso, dueNatural, todoId }, req.todoScope);
      broadcast('reminder_added', { reminder });
      res.status(201).json({ ok: true, reminder });
    } catch (e) {
      next(e);
    }
  });

  router.patch('/reminders/:id/fire', async (req, res, next) => {
    try {
      const { id } = req.params;
      const reminder = await markReminderFired(id, req.todoScope);
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
      const deleted = await deleteReminder(id, req.todoScope);
      if (!deleted) return res.status(404).json({ error: 'Reminder not found' });
      broadcast('reminder_deleted', { id });
      res.json({ ok: true, id });
    } catch (e) {
      next(e);
    }
  });

  // ── Remind (highest-priority TTS announcement) ────────────────────────────
  // POST /todos/remind   — speaks all pending todos ordered high → medium → low.
  // Optional body: { "limit": 10 }  (default: all undone tasks)
  // Optional body: { "priority": "high" }  (filter to a single priority tier)
  // Scoped like other /todos routes (JWT user/org, agent default env, or legacy anonymous).

  router.post('/remind', async (req, res, next) => {
    try {
      const limitRaw = parseInt(req.body?.limit ?? '0', 10);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 0;
      const priorityFilter = typeof req.body?.priority === 'string' ? req.body.priority.toLowerCase() : null;

      let todos = await getTodos(req.todoScope);

      if (priorityFilter && ['high', 'medium', 'low'].includes(priorityFilter)) {
        todos = todos.filter((t) => t.priority === priorityFilter);
      }

      const undone = todos.filter((t) => !t.done && !t.silentRemind);
      undone.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1));
      const subset = limit ? undone.slice(0, limit) : undone;

      const userName = process.env.FRIDAY_USER_NAME || '';
      const text = buildRemindText(todos, userName);

      spawnRemindSpeak(text, req.log);

      res.json({
        ok: true,
        spoken: text,
        count: subset.length,
        todos: subset,
      });
    } catch (e) {
      next(e);
    }
  });

  // ── Todos ──────────────────────────────────────────────────────────────────

  router.get('/', async (req, res, next) => {
    try {
      const filter = (req.query.done ?? 'all').toLowerCase();
      let todos = await getTodos(req.todoScope);
      if (filter === 'true') todos = todos.filter((t) => t.done);
      else if (filter === 'false') todos = todos.filter((t) => !t.done);
      res.json({ ok: true, todos });
    } catch (e) {
      next(e);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const { title, detail, priority, source, pinned, silentRemind } = req.body || {};
      if (!title || typeof title !== 'string' || !title.trim()) {
        return res.status(400).json({ error: 'title is required' });
      }
      const todo = await addTodo({ title, detail, priority, source, pinned, silentRemind }, req.todoScope);
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
      const { title, detail, priority, done, pinned, silentRemind } = req.body || {};
      if (title !== undefined) patch.title = title;
      if (detail !== undefined) patch.detail = detail;
      if (priority !== undefined) patch.priority = priority;
      if (done !== undefined) patch.done = Boolean(done);
      if (pinned !== undefined) patch.pinned = Boolean(pinned);
      if (silentRemind !== undefined) patch.silentRemind = Boolean(silentRemind);
      const updated = await updateTodo(id, patch, req.todoScope);
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
      const deleted = await deleteTodo(id, req.todoScope);
      if (!deleted) return res.status(404).json({ error: 'Todo not found' });
      broadcast('todo_deleted', { id });
      res.json({ ok: true, id });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
