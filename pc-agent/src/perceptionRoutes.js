import express from 'express';
import {
  perceptionDbConfigured,
  perceptionDbHealth,
  insertPerceptionCapture,
  searchPerceptionByVector,
  listRecentCaptures,
  getExpectedEmbeddingDim,
} from './perceptionDb.js';
import { cachePerceptionSummary, perceptionRedisHealth } from './perceptionRedis.js';

const ALLOWED_SOURCES = new Set(['screen', 'camera', 'screen_vision', 'multimodal']);

export function createPerceptionRouter(authMiddleware) {
  const r = express.Router();
  r.use(express.json({ limit: '25mb' }));
  r.use(authMiddleware);

  r.get('/status', async (_req, res) => {
    const pg = await perceptionDbHealth();
    const redis = await perceptionRedisHealth();
    res.json({
      ok: true,
      postgres: pg,
      redis,
      embeddingDim: getExpectedEmbeddingDim(),
      configured: perceptionDbConfigured(),
    });
  });

  r.post('/capture', async (req, res) => {
    if (!perceptionDbConfigured()) {
      return res.status(503).json({ error: 'OPENCLAW_DATABASE_URL not set' });
    }
    const b = req.body || {};
    const sourceType = typeof b.sourceType === 'string' ? b.sourceType.trim() : '';
    if (!ALLOWED_SOURCES.has(sourceType)) {
      return res.status(400).json({
        error: `sourceType must be one of: ${[...ALLOWED_SOURCES].join(', ')}`,
      });
    }

    let imageBytes = null;
    if (typeof b.imageBase64 === 'string' && b.imageBase64.length) {
      try {
        imageBytes = Buffer.from(b.imageBase64, 'base64');
      } catch {
        return res.status(400).json({ error: 'invalid imageBase64' });
      }
    }

    let embedding = b.embedding;
    if (embedding != null && !Array.isArray(embedding)) {
      return res.status(400).json({ error: 'embedding must be an array of numbers' });
    }
    const dim = getExpectedEmbeddingDim();
    if (Array.isArray(embedding) && embedding.length > 0 && embedding.length !== dim) {
      return res.status(400).json({ error: `embedding length must be ${dim}` });
    }
    if (Array.isArray(embedding) && embedding.length === 0) embedding = null;

    const metadata =
      b.metadata && typeof b.metadata === 'object' && !Array.isArray(b.metadata) ? b.metadata : {};

    try {
      const row = await insertPerceptionCapture({
        sourceType,
        rawText: typeof b.rawText === 'string' ? b.rawText : null,
        descriptionText: typeof b.descriptionText === 'string' ? b.descriptionText : null,
        embedding: embedding || null,
        metadata,
        imageMime: typeof b.imageMime === 'string' ? b.imageMime : null,
        imageBytes,
        mediaPath: typeof b.mediaPath === 'string' ? b.mediaPath : null,
        redisCacheKey: typeof b.redisCacheKey === 'string' ? b.redisCacheKey : null,
      });

      await cachePerceptionSummary({
        id: row.id,
        capturedAt: row.captured_at,
        sourceType,
        hasImage: Boolean(imageBytes?.length),
        mediaPath: b.mediaPath || null,
      });

      res.status(201).json({ ok: true, id: row.id, capturedAt: row.captured_at });
    } catch (e) {
      req.log?.warn({ err: String(e.message || e) }, 'perception capture failed');
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  r.post('/search', async (req, res) => {
    if (!perceptionDbConfigured()) {
      return res.status(503).json({ error: 'OPENCLAW_DATABASE_URL not set' });
    }
    const emb = req.body?.embedding;
    if (!Array.isArray(emb)) {
      return res.status(400).json({ error: 'body.embedding array required' });
    }
    const limit = Number(req.body?.limit) || 10;
    try {
      const rows = await searchPerceptionByVector(emb, limit);
      res.json({ ok: true, results: rows });
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  r.get('/recent', async (req, res) => {
    if (!perceptionDbConfigured()) {
      return res.status(503).json({ error: 'OPENCLAW_DATABASE_URL not set' });
    }
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    try {
      const rows = await listRecentCaptures(limit);
      res.json({ ok: true, rows });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  return r;
}
