import crypto from 'node:crypto';
import { pickNotifyPhrase } from './notifyPhrases.js';

/**
 * Alexa Proactive Events — push a MessageAlert notification to the user's device.
 *
 * Delivery: Alexa beeps + lights yellow ring → user says "Alexa, read my notifications"
 *           → Alexa reads: "You have a message from <creatorName>"
 *
 * Immediate speech is NOT possible via any proactive API outside an active skill session.
 * (Reminders API explicitly blocks out-of-session token usage for creation.)
 *
 * For on-PC immediacy, pc-agent sends a Windows toast notification in parallel.
 *
 * Notification types:
 *   task_done | waiting | alert | reminder | result | build | message
 *
 * AI layer (opt-in): set ANTHROPIC_API_KEY + NOTIFY_AI_SUMMARIES=true to have
 * Claude Haiku distil the raw task output into a punchy one-liner appended to
 * the randomised phrase ("Friday — nailed it, Raj: cleaned 3 files").
 *
 * @see https://developer.amazon.com/en-US/docs/alexa/smapi/proactive-events-api.html
 */

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MAX_CREATOR   = 100;

let tokenCache = { accessToken: null, expiresAtMs: 0 };

// ── Config ────────────────────────────────────────────────────────────────────

export function proactiveNotifyConfigured() {
  if (String(process.env.ALEXA_PROACTIVE_ENABLED ?? 'true').toLowerCase() === 'false') return false;
  return Boolean(process.env.ALEXA_LWA_CLIENT_ID?.trim() && process.env.ALEXA_LWA_CLIENT_SECRET?.trim());
}

export function aiSummariesEnabled() {
  return (
    Boolean(process.env.ANTHROPIC_API_KEY?.trim()) &&
    String(process.env.NOTIFY_AI_SUMMARIES || 'true').toLowerCase() !== 'false'
  );
}

function proactiveEventsPostUrl() {
  const host = (process.env.ALEXA_PROACTIVE_API_HOST || 'https://api.amazonalexa.com').replace(/\/$/, '');
  const dev  = process.env.ALEXA_PROACTIVE_USE_DEVELOPMENT !== 'false';
  return dev ? `${host}/v1/proactiveEvents/stages/development` : `${host}/v1/proactiveEvents/`;
}

// ── LWA token ─────────────────────────────────────────────────────────────────

/** @param {import('pino').Logger} log */
export async function fetchProactiveAccessToken(log) {
  const clientId     = process.env.ALEXA_LWA_CLIENT_ID?.trim();
  const clientSecret = process.env.ALEXA_LWA_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return { ok: false, error: 'missing_lwa_credentials' };

  const now = Date.now();
  if (tokenCache.accessToken && tokenCache.expiresAtMs > now + 30_000) {
    return { ok: true, accessToken: tokenCache.accessToken };
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'alexa::proactive_events',
  });
  let res;
  try {
    res = await fetch(LWA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (e) {
    log.warn({ err: String(e.message || e) }, 'alexa LWA token request failed');
    return { ok: false, error: 'lwa_network', detail: String(e.message || e) };
  }
  const text = await res.text();
  if (!res.ok) {
    log.warn({ status: res.status, detail: text.slice(0, 400) }, 'alexa LWA token rejected');
    return { ok: false, error: 'lwa_http', status: res.status, detail: text.slice(0, 500) };
  }
  let data;
  try { data = JSON.parse(text); } catch {
    return { ok: false, error: 'lwa_bad_json', detail: text.slice(0, 200) };
  }
  const expSec = Number(data.expires_in) || 3600;
  tokenCache = {
    accessToken: data.access_token,
    expiresAtMs: Date.now() + Math.max(120, expSec - 60) * 1000,
  };
  return { ok: true, accessToken: tokenCache.accessToken };
}

// ── AI summary ────────────────────────────────────────────────────────────────

/**
 * Call Claude Haiku to distil a raw task result into a punchy 1-liner (≤ 55 chars).
 * @param {import('pino').Logger} log
 * @param {string} rawText
 * @param {string} type
 * @returns {Promise<string|undefined>}
 */
export async function generateAiSummary(log, rawText, type) {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return undefined;

  const typeHints = {
    task_done: 'what was accomplished',
    waiting:   'what decision or input is needed',
    alert:     'what went wrong or needs attention',
    reminder:  'what the reminder is about',
    result:    'what the key finding or output is',
    build:     'build or deploy outcome',
    message:   'main point',
  };

  const prompt =
    `You are Friday, a sharp personal AI assistant. Summarise the following task output into ` +
    `a single punchy phrase (max 55 characters, no quotes, no punctuation at end, plain ASCII) ` +
    `that tells the user ${typeHints[type] || typeHints.message}. Be specific and witty.\n\n` +
    `Output:\n${String(rawText).slice(0, 800)}`;

  let res;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.NOTIFY_AI_MODEL || 'claude-haiku-4-5',
        max_tokens: 60,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    log.warn({ err: String(e.message || e) }, 'notify AI summary request failed');
    return undefined;
  }

  if (!res.ok) { log.warn({ status: res.status }, 'notify AI summary rejected'); return undefined; }

  let data;
  try { data = await res.json(); } catch { return undefined; }

  return String(data?.content?.[0]?.text || '')
    .replace(/^["']|["']$/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[.!?,;]+$/, '')
    .trim()
    .slice(0, 55) || undefined;
}

// ── Creator-name builder ──────────────────────────────────────────────────────

/**
 * Build the Alexa MessageAlert "creator name" (what Alexa reads after "You have a message from…").
 * Picks a randomised phrase + optional AI summary.
 */
export async function buildSmartCreatorName(log, userId, type, rawText) {
  let aiSummary;
  if (rawText && aiSummariesEnabled()) {
    aiSummary = await generateAiSummary(log, rawText, type);
    if (aiSummary) log.debug({ type, aiSummary }, 'notify AI summary generated');
  }
  return pickNotifyPhrase(userId, type, aiSummary);
}

/** @deprecated Use buildSmartCreatorName */
export function buildCreatorName(type, detail) {
  const prefixes = {
    task_done: 'Friday - Done', waiting: 'Friday - Needs you', alert: 'Friday - Alert',
    reminder: 'Friday - Reminder', result: 'Friday - Result ready', build: 'Friday - Build', message: 'Friday',
  };
  const pre  = prefixes[type] || prefixes.message;
  const raw  = String(detail || '').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
  const full = `${pre}${raw ? ': ' : ''}${raw}`;
  return full.length <= MAX_CREATOR ? full : `${full.slice(0, MAX_CREATOR - 1)}\u2026`;
}

/** @deprecated Use buildCreatorName('task_done', summary) */
export function proactiveCreatorNameFromSummary(text) {
  return buildCreatorName('task_done', text);
}

// ── Send notification ─────────────────────────────────────────────────────────

function isoAlexaZ(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, '.00Z');
}

/**
 * Send a unicast Alexa MessageAlert notification (beep + yellow ring).
 * User hears it by saying "Alexa, read my notifications".
 *
 * @param {import('pino').Logger} log
 * @param {object} opts
 * @param {string}  opts.userId
 * @param {string}  [opts.type]        task_done | waiting | alert | reminder | result | build | message
 * @param {string}  [opts.rawText]     Full task output — fed to AI for summary
 * @param {string}  [opts.creatorName] Explicit label (skips phrase picker + AI)
 * @param {number}  [opts.count]       Message count (default 1)
 * @param {string}  [opts.referenceId] Idempotency key
 */
export async function sendUnicastNotification(log, {
  userId,
  type = 'message',
  rawText,
  creatorName,
  count,
  referenceId,
}) {
  const lwaToken = await fetchProactiveAccessToken(log);
  if (!lwaToken.ok) return lwaToken;

  const name = creatorName
    ? String(creatorName).replace(/[^\x20-\x7E]/g, '').trim().slice(0, MAX_CREATOR) || 'Friday'
    : await buildSmartCreatorName(log, userId, type, rawText);

  const n   = Math.min(100, Math.max(1, Math.floor(Number(count ?? 1)) || 1));
  const ref = referenceId || crypto.randomUUID();
  const now = new Date();
  const exp = new Date(now.getTime() + 24 * 3600 * 1000);

  const payload = {
    timestamp: isoAlexaZ(now),
    referenceId: ref,
    expiryTime: isoAlexaZ(exp),
    event: {
      name: 'AMAZON.MessageAlert.Activated',
      payload: {
        state: { status: 'UNREAD', freshness: 'NEW' },
        messageGroup: { creator: { name }, count: n },
      },
    },
    relevantAudience: { type: 'Unicast', payload: { user: userId } },
  };

  const url = proactiveEventsPostUrl();
  let res;
  try {
    res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${lwaToken.accessToken}` },
      body:    JSON.stringify(payload),
    });
  } catch (e) {
    log.warn({ err: String(e.message || e) }, 'alexa proactive POST failed');
    return { ok: false, error: 'proactive_network', detail: String(e.message || e) };
  }

  const respText = await res.text();
  if (!res.ok) {
    log.warn({ status: res.status, url, detail: respText.slice(0, 500), userId: '(redacted)', type }, 'alexa proactive event rejected');
    return { ok: false, error: 'proactive_http', status: res.status, detail: respText.slice(0, 800) };
  }

  log.info({ amazonStatus: res.status, referenceId: ref, type, creatorName: name }, 'alexa MessageAlert sent');
  return { ok: true, status: res.status, referenceId: ref, type, creatorName: name };
}

/** @deprecated Prefer sendUnicastNotification */
export async function sendUnicastMessageAlert(log, { userId, creatorName, count, referenceId }) {
  return sendUnicastNotification(log, { userId, creatorName, count, referenceId, type: 'task_done' });
}
