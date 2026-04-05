import express from 'express';
import { fetchGmailSnapshot } from './gmailRunner.js';

export function createAutomationRouter(authMiddleware) {
  const r = express.Router();
  r.use(express.json({ limit: '256kb' }));
  r.use(authMiddleware);

  /**
   * Runs scripts/gmail.py unread + list; returns JSON for n8n (Docker) automations.
   * Requires GMAIL_ADDRESS + GMAIL_APP_PWD in pc-agent environment (.env at repo root).
   */
  r.post('/gmail-snapshot', async (req, res) => {
    const b = req.body || {};
    const unreadCount = Math.min(50, Math.max(1, Number(b.unreadCount) || 15));
    const recentCount = Math.min(50, Math.max(1, Number(b.recentCount) || 12));
    try {
      const snap = await fetchGmailSnapshot({ unreadCount, recentCount });
      res.json(snap);
    } catch (e) {
      req.log?.warn({ err: String(e.message) }, 'gmail-snapshot failed');
      res.status(503).json({ ok: false, error: String(e.message || e) });
    }
  });

  return r;
}
