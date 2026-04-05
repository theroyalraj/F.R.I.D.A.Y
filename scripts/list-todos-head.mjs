#!/usr/bin/env node
/** List newest todos (Bearer PC_AGENT_SECRET) — quick verify after mock:whatsapp --important */
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
if (!secret) {
  console.error('PC_AGENT_SECRET missing');
  process.exit(1);
}

const r = await fetch(`http://127.0.0.1:${port}/todos`, {
  headers: { Authorization: `Bearer ${secret}` },
});
const j = await r.json().catch(() => ({}));
console.log(`HTTP ${r.status}`);
const todos = Array.isArray(j.todos) ? j.todos : [];
const recent = todos
  .filter((t) => t && String(t.source || '').includes('whatsapp-mock'))
  .slice(0, 5);
console.log('Todos from source whatsapp-mock (up to 5):', JSON.stringify(recent, null, 2));
if (!recent.length) {
  console.log('Last 3 todos overall:', JSON.stringify(todos.slice(0, 3), null, 2));
}
