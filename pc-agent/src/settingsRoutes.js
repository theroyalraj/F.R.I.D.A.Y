import express from 'express';
import { perceptionDbConfigured } from './perceptionDb.js';
import { getAmbientMerged, putAmbientPartial } from './settingsDb.js';

export function createSettingsRouter(authMiddleware) {
  const r = express.Router();
  r.use(express.json({ limit: '32kb' }));
  r.use(authMiddleware);

  r.get('/ambient', async (_req, res) => {
    if (!perceptionDbConfigured()) {
      return res.status(503).json({ error: 'OPENCLAW_DATABASE_URL not set' });
    }
    try {
      const merged = await getAmbientMerged();
      res.json({ ok: true, ...merged });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  r.put('/ambient', async (req, res) => {
    if (!perceptionDbConfigured()) {
      return res.status(503).json({ error: 'OPENCLAW_DATABASE_URL not set' });
    }
    const b = req.body || {};
    try {
      const merged = await putAmbientPartial({
        postTtsGap: b.postTtsGap,
        minSilenceSec: b.minSilenceSec,
        maxSilenceSec: b.maxSilenceSec,
      });
      res.json({ ok: true, ...merged });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  return r;
}
