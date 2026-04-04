#!/usr/bin/env node
/**
 * Plays two neural TTS lines the same way production does for boot + task-done:
 * FRIDAY_TTS_BYPASS_CURSOR_DEFER + FRIDAY_TTS_PRIORITY so Cursor focus cannot mute them.
 *
 * Run: npm run test:mandatory-tts
 * Requires: Python, skill-gateway/scripts/friday-speak.py, edge-tts reachable (or SAPI fallback).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

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

const speak = path.join(root, 'skill-gateway', 'scripts', 'friday-speak.py');
if (!existsSync(speak)) {
  console.error('Missing', speak);
  process.exit(1);
}

const name = (process.env.FRIDAY_USER_NAME || 'Raj').trim() || 'Raj';

function runLine(label, text) {
  return new Promise((resolve) => {
    console.log(`\n── ${label} ──\n${text}\n`);
    const env = {
      ...process.env,
      FRIDAY_TTS_BYPASS_CURSOR_DEFER: 'true',
      FRIDAY_TTS_PRIORITY: '1',
    };
    const child = spawn('python', [speak, text], {
      env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', (e) => {
      console.error(e);
      resolve(1);
    });
  });
}

const code1 = await runLine(
  'Startup-style (gateway / agent boot)',
  `OpenClaw voice check. Systems online and ready to assist, ${name}.`,
);
if (code1 !== 0) console.warn('First line exited', code1);

const code2 = await runLine(
  'Task-done style (summary)',
  `Done, ${name}. Mandatory playback test complete. You should have heard both lines even if Cursor is focused.`,
);
if (code2 !== 0) console.warn('Second line exited', code2);

console.log('\nDone. If you heard both lines, mandatory TTS is working.\n');
