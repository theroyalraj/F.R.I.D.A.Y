#!/usr/bin/env node
/**
 * Load-test WhatsApp mock ingest + Gmail snapshot API (no Google Chat API in this repo).
 *
 * Usage (from repo root):
 *   node scripts/load-test-messaging.mjs
 *   node scripts/load-test-messaging.mjs --whatsapp 25 --gmail-rounds 4
 *
 * WhatsApp: requires OPENCLAW_WHATSAPP_MOCK=1, Redis, running pc-agent.
 * Mock store keeps at most 30 rows (see whatsappMockCache.js).
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
const base = `http://127.0.0.1:${port}`;
const auth = { Authorization: `Bearer ${secret}` };

function parseArgs() {
  const a = process.argv.slice(2);
  let whatsapp = 25;
  let gmailRounds = 4;
  let clearFirst = true;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--whatsapp' && a[i + 1]) {
      whatsapp = Math.max(1, Math.min(80, Number(a[++i]) || 25));
    } else if (a[i] === '--gmail-rounds' && a[i + 1]) {
      gmailRounds = Math.max(1, Math.min(20, Number(a[++i]) || 4));
    } else if (a[i] === '--no-clear') {
      clearFirst = false;
    }
  }
  return { whatsapp, gmailRounds, clearFirst };
}

async function main() {
  if (!secret) {
    console.error('PC_AGENT_SECRET missing (.env)');
    process.exit(1);
  }

  const { whatsapp, gmailRounds, clearFirst } = parseArgs();
  console.log('OpenClaw messaging load test');
  console.log(`  base: ${base}`);
  console.log(`  WhatsApp mock POSTs (parallel): ${whatsapp}`);
  console.log(`  Gmail GET rounds: ${gmailRounds} (first may hit IMAP; rest usually Redis cache)`);
  console.log('  Note: no Google Chat integration — testing Gmail IMAP snapshot as Google-side mail.');

  // Ping
  const ping = await fetch(`${base}/voice/ping`);
  console.log(`\n/voice/ping -> HTTP ${ping.status}`);

  // Optional clear mock queue
  if (clearFirst) {
    const del = await fetch(`${base}/integrations/whatsapp/mock/inbound`, {
      method: 'DELETE',
      headers: { ...auth },
    });
    const dj = await del.json().catch(() => ({}));
    console.log(`DELETE /integrations/whatsapp/mock/inbound -> HTTP ${del.status}`, dj.deletedKeys != null ? `(deletedKeys=${dj.deletedKeys})` : '');
  }

  // Parallel mock notifies — skip TTS and todos (load test only)
  const t0 = Date.now();
  const batch = Array.from({ length: whatsapp }, (_, i) =>
    fetch(`${base}/integrations/whatsapp/mock/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({
        from: `1555${String(100000 + i).slice(-6)}`,
        text: `Load test message ${i + 1} at ${Date.now()}`,
        skipSpeak: true,
        skipTodo: true,
      }),
    }),
  );
  const responses = await Promise.all(batch);
  const ms = Date.now() - t0;
  const ok = responses.filter((r) => r.ok).length;
  const statuses = responses.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
  console.log(`\nWhatsApp mock/notify: ${ok}/${whatsapp} OK in ${ms}ms`, statuses);

  const bad = responses.find((r) => !r.ok);
  if (bad) {
    const j = await bad.json().catch(() => ({}));
    console.log('  first failure body:', JSON.stringify(j).slice(0, 500));
  }

  const msgRes = await fetch(`${base}/integrations/whatsapp/messages?limit=50`, { headers: { ...auth } });
  const msgJson = await msgRes.json().catch(() => ({}));
  const n = Array.isArray(msgJson.messages) ? msgJson.messages.length : 0;
  console.log(`\nGET /integrations/whatsapp/messages -> HTTP ${msgRes.status}, messages.length=${n} source=${msgJson.source || '?'}`);
  if (msgJson.warn) console.log('  warn:', String(msgJson.warn).slice(0, 200));

  // Gmail — stagger fresh so we do not hammer IMAP
  console.log('\nGmail snapshot:');
  for (let r = 0; r < gmailRounds; r++) {
    const fresh = r === 0 ? '1' : '0';
    const g0 = Date.now();
    const gr = await fetch(
      `${base}/integrations/gmail?unreadCount=8&recentCount=8&unreadOffset=0&recentOffset=0&fresh=${fresh}`,
      { headers: { ...auth } },
    );
    const gms = Date.now() - g0;
    const gj = await gr.json().catch(() => ({}));
    const unread = Array.isArray(gj.unread) ? gj.unread.length : 0;
    const recent = Array.isArray(gj.recent) ? gj.recent.length : 0;
    const src = gj.source || '?';
    console.log(`  round ${r + 1} fresh=${fresh} -> HTTP ${gr.status} in ${gms}ms source=${src} unread=${unread} recent=${recent}`);
    if (!gr.ok) console.log('    error:', gj.error || gj);
  }

  console.log('\nDone.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
