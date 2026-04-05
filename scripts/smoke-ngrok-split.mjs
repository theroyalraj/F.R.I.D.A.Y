#!/usr/bin/env node
/**
 * smoke-ngrok-split.mjs — quick checks for a remote pc-agent base URL (ngrok).
 *
 * Usage:
 *   npm run smoke:ngrok-split -- https://xxx.ngrok-free.app
 *   PC_AGENT_TEST_URL=https://... node scripts/smoke-ngrok-split.mjs
 */
const base = (process.argv[2] || process.env.PC_AGENT_TEST_URL || '').replace(/\/$/, '');
if (!base) {
  console.error('Usage: node scripts/smoke-ngrok-split.mjs <https://pc-agent-host>  or set PC_AGENT_TEST_URL');
  process.exit(1);
}

const hdr = { 'ngrok-skip-browser-warning': 'true', Accept: 'application/json' };

async function get(path) {
  const u = `${base}${path}`;
  const r = await fetch(u, { headers: hdr });
  const text = await r.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { ok: r.ok, status: r.status, body };
}

async function main() {
  const health = await get('/health');
  console.log('/health', health.status, health.ok ? 'ok' : 'fail');
  if (!health.ok) {
    console.error(health.body);
    process.exit(2);
  }

  const ping = await get('/voice/ping');
  console.log('/voice/ping', ping.status, ping.ok ? 'ok' : 'fail');
  if (!ping.ok) {
    console.error(ping.body);
    process.exit(3);
  }
  console.log('smoke-ngrok-split: all checks passed for', base);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
