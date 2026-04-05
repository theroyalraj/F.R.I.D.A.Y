import express from 'express';
import { perceptionDbConfigured } from './perceptionDb.js';
import { getAmbientMerged, putAmbientPartial } from './settingsDb.js';
import { getEchoMerged, putEchoPartial } from './echoSettings.js';
import {
  getVoiceAgentPersonasMerged,
  putVoiceAgentPersonaPatch,
  resetVoiceAgentPersonaPatch,
  SETTINGS_KEY,
} from './voiceAgentPersona.js';

/**
 * @param {import('express').RequestHandler} authMiddleware
 * @param {{ (type: string, data?: object): void } | undefined} broadcastEvent — SSE fan-out (e.g. echo_personality_changed)
 */
export function createSettingsRouter(authMiddleware, broadcastEvent) {
  const r = express.Router();
  r.use(express.json({ limit: '32kb' }));
  r.use(authMiddleware);

  r.get('/ambient', async (_req, res) => {
    if (!perceptionDbConfigured()) {
      return res.status(503).json({
        error: 'Database not configured',
        hint: 'Set OPENCLAW_SQLITE_PATH (embedded) or OPENCLAW_DATABASE_URL (Postgres).',
      });
    }
    try {
      const merged = await getAmbientMerged();
      res.json({ ok: true, ...merged });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  /**
   * Voice-agent personas (OpenClaw Labs roster): defaults merged with JSON from Postgres openclaw_settings.voice_agent_personas.
   * PUT body: full or partial { jarvis: { name?, title?, voice?, personality?, rate? }, ... } — replaces stored patch.
   * DELETE: clear patch (back to code defaults only).
   */
  r.get('/personas', async (_req, res) => {
    if (!perceptionDbConfigured()) {
      return res.status(503).json({
        error: 'Database not configured',
        hint: 'Set OPENCLAW_SQLITE_PATH or OPENCLAW_DATABASE_URL.',
      });
    }
    try {
      const { merged, patch, fromDatabase } = await getVoiceAgentPersonasMerged();
      res.json({
        ok: true,
        settingsKey: SETTINGS_KEY,
        fromDatabase,
        patch,
        merged,
        note: 'Edit patch via PUT /settings/personas — merged = defaults + patch. Python daemons read Redis openclaw:voice_agent_personas_patch.',
      });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  r.put('/personas', async (req, res) => {
    if (!perceptionDbConfigured()) {
      return res.status(503).json({
        error: 'Database not configured',
        hint: 'Set OPENCLAW_SQLITE_PATH or OPENCLAW_DATABASE_URL.',
      });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    try {
      const { patch, merged, redisSynced } = await putVoiceAgentPersonaPatch(body);
      res.json({
        ok: true,
        settingsKey: SETTINGS_KEY,
        patch,
        merged,
        redisSynced,
      });
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  r.delete('/personas', async (_req, res) => {
    if (!perceptionDbConfigured()) {
      return res.status(503).json({
        error: 'Database not configured',
        hint: 'Set OPENCLAW_SQLITE_PATH or OPENCLAW_DATABASE_URL.',
      });
    }
    try {
      const { patch, merged, redisSynced } = await resetVoiceAgentPersonaPatch();
      res.json({ ok: true, patch, merged, redisSynced });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  r.put('/ambient', async (req, res) => {
    if (!perceptionDbConfigured()) {
      return res.status(503).json({
        error: 'Database not configured',
        hint: 'Set OPENCLAW_SQLITE_PATH (embedded) or OPENCLAW_DATABASE_URL (Postgres).',
      });
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

  /** ECHO (silence watcher): personality sliders, timing, Edge voice — Redis mirror for Python. */
  r.get('/echo', async (_req, res) => {
    try {
      const merged = await getEchoMerged();
      res.json(merged);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  r.put('/echo', async (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    try {
      const out = await putEchoPartial(b);
      if (typeof broadcastEvent === 'function') {
        broadcastEvent('echo_personality_changed', {
          humor: out.humor,
          warmth: out.warmth,
          directness: out.directness,
          curiosity: out.curiosity,
          formality: out.formality,
          idleSec: out.idleSec,
          rearmSec: out.rearmSec,
          voice: out.voice,
        });
      }
      res.json(out);
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  return r;
}
