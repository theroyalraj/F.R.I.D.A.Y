#!/usr/bin/env node
/** GET /integrations/whatsapp/messages after mocks — same .env load as whatsapp-ui-mimic.mjs */
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
const base = `http://127.0.0.1:${port}`;

if (!secret) {
  console.error('PC_AGENT_SECRET missing');
  process.exit(1);
}

const r = await fetch(`${base}/integrations/whatsapp/messages?limit=8`, {
  headers: { Authorization: `Bearer ${secret}` },
});
const j = await r.json().catch(() => ({}));
console.log(`HTTP ${r.status}`, JSON.stringify(j, null, 2));
