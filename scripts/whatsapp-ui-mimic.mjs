#!/usr/bin/env node
/**
 * Mimic an inbound WhatsApp for the Friday Listen UI:
 * - Stores a row in Redis (shown under WhatsApp → Recent inbound when OPENCLAW_WHATSAPP_MOCK=1)
 * - Optional TTS via pc-agent /voice/speak-async (Dexter + whatsapp rail)
 * - With --important, creates a high-priority todo
 *
 * Prereqs: OPENCLAW_WHATSAPP_MOCK=1 in .env, Redis, pc-agent running, PC_AGENT_SECRET in .env.
 *
 * Usage (repo root):
 *   node scripts/whatsapp-ui-mimic.mjs
 *   node scripts/whatsapp-ui-mimic.mjs --important
 *   node scripts/whatsapp-ui-mimic.mjs --from 919876543210 --text "Your message here" --no-speak
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

const secret = (process.env.PC_AGENT_SECRET || '').trim();
const port = Number(process.env.PC_AGENT_PORT || 3847);
const base = (process.env.PC_AGENT_TEST_URL || `http://127.0.0.1:${port}`).replace(/\/$/, '');

const argv = process.argv.slice(2);
const important = argv.includes('--important');
const skipSpeak = argv.includes('--no-speak');
const skipTodo = argv.includes('--no-todo');

function argVal(name) {
  const i = argv.indexOf(name);
  if (i === -1 || i + 1 >= argv.length) return null;
  return argv[i + 1];
}

const from = (argVal('--from') || '15551234567').replace(/\D/g, '') || '15551234567';
const text =
  argVal('--text') ||
  'Demo inbound WhatsApp. You should see this under Recent inbound, hear Dexter if speak is on, and a todo if you passed --important.';

if (String(process.env.OPENCLAW_WHATSAPP_MOCK || '').trim() !== '1') {
  console.error('Set OPENCLAW_WHATSAPP_MOCK=1 in .env and restart pc-agent.');
  process.exit(1);
}

if (!secret) {
  console.error('PC_AGENT_SECRET missing in .env');
  process.exit(1);
}

const body = {
  from,
  text,
  important,
  skipSpeak,
  skipTodo,
};

console.log(`POST ${base}/integrations/whatsapp/mock/notify`, body);

const r = await fetch(`${base}/integrations/whatsapp/mock/notify`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${secret}`,
  },
  body: JSON.stringify(body),
});

const j = await r.json().catch(() => ({}));
console.log(`HTTP ${r.status}`, JSON.stringify(j, null, 2));
if (!r.ok) process.exit(1);
