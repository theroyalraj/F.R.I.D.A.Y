/**
 * WhatsApp group chat → Jira ticket pipeline.
 *
 * Triggered from Evolution API MESSAGES_UPSERT on /webhook/evolution when
 * WHATSAPP_JIRA_ENABLED=true and the message is from an allowlisted group (@g.us).
 *
 * @see docs/setup.md § WhatsApp group → Jira
 */

import { rootLogger } from './log.js';

const log = rootLogger.child({ module: 'whatsappJiraPipeline' });

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

/** @type {import('redis').RedisClientType | null | false} */
let redisState = null;

function envBool(name, fallback = false) {
  const v = String(process.env[name] || '').toLowerCase().trim();
  if (!v) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v);
}

export function whatsappJiraPipelineConfigured() {
  if (!envBool('WHATSAPP_JIRA_ENABLED', false)) return false;
  const groups = parseGroupAllowlist();
  if (!groups.length) {
    log.warn('WHATSAPP_JIRA_ENABLED but WHATSAPP_JIRA_GROUPS is empty');
    return false;
  }
  const base = (process.env.JIRA_BASE_URL || '').trim().replace(/\/$/, '');
  const email = (process.env.JIRA_EMAIL || '').trim();
  const token = (process.env.JIRA_API_TOKEN || '').trim();
  const project = (process.env.WHATSAPP_JIRA_PROJECT || '').trim();
  if (!base || !email || !token || !project) {
    log.warn('WhatsApp→Jira missing JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, or WHATSAPP_JIRA_PROJECT');
    return false;
  }
  if (!(process.env.ANTHROPIC_API_KEY || '').trim()) {
    log.warn('WhatsApp→Jira enabled but ANTHROPIC_API_KEY is empty (classifier needs it)');
    return false;
  }
  return true;
}

function parseGroupAllowlist() {
  const raw = (process.env.WHATSAPP_JIRA_GROUPS || '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseTriggerPrefix() {
  return (process.env.WHATSAPP_JIRA_TRIGGER || '').trim();
}

/**
 * Optional JSON map: display name → Jira accountId
 * @returns {Record<string, string>}
 */
function parseUserMap() {
  const raw = (process.env.WHATSAPP_JIRA_USERS || '').trim();
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === 'object') return /** @type {Record<string, string>} */ (o);
  } catch {
    log.warn('WHATSAPP_JIRA_USERS is not valid JSON');
  }
  return {};
}

function extractMessageText(msg) {
  const m = msg.message || msg;
  let text = '';
  if (typeof m.conversation === 'string') text = m.conversation;
  else if (m.extendedTextMessage?.text) text = String(m.extendedTextMessage.text);
  else if (m.imageMessage?.caption) text = String(m.imageMessage.caption || '');
  else if (m.videoMessage?.caption) text = String(m.videoMessage.caption || '');
  else if (typeof msg.text === 'string') text = msg.text;
  else if (typeof msg.body === 'string') text = msg.body;
  return String(text || '').trim();
}

function plainToAdf(text) {
  const lines = String(text || '').split(/\n/);
  const content = [];
  for (const line of lines) {
    const t = line.slice(0, 32767);
    content.push({
      type: 'paragraph',
      content: [{ type: 'text', text: t || '\u00a0' }],
    });
  }
  if (!content.length) {
    content.push({
      type: 'paragraph',
      content: [{ type: 'text', text: '(no description)' }],
    });
  }
  return { type: 'doc', version: 1, content };
}

/** @returns {Promise<boolean>} true if this message id is new (should process) */
async function tryDedupMessageId(messageId) {
  if (!messageId) return true;
  const key = `openclaw:whatsapp:jira:msg:${messageId}`;

  if (redisState === false) return true;

  if (redisState === null) {
    try {
      const { createClient } = await import('redis');
      const url =
        (process.env.OPENCLAW_REDIS_URL || '').trim() ||
        (process.env.FRIDAY_AMBIENT_REDIS_URL || '').trim() ||
        'redis://127.0.0.1:6379';
      const client = createClient({ url });
      client.on('error', () => {});
      await client.connect();
      redisState = client;
    } catch (e) {
      log.debug({ err: String(e?.message || e) }, 'redis unavailable for WhatsApp→Jira dedup');
      redisState = false;
      return true;
    }
  }

  try {
    const r = await /** @type {import('redis').RedisClientType} */ (redisState).set(key, '1', {
      NX: true,
      EX: 86_400,
    });
    if (r === null) {
      log.info({ messageId }, 'WhatsApp→Jira skip duplicate message');
      return false;
    }
    return true;
  } catch (e) {
    log.warn({ err: String(e?.message || e) }, 'redis dedup failed');
    return true;
  }
}

const CLASSIFIER_SYSTEM = `You are an issue triage assistant. Given a WhatsApp group message, extract structured data.
Return JSON only, no markdown, no explanation. Schema:
{
  "actionable": true|false,
  "title": "short Jira summary, max 120 chars",
  "description": "fuller context for Jira body, markdown plain text ok",
  "issue_type": "Bug"|"Task"|"Story",
  "priority": "Highest"|"High"|"Medium"|"Low"|"Lowest"|"",
  "assignee_hint": "person name or empty if unknown",
  "labels": ["label1", "label2"]
}
If the message is casual chat, greetings, thanks, or not something that should become a work item, set actionable to false and omit other fields.
If assignee_hint is vague, still provide best guess or empty string.`;

/**
 * @param {string} text
 * @param {{ pushName: string, groupJid: string }} ctx
 */
async function classifyWithClaude(text, ctx) {
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) throw new Error('ANTHROPIC_API_KEY missing');

  const model = (process.env.WHATSAPP_JIRA_CLAUDE_MODEL || 'claude-haiku-4-5').trim();

  const userBlock = `Group JID: ${ctx.groupJid}
Sender display name: ${ctx.pushName}

Message:
${text}`;

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: CLASSIFIER_SYSTEM,
      messages: [{ role: 'user', content: userBlock }],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Anthropic classifier HTTP ${res.status}: ${t.slice(0, 400)}`);
  }

  const data = await res.json();
  let raw = String(data?.content?.[0]?.text || '').trim();
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn({ raw: raw.slice(0, 200) }, 'classifier returned non-JSON');
    return { actionable: false };
  }

  return parsed;
}

function jiraAuthHeader() {
  const email = (process.env.JIRA_EMAIL || '').trim();
  const token = (process.env.JIRA_API_TOKEN || '').trim();
  const b64 = Buffer.from(`${email}:${token}`, 'utf8').toString('base64');
  return `Basic ${b64}`;
}

function jiraBase() {
  return (process.env.JIRA_BASE_URL || '').trim().replace(/\/$/, '');
}

/**
 * @param {string} hint
 * @param {Record<string, string>} userMap
 */
async function resolveAssigneeAccountId(hint, userMap) {
  const h = String(hint || '').trim();
  if (!h) return null;

  for (const [name, id] of Object.entries(userMap)) {
    if (!name || !id) continue;
    if (h.toLowerCase() === name.toLowerCase()) return id;
    if (h.toLowerCase().includes(name.toLowerCase())) return id;
    if (name.toLowerCase().includes(h.toLowerCase())) return id;
  }

  const url = new URL(`${jiraBase()}/rest/api/3/user/search`);
  url.searchParams.set('query', h);

  const res = await fetch(url.toString(), {
    headers: { Authorization: jiraAuthHeader(), Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    log.warn({ status: res.status }, 'Jira user search failed');
    return null;
  }

  const arr = await res.json();
  if (!Array.isArray(arr) || !arr.length) return null;
  const first = arr[0];
  return first?.accountId || null;
}

/**
 * @param {object} classified
 * @param {{ pushName: string, groupJid: string, rawMessage: string }} meta
 * @param {string | null} assigneeId
 */
async function createJiraIssue(classified, meta, assigneeId) {
  const projectKey = (process.env.WHATSAPP_JIRA_PROJECT || '').trim();
  const issueTypeName = (process.env.WHATSAPP_JIRA_ISSUE_TYPE || 'Task').trim();

  const summary = String(classified.title || 'WhatsApp ticket').slice(0, 255);

  let description = String(classified.description || meta.rawMessage || '');
  description += `\n\n---\nSource: WhatsApp group ${meta.groupJid}\nReporter (display): ${meta.pushName}`;

  /** @type {Record<string, unknown>} */
  const fields = {
    project: { key: projectKey },
    summary,
    description: plainToAdf(description),
    issuetype: { name: issueTypeName },
  };

  const pri = String(classified.priority || '').trim();
  if (pri) fields.priority = { name: pri };

  const labels = Array.isArray(classified.labels) ? classified.labels.map((x) => String(x)).filter(Boolean) : [];
  if (labels.length) fields.labels = labels.slice(0, 10);

  if (assigneeId) fields.assignee = { id: assigneeId };

  const res = await fetch(`${jiraBase()}/rest/api/3/issue`, {
    method: 'POST',
    headers: {
      Authorization: jiraAuthHeader(),
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    // Retry without assignee if assignee is the problem
    if (assigneeId && (res.status === 400 || res.status === 404)) {
      log.warn({ err: errText.slice(0, 300) }, 'Jira create failed with assignee — retrying unassigned');
      delete fields.assignee;
      const res2 = await fetch(`${jiraBase()}/rest/api/3/issue`, {
        method: 'POST',
        headers: {
          Authorization: jiraAuthHeader(),
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res2.ok) {
        const t2 = await res2.text().catch(() => '');
        throw new Error(`Jira create HTTP ${res2.status}: ${t2.slice(0, 400)}`);
      }
      return res2.json();
    }
    throw new Error(`Jira create HTTP ${res.status}: ${errText.slice(0, 400)}`);
  }

  return res.json();
}

/**
 * @param {string} groupJid
 * @param {string} text
 * @param {{ key: Record<string, unknown>, textSnippet: string } | null} quoted
 */
async function evolutionSendGroupText(groupJid, text, quoted) {
  const key = (process.env.EVOLUTION_API_KEY || '').trim();
  const inst = (process.env.EVOLUTION_INSTANCE || 'openclaw').trim() || 'openclaw';
  const port = (process.env.EVOLUTION_PORT || '8181').trim();
  if (!key || key === 'change-me') {
    log.warn('EVOLUTION_API_KEY not set — cannot send WhatsApp reply');
    return;
  }

  /** @type {Record<string, unknown>} */
  const body = {
    number: groupJid,
    text: text.slice(0, 3500),
  };

  if (quoted?.key) {
    body.quoted = {
      key: {
        id: quoted.key.id,
        remoteJid: quoted.key.remoteJid,
        fromMe: !!quoted.key.fromMe,
        ...(quoted.key.participant ? { participant: quoted.key.participant } : {}),
      },
      message: { conversation: quoted.textSnippet || '' },
    };
  }

  const res = await fetch(`http://127.0.0.1:${port}/message/sendText/${encodeURIComponent(inst)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    log.warn({ status: res.status, t: t.slice(0, 200) }, 'Evolution sendText failed');
  }
}

/**
 * @param {unknown} data Evolution webhook `data` payload for MESSAGES_UPSERT
 * @param {import('pino').Logger} [parentLog]
 */
export async function processWhatsAppJiraMessagesUpsert(data, parentLog) {
  const reqLog = parentLog || log;
  if (!whatsappJiraPipelineConfigured()) return;

  const groupsAllow = new Set(parseGroupAllowlist());
  const trigger = parseTriggerPrefix();
  const dryRun = envBool('WHATSAPP_JIRA_DRY_RUN', false);

  const messages = Array.isArray(data) ? data : data?.messages || [data];

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;

    const key = msg.key || {};
    if (key.fromMe) continue;

    /** @type {string} */
    let jid = String(key.remoteJid || '');

    if (msg.remoteJid && !jid) jid = String(msg.remoteJid);

    if (!jid.endsWith('@g.us')) continue;

    if (!groupsAllow.has(jid)) {
      reqLog.debug({ jid }, 'WhatsApp→Jira skip group not allowlisted');
      continue;
    }

    const text = extractMessageText(msg);
    if (!text) continue;

    if (trigger && !text.startsWith(trigger)) {
      reqLog.debug({ preview: text.slice(0, 40) }, 'WhatsApp→Jira skip missing trigger prefix');
      continue;
    }

    const workText = trigger ? text.slice(trigger.length).trim() : text;
    if (!workText) continue;

    const messageId = String(key.id || '');
    const shouldProcess = await tryDedupMessageId(messageId);
    if (!shouldProcess) continue;

    const pushName = String(msg.pushName || msg.name || 'Unknown');
    const ctx = { pushName, groupJid: jid };

    let classified;
    try {
      classified = await classifyWithClaude(workText, ctx);
    } catch (e) {
      reqLog.error({ err: String(e?.message || e) }, 'WhatsApp→Jira classifier failed');
      continue;
    }

    if (!classified || classified.actionable === false) {
      reqLog.info({ preview: workText.slice(0, 60) }, 'WhatsApp→Jira classifier: not actionable');
      continue;
    }

    const userMap = parseUserMap();
    let assigneeId = await resolveAssigneeAccountId(classified.assignee_hint, userMap);

    if (dryRun) {
      reqLog.info(
        {
          summary: classified.title,
          assignee_hint: classified.assignee_hint,
          resolvedAssignee: assigneeId,
          dryRun: true,
        },
        'WhatsApp→Jira dry run — would create issue',
      );
      continue;
    }

    let issue;
    try {
      issue = await createJiraIssue(classified, { ...ctx, rawMessage: workText }, assigneeId);
    } catch (e) {
      reqLog.error({ err: String(e?.message || e) }, 'WhatsApp→Jira Jira create failed');
      try {
        await evolutionSendGroupText(
          jid,
          `Could not create Jira ticket: ${String(e?.message || e).slice(0, 200)}`,
          buildQuotedPayload(msg, workText),
        );
      } catch { /* ignore */ }
      continue;
    }

    const issueKey = issue?.key || issue?.id || '';
    const browseUrl = issueKey ? `${jiraBase()}/browse/${issueKey}` : '';

    const assignLine =
      assigneeId && classified.assignee_hint
        ? `Assigned: ${classified.assignee_hint}`
        : 'Assignee: unassigned (could not resolve — set WHATSAPP_JIRA_USERS or fix name)';

    const reply = issueKey
      ? `Ticket created: ${issueKey} — ${classified.title}\n${assignLine}\n${browseUrl}`
      : `Ticket created. ${assignLine}\n${browseUrl}`;

    reqLog.info({ issueKey, groupJid: jid }, 'WhatsApp→Jira issue created');

    try {
      await evolutionSendGroupText(jid, reply, buildQuotedPayload(msg, workText));
    } catch (e) {
      reqLog.warn({ err: String(e?.message || e) }, 'WhatsApp→Jira reply send failed');
    }
  }
}

/** @param {Record<string, unknown>} msg */
function buildQuotedPayload(msg, textSnippet) {
  const k = msg.key || {};
  if (!k.id) return null;
  return {
    key: k,
    textSnippet: String(textSnippet || '').slice(0, 500),
  };
}
