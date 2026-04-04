import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import express from 'express';
import dotenv from 'dotenv';
import pinoHttp from 'pino-http';
import { rootLogger } from './log.js';
import { runTask } from './taskRunner.js';
import { prepareTextForTts } from './ttsPrep.js';
import { piperConfigured, synthesizePiperWav } from './piperTts.js';
import { edgeTtsConfigured, edgeTtsVoice, synthesizeEdgeTtsMp3 } from './edgeTts.js';
import { openAiTtsApiKey, openAiTtsConfigured, synthesizeOpenAiMp3 } from './openaiTts.js';

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

const PORT = Number(process.env.PC_AGENT_PORT || 3847);

// ── Friday startup voice ──────────────────────────────────────────────────────
const SPEAK_SCRIPT = path.resolve(__dirname, '../../skill-gateway/scripts/friday-speak.py');

const PC_AGENT_GREETINGS = [
  'P.C. agent online. Voice interface active. Ready to assist, sir.',
  'All local systems operational. Friday standing by, sir.',
  'Agent initialised. Claude is armed and standing by, sir.',
  'Online. What shall we build today, sir?',
  'Systems up. Voice and command interface ready, sir.',
];

function speakStartup() {
  if (process.env.FRIDAY_SPEAK_PY === 'false' || process.env.FRIDAY_SPEAK_PY === '0') return;
  if (!existsSync(SPEAK_SCRIPT)) return;
  const phrase = PC_AGENT_GREETINGS[Math.floor(Math.random() * PC_AGENT_GREETINGS.length)];
  const child = spawn('python', [SPEAK_SCRIPT, phrase], {
    env: {
      ...process.env,
      FRIDAY_TTS_VOICE:  process.env.FRIDAY_TTS_VOICE  || 'en-GB-RyanNeural',
      FRIDAY_TTS_DEVICE: process.env.FRIDAY_TTS_DEVICE || 'default',
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
    p === '/favicon.ico'
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
    const out = await runTask(req.body, req.log);
    res.status(out.status).json(out.json);
  } catch (e) {
    next(e);
  }
});

/** Free local neural TTS (Piper) → WAV; optional paid OpenAI (set FRIDAY_TTS_OPENAI=true). Else client uses browser. */
voiceRouter.post('/tts', async (req, res) => {
  const text = prepareTextForTts(req.body?.text);
  if (!text || text === 'Done.') {
    return res.status(400).json({ error: 'Missing text' });
  }

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
      const mp3 = await synthesizeEdgeTtsMp3(text, { voice: edgeTtsVoice() });
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Friday-Tts', 'edge');
      res.setHeader('X-Friday-Tts-Voice', edgeTtsVoice());
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

  // Replay recent history so the page isn't blank on (re)connect
  for (const msg of sseBuffer) {
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

app.use('/voice', voiceRouter);

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'openclaw-pc-agent' });
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

app.get('/friday', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.sendFile(path.join(publicDir, 'voice.html'));
});

app.get('/friday/listen', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.sendFile(path.join(publicDir, 'listen.html'));
});

app.get('/jarvis', (_req, res) => {
  res.redirect(302, '/friday');
});

app.post('/task', auth, async (req, res, next) => {
  try {
    const out = await runTask(req.body, req.log);
    res.status(out.status).json(out.json);
  } catch (e) {
    next(e);
  }
});

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
  speakStartup();
});
server.on('error', (err) => {
  rootLogger.fatal({ err }, 'server listen error');
  process.exit(1);
});
