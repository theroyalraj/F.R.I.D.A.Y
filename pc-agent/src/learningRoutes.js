import express from 'express';
import { isLearningEnabled } from './learningEnv.js';
import { insertLearningFeedback, getGenerationRowRedacted } from './learningDb.js';

function labelToScore(label) {
  const k = String(label || '').trim().toLowerCase();
  const map = {
    thumb_up: 1,
    thumb_down: -1,
    corrected: -0.5,
    implicit_ok: 0.3,
    implicit_negative: -0.3,
  };
  return map[k] ?? null;
}

export function createLearningRouter() {
  const r = express.Router();

  r.post('/feedback', async (req, res) => {
    if (!isLearningEnabled()) {
      return res.status(503).json({ ok: false, error: 'OPENCLAW_LEARNING_ENABLED is off' });
    }
    const generationLogId = String(req.body?.generationLogId || req.body?.generation_id || '').trim();
    let score = req.body?.score;
    const labelRaw = req.body?.label;
    const comment = req.body?.comment;

    if (generationLogId.length < 10) {
      return res.status(400).json({ ok: false, error: 'generationLogId required' });
    }

    if (score == null || score === '') {
      const fromLabel = labelToScore(labelRaw);
      if (fromLabel == null) {
        return res.status(400).json({ ok: false, error: 'Provide score or a known label (thumb_up, thumb_down, corrected, implicit_ok)' });
      }
      score = fromLabel;
    } else {
      score = Number(score);
      if (!Number.isFinite(score)) {
        return res.status(400).json({ ok: false, error: 'invalid score' });
      }
    }

    const label = String(labelRaw || 'manual').slice(0, 120);
    const out = await insertLearningFeedback({
      generationId: generationLogId,
      score,
      label,
      comment,
      log: req.log,
    });
    if (!out.ok) {
      const st = out.error === 'generation not found' ? 404 : 400;
      return res.status(st).json({ ok: false, error: out.error || 'failed' });
    }
    return res.status(201).json({ ok: true, feedbackId: out.id });
  });

  r.get('/generation/:id', async (req, res) => {
    if (!isLearningEnabled()) {
      return res.status(503).json({ ok: false, error: 'OPENCLAW_LEARNING_ENABLED is off' });
    }
    const row = await getGenerationRowRedacted(req.params.id, { log: req.log });
    if (!row) return res.status(404).json({ ok: false, error: 'not found' });
    return res.json({ ok: true, generation: row });
  });

  return r;
}
