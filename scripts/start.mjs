#!/usr/bin/env node
/**
 * start.mjs — runs all OpenClaw services in the CURRENT terminal.
 *
 * Services:
 *   [gateway]  skill-gateway on :3848
 *   [agent]    pc-agent on :3847
 *   [listener] friday-listen.py voice daemon
 *
 * Ctrl+C  — or closing the terminal — kills all three cleanly.
 * Output is prefixed with a colour-coded service name.
 */

import { spawn, execSync } from 'node:child_process';
import { existsSync }      from 'node:fs';
import { fileURLToPath }   from 'node:url';
import path                from 'node:path';
import http                from 'node:http';


const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ── Colours ──────────────────────────────────────────────────────────────────
const C = {
  gateway:  '\x1b[36m',   // cyan
  agent:    '\x1b[32m',   // green
  listener: '\x1b[35m',   // magenta
  warn:     '\x1b[33m',
  reset:    '\x1b[0m',
};

function tag(name) { return `${C[name] || ''}[${name}]${C.reset}`; }
function log(name, line) { process.stdout.write(`${tag(name)} ${line}\n`); }

// ── Process registry ─────────────────────────────────────────────────────────
const procs = [];

function start(name, cmd, args, { delayMs = 0 } = {}) {
  return new Promise((resolve) => {
    setTimeout(() => {
      const child = spawn(cmd, args, {
        cwd:         ROOT,
        stdio:       ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      procs.push({ name, child });

      const handle = (stream) =>
        stream.on('data', (buf) =>
          buf.toString().split('\n').filter(l => l.trim()).forEach(l => log(name, l))
        );

      handle(child.stdout);
      handle(child.stderr);

      child.on('exit', (code, sig) => {
        log(name, `${C.warn}process exited (code ${code} signal ${sig})${C.reset}`);
      });

      child.on('error', (err) => {
        log(name, `${C.warn}spawn error: ${err.message}${C.reset}`);
      });

      resolve(child);
    }, delayMs);
  });
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
let shuttingDown = false;

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`\n${C.warn}[openclaw] ${reason} — stopping all services...${C.reset}\n`);

  // Stop any playing song before killing node services
  const playScript = path.join(ROOT, 'skill-gateway', 'scripts', 'friday-play.py');
  if (existsSync(playScript)) {
    try { spawn('python', [playScript, '--stop'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
  }

  for (const { name, child } of procs) {
    try {
      if (!child.killed) {
        child.kill('SIGTERM');
        log(name, 'sent SIGTERM');
      }
    } catch { /* already gone */ }
  }

  // Force-kill anything still running after 3 s
  setTimeout(() => {
    for (const { name, child } of procs) {
      try {
        if (!child.killed) {
          child.kill('SIGKILL');
          log(name, 'force-killed');
        }
      } catch { /* ignore */ }
    }
    process.exit(0);
  }, 3000).unref();
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP',  () => shutdown('SIGHUP'));

// ── Wait for port to accept connections ───────────────────────────────────────
function waitForPort(port, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
        res.resume();
        if (res.statusCode < 500) { resolve(true); return; }
        retry();
      });
      req.on('error', retry);
      req.setTimeout(800, () => { req.destroy(); retry(); });
    }
    function retry() {
      if (Date.now() > deadline) { resolve(false); return; }
      setTimeout(attempt, 350);
    }
    attempt();
  });
}

// ── Open Chrome to URL ────────────────────────────────────────────────────────
function openChrome(url) {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  const exe = candidates.find(p => existsSync(p));
  const cmd = exe || 'chrome';
  const child = spawn(cmd, [url, '--new-tab'], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  child.on('error', () => {
    // fallback: try PowerShell Start-Process
    const ps = spawn('powershell', ['-Command', `Start-Process "${url}"`], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    ps.unref();
    ps.on('error', () => {});
  });
}

// ── Kill anything already on our ports ───────────────────────────────────────
// Kill the port holder AND its parent so node --watch can't auto-restart.
function freePort(port) {
  try {
    execSync(
      `powershell -NoProfile -Command "` +
      `$pids = Get-NetTCPConnection -LocalPort ${port} -State Listen -EA SilentlyContinue | ` +
      `  Select-Object -ExpandProperty OwningProcess -Unique; ` +
      `foreach ($p in $pids) { ` +
      `  $pp = (Get-CimInstance Win32_Process -Filter 'ProcessId='+$p -EA SilentlyContinue).ParentProcessId; ` +
      `  taskkill /F /T /PID $p 2>$null | Out-Null; ` +
      `  if ($pp -gt 4) { taskkill /F /T /PID $pp 2>$null | Out-Null } ` +
      `}"`,
      { stdio: 'ignore', windowsHide: true }
    );
    // Give OS ~400ms to release the port after kill
    execSync('powershell -NoProfile -Command "Start-Sleep -Milliseconds 400"',
      { stdio: 'ignore', windowsHide: true });
  } catch { /* non-Windows or no match — fine */ }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Free ports first so the new instances always bind cleanly
  freePort(3848);
  freePort(3847);

  process.stdout.write(`${C.warn}
  ╔══════════════════════════════════════════════════╗
  ║          OpenClaw  —  All Services               ║
  ║   gateway :3848  │  agent :3847  │  mic daemon   ║
  ╚══════════════════════════════════════════════════╝
${C.reset}\n`);

  await start('gateway', 'node', [
    '--watch',
    '--watch-path=skill-gateway/src',
    '--watch-path=lib',
    'skill-gateway/src/server.js',
  ]);
  await start('agent', 'node', [
    '--watch',
    '--watch-path=pc-agent/src',
    '--watch-path=lib',
    'pc-agent/src/server.js',
  ]);

  // Wait for pc-agent to be healthy, then open Chrome to the listen UI
  process.stdout.write(`${C.warn}[openclaw] Waiting for pc-agent to be ready…${C.reset}\n`);
  const agentReady = await waitForPort(3847, 12_000);
  if (agentReady) {
    const listenUrl = 'http://127.0.0.1:3847/friday/listen';
    process.stdout.write(`${C.warn}[openclaw] Opening Chrome → ${listenUrl}${C.reset}\n`);
    openChrome(listenUrl);
  } else {
    process.stdout.write(`${C.warn}[openclaw] pc-agent not ready in time — skipping Chrome open${C.reset}\n`);
  }

  const listenScript = path.join(ROOT, 'scripts', 'friday-listen.py');
  if (existsSync(listenScript)) {
    log('listener', 'voice daemon will start in 3 s...');
    await start('listener', 'python', ['scripts/friday-listen.py'], { delayMs: 3000 });
  } else {
    process.stdout.write(`${C.warn}[openclaw] friday-listen.py not found — voice daemon skipped${C.reset}\n`);
  }

  process.stdout.write(`${C.warn}[openclaw] All services running. Press Ctrl+C to stop everything.${C.reset}\n\n`);

  // Keep process alive until all children exit (or Ctrl+C)
  await Promise.allSettled(
    procs.map(({ child }) => new Promise((res) => child.on('close', res)))
  );
  shutdown('all services exited');
}

main().catch((err) => {
  console.error('[openclaw] fatal:', err);
  shutdown('fatal error');
});
