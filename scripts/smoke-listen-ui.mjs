#!/usr/bin/env node
/**
 * Smoke test Listen UI + auth API (no Playwright).
 *
 *   node scripts/smoke-listen-ui.mjs
 *   LISTEN_UI_URL=http://127.0.0.1:5173 AGENT_URL=http://127.0.0.1:3847 node scripts/smoke-listen-ui.mjs
 */
const AGENT = (process.env.AGENT_URL || 'http://127.0.0.1:3847').replace(/\/$/, '');
const VITE = (process.env.LISTEN_UI_URL || 'http://127.0.0.1:5173').replace(/\/$/, '');
async function getOk(url, opts = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(url, { ...opts, signal: controller.signal });
    return { ok: r.ok, status: r.status, text: await r.text() };
  } finally {
    clearTimeout(t);
  }
}

function fail(msg) {
  console.error('smoke-listen-ui:', msg);
  process.exit(1);
}

async function main() {
  let n = 0;

  // 1) pc-agent health
  const h = await getOk(`${AGENT}/health`);
  if (!h.ok) fail(`/health → ${h.status}`);
  const hj = JSON.parse(h.text);
  if (!hj.ok || hj.service !== 'openclaw-pc-agent') fail('unexpected /health body');
  console.log('ok', `${AGENT}/health`);
  n += 1;

  // 2) voice ping (public)
  const vp = await getOk(`${AGENT}/voice/ping`);
  if (!vp.ok) fail(`/voice/ping → ${vp.status}`);
  console.log('ok', `${AGENT}/voice/ping`);
  n += 1;

  // 3) auth login validation (expect 400/401/503, never 404 if agent is current)
  const login = await getOk(`${AGENT}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'smoke@test.local', password: 'x' }),
  });
  if (login.status === 404 || /Cannot POST \/auth\//i.test(login.text || '')) {
    fail(
      `/auth/login → 404 — pc-agent on ${AGENT} is an old build without auth routes; restart pc-agent after updating code.`,
    );
  }
  if (login.status !== 400 && login.status !== 401 && login.status !== 503) {
    fail(`/auth/login invalid body/creds → expected 400/401/503 got ${login.status}`);
  }
  console.log('ok', `${AGENT}/auth/login (reject invalid, status ${login.status})`);
  n += 1;

  // 4) voice/command without auth → 401
  const vcmd = await getOk(`${AGENT}/voice/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hi', source: 'ui' }),
  });
  if (vcmd.status !== 401) {
    fail(`/voice/command without Bearer → expected 401, got ${vcmd.status}`);
  }
  console.log('ok', `${AGENT}/voice/command rejects unauthenticated`);
  n += 1;

  // 5) Vite dev (optional)
  let viteRoot;
  try {
    viteRoot = await getOk(`${VITE}/`);
  } catch {
    viteRoot = { ok: false, status: 0, text: '' };
  }
  if (!viteRoot.status || viteRoot.text === '') {
    console.warn(`skip: ${VITE}/ unreachable (start npm run ui:dev in pc-agent)`);
  } else {
    if (!viteRoot.ok) fail(`${VITE}/ → ${viteRoot.status}`);
    if (!viteRoot.text.includes('id="root"') || !viteRoot.text.includes('main.tsx')) {
      fail(`${VITE}/ missing root or main.tsx`);
    }
    const viteHealth = await getOk(`${VITE}/health`);
    if (!viteHealth.ok) fail(`${VITE}/health proxy → ${viteHealth.status}`);
    console.log('ok', `${VITE}/ (Listen UI dev)`);
    n += 1;
  }

  // 6) Built app on pc-agent /friday/listen
  const built = await getOk(`${AGENT}/friday/listen`);
  if (built.status === 404) {
    console.warn(`skip: ${AGENT}/friday/listen → 404 (run npm run ui:build in pc-agent)`);
  } else {
    if (!built.ok) fail(`/friday/listen → ${built.status}`);
    if (!built.text.includes('id="root"')) fail('/friday/listen HTML missing root');
    console.log('ok', `${AGENT}/friday/listen (built)`);
    n += 1;
  }

  // 7) Security scan status (Bearer PC_AGENT_SECRET)
  const SECRET = (process.env.PC_AGENT_SECRET || '').trim();
  if (!SECRET) {
    console.warn('skip: PC_AGENT_SECRET unset — /security/scan/status');
  } else {
    const sec = await getOk(`${AGENT}/security/scan/status`, {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    if (!sec.ok) fail(`/security/scan/status → ${sec.status}`);
    const sj = JSON.parse(sec.text);
    if (!sj.ok) fail('unexpected /security/scan/status body');
    console.log('ok', `${AGENT}/security/scan/status`);
    n += 1;
  }

  console.log(`smoke-listen-ui: passed (${n} checks)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
