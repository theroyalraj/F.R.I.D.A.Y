import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import express from 'express';
import dotenv from 'dotenv';
import pinoHttp from 'pino-http';
import { rootLogger } from './log.js';
import { runTask } from './taskRunner.js';
import { pythonChildExecutable } from './winPython.js';
import { prepareTextForTts } from './ttsPrep.js';
import { piperConfigured, synthesizePiperWav } from './piperTts.js';
import {
  edgeTtsConfigured,
  edgeTtsVoice,
  synthesizeEdgeTtsMp3,
  setSessionVoice,
  filteredEdgeTtsCatalogue,
  getVoiceBlockSet,
  isVoiceBlocked,
  restoreSessionVoiceFromRedis,
} from './edgeTts.js';
import { getAllVoiceContexts } from './voiceRedis.js';
import { openAiTtsApiKey, openAiTtsConfigured, synthesizeOpenAiMp3 } from './openaiTts.js';
import { createPerceptionRouter } from './perceptionRoutes.js';
import { createSettingsRouter } from './settingsRoutes.js';
import { createAutomationRouter } from './automationRoutes.js';
import { createIntegrationsRouter } from './integrationsRoutes.js';
import { createTodosRouter } from './todosRoutes.js';
import { createActionItemsRouter } from './actionItemsRoutes.js';
import { perceptionDbConfigured, perceptionDbHealth } from './perceptionDb.js';
import { loadOpenclawUserConfig } from './userConfig.js';
import { getSpeakStyle, setSpeakStyle, buildSpeakStyleInstruction, mergeDeliveryWithSpeakStyle } from './speakStyle.js';
import {
  playDoneSong,
  buildCelebrationOffer,
  resolveCelebration,
  getCelebrationMode,
} from './celebration.js';
import { buildMusicPlaySsePayload } from './musicVisualSse.js';
import { createAuthRouter } from './authRoutes.js';
import { createOrganizationRouter } from './organizationRoutes.js';
import { authJwtOrAgentSecret } from './authMiddleware.js';
import { ensureAuthSchema } from './ensureAuthSchema.js';
import { registerDeferredOpenRouterEmitter } from './deferredOpenRouter.js';
import {
  refreshPersonaPatchRedisFromDb,
  getVoicePersonasRegistrySnapshot,
} from './voiceAgentPersona.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '../public');

// ── SSE event bus (voice daemon live feed) ────────────────────────────────────
const sseClients = new Set();
const EVENT_BUFFER_MAX = 200;
const sseBuffer = [];   // replayed to new clients

function broadcastEvent(type, data = {}) {
  const payload = JSON.stringify({ type, ts: Date.now(), ...data });
  const msg = `data: ${payload}\n\n`;
  sseBuffer.push(msg);
  if (sseBuffer.length > EVENT_BUFFER_MAX) sseBuffer.shift();
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });
loadOpenclawUserConfig();

const PORT = Number(process.env.PC_AGENT_PORT || 3847);

function gatewayBaseUrl() {
  return (process.env.OPENCLAW_SKILL_GATEWAY_URL || 'http://127.0.0.1:3848').replace(/\/$/, '');
}

// ── Friday startup voice ──────────────────────────────────────────────────────
const SPEAK_SCRIPT = path.resolve(__dirname, '../../skill-gateway/scripts/friday-speak.py');

function pcAgentStartupGreetingPhrase() {
  const n = (process.env.FRIDAY_USER_NAME || 'Raj').trim() || 'Raj';
  const lines = [
    `Friday here, ${n} — I'm up when you are.`,
    `Hey ${n}, I'm online. What do you need?`,
    `Right, ${n}, we're connected. Go ahead whenever.`,
    `Good to go, ${n}. What's on your mind?`,
    `I'm here, ${n}. Talk to me when you're ready.`,
  ];
  return lines[Math.floor(Math.random() * lines.length)];
}

function parseIntEnv(name, defaultVal) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultVal;
  const n = parseInt(String(raw).split('#')[0].trim(), 10);
  return Number.isFinite(n) ? n : defaultVal;
}

/** Random or fixed rate/pitch for boot greeting — matches friday_greeting_delivery.py */
function greetingTtsRatePitch() {
  const off = ['false', '0', 'no', 'off'];
  const raw = (process.env.FRIDAY_TTS_JARVIS_RANDOM || 'true').toLowerCase();
  if (off.includes(raw)) {
    return {
      FRIDAY_TTS_RATE: process.env.FRIDAY_TTS_JARVIS_RATE || '+10%',
      FRIDAY_TTS_PITCH: process.env.FRIDAY_TTS_JARVIS_PITCH || '+2Hz',
    };
  }
  const rLo = parseIntEnv('FRIDAY_TTS_JARVIS_RATE_MIN_PCT', 3);
  const rHi = parseIntEnv('FRIDAY_TTS_JARVIS_RATE_MAX_PCT', 12);
  const pLo = parseIntEnv('FRIDAY_TTS_JARVIS_PITCH_MIN_HZ', 0);
  const pHi = parseIntEnv('FRIDAY_TTS_JARVIS_PITCH_MAX_HZ', 10);
  const rMin = Math.min(rLo, rHi);
  const rMax = Math.max(rLo, rHi);
  const pMin = Math.min(pLo, pHi);
  const pMax = Math.max(pLo, pHi);
  const rp = rMin + Math.floor(Math.random() * (rMax - rMin + 1));
  const ph = pMin + Math.floor(Math.random() * (pMax - pMin + 1));
  return {
    FRIDAY_TTS_RATE: `${rp >= 0 ? '+' : ''}${rp}%`,
    FRIDAY_TTS_PITCH: `${ph >= 0 ? '+' : ''}${ph}Hz`,
  };
}

function speakStartup() {
  if (process.env.FRIDAY_SPEAK_PY === 'false' || process.env.FRIDAY_SPEAK_PY === '0') return;
  if (process.env.PC_AGENT_STARTUP_SPEAK === 'false' || process.env.PC_AGENT_STARTUP_SPEAK === '0') return;
  if (!existsSync(SPEAK_SCRIPT)) return;
  const phrase = pcAgentStartupGreetingPhrase();
  const delivery = greetingTtsRatePitch();
  const child = spawn('python', [SPEAK_SCRIPT, phrase], {
    env: {
      ...process.env,
      FRIDAY_TTS_VOICE:  process.env.FRIDAY_TTS_VOICE  || 'en-US-AvaMultilingualNeural',
      FRIDAY_TTS_DEVICE: process.env.FRIDAY_TTS_DEVICE || 'default',
      FRIDAY_TTS_BYPASS_CURSOR_DEFER: 'true',
      FRIDAY_TTS_PRIORITY: '1',
      ...delivery,
    },
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  child.stderr?.on('data', (buf) => {
    const line = buf.toString().trim();
    if (line) rootLogger.warn({ fridaySpeak: line }, 'pc-agent speakStartup stderr');
  });
  child.on('close', (code) => {
    if (code === 0) rootLogger.info({ phrase: phrase.slice(0, 60) }, 'pc-agent speakStartup: done');
    else rootLogger.warn({ exitCode: code }, 'pc-agent speakStartup: non-zero exit');
  });
  child.on('error', (e) => rootLogger.warn({ err: e.message }, 'pc-agent speakStartup: spawn error'));
  child.unref();
}
/** Default all interfaces so LAN + ngrok local forward both work; set PC_AGENT_BIND=127.0.0.1 to loopback-only. */
const BIND = process.env.PC_AGENT_BIND || '0.0.0.0';
const SECRET = process.env.PC_AGENT_SECRET || '';

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  req.openclawReqId = crypto.randomUUID();
  next();
});

function shouldIgnoreRequestLog(req) {
  const p = req.path || '';
  return (
      p === '/health' ||
      p === '/friday' ||
      p === '/friday/listen' ||
      p === '/jarvis' ||
      p === '/voice/ping' ||
      p === '/voice/stream' ||
      p === '/favicon.svg' ||
      p === '/favicon.ico' ||
      p.startsWith('/todos') ||
      p.startsWith('/auth/') ||
      p.startsWith('/organization/')
    );
}

app.use(
  pinoHttp({
    logger: rootLogger,
    genReqId: (req) => req.openclawReqId,
    autoLogging: {
      ignore: (req) => shouldIgnoreRequestLog(req),
    },
    customProps: (req) => ({ openclawReqId: req.openclawReqId }),
    serializers: {
      req: (req) => ({
        id: req.id,
        method: req.method,
        url: req.url,
        openclawReqId: req.openclawReqId,
      }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
    customLogLevel(_req, res, err) {
      if (err) return 'error';
      if (res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
  }),
);

app.use(express.json({ limit: '512kb' }));

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!SECRET || token !== SECRET) {
    req.log.warn({ hasAuth: Boolean(h) }, 'auth failed');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

/** User JWT or PC_AGENT_SECRET — for /task and /voice (daemons, N8N, Listen UI). */
function authTaskOrUser(req, res, next) {
  return authJwtOrAgentSecret(SECRET)(req, res, next);
}

app.use('/auth', createAuthRouter());
app.use('/organization', createOrganizationRouter());

/** Friday voice API: CORS + explicit JSON ping (works behind ngrok, curl, monitors; ?query no longer breaks logging). */
const voiceRouter = express.Router();

voiceRouter.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Accept, ngrok-skip-browser-warning, Authorization',
  );
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

voiceRouter.use((req, res, next) => {
  if (req.method === 'HEAD' && req.path === '/ping') return next();
  if (req.method === 'GET' && (req.path === '/ping' || req.path === '/stream')) return next();
  return authTaskOrUser(req, res, next);
});

function ttsProviderLabel() {
  if (piperConfigured()) return 'piper';
  if (edgeTtsConfigured()) return 'edge';
  if (openAiTtsConfigured()) return 'openai';
  return 'browser';
}

function sendVoicePing(_req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Friday-Ping', '1');
  res.type('application/json');
  const provider = ttsProviderLabel();
  res.status(200).send(
    JSON.stringify({
      ok: true,
      service: 'friday-voice',
      postTo: '/voice/command',
      version: 1,
      tts: {
        provider,
        endpoint: '/voice/tts',
        speakStyle: '/voice/speak-style',
        piper: piperConfigured(),
        edge: edgeTtsConfigured(),
        openai: openAiTtsConfigured(),
        edgeVoice: edgeTtsConfigured() ? edgeTtsVoice() : undefined,
      },
    }),
  );
}

voiceRouter.get('/ping', sendVoicePing);
voiceRouter.head('/ping', (_req, res) => {
  res.setHeader('X-Friday-Ping', '1');
  res.setHeader('Cache-Control', 'no-store');
  res.sendStatus(200);
});

voiceRouter.post('/command', async (req, res, next) => {
  try {
    const orgId = req.user?.orgId ?? null;
    const out = await runTask(req.body, req.log, { orgId });
    const json = { ...(out.json || {}) };
    if (json.ok && json.mode === 'play_music' && json.musicQuery) {
      broadcastEvent('music_play', buildMusicPlaySsePayload(json.musicQuery, 'full'));
    }
    const skipCelebrationModes = new Set(['play_music', 'open_app']);
    if (out.json?.ok && !out.json?.deferredOpenRouter && !skipCelebrationModes.has(out.json.mode)) {
      const mode = getCelebrationMode();
      if (mode === 'immediate') {
        playDoneSong(req.log);
        const song = (process.env.FRIDAY_DONE_SONG || '').trim();
        if (song) broadcastEvent('music_play', buildMusicPlaySsePayload(song, 'clip'));
      } else if (mode === 'ask') {
        const offer = await buildCelebrationOffer();
        Object.assign(json, offer);
      }
    }
    res.status(out.status).json(json);
  } catch (e) {
    next(e);
  }
});

/** After a successful task: accept true plays FRIDAY_DONE_SONG; false speaks a focus-mode recap (last 3 voice sessions). */
voiceRouter.post('/celebration', async (req, res, next) => {
  try {
    const accept = Boolean(req.body?.accept);
    const song = (process.env.FRIDAY_DONE_SONG || '').trim();
    const result = await resolveCelebration(req.log, accept);
    if (accept && result.played && song) {
      broadcastEvent('music_play', buildMusicPlaySsePayload(song, 'clip'));
    }
    res.json({ ok: true, ...result });
  } catch (e) {
    next(e);
  }
});

/** Speak text asynchronously via friday-speak.py with Jarvis voice settings (fire-and-forget).
 * Used for incoming messages (WhatsApp, email, etc.) to auto-speak responses.
 */
voiceRouter.post('/speak-async', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) {
    return res.status(400).json({ error: 'Missing text in body: { "text": "Hello" }' });
  }
  if (!existsSync(SPEAK_SCRIPT)) {
    return res.status(503).json({ error: 'friday-speak.py not found', hint: 'Install skill-gateway scripts.' });
  }

  const style = await getSpeakStyle();
  const delivery = mergeDeliveryWithSpeakStyle(greetingTtsRatePitch(), style);
  const child = spawn(pythonChildExecutable(), [SPEAK_SCRIPT, text], {
    env: {
      ...process.env,
      FRIDAY_TTS_VOICE:  process.env.FRIDAY_TTS_VOICE  || 'en-US-AvaMultilingualNeural',
      FRIDAY_TTS_DEVICE: process.env.FRIDAY_TTS_DEVICE || 'default',
      FRIDAY_TTS_PRIORITY: '1',
      FRIDAY_TTS_BYPASS_CURSOR_DEFER: 'true',
      ...delivery,
    },
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });

  child.stderr?.on('data', (buf) => {
    const line = buf.toString().trim();
    if (line) req.log?.warn({ fridaySpeak: line }, '/voice/speak-async stderr');
  });

  // Check if autoPlay is enabled - if so, suppress visual UI and only play audio
  const { isAutoPlayEnabled } = await import('./voiceRedis.js');
  const autoPlayEnabled = await isAutoPlayEnabled('api');
  const preview = text.length > 240 ? `${text.slice(0, 240)}…` : text;

  // Only broadcast speak event if autoPlay is NOT enabled (show UI when not in background mode)
  if (!autoPlayEnabled) {
    broadcastEvent('speak', { text: preview });
  }

  let listenSent = false;
  const emitListenDone = () => {
    if (listenSent) return;
    listenSent = true;
    // Only emit listening if we showed the speak event
    if (!autoPlayEnabled) {
      broadcastEvent('listening', {});
    }
  };
  child.once('close', emitListenDone);
  child.once('error', emitListenDone);

  res.json({ ok: true, text: text.slice(0, 60), autoPlay: autoPlayEnabled });
});

/** Toggle autoPlay mode (background-only playback, no visual UI). */
voiceRouter.post('/auto-play', async (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'Expected { enabled: boolean }' });
  }
  const { setAutoPlay, isAutoPlayEnabled } = await import('./voiceRedis.js');
  await setAutoPlay('api', enabled);
  const newState = await isAutoPlayEnabled('api');
  res.json({ ok: true, autoPlay: newState });
});

/** Get current autoPlay status. */
voiceRouter.get('/auto-play', async (req, res) => {
  const { isAutoPlayEnabled } = await import('./voiceRedis.js');
  const autoPlay = await isAutoPlayEnabled('api');
  res.json({ ok: true, autoPlay });
});

/** Free local neural TTS (Piper) → WAV; optional paid OpenAI (set FRIDAY_TTS_OPENAI=true). Else client uses browser. */
voiceRouter.post('/tts', async (req, res) => {
  const text = prepareTextForTts(req.body?.text);
  if (!text || text === 'Done.') {
    return res.status(400).json({ error: 'Missing text' });
  }

  // Optional per-session voice from client — validated against allowed (non-blocked) catalogue.
  const reqVoice   = (typeof req.body?.voice === 'string' && req.body.voice.trim()) ? req.body.voice.trim() : null;
  const allowed    = filteredEdgeTtsCatalogue();
  const isKnown    = reqVoice && allowed.some((v) => v.voice === reqVoice);
  const resolvedVoice = isKnown ? reqVoice : edgeTtsVoice();

  if (piperConfigured()) {
    try {
      const wav = synthesizePiperWav(text, {
        piperBin: process.env.PIPER_PATH,
        modelPath: process.env.PIPER_MODEL,
      });
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Friday-Tts', 'piper');
      return res.send(wav);
    } catch (e) {
      req.log?.warn({ err: String(e.message || e) }, 'piper tts failed');
      return res.status(502).json({
        error: 'Piper TTS failed',
        detail: String(e.message || e).slice(0, 300),
        fallback: 'browser',
      });
    }
  }

  if (edgeTtsConfigured()) {
    try {
      const mp3 = await synthesizeEdgeTtsMp3(text, { voice: resolvedVoice });
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Friday-Tts', 'edge');
      res.setHeader('X-Friday-Tts-Voice', resolvedVoice);
      return res.send(mp3);
    } catch (e) {
      req.log?.warn({ err: String(e.message || e) }, 'edge tts failed — falling through');
    }
  }

  if (openAiTtsConfigured()) {
    try {
      const mp3 = await synthesizeOpenAiMp3(text, {
        apiKey: openAiTtsApiKey(),
        model: process.env.FRIDAY_TTS_MODEL || 'tts-1-hd',
        voice: process.env.FRIDAY_TTS_VOICE || 'nova',
      });
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Friday-Tts', 'openai');
      return res.send(mp3);
    } catch (e) {
      req.log?.warn({ err: String(e.message || e) }, 'openai tts failed');
      return res.status(502).json({
        error: 'OpenAI TTS failed',
        detail: String(e.message || e).slice(0, 300),
        fallback: 'browser',
      });
    }
  }

  return res.status(501).json({
    fallback: 'browser',
    hint: 'Edge TTS should be active by default. Set FRIDAY_TTS_EDGE=false to disable. Or install Piper (docs/setup.md) for offline neural TTS.',
  });
});

/** SSE stream — browser subscribes here for real-time voice daemon events. */
voiceRouter.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Replay only tail — full buffer on every reconnect duplicates the whole conversation in the UI
  const SSE_REPLAY_TAIL = 35;
  const tail = sseBuffer.slice(-SSE_REPLAY_TAIL);
  for (const msg of tail) {
    try { res.write(msg); } catch { /* ignore */ }
  }

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));

  // Heartbeat every 20 s to keep the connection alive through proxies
  const hb = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { clearInterval(hb); sseClients.delete(res); }
  }, 20_000);
  req.on('close', () => clearInterval(hb));
});

/** Receive status events from friday-listen.py and broadcast to SSE clients. */
voiceRouter.post('/event', (req, res) => {
  const { type, ...rest } = req.body || {};
  if (type) broadcastEvent(type, rest);
  res.json({ ok: true, clients: sseClients.size });
});

/** Return curated Edge TTS voice catalogue + current active voice. */
voiceRouter.get('/voices', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    provider: ttsProviderLabel(),
    active: edgeTtsConfigured() ? edgeTtsVoice() : null,
    voices: filteredEdgeTtsCatalogue(),
    blockedVoices: [...getVoiceBlockSet()],
  });
});

/** Return live status of every tracked voice context from Redis. */
voiceRouter.get('/status', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const contexts = await getAllVoiceContexts();
    res.json({ ok: true, contexts });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

/** Set the active Edge TTS voice for this server session (persisted to Redis). */
voiceRouter.post('/set-voice', (req, res) => {
  const { voice } = req.body || {};
  if (!voice || typeof voice !== 'string') {
    return res.status(400).json({ error: 'Missing voice name in body: { "voice": "en-US-AvaMultilingualNeural" }' });
  }
  const trimmed = voice.trim();
  if (isVoiceBlocked(trimmed)) {
    return res.status(400).json({
      error: 'Voice is blocked (FRIDAY_TTS_VOICE_BLOCK). Choose another from GET /voice/voices.',
      blockedVoices: [...getVoiceBlockSet()],
    });
  }
  setSessionVoice(trimmed);
  const active = edgeTtsVoice();
  broadcastEvent('voice_changed', { voice: active });
  res.json({ ok: true, active });
});

/** Global speak mood toggles + custom prompt (Redis). */
voiceRouter.get('/speak-style', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const style = await getSpeakStyle();
    res.json({
      ok: true,
      style,
      promptPreview: buildSpeakStyleInstruction(style) || null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

voiceRouter.post('/speak-style', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const allowed = ['funny', 'snarky', 'bored', 'dry', 'warm', 'customPrompt'];
    const patch = {};
    for (const k of allowed) {
      if (Object.prototype.hasOwnProperty.call(body, k)) {
        if (k === 'customPrompt') {
          patch[k] = typeof body[k] === 'string' ? body[k] : '';
        } else {
          patch[k] = Boolean(body[k]);
        }
      }
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({
        error: 'No valid fields. Send { funny, snarky, bored, dry, warm, customPrompt }.',
      });
    }
    const style = await setSpeakStyle(patch);
    broadcastEvent('speak_style_changed', { style });
    res.json({
      ok: true,
      style,
      promptPreview: buildSpeakStyleInstruction(style) || null,
    });
  } catch (err) {
    if (err.code === 'REDIS_DOWN') {
      return res.status(503).json({ ok: false, error: String(err.message || err) });
    }
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.use('/voice', voiceRouter);

app.get('/health', async (_req, res) => {
  const uptimeSec = Math.floor(process.uptime());
  const startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
  const body = { ok: true, service: 'openclaw-pc-agent', uptimeSec, startedAt };
  if (perceptionDbConfigured()) {
    body.database = await perceptionDbHealth();
    body.postgres = body.database;
  }
  try {
    body.personas = await getVoicePersonasRegistrySnapshot();
  } catch {
    /* ignore */
  }
  const gw = gatewayBaseUrl();
  body.links = {
    openclawStatusProxy: `http://127.0.0.1:${PORT}/openclaw/status`,
    gatewayOpenclawStatus: `${gw}/openclaw/status`,
    personasJson: `http://127.0.0.1:${PORT}/settings/personas`,
  };
  res.json(body);
});

/** Aggregated stack status (proxies skill-gateway) + local persona registry snapshot. No auth — same host as Listen. */
app.get('/openclaw/status', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const gw = gatewayBaseUrl();
  try {
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), 4500);
    const r = await fetch(`${gw}/openclaw/status`, { signal: ac.signal });
    clearTimeout(tid);
    const j = await r.json();
    try {
      j.personas = await getVoicePersonasRegistrySnapshot();
      j.personas.note = 'Full merged roster: GET /settings/personas (Bearer JWT or PC_AGENT_SECRET)';
      j.links = {
        ...(typeof j.links === 'object' && j.links ? j.links : {}),
        listenOpenclawStatus: `http://127.0.0.1:${PORT}/openclaw/status`,
        gatewayOpenclawStatus: `${gw}/openclaw/status`,
        personasSettings: `http://127.0.0.1:${PORT}/settings/personas`,
      };
    } catch (e) {
      j.personasError = String(e.message || e);
    }
    res.status(r.status).json(j);
  } catch (e) {
    let personas = null;
    try {
      personas = await getVoicePersonasRegistrySnapshot();
    } catch {
      /* ignore */
    }
    res.status(502).json({
      ok: false,
      error: String(e.message || e),
      hint: 'Start skill-gateway on 3848 or set OPENCLAW_SKILL_GATEWAY_URL',
      gatewayTried: gw,
      personas,
      links: {
        listenOpenclawStatus: `http://127.0.0.1:${PORT}/openclaw/status`,
        gatewayOpenclawStatus: `${gw}/openclaw/status`,
        personasSettings: `http://127.0.0.1:${PORT}/settings/personas`,
      },
    });
  }
});

app.get('/', (_req, res) => {
  res.redirect(302, '/friday');
});

app.get('/favicon.svg', (_req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(publicDir, 'favicon.svg'));
});

app.get('/favicon.ico', (_req, res) => {
  res.redirect(302, '/favicon.svg');
});

app.get('/friday', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  const htmlPath = path.join(publicDir, 'voice.html');
  const secret = String(process.env.PC_AGENT_SECRET || '').trim();
  if (!secret) {
    res.sendFile(htmlPath);
    return;
  }
  try {
    const data = await readFile(htmlPath, 'utf8');
    const inject = `<script>window.__OPENCLAW_PC_AGENT_BEARER__=${JSON.stringify(secret)};</script>`;
    const out = data.includes('</head>')
      ? data.replace('</head>', `${inject}</head>`)
      : `${inject}${data}`;
    res.type('html').send(out);
  } catch (e) {
    rootLogger.error({ err: e }, 'failed to serve /friday');
    res.status(500).send('Failed to load voice UI');
  }
});

// React SPA routes — serve React app for /friday/listen
// Falls back to index.html for client-side routing
const reactDistDir = path.join(__dirname, '../dist');
const reactIndexPath = path.join(reactDistDir, 'index.html');

function injectListenPageBoot(html) {
  const secret = String(process.env.PC_AGENT_SECRET || '').trim();
  const auto = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.PC_AGENT_LISTEN_AUTO_LOGIN || '').trim().toLowerCase(),
  );
  if (!secret) return html;
  const bits = [`window.__OPENCLAW_PC_AGENT_BEARER__=${JSON.stringify(secret)}`];
  if (auto) bits.push('window.__OPENCLAW_LISTEN_AUTO_LOGIN__=true');
  const inject = `<script>${bits.join(';')};</script>`;
  return html.includes('</head>') ? html.replace('</head>', `${inject}</head>`) : `${inject}${html}`;
}

app.get('/friday/listen', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Content-Type', 'text/html');

  const builtPath = reactIndexPath;
  const htmlPath = existsSync(builtPath) ? builtPath : path.join(publicDir, 'listen.html');
  try {
    const raw = await readFile(htmlPath, 'utf8');
    res.send(injectListenPageBoot(raw));
  } catch (e) {
    rootLogger.error({ err: e }, 'failed to serve /friday/listen');
    res.status(500).send('Failed to load Listen UI');
  }
});

// Serve React app static assets (JS, CSS, etc.) from dist/
if (existsSync(reactDistDir)) {
  app.use(express.static(reactDistDir, { index: false }));
}

app.get('/jarvis', (_req, res) => {
  res.redirect(302, '/friday');
});

app.post('/task', authTaskOrUser, async (req, res, next) => {
  try {
    const orgId = req.user?.orgId ?? null;
    const out = await runTask(req.body, req.log, { orgId });
    res.status(out.status).json(out.json);
  } catch (e) {
    next(e);
  }
});

app.use('/perception', createPerceptionRouter(auth));
app.use('/settings', createSettingsRouter(auth));
app.use('/automation', createAutomationRouter(auth));
app.use('/integrations', createIntegrationsRouter(authJwtOrAgentSecret(SECRET)));
app.use('/todos', createTodosRouter(broadcastEvent, SECRET));
app.use('/action-items', createActionItemsRouter());

app.use((err, req, res, _next) => {
  req.log?.error({ err }, 'unhandled route error');
  if (!res.headersSent) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

process.on('unhandledRejection', (reason) => {
  rootLogger.error({ err: String(reason) }, 'unhandledRejection');
});

let server = null;
let shuttingDown = false;

function exitAfterClose(code) {
  const done = () => process.exit(code);
  if (server?.listening) {
    server.close(() => {
      try {
        rootLogger.info('server closed');
      } catch {
        /* ignore */
      }
      done();
    });
    setTimeout(done, 2500);
  } else {
    done();
  }
}

process.on('uncaughtException', (err) => {
  rootLogger.fatal({ err }, 'uncaughtException');
  exitAfterClose(1);
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    rootLogger.info({ signal }, 'shutting down');
  } catch {
    /* ignore */
  }
  exitAfterClose(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function bootstrap() {
  registerDeferredOpenRouterEmitter((type, data) => broadcastEvent(type, data));

  try {
    await ensureAuthSchema(rootLogger);
  } catch (e) {
    rootLogger.fatal(
      { err: String(e.message || e) },
      'ensureAuthSchema failed — run docker/postgres/init/04-auth-company.sql and 05-multitenant-org.sql on your DB, or fix OPENCLAW_DATABASE_URL',
    );
    process.exit(1);
  }

  server = app.listen(PORT, BIND, () => {
    // Jarvis-style startup banner
    process.stdout.write(
      '\n\x1b[35m╔══════════════════════════════════════════════════════════════╗\x1b[0m\n' +
      '\x1b[35m║\x1b[0m  \x1b[1;37m░░  F · R · I · D · A · Y  —  OpenClaw PC Agent      ░░\x1b[0m  \x1b[35m║\x1b[0m\n' +
      '\x1b[35m║\x1b[0m  \x1b[90mVoice UI  ·  Claude  ·  Edge TTS  ·  All Systems Go\x1b[0m       \x1b[35m║\x1b[0m\n' +
      '\x1b[35m╚══════════════════════════════════════════════════════════════╝\x1b[0m\n\n',
    );

    rootLogger.info(
      {
        bind: `${BIND}:${PORT}`,
        voiceUi: `http://127.0.0.1:${PORT}/friday`,
        voicePing: `http://127.0.0.1:${PORT}/voice/ping`,
        tts: ttsProviderLabel(),
        ttsVoice: ttsProviderLabel() === 'edge' ? edgeTtsVoice() : undefined,
        bindNote: BIND === '0.0.0.0' ? 'all-interfaces' : 'loopback',
        logLevel: process.env.LOG_LEVEL || 'default',
        logDir: process.env.OPENCLAW_LOG_DIR || null,
        nodeEnv: process.env.NODE_ENV || 'development',
      },
      'pc-agent listening',
    );

    broadcastEvent('server_start', { text: 'PC Agent online. All systems go.' });
    // Restore the last API session voice from Redis so it survives restarts
    restoreSessionVoiceFromRedis().catch(() => {});
    void refreshPersonaPatchRedisFromDb().then((ok) => {
      if (ok) rootLogger.info('voice_agent_personas: Redis patch synced from Postgres (for Python daemons)');
    });
    speakStartup();
  });
  server.on('error', (err) => {
    rootLogger.fatal({ err }, 'server listen error');
    process.exit(1);
  });
}

bootstrap();
