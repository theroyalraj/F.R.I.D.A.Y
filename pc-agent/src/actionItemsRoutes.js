/**
 * actionItemsRoutes.js — /action-items (no auth — local trust).
 */

import express from 'express';
import {
  listActionItems,
  summaryByPriority,
  getActionItem,
  updateActionItem,
  markActionItemDone,
  markActionItemDismissed,
  deleteActionItem,
  actionItemsDbAvailable,
} from './actionItemsDb.js';

export function createActionItemsRouter() {
  const router = express.Router();

  router.use((_req, res, next) => {
    if (!actionItemsDbAvailable()) {
      return res.status(503).json({
        ok: false,
        error: 'Postgres not configured (set OPENCLAW_DATABASE_URL and run migrations)',
      });
    }
    next();
  });

  router.get('/', async (req, res, next) => {
    try {
      const status = req.query.status ? String(req.query.status) : undefined;
      const priority = req.query.priority ? String(req.query.priority) : undefined;
      const items = await listActionItems({ status, priority });
      res.json({ ok: true, items });
    } catch (e) {
      next(e);
    }
  });

  router.get('/summary', async (_req, res, next) => {
    try {
      const body = await summaryByPriority();
      res.json(body);
    } catch (e) {
      next(e);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const item = await getActionItem(req.params.id);
      if (!item) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true, item });
    } catch (e) {
      next(e);
    }
  });

  router.patch('/:id', async (req, res, next) => {
    try {
      const { title, detail, category, priority, status, dueAt, dueNatural, metadata } = req.body || {};
      const patch = {};
      if (title !== undefined) patch.title = title;
      if (detail !== undefined) patch.detail = detail;
      if (category !== undefined) patch.category = category;
      if (priority !== undefined) patch.priority = priority;
      if (status !== undefined) patch.status = status;
      if (dueAt !== undefined) patch.dueAt = dueAt;
      if (dueNatural !== undefined) patch.dueNatural = dueNatural;
      if (metadata !== undefined) patch.metadata = metadata;
      const updated = await updateActionItem(req.params.id, patch);
      if (!updated) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true, item: updated });
    } catch (e) {
      next(e);
    }
  });

  router.patch('/:id/done', async (req, res, next) => {
    try {
      const updated = await markActionItemDone(req.params.id);
      if (!updated) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true, item: updated });
    } catch (e) {
      next(e);
    }
  });

  router.patch('/:id/dismiss', async (req, res, next) => {
    try {
      const updated = await markActionItemDismissed(req.params.id);
      if (!updated) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true, item: updated });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      const ok = await deleteActionItem(req.params.id);
      if (!ok) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true, id: req.params.id });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
