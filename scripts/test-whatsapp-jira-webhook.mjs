#!/usr/bin/env node
/**
 * POST a synthetic Evolution MESSAGES_UPSERT to skill-gateway /webhook/evolution.
 * Requires gateway running (e.g. npm run dev:gateway) unless you only check wiring offline.
 *
 * Env: WHATSAPP_WEBHOOK_SECRET (if set on gateway), WHATSAPP_JIRA_GROUPS (first group used),
 *      WHATSAPP_JIRA_TRIGGER, EVOLUTION_INSTANCE, OPENCLAW_SKILL_GATEWAY_URL
 *
 * Usage: npm run test:whatsapp-jira
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const base = (process.env.OPENCLAW_SKILL_GATEWAY_URL || 'http://127.0.0.1:3848').replace(/\/$/, '');
const secret = (process.env.WHATSAPP_WEBHOOK_SECRET || '').trim();
const inst = (process.env.EVOLUTION_INSTANCE || 'openclaw').trim();
const trigger = (process.env.WHATSAPP_JIRA_TRIGGER || '/ticket').trim();
const groupsRaw = (process.env.WHATSAPP_JIRA_GROUPS || '').trim();
const firstGroup = groupsRaw.split(',')[0].trim() || '120363999999999999@g.us';

const text =
  (trigger ? `${trigger} ` : '') +
  'Smoke test: login page broken on iOS. Assign to the right owner.';

const payload = {
  event: 'MESSAGES_UPSERT',
  instance: inst,
  data: {
    messages: [
      {
        key: {
          remoteJid: firstGroup,
          fromMe: false,
          id: `openclaw-jira-smoke-${Date.now()}`,
          participant: '919999999999@s.whatsapp.net',
        },
        pushName: 'OpenClaw Smoke',
        message: { conversation: text },
      },
    ],
  },
};

const headers = { 'Content-Type': 'application/json' };
if (secret) headers['x-openclaw-whatsapp-secret'] = secret;

console.log(`POST ${base}/webhook/evolution`);
console.log('Group JID:', firstGroup);
if (!process.env.WHATSAPP_JIRA_ENABLED || String(process.env.WHATSAPP_JIRA_ENABLED).toLowerCase() === 'false') {
  console.log('Note: WHATSAPP_JIRA_ENABLED is not true — pipeline will no-op after HTTP 200.');
}
if (process.env.WHATSAPP_JIRA_DRY_RUN === 'true') {
  console.log('WHATSAPP_JIRA_DRY_RUN=true — classifier runs; Jira/Evolution writes skipped.');
}

let res;
try {
  res = await fetch(`${base}/webhook/evolution`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
} catch (e) {
  console.error('Fetch failed (is skill-gateway running on 3848?)', e.message);
  process.exit(1);
}

const bodyText = await res.text();
console.log('Response:', res.status, bodyText.slice(0, 500));
