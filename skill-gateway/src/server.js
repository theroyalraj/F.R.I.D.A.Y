import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import dotenv from 'dotenv';
import pinoHttp from 'pino-http';
import { verifyAlexaHttpRequest } from './verifyAmazon.js';
import { rootLogger } from './log.js';
import { summarizeAlexaRequest } from './alexaMeta.js';
import {
  buildSsmlSpeak,
  extractUserCommand,
  nextFridayGreetingSsml,
  randomAckText,
  randomProgressiveSsml,
  randomStopSsml,
  sendProgressiveSpeak,
  skillResponse,
} from './alexa.js';
import {
  rememberLastSpoken,
  getLastSpoken,
  setAwaitingUserReply,
  getAwaitingUserReply,
  clearAwaitingUserReply,
} from './memory.js';
import {
  proactiveNotifyConfigured,
  sendUnicastNotification,
  aiSummariesEnabled,
  generateAiSummary,
} from './alexaProactive.js';
import { winTtsEnabled, speakWinTts } from './winTts.js';
import { loadOpenclawUserConfig } from './userConfig.js';
import { useDirectIntake, enqueueDirectToPcAgent } from './directIntake.js';
import {
  fridaySpeakEnabled,
  speakFridayPy,
  speakGatewayStartup,
  speakTaskDone,
  speakAlexaLaunch,
  speakAlexaCommand,
  speakJarvisReadyAfterSong,
} from './fridaySpeak.js';
import { notifyFollowupListenEnabled, spawnNotifyFollowupListen } from './notifyFollowupListen.js';
import { alexaMusicConfigured, alexaPlayMusic, alexaStopMusic } from './alexaMusic.js';
import { playLocalSong } from './fridayPlay.js';
import { startBriefingCron } from './briefingCron.js';
import { stopAllFridayAudioAsync } from './stopAllFridayAudio.js';

/** When true, startup / done / launch songs use yt-dlp on the PC even if an Alexa cookie exists (hear music on your Windows output). */
function fridaySongsPreferLocalPc() {
  return ['1', 'true', 'yes', 'on'].includes(
    String(process.env.FRIDAY_SONGS_PREFER_LOCAL_PC || '').toLowerCase(),
  );
}

/** Play `FRIDAY_STARTUP_SONG` locally or via Alexa (same routing as gateway boot). */
function playStartupSong(log) {
  const phrase = process.env.FRIDAY_STARTUP_SONG;
  if (!phrase?.trim()) return;

  const promptAfterSong = !['false', '0', 'no', 'off'].includes(
    String(process.env.FRIDAY_STARTUP_AFTER_SONG_PROMPT ?? 'true').toLowerCase(),
  );
  const gapMs = Math.max(0, parseInt(process.env.FRIDAY_STARTUP_AFTER_SONG_GAP_MS || '700', 10));

  const jarvisPrompt = () => {
    if (!promptAfterSong || !fridaySpeakEnabled()) return;
    const run = () => speakJarvisReadyAfterSong(log);
    if (gapMs > 0) setTimeout(run, gapMs);
    else run();
  };

  if (fridaySongsPreferLocalPc()) {
    playLocalSong(phrase, log, { onClose: jarvisPrompt });
  } else if (alexaMusicConfigured()) {
    alexaPlayMusic(phrase, log)
      .then(() => {
        const sec = parseInt(process.env.FRIDAY_PLAY_SECONDS || '45', 10);
        // Alexa has no end signal — approximate clip length (+ gap inside jarvisPrompt).
        setTimeout(jarvisPrompt, Math.max(4000, sec * 1000));
      })
      .catch((err) => {
        log.warn({ err: String(err?.message || err) }, 'startup song: Alexa failed — local friday-play');
        playLocalSong(phrase, log, { onClose: jarvisPrompt });
      });
  } else {
    playLocalSong(phrase, log, { onClose: jarvisPrompt });
  }
}

/** PC welcome line first; then optional gap; then startup song. If neural TTS is off, skip straight to the song. */
function scheduleStartupAfterWelcome(log, songGapMs) {
  const kick = () => {
    setTimeout(() => playStartupSong(log), Math.max(0, songGapMs));
  };
  if (fridaySpeakEnabled()) {
    speakGatewayStartup(log, 'gateway', { onClose: kick });
  } else {
    kick();
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });
loadOpenclawUserConfig();

const PORT = Number(process.env.PORT || 3848);
const N8N_INTAKE_URL = process.env.N8N_INTAKE_URL || 'http://127.0.0.1:5678/webhook/friday-intake';
const N8N_WEBHOOK_SECRET = process.env.N8N_WEBHOOK_SECRET || '';
const VERIFY_SIG = process.env.ALEXA_VERIFY_SIGNATURE !== 'false';

function verifyAlexaSignature(req, res, buf) {
  req.rawBody = buf.toString('utf8');
}

const app = express();

app.disable('x-powered-by');

app.use((req, res, next) => {
  req.openclawReqId = crypto.randomUUID();
  next();
});

app.use(
  pinoHttp({
    logger: rootLogger,
    genReqId: (req) => req.openclawReqId,
    autoLogging: {
      ignore: (req) => req.url === '/health',
    },
    customProps: (req) => ({ openclawReqId: req.openclawReqId }),
    serializers: {
      req: (req) => ({
        id: req.id,
        method: req.method,
        url: req.url,
        openclawReqId: req.openclawReqId,
        hasSig256: Boolean(req.headers['signature-256']),
        hasSig: Boolean(req.headers.signature),
        hasCertChain: Boolean(req.headers.signaturecertchainurl),
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

app.use(express.json({ verify: verifyAlexaSignature, limit: '1mb' }));

function runVerifier(req, res, next) {
  if (!VERIFY_SIG) {
    req.log.warn('ALEXA_VERIFY_SIGNATURE disabled — not for production');
    return next();
  }
  const cert = req.headers.signaturecertchainurl;
  const signature256 = req.headers['signature-256'];
  const signature = req.headers.signature;
  const body = req.rawBody;
  if (!cert || !body) {
    req.log.warn('reject: missing cert URL or body');
    return res.status(400).send('Missing Alexa request body or cert URL');
  }
  if (!signature256 && !signature) {
    req.log.warn('reject: missing signature headers');
    return res.status(400).send('Missing Signature-256 or Signature header');
  }
  verifyAlexaHttpRequest(cert, signature256, signature, body, (err) => {
    if (err) {
      req.log.warn({ err: String(err), phase: 'signature-verify' }, 'amazon verify failed');
      return res.status(400).send('Bad Request');
    }
    next();
  });
}

/** Public path for Lambda / single-tunnel setups: same host as /alexa, forwards to N8N or direct pc-agent. */
app.post('/webhook/friday-intake', async (req, res) => {
  const t0 = Date.now();
  const secret = req.headers['x-openclaw-secret'];
  try {
    if (useDirectIntake()) {
      if (N8N_WEBHOOK_SECRET && secret !== N8N_WEBHOOK_SECRET) {
        req.log.warn('webhook/friday-intake unauthorized (direct mode)');
        return res.status(401).json({ error: 'Unauthorized' });
      }
      await enqueueDirectToPcAgent(req.body ?? {}, req.log, N8N_WEBHOOK_SECRET);
      req.log.info({ directIntake: true, ms: Date.now() - t0 }, 'webhook friday-intake handled direct');
      return res.status(202).json({ ok: true, direct: true });
    }
    const r = await fetch(N8N_INTAKE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(secret ? { 'X-Openclaw-Secret': secret } : {}),
      },
      body: JSON.stringify(req.body ?? {}),
    });
    const buf = Buffer.from(await r.arrayBuffer());
    req.log.info({ n8nProxy: true, status: r.status, ms: Date.now() - t0 }, 'proxied friday-intake to n8n');
    res.status(r.status);
    const ct = r.headers.get('content-type');
    if (ct && ct.includes('application/json') && buf.length) {
      try {
        return res.json(JSON.parse(buf.toString('utf8')));
      } catch {
        /* fall through */
      }
    }
    if (buf.length) return res.type(ct || 'application/octet-stream').send(buf);
    return res.end();
  } catch (e) {
    req.log.error({ err: String(e.message || e), ms: Date.now() - t0 }, 'n8n proxy failed');
    if (!res.headersSent) res.status(502).json({ error: 'Upstream N8N unreachable' });
  }
});

function enqueueN8n(payload, reqLog) {
  if (!N8N_WEBHOOK_SECRET) {
    reqLog.warn('N8N_WEBHOOK_SECRET empty; skipping enqueue');
    return;
  }
  const t0 = Date.now();
  fetch(N8N_INTAKE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Openclaw-Secret': N8N_WEBHOOK_SECRET,
    },
    body: JSON.stringify(payload),
  })
    .then((r) => {
      reqLog.info(
        {
          n8n: true,
          status: r.status,
          ms: Date.now() - t0,
          correlationId: payload.correlationId,
        },
        'n8n webhook response',
      );
    })
    .catch((e) => {
      reqLog.error({ err: String(e.message || e), correlationId: payload.correlationId }, 'n8n enqueue error');
    });
}

/** N8N workflow or direct pc-agent when OPENCLAW_DIRECT_INTAKE=true (macOS app / simple installs). */
function enqueueIntake(payload, reqLog) {
  if (useDirectIntake()) {
    enqueueDirectToPcAgent(payload, reqLog, N8N_WEBHOOK_SECRET).catch((e) => {
      reqLog.error({ err: String(e.message || e), correlationId: payload.correlationId }, 'direct intake threw');
    });
    return;
  }
  enqueueN8n(payload, reqLog);
}

/**
 * Curl / Postman: enqueue a PC task like Lambda→N8N without an Alexa skill envelope.
 * Header X-Openclaw-Secret = N8N_WEBHOOK_SECRET. Body: commandText (required), userId, locale, correlationId, …
 * Do not use /alexa for this shape — /alexa expects version/session/context/request + Amazon signatures.
 */
app.post('/openclaw/trigger', (req, res) => {
  const secret = req.headers['x-openclaw-secret'];
  if (!N8N_WEBHOOK_SECRET || secret !== N8N_WEBHOOK_SECRET) {
    req.log.warn('openclaw/trigger unauthorized');
    return res.status(401).json({
      error: 'Unauthorized',
      hint: 'Send header X-Openclaw-Secret with the same value as N8N_WEBHOOK_SECRET in .env',
    });
  }
  const b = req.body || {};
  const cmd = String(b.commandText ?? '').trim();
  if (!cmd) {
    return res.status(400).json({ error: 'Missing commandText' });
  }
  const payload = {
    correlationId: b.correlationId || crypto.randomUUID(),
    source: String(b.source || 'openclaw-trigger').slice(0, 48),
    userId: typeof b.userId === 'string' && b.userId.trim() ? b.userId.trim() : 'anonymous',
    locale: typeof b.locale === 'string' && b.locale.trim() ? b.locale.trim() : 'en-US',
    commandText: cmd,
    requestType: 'IntentRequest',
    alexaRequestId: b.alexaRequestId || `openclaw-trigger.${crypto.randomUUID()}`,
    apiEndpoint: typeof b.apiEndpoint === 'string' ? b.apiEndpoint : undefined,
    receivedAt:
      typeof b.receivedAt === 'string' && b.receivedAt.trim()
        ? b.receivedAt.trim()
        : new Date().toISOString(),
  };
  enqueueIntake(payload, req.log);
  res.status(202).json({
    ok: true,
    queued: true,
    correlationId: payload.correlationId,
    hint: '/alexa is only for real Alexa JSON + signatures; this endpoint is for manual triggers.',
  });
});

app.post('/alexa', runVerifier, async (req, res, next) => {
  const t0 = Date.now();
  try {
    const body = req.body;
    // Support both standard Alexa SDK format (body.request.type) and
    // our custom Lambda flat format (body.requestType)
    const requestType = body?.request?.type || body?.requestType;

    req.log.info({ alexa: summarizeAlexaRequest(body) }, 'alexa request accepted');

    if (requestType === 'SessionEndedRequest') {
      req.log.debug({ reason: body?.request?.reason }, 'session ended');
      return res.json({ version: '1.0' });
    }

    const userId =
      body?.session?.user?.userId ||
      body?.context?.System?.user?.userId ||
      body?.userId ||       // flat Lambda format
      'anonymous';
    const locale      = body?.request?.locale      || body?.locale      || 'en-US';
    const apiEndpoint = body?.context?.System?.apiEndpoint || body?.apiEndpoint;
    const apiAccessToken = body?.context?.System?.apiAccessToken;
    const requestId   = body?.request?.requestId   || body?.alexaRequestId;

    const extracted = extractUserCommand(body);

    if (extracted?.kind === 'stop') {
      req.log.info('intent: stop');
      return res.json(skillResponse({ ssml: randomStopSsml(locale), shouldEndSession: true }));
    }
    if (extracted?.kind === 'help') {
      req.log.info('intent: help');
      return res.json(
        skillResponse({
          ssml: buildSsmlSpeak(
            'I am your Friday — apps, files, Claude jobs on this PC, the nerdy stuff too. If something on the machine is waiting on you, open me again for the reminder, or say I took care of it when you are done. What do you want to try?',
            locale,
          ),
          shouldEndSession: false,
        }),
      );
    }
    if (extracted?.kind === 'last_result') {
      req.log.info('intent: last_result');
      const last = getLastSpoken(userId);
      const pending = getAwaitingUserReply(userId);
      let msg = last || 'Nothing new yet — ask me to do something first, then check back for the last result.';
      if (pending?.prompt) {
        msg = `Your PC is still waiting for you: ${pending.prompt}. ${msg}`;
      }
      return res.json(skillResponse({ ssml: buildSsmlSpeak(msg, locale), shouldEndSession: true }));
    }
    if (extracted?.kind === 'ack_pending') {
      req.log.info('intent: ack_pending');
      clearAwaitingUserReply(userId);
      const ssml = buildSsmlSpeak('Got it — I will drop that reminder. What should we tackle next?', locale);
      const repromptSsml = buildSsmlSpeak('Anything else you need?', locale);
      return res.json(skillResponse({ ssml, shouldEndSession: false, repromptSsml }));
    }

    if (requestType === 'LaunchRequest') {
      // Any LaunchRequest (probe or real open) = system init:
      //   1. Speak PC welcome TTS first (friday-speak runs to completion)
      //   2. Then play startup song (local friday-play or Alexa)
      //   3. Respond to Alexa with SSML greeting + keep session open for commands
      req.log.info({ ms: Date.now() - t0, probe: !!body.lambdaLaunchProbe }, 'launch — triggering init sequence');

      const initSong = process.env.FRIDAY_STARTUP_SONG;
      const welcomeDelayMs = parseInt(process.env.FRIDAY_STARTUP_WELCOME_DELAY_MS || '500', 10);
      const songGapMs = parseInt(process.env.FRIDAY_STARTUP_SONG_DELAY_MS || '0', 10);

      if (initSong?.trim()) {
        setTimeout(() => scheduleStartupAfterWelcome(req.log, songGapMs), welcomeDelayMs);
      } else {
        setTimeout(() => speakGatewayStartup(req.log), 1500);
      }

      // If there is a pending user-reply prompt, surface it first
      const pending = getAwaitingUserReply(userId);
      let ssml, repromptSsml;
      if (pending?.prompt) {
        ssml = buildSsmlSpeak(
          `Reminder: your PC needs something from you — ${pending.prompt}. When you have handled it, say I took care of it. You can also give me a new command.`,
          locale,
        );
        repromptSsml = buildSsmlSpeak('Say I took care of it, or tell me what to do next.', locale);
      } else {
        ssml         = nextFridayGreetingSsml(userId, locale);
        repromptSsml = buildSsmlSpeak('What should we try on the PC?', locale);
      }

      // For a probe the Lambda doesn't care about the session, but keeping it open
      // costs nothing and lets a real voice invocation immediately issue commands.
      return res.json(skillResponse({ ssml, shouldEndSession: false, repromptSsml }));
    }

    let commandText = extracted?.kind === 'command' ? extracted.text?.trim() || '' : '';
    if (!commandText && requestType === 'IntentRequest') {
      req.log.info('intent: empty command reprompt');
      const msg =
        "I didn't catch that. Try: Alexa, ask Friday to open Notepad. If you used open with the skill name, do not say open again for the app.";
      return res.json(
        skillResponse({
          ssml: buildSsmlSpeak(msg, locale),
          shouldEndSession: false,
          repromptSsml: buildSsmlSpeak(msg, locale),
        }),
      );
    }

    const correlationId = crypto.randomUUID();
    const progressiveSsml = randomProgressiveSsml(locale);
    await sendProgressiveSpeak({
      apiEndpoint,
      apiAccessToken,
      requestId,
      ssml: progressiveSsml,
    }).catch((e) => req.log.warn({ err: String(e) }, 'progressive speak threw'));

    const ackText = randomAckText();
    rememberLastSpoken(userId, ackText);

    enqueueIntake(
      {
        correlationId,
        source: 'alexa',
        userId,
        locale,
        commandText,
        requestType,
        alexaRequestId: requestId,
        apiEndpoint,
        receivedAt: new Date().toISOString(),
      },
      req.log,
    );

    req.log.info({ correlationId, commandPreview: commandText.slice(0, 80), ms: Date.now() - t0 }, 'command queued');
    speakAlexaCommand(req.log);
    const followUpReprompt = buildSsmlSpeak('Anything else you want to do on the PC?', locale);
    return res.json(
      skillResponse({
        ssml: buildSsmlSpeak(ackText, locale),
        shouldEndSession: false,
        repromptSsml: followUpReprompt,
      }),
    );
  } catch (err) {
    next(err);
  }
});

function requireN8nSecret(req, res) {
  const secret = req.headers['x-openclaw-secret'];
  if (!N8N_WEBHOOK_SECRET || secret !== N8N_WEBHOOK_SECRET) {
    req.log.warn('internal route unauthorized');
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

/** Lambda / tools: POST { userId } → { message, summary } (includes awaiting-user prompt if any). */
app.post('/internal/last-result/fetch', (req, res) => {
  if (!requireN8nSecret(req, res)) return;
  const { userId } = req.body || {};
  const uid = userId || 'anonymous';
  const last = getLastSpoken(uid);
  const pending = getAwaitingUserReply(uid);
  let message = last || '';
  if (pending?.prompt) {
    message = `Your PC is still waiting for you: ${pending.prompt}. ${message}`.trim();
  }
  res.json({ message, summary: message });
});

app.post('/internal/last-result', async (req, res, next) => {
  try {
    const secret = req.headers['x-openclaw-secret'];
    if (!N8N_WEBHOOK_SECRET || secret !== N8N_WEBHOOK_SECRET) {
      req.log.warn('last-result unauthorized');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { userId, message, notify, notifyLabel, notifyType, correlationId } = req.body || {};
    if (!message) {
      return res.status(400).json({ error: 'Missing message' });
    }
    rememberLastSpoken(userId || 'anonymous', String(message).slice(0, 500));

    const envPush = process.env.ALEXA_NOTIFY_ON_EACH_TASK_COMPLETION === 'true';
    const wantNotify = notify === true || (notify === undefined && envPush);

    let notification = null;
    if (wantNotify && userId && typeof userId === 'string') {
      if (proactiveNotifyConfigured()) {
        const type        = notifyType || 'task_done';
        const creatorName = (notifyLabel && String(notifyLabel).trim().slice(0, 100)) || undefined;
        notification = await sendUnicastNotification(req.log, {
          userId,
          type,
          rawText:    creatorName ? undefined : String(message),
          creatorName,
          count: 1,
          referenceId: correlationId ? String(correlationId) : undefined,
        });
      } else {
        notification = { skipped: 'lwa_not_configured' };
      }
    }

    req.log.info(
      {
        userId: userId ? '(redacted)' : 'anonymous',
        len: String(message).length,
        notify: Boolean(wantNotify),
        notifOk: notification?.ok,
      },
      'last-result stored',
    );

    // Speak task-done aloud — generate a short AI summary for the spoken phrase.
    // notification.creatorName is formatted for Alexa ("Friday — nailed it: …") so we
    // generate the summary independently here to keep the spoken output natural.
    let speakSummary = String(message).slice(0, 120);
    if (fridaySpeakEnabled() || winTtsEnabled()) {
      if (aiSummariesEnabled()) {
        try {
          const s = await generateAiSummary(req.log, String(message).slice(0, 800), 'task_done');
          if (s) speakSummary = s;
        } catch (e) {
          req.log.warn({ err: String(e.message || e) }, 'speak: AI summary failed, using raw snippet');
        }
      }
      const chainListen = notifyFollowupListenEnabled()
        ? () => spawnNotifyFollowupListen(req.log)
        : undefined;
      if (fridaySpeakEnabled()) {
        speakTaskDone(speakSummary, req.log, { onClose: chainListen });
      } else if (winTtsEnabled()) {
        speakWinTts(speakSummary, req.log, {
          bypassCursorDefer: true,
          priority: true,
          onClose: chainListen,
        });
      }
    }

    // Optional: play a song through Echo Dot when task is done
    const doneSong = process.env.FRIDAY_DONE_SONG;
    if (doneSong) {
      if (fridaySongsPreferLocalPc()) {
        playLocalSong(doneSong, req.log);
      } else if (alexaMusicConfigured()) {
        alexaPlayMusic(doneSong, req.log).catch((err) => {
          req.log.warn({ err: String(err?.message || err) }, 'notify: Alexa music failed — local friday-play');
          playLocalSong(doneSong, req.log);
        });
      } else {
        playLocalSong(doneSong, req.log);
      }
    }

    res.json({ ok: true, notification });
  } catch (e) {
    next(e);
  }
});

/**
 * Set (or replace) a “waiting on you” message for an Alexa userId. Optional Alexa notification.
 * Body: { userId, prompt, correlationId?, notify?: bool, creatorName?, count? }
 */
app.post('/internal/awaiting-user', async (req, res) => {
  if (!requireN8nSecret(req, res)) return;
  const { userId, prompt, correlationId, notify, notifyType, creatorName, count } = req.body || {};
  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ error: 'Missing userId' });
  }
  if (prompt == null || String(prompt).trim() === '') {
    return res.status(400).json({ error: 'Missing prompt' });
  }
  setAwaitingUserReply(userId, { prompt: String(prompt), correlationId });
  let notification = null;
  if (notify === true) {
    if (!proactiveNotifyConfigured()) {
      notification = { ok: false, error: 'proactive_not_configured' };
    } else {
      const type = notifyType || 'waiting';
      notification = await sendUnicastNotification(req.log, {
        userId,
        type,
        rawText:     creatorName ? undefined : String(prompt),
        creatorName: creatorName || undefined,
        count:       count ?? 1,
        referenceId: correlationId ? String(correlationId) : undefined,
      });
    }
  }
  req.log.info(
    { userId: '(redacted)', notify: Boolean(notify), notifOk: notification?.ok },
    'awaiting-user set',
  );
  res.json({ ok: true, notification });
});

/** Clear pending “waiting on user” state (e.g. PC got the reply). Body: { userId } */
app.post('/internal/awaiting-user/clear', (req, res) => {
  if (!requireN8nSecret(req, res)) return;
  const { userId } = req.body || {};
  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ error: 'Missing userId' });
  }
  clearAwaitingUserReply(userId);
  res.json({ ok: true });
});

/** Body: { userId } → { ok, pending: { prompt, correlationId, at } | null } */
app.post('/internal/awaiting-user/peek', (req, res) => {
  if (!requireN8nSecret(req, res)) return;
  const { userId } = req.body || {};
  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ error: 'Missing userId' });
  }
  res.json({ ok: true, pending: getAwaitingUserReply(userId) });
});

/** Stop Alexa music immediately (called by friday-listen.py when voice is detected).
 *  Cooldown of 8s prevents the mic VAD from hammering this on every noise burst. */
let _lastAlexaStop = 0;
app.post('/internal/alexa-stop', async (req, res) => {
  const now = Date.now();
  if (now - _lastAlexaStop < 8_000) {
    return res.json({ ok: true, skipped: 'cooldown' });
  }
  _lastAlexaStop = now;
  await alexaStopMusic(req.log).catch(() => {});
  res.json({ ok: true });
});

/** Kill local friday-player/ffplay, clear music Redis lease, pause Alexa. No mic cooldown.
 *  Query ?full=1 or body { full: true } also clears TTS locks (use after hard wedged state). */
app.post('/internal/stop-all-media', async (req, res) => {
  const full =
    req.query?.full === '1' ||
    req.query?.full === 'true' ||
    req.body?.full === true;
  await stopAllFridayAudioAsync(req.log, { fullPanic: full, alexa: true });
  res.json({ ok: true, fullPanic: Boolean(full) });
});

/**
 * Speak arbitrary text via Jarvis (friday-speak.py).
 * Body: { text } — called by N8N workflows for WhatsApp notifications, reminders, etc.
 */
app.post('/internal/speak', async (req, res) => {
  const secret = req.headers['x-openclaw-secret'];
  if (N8N_WEBHOOK_SECRET && secret !== N8N_WEBHOOK_SECRET) {
    req.log.warn('internal/speak unauthorized');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { text } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  res.json({ ok: true });
  // Fire-and-forget — don't block the response
  const chainListen = notifyFollowupListenEnabled()
    ? () => spawnNotifyFollowupListen(req.log)
    : undefined;
  if (fridaySpeakEnabled()) {
    speakFridayPy(text.trim(), req.log, {
      bypassCursorDefer: true,
      priority: true,
      onClose: chainListen,
    });
  } else if (winTtsEnabled()) {
    speakWinTts(text.trim(), req.log, { bypassCursorDefer: true, onClose: chainListen });
  }
});

/**
 * Push an Alexa notification (Proactive Events — MessageAlert). Same auth as last-result.
 * Body: { userId, creatorName?, count?, referenceId? } — userId must be the skill account id from the intake payload.
 * Requires LWA client credentials + skill manifest (see docs/setup.md). EU endpoints: set ALEXA_PROACTIVE_API_HOST.
 */
app.post('/internal/alexa-notify', async (req, res) => {
  const secret = req.headers['x-openclaw-secret'];
  if (!N8N_WEBHOOK_SECRET || secret !== N8N_WEBHOOK_SECRET) {
    req.log.warn('alexa-notify unauthorized');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { userId, creatorName, count, referenceId } = req.body || {};
  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ error: 'Missing userId' });
  }
  if (!proactiveNotifyConfigured()) {
    return res.status(503).json({
      error: 'Proactive notify not configured',
      hint: 'Set ALEXA_LWA_CLIENT_ID and ALEXA_LWA_CLIENT_SECRET in .env',
    });
  }
  const r = await sendUnicastMessageAlert(req.log, {
    userId,
    creatorName,
    count,
    referenceId,
  });
  if (!r.ok) {
    return res.status(502).json({
      error: r.error,
      status: r.status,
      detail: r.detail,
    });
  }
  res.json({ ok: true, referenceId: r.referenceId, amazonStatus: r.status });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'openclaw-skill-gateway' });
});

app.use(express.static(path.resolve(__dirname, '../public')));

app.use((err, req, res, _next) => {
  req.log?.error({ err }, 'unhandled route error');
  if (!res.headersSent) {
    if (req.path === '/alexa') {
      res.status(500).json({
        version: '1.0',
        response: {
          outputSpeech: {
            type: 'SSML',
            ssml: '<speak>Sorry — something glitched on my side. Try again in a second.</speak>',
          },
          shouldEndSession: true,
        },
      });
    } else {
      res.status(500).json({ message: 'Internal Server Error' });
    }
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

server = app.listen(PORT, () => {
  // Jarvis-style startup banner
  process.stdout.write(
    '\n\x1b[36m╔══════════════════════════════════════════════════════════════╗\x1b[0m\n' +
    '\x1b[36m║\x1b[0m  \x1b[1;37m░░  F · R · I · D · A · Y  —  OpenClaw Skill Gateway  ░░\x1b[0m  \x1b[36m║\x1b[0m\n' +
    '\x1b[36m║\x1b[0m  \x1b[90mAlexa Bridge  ·  N8N Intake  ·  All Systems Nominal\x1b[0m       \x1b[36m║\x1b[0m\n' +
    '\x1b[36m╚══════════════════════════════════════════════════════════════╝\x1b[0m\n\n',
  );

  startBriefingCron(rootLogger);

  rootLogger.info(
    {
      port: PORT,
      alexa: `POST http://127.0.0.1:${PORT}/alexa`,
      openclawTrigger: `POST http://127.0.0.1:${PORT}/openclaw/trigger (X-Openclaw-Secret + JSON commandText)`,
      intakeProxy: useDirectIntake()
        ? `POST http://127.0.0.1:${PORT}/webhook/friday-intake → direct pc-agent (OPENCLAW_DIRECT_INTAKE)`
        : `POST http://127.0.0.1:${PORT}/webhook/friday-intake → ${N8N_INTAKE_URL}`,
      n8nIntake: useDirectIntake() ? 'disabled (direct)' : N8N_INTAKE_URL,
      openclawDirectIntake: useDirectIntake(),
      alexaNotify: proactiveNotifyConfigured()
        ? `POST http://127.0.0.1:${PORT}/internal/alexa-notify`
        : undefined,
      alexaVerify: VERIFY_SIG,
      voice: fridaySpeakEnabled() ? (process.env.FRIDAY_TTS_VOICE || 'en-US-EmmaMultilingualNeural') : (winTtsEnabled() ? 'winTts' : 'off'),
      alexaMusic: alexaMusicConfigured() ? 'ready' : 'not configured (run: node scripts/setup-alexa-cookie.mjs)',
      logLevel: process.env.LOG_LEVEL || 'default',
      logDir: process.env.OPENCLAW_LOG_DIR || null,
      nodeEnv: process.env.NODE_ENV || 'development',
    },
    'skill-gateway listening (Alexa → N8N intake)',
  );

  // ── Startup sequence ────────────────────────────────────────────────────────
  // Welcome TTS first (friday-speak exits after playback), then optional gap, then song.
  const startSong = process.env.FRIDAY_STARTUP_SONG;
  const welcomeDelayMs = parseInt(process.env.FRIDAY_STARTUP_WELCOME_DELAY_MS || '500', 10);
  const songGapMs = parseInt(process.env.FRIDAY_STARTUP_SONG_DELAY_MS || '0', 10);

  if (startSong?.trim()) {
    rootLogger.info(
      { welcomeDelayMs, songGapMs },
      'startup: welcome TTS first — song after friday-speak exits (+ gap)',
    );
    setTimeout(() => scheduleStartupAfterWelcome(rootLogger, songGapMs), welcomeDelayMs);
  } else {
    setTimeout(() => speakGatewayStartup(rootLogger), 1500);
  }
});
server.on('error', (err) => {
  rootLogger.fatal({ err }, 'server listen error');
  process.exit(1);
});
