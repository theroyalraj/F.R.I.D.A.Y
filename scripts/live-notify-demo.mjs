#!/usr/bin/env node
import crypto from 'node:crypto';
/**
 * One-shot: POST /internal/last-result with a non-default notifyType, then (after delay)
 * POST /voice/speak-async with channel + persona for Listen UI rail + different voice.
 *
 * Usage (repo root):
 *   node scripts/live-notify-demo.mjs
 *   NOTIFY_LAST_TYPE=reminder node scripts/live-notify-demo.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim().split('#')[0].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const n8nSecret = process.env.N8N_WEBHOOK_SECRET;
const pcSecret = process.env.PC_AGENT_SECRET;
const gateway = (process.env.GATEWAY_TEST_URL || 'http://127.0.0.1:3848').replace(/\/$/, '');
const agent = (process.env.PC_AGENT_TEST_URL || 'http://127.0.0.1:3847').replace(/\/$/, '');
const displayName = (process.env.FRIDAY_USER_NAME || 'Raj').trim() || 'Raj';

const notifyType = (process.env.NOTIFY_LAST_TYPE || 'alert').trim() || 'alert';
const delaySec = Math.max(2, Number(process.env.LIVE_NOTIFY_GAP_SEC || '5') || 5);

if (!n8nSecret || !pcSecret) {
  console.error('Missing N8N_WEBHOOK_SECRET or PC_AGENT_SECRET in .env');
  process.exit(1);
}

const message =
  process.env.NOTIFY_TEST_MESSAGE ||
  `Live demo ${displayName} — ${notifyType} notification path. You should hear immediate PC speech from the gateway and see Listen update on the second ping.`;

const body = {
  userId: process.env.NOTIFY_TEST_USER_ID || 'amzn1.ask.account.LOCAL-TEST-NO-ALEXA-PING',
  message,
  notify: true,
  notifyType,
  correlationId: crypto.randomUUID(),
};

console.log(`\n[1/2] POST ${gateway}/internal/last-result  notifyType=${notifyType}`);
const r1 = await fetch(`${gateway}/internal/last-result`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Openclaw-Secret': n8nSecret },
  body: JSON.stringify(body),
});
const j1 = await r1.json().catch(() => ({}));
console.log(`HTTP ${r1.status}`, JSON.stringify(j1, null, 2));
if (!r1.ok) process.exit(1);

console.log(`\n… waiting ${delaySec}s (gateway TTS finishes, then Nova / mail rail)\n`);
await new Promise((r) => setTimeout(r, delaySec * 1000));

const line2 =
  process.env.LIVE_NOTIFY_SPEAK_TEXT ||
  `Nova here — second ping on the mail channel so the Listen integrations rail lights up with a different voice.`;
console.log(`[2/2] POST ${agent}/voice/speak-async  channel=mail personaKey=nova`);
const r2 = await fetch(`${agent}/voice/speak-async`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pcSecret}` },
  body: JSON.stringify({
    text: line2,
    channel: 'mail',
    personaKey: 'nova',
  }),
});
const t2 = await r2.text();
console.log(`HTTP ${r2.status}`, t2.slice(0, 500));
