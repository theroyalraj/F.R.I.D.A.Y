/**
 * Evolution API webhook handler — receives events from the WhatsApp
 * integration (Baileys) and routes them:
 *
 *   CALL (personal, not group)  → stop all media + highest-priority TTS
 *   CALL (group or video)       → persistent Windows toast (no auto-dismiss)
 *   MESSAGES_UPSERT             → optional TTS announcement of new DMs + optional
 *                                 WhatsApp group → Jira pipeline (WHATSAPP_JIRA_*)
 *
 * Configure the webhook URL in Evolution API to point at:
 *   POST http://host.docker.internal:3848/webhook/evolution
 *
 * If Evolution already posts only to N8N, mirror each POST to this URL from N8N
 * (see docs/setup.md § WhatsApp group → Jira).
 */

import { rootLogger } from './log.js';
import { sendWinToast, sendPersistentCallToast } from './winToast.js';
import { stopAllFridayAudioSync } from './stopAllFridayAudio.js';
import { fridaySpeakEnabled, speakFridayPy } from './fridaySpeak.js';
import { winTtsEnabled, speakWinTts } from './winTts.js';

const PC_AGENT_URL = (process.env.PC_AGENT_URL || process.env.PC_AGENT_INTERNAL_URL || 'http://127.0.0.1:3847').replace(
  /\/$/,
  '',
);
const PC_AGENT_SECRET = (process.env.PC_AGENT_SECRET || '').trim();

/**
 * WhatsApp DM notify: prefer pc-agent /voice/speak-async so Friday Listen SSE shows the WhatsApp rail (Dexter).
 * Falls back to local friday-speak.py when secret missing or request fails.
 */
async function speakWhatsAppMessageLine(text, log) {
  const line = String(text || '').trim().slice(0, 500);
  if (!line) return;

  if (PC_AGENT_SECRET) {
    try {
      const r = await fetch(`${PC_AGENT_URL}/voice/speak-async`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${PC_AGENT_SECRET}`,
        },
        body: JSON.stringify({
          text: line,
          channel: 'whatsapp',
          personaKey: 'dexter',
        }),
      });
      if (r.ok) {
        log?.info({ preview: line.slice(0, 80) }, 'whatsapp message: speak-async ok');
        return;
      }
      log?.warn({ status: r.status }, 'whatsapp message: speak-async non-OK, falling back');
    } catch (err) {
      log?.warn({ err: String(err?.message || err) }, 'whatsapp message: speak-async failed, falling back');
    }
  }

  if (fridaySpeakEnabled()) {
    speakFridayPy(line, log, {
      bypassCursorDefer: true,
      priority: true,
      speakChannel: 'whatsapp',
      speakPersonaKey: 'dexter',
    });
  } else if (winTtsEnabled()) {
    speakWinTts(line, log, { bypassCursorDefer: true });
  }
}
import { processWhatsAppJiraMessagesUpsert } from './whatsappJiraPipeline.js';

const log = rootLogger.child({ module: 'evolutionWebhook' });

function envBool(name, fallback = false) {
  const v = (process.env[name] || '').toLowerCase().trim();
  if (!v) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v);
}

function whatsappCallNotifyEnabled() {
  return envBool('WHATSAPP_CALL_NOTIFY', true);
}

function whatsappMessageNotifyEnabled() {
  return envBool('WHATSAPP_MESSAGE_NOTIFY', false);
}

function webhookSecretValid(incoming) {
  const expected = (process.env.WHATSAPP_WEBHOOK_SECRET || '').trim();
  if (!expected) return true;
  return incoming === expected;
}

/**
 * Normalise a JID to a plain phone number.
 * "919876543210@s.whatsapp.net" → "919876543210"
 */
function jidToNumber(jid) {
  return String(jid || '').split('@')[0].replace(/\D/g, '');
}

/**
 * Resolve a human-readable name from a JID.
 * For now returns the phone number; could be extended to look up contacts.
 */
function resolveCallerName(callData) {
  const pushName = callData?.pushName || callData?.notify || '';
  if (pushName) return pushName;
  return jidToNumber(callData?.from || callData?.chatId || '');
}

// ── Call event handler ──────────────────────────────────────────────

function handleCallEvent(data) {
  if (!whatsappCallNotifyEnabled()) return;

  const calls = Array.isArray(data) ? data : [data];

  for (const call of calls) {
    if (!call || typeof call !== 'object') continue;

    const status = String(call.status || '').toLowerCase();
    if (status !== 'offer') continue;

    const isGroup = Boolean(call.isGroup);
    const isVideo = Boolean(call.isVideo);
    const callerName = resolveCallerName(call);
    const callerNumber = jidToNumber(call.from || call.chatId || '');

    if (isGroup) {
      handleGroupCall(call, callerName, callerNumber, isVideo);
    } else {
      handlePersonalCall(call, callerName, callerNumber, isVideo);
    }
  }
}

/**
 * Personal voice/video call → HIGHEST priority interrupt.
 * 1. Stop all media (music, player, TTS locks)
 * 2. Speak at priority=1 with bypass
 */
function handlePersonalCall(call, callerName, callerNumber, isVideo) {
  const callType = isVideo ? 'video' : 'voice';
  const spokenText = `Incoming ${callType} call from ${callerName || callerNumber}. You should pick up.`;

  log.info(
    { callerName, callerNumber, isVideo, callId: call.id },
    `personal ${callType} call — interrupting all audio`,
  );

  stopAllFridayAudioSync(log, { fullPanic: true });

  if (fridaySpeakEnabled()) {
    speakFridayPy(spokenText, log, {
      bypassCursorDefer: true,
      priority: true,
    });
  } else if (winTtsEnabled()) {
    speakWinTts(spokenText, log, { bypassCursorDefer: true });
  }

  sendWinToast({
    title: `📞 ${callerName || callerNumber}`,
    body: `Incoming ${callType} call`,
    type: 'call',
    log,
  });
}

/**
 * Group voice/video call → persistent Windows toast (no auto-dismiss).
 * Does NOT interrupt audio — just notifies.
 */
function handleGroupCall(call, callerName, callerNumber, isVideo) {
  const callType = isVideo ? 'video' : 'voice';
  const groupName = call.groupJid
    ? jidToNumber(call.groupJid)
    : 'a group';

  log.info(
    { callerName, callerNumber, isVideo, groupJid: call.groupJid, callId: call.id },
    `group ${callType} call — persistent toast (no interrupt)`,
  );

  sendPersistentCallToast({
    title: `👥 Group ${callType} call`,
    body: `${callerName || callerNumber} started a ${callType} call${call.groupJid ? ` in ${groupName}` : ''}`,
    log,
  });
}

// ── Message notification handler ────────────────────────────────────

function handleMessagesUpsert(data) {
  if (!whatsappMessageNotifyEnabled()) return;

  const messages = Array.isArray(data) ? data : data?.messages || [data];

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;

    const key = msg.key || {};
    if (key.fromMe) continue;

    const jid = key.remoteJid || '';
    if (jid.endsWith('@g.us')) continue;

    const m = msg.message || msg;
    let text = '';
    if (typeof m.conversation === 'string') text = m.conversation;
    else if (m.extendedTextMessage?.text) text = String(m.extendedTextMessage.text);
    else if (typeof msg.text === 'string') text = msg.text;
    else if (typeof msg.body === 'string') text = msg.body;

    if (!text.trim()) continue;

    const from = msg.pushName || jidToNumber(jid);
    const preview = text.slice(0, 100);

    log.info({ from, preview: preview.slice(0, 40) }, 'new WhatsApp message');

    sendWinToast({
      title: `💬 ${from}`,
      body: preview,
      type: 'message',
      log,
    });

    void speakWhatsAppMessageLine(`New WhatsApp message from ${from}. ${preview}`, log);
  }
}

// ── Main handler (called from express route) ────────────────────────

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export function handleEvolutionWebhook(req, res) {
  const secret = req.headers['x-openclaw-whatsapp-secret'] || req.headers['x-webhook-secret'] || '';
  if (!webhookSecretValid(secret)) {
    log.warn('evolution webhook: invalid secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.json({ ok: true });

  const body = req.body || {};

  const event = String(
    body.event || body.type || body.action || '',
  ).toUpperCase().replace(/\./g, '_');

  log.debug({ event, instance: body.instanceName || body.instance }, 'evolution webhook received');

  const data = body.data ?? body.payload ?? body;

  try {
    if (event === 'CALL' || event === 'CALLS') {
      handleCallEvent(data);
    } else if (event === 'MESSAGES_UPSERT' || event === 'MESSAGE' || event === 'MESSAGES') {
      handleMessagesUpsert(data);
      void processWhatsAppJiraMessagesUpsert(data, log).catch((err) => {
        log.error({ err: String(err?.message || err) }, 'whatsapp jira pipeline error');
      });
    } else if (event === 'CONNECTION_UPDATE') {
      const state = data?.state || data?.connection || '';
      log.info({ state }, 'WhatsApp connection update');
      if (state === 'open') {
        sendWinToast({
          title: 'WhatsApp Connected',
          body: 'Evolution API session is now active.',
          type: 'alert',
          log,
        });
      }
    }
  } catch (err) {
    log.error({ err: String(err?.message || err), event }, 'evolution webhook handler error');
  }
}
