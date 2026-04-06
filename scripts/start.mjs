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
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath }   from 'node:url';
import path                from 'node:path';
import http                from 'node:http';


const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function pythonChildForScripts() {
  const o = process.env.FRIDAY_PYTHON_CHILD?.trim();
  if (o) return o;
  return process.platform === 'win32' ? 'pythonw' : 'python3';
}

/** When set, do not kill listeners on 3847/3848 before spawn (default for safe restart-local). */
const NO_FREE_PORTS = ['1', 'true', 'yes'].includes(
  String(process.env.OPENCLAW_NO_FREE_PORTS || '').toLowerCase(),
);
/** Opt-in: kill processes listening on 3847/3848 before spawn (restart-local.ps1 -ForceKill sets this). */
const FREE_PORTS_ON_START = ['1', 'true', 'yes'].includes(
  String(process.env.OPENCLAW_FREE_PORTS_ON_START || '').toLowerCase(),
);

/**
 * Minimal .env loader — parses KEY=VALUE lines (strips inline comments, quotes).
 * Injects into process.env so all spawned children (Python daemons etc.) inherit them.
 * System env vars take precedence (never overwritten).
 */
function loadDotEnv() {
  const p = path.join(ROOT, '.env');
  if (!existsSync(p)) return;
  try {
    const text = readFileSync(p, 'utf8');
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 1) continue;
      const k = t.slice(0, eq).trim();
      if (!k || k in process.env) continue;   // system env wins
      let v = t.slice(eq + 1).split('#')[0].trim();  // strip inline comments
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
        v = v.slice(1, -1);
      process.env[k] = v;
    }
  } catch { /* ignore */ }
}
loadDotEnv();

function readFridayAmbientFromDotEnv() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.FRIDAY_AMBIENT || '').toLowerCase());
}

function readCursorNarrationFromDotEnv() {
  return ['1', 'true', 'yes', 'on'].includes(
    String(process.env.FRIDAY_CURSOR_NARRATION || '').trim().toLowerCase(),
  );
}

/** Empty key → defaultVal; explicit true/false tokens override. */
function envBool(key, defaultVal) {
  const v = String(process.env[key] || '').trim().toLowerCase();
  if (v === '') return defaultVal;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  return defaultVal;
}

function readFridayActionTrackerFromDotEnv() {
  return envBool('FRIDAY_TRACKER_ENABLED', true);
}

/** SAGE (Head of Research) — OCR + JSONL-gated thinking speech. */
function readSageOcrFromDotEnv() {
  const raw = String(process.env.FRIDAY_SAGE_ENABLED || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return envBool('FRIDAY_CURSOR_THINKING_OCR', false);
}

/** ARGUS — the all-seeing watcher. Reminds user when Claude has pending file edits. */
function readArgusFromDotEnv() {
  return envBool('FRIDAY_ARGUS_ENABLED', true);
}

/** ECHO — silence watcher: speaks a check-in after FRIDAY_SILENCE_IDLE_SEC without TTS. */
function readSilenceWatchFromDotEnv() {
  return envBool('FRIDAY_SILENCE_WATCH', true);
}

/** Windows toast notification watcher — reads WPN DB, speaks via TTS even when muted. */
function readWinNotifyFromDotEnv() {
  return envBool('FRIDAY_WIN_NOTIFY_WATCH', true);
}

/** macOS — SSE win_notify-style toasts via osascript (default off). */
function readMacNotifyFromDotEnv() {
  return envBool('FRIDAY_MAC_NOTIFY_WATCH', false);
}

/** Cursor JSONL → TTS: on if reply and/or thinking toggle is on, unless live narration suppresses it. */
function readCursorReplyWatchFromDotEnv() {
  function enabled(key) {
    const v = String(process.env[key] || '').trim().toLowerCase();
    if (v === '') return true;
    if (['0', 'false', 'no', 'off'].includes(v)) return false;
    return true;
  }
  let main = enabled('FRIDAY_CURSOR_SPEAK_REPLY');
  let sub = enabled('FRIDAY_CURSOR_SPEAK_SUBAGENT_REPLY');
  let thinking = enabled('FRIDAY_CURSOR_SPEAK_THINKING');
  if (readCursorNarrationFromDotEnv()) {
    const mainWith = ['1', 'true', 'yes', 'on'].includes(
      String(process.env.FRIDAY_CURSOR_SPEAK_REPLY_WITH_NARRATION || '').trim().toLowerCase(),
    );
    const subWith = ['1', 'true', 'yes', 'on'].includes(
      String(process.env.FRIDAY_CURSOR_SPEAK_SUBAGENT_WITH_NARRATION || '').trim().toLowerCase(),
    );
    if (main && !mainWith) main = false;
    if (sub && !subWith) sub = false;
    if (thinking && !envBool('FRIDAY_CURSOR_SPEAK_THINKING_WITH_NARRATION', true)) {
      thinking = false;
    }
  }
  return main || sub || thinking;
}

/** Experimental Cursor ChatService stream (duplicate API usage vs IDE). */
function readCursorGrpcWatchFromDotEnv() {
  return envBool('FRIDAY_CURSOR_GRPC', false);
}

/**
 * all — single machine: gateway + agent + voice/Cursor daemons + action tracker (default).
 * server — headless/backend: gateway + agent + optional Gmail watch + action tracker (no mic UI spawn).
 * client — local speech/mic/Cursor helpers only; set PC_AGENT_URL if pc-agent runs elsewhere.
 */
function parseOpenclawMode() {
  const arg = process.argv.find((a) => a.startsWith('--openclaw-mode='));
  if (arg) {
    const m = arg.split('=')[1]?.trim().toLowerCase();
    if (['server', 'client', 'all'].includes(m)) return m;
  }
  const env = String(process.env.OPENCLAW_START_MODE || 'all').trim().toLowerCase();
  if (['server', 'client', 'all'].includes(env)) return env;
  return 'all';
}

/**
 * Node --watch on gateway + agent (same idea as nodemon; no extra dependency).
 * ON by default for local dev; OFF when NODE_ENV=production unless OPENCLAW_SERVER_WATCH=1.
 * Set OPENCLAW_SERVER_WATCH=0 to disable while developing.
 */
function useServerWatch() {
  const explicit = String(process.env.OPENCLAW_SERVER_WATCH || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(explicit)) return true;
  if (['0', 'false', 'no', 'off'].includes(explicit)) return false;
  return String(process.env.NODE_ENV || '').toLowerCase() !== 'production';
}

function nodeArgsForServer(entryRel, watchPathsRel) {
  const watch = useServerWatch();
  if (!watch) return [entryRel];
  const args = ['--watch'];
  for (const p of watchPathsRel) args.push('--watch-path', p);
  args.push(entryRel);
  return args;
}

function readEmailWatchSpawnFromDotEnv() {
  return envBool('FRIDAY_EMAIL_WATCH', false);
}

// ── Colours ──────────────────────────────────────────────────────────────────
const C = {
  gateway:  '\x1b[36m',   // cyan
  agent:    '\x1b[32m',   // green
  listener: '\x1b[35m',   // magenta
  winnotify:'\x1b[96m',   // bright cyan — Windows toast notification watcher
  cursor:   '\x1b[95m',   // bright magenta — Composer reply TTS
  sage:     '\x1b[94m',   // bright blue — SAGE (thinking OCR)
  grpc:     '\x1b[35m',   // magenta — Cursor gRPC stream watch
  argus:    '\x1b[93m',   // bright yellow — ARGUS pending-accept watcher
  ambient:  '\x1b[96m',   // bright cyan
  echo:     '\x1b[92m',   // bright green — ECHO silence / presence watcher
  music:    '\x1b[93m',   // bright yellow
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
    try {
      spawn(pythonChildForScripts(), [playScript, '--stop'], { stdio: 'ignore', windowsHide: true });
    } catch { /* ignore */ }
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

// ── Open Listen UI in the default browser (Windows Chrome preferentially, macOS open, Linux xdg-open) ──
function openListenBrowser(url) {
  if (process.platform === 'darwin') {
    const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    child.unref();
    child.on('error', () => {});
    return;
  }
  if (process.platform === 'linux') {
    const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.unref();
    child.on('error', () => {});
    return;
  }
  // Windows — prefer Chrome so same-origin reuse behaves; fall back to default handler
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  const exe = candidates.find(p => existsSync(p));
  const cmd = exe || 'chrome';
  const child = spawn(cmd, [url], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  child.on('error', () => {
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
  if (process.platform === 'win32') {
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
      execSync('powershell -NoProfile -Command "Start-Sleep -Milliseconds 400"', {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch { /* no match — fine */ }
  } else {
    try {
      const pids = execSync(`lsof -ti :${port}`, { encoding: 'utf8' }).trim();
      if (pids) {
        for (const pid of pids.split(/\s+/)) {
          const p = pid.trim();
          if (!p) continue;
          try {
            execSync(`kill -9 ${p}`, { stdio: 'ignore' });
          } catch { /* ignore */ }
        }
      }
      try {
        execSync('sleep 0.5', { stdio: 'ignore' });
      } catch { /* ignore */ }
    } catch {
      /* no listener */
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Regenerate .cursor/rules/openclaw-company.mdc from the live Python registry
  // so the Cursor rule always reflects code defaults + .env overrides + Redis patches.
  try {
    execSync('python scripts/openclaw_company.py --generate-rule', { cwd: ROOT, stdio: 'pipe' });
    log('agent', 'Company persona rule regenerated from openclaw_company.py');
  } catch { /* non-fatal — rule stays as-is */ }

  const MODE = parseOpenclawMode();
  process.stdout.write(`${C.warn}[openclaw] OPENCLAW start mode: ${MODE}${C.reset}\n`);
  process.stdout.write(
    `${C.warn}[openclaw] gateway/agent file watch: ${useServerWatch() ? 'ON' : 'OFF'} ` +
      `(OPENCLAW_SERVER_WATCH / NODE_ENV) — edits under skill-gateway/src, pc-agent/src, or lib/ reload those servers; ` +
      `root dot env changes still need npm run restart:force${C.reset}\n`,
  );

  if (MODE === 'client') {
    process.stdout.write(
      `${C.warn}[openclaw] client mode — leaving ports 3847 and 3848 untouched (remote pc-agent OK)${C.reset}\n`,
    );
  } else if (NO_FREE_PORTS) {
    process.stdout.write(`${C.warn}[openclaw] OPENCLAW_NO_FREE_PORTS set — not clearing ports 3847/3848${C.reset}\n`);
  } else if (FREE_PORTS_ON_START) {
    freePort(3848);
    freePort(3847);
  } else {
    process.stdout.write(
      `${C.warn}[openclaw] Not clearing ports 3847/3848 (default). Set OPENCLAW_FREE_PORTS_ON_START=1 or use npm run restart:force to replace listeners.${C.reset}\n`,
    );
  }

  const modeBanner =
    MODE === 'server'
      ? '║ server: :3848 gateway │ :3847 agent │ email + tracker (no mic tab)  ║'
      : MODE === 'client'
        ? '║ client: mic │ ambient │ Cursor TTS · set PC_AGENT_URL if remote    ║'
        : '║ gateway :3848 │ agent :3847 │ mic │ Jarvis + team                   ║';
  process.stdout.write(`${C.warn}
  ╔══════════════════════════════════════════════════╗
  ║          OpenClaw — ${String(MODE).toUpperCase().padEnd(8)} stack                    ║
  ${modeBanner}
  ╚══════════════════════════════════════════════════╝
${C.reset}\n`);

  if (MODE === 'all' || MODE === 'server') {
    await start('gateway', 'node', nodeArgsForServer('skill-gateway/src/server.js', [
      'skill-gateway/src',
      'lib',
    ]));
    await start('agent', 'node', nodeArgsForServer('pc-agent/src/server.js', [
      'pc-agent/src',
      'lib',
    ]));
  }

  if (MODE === 'all') {
    // Wait for pc-agent to be healthy, then open Chrome to the listen UI
    process.stdout.write(`${C.warn}[openclaw] Waiting for pc-agent to be ready…${C.reset}\n`);
    const agentReady = await waitForPort(3847, 12_000);
    if (agentReady) {
      const agentBase = (process.env.PC_AGENT_URL || 'http://127.0.0.1:3847').replace(/\/$/, '');
      const listenUrl = `${agentBase}/friday/listen`;
      process.stdout.write(`${C.warn}[openclaw] Opening Listen UI → ${listenUrl}${C.reset}\n`);
      openListenBrowser(listenUrl);
    } else {
      process.stdout.write(`${C.warn}[openclaw] pc-agent not ready in time — skipping Chrome open${C.reset}\n`);
    }
  } else if (MODE === 'server') {
    process.stdout.write(`${C.warn}[openclaw] Waiting for pc-agent (no browser open in server mode)…${C.reset}\n`);
    await waitForPort(3847, 12_000);
  } else if (MODE === 'client') {
    const agentUrl = (process.env.PC_AGENT_URL || 'http://127.0.0.1:3847').replace(/\/$/, '');
    process.stdout.write(
      `${C.warn}[openclaw] client mode — voice commands go to ${agentUrl} (set PC_AGENT_URL if remote)${C.reset}\n`,
    );
    const openClientListen = envBool('OPENCLAW_CLIENT_OPEN_LISTEN', true);
    if (openClientListen) {
      const listenOverride = String(process.env.OPENCLAW_CLIENT_LISTEN_URL || '').trim();
      const listenUrl =
        listenOverride.replace(/\/$/, '') ||
        `${agentUrl}/friday/listen`;
      setTimeout(() => {
        process.stdout.write(`${C.warn}[openclaw] Opening Listen UI → ${listenUrl}${C.reset}\n`);
        openListenBrowser(listenUrl);
      }, 4000);
    }
  }

  if (MODE === 'server') {
    const emailScript = path.join(ROOT, 'scripts', 'gmail-watch.py');
    if (readEmailWatchSpawnFromDotEnv() && existsSync(emailScript)) {
      log('email', 'Gmail watch will start in 2 s…');
      await start('email', 'python', ['scripts/gmail-watch.py'], {
        delayMs: 2000,
      });
    }
  }

  if (MODE === 'all' || MODE === 'client') {
    const listenScript = path.join(ROOT, 'scripts', 'friday-listen.py');
    if (existsSync(listenScript)) {
      log('listener', 'voice daemon will start in 3 s...');
      await start('listener', 'python', ['scripts/friday-listen.py'], { delayMs: 3000 });
    } else {
      process.stdout.write(`${C.warn}[openclaw] friday-listen.py not found — voice daemon skipped${C.reset}\n`);
    }

    const cursorWatchScript = path.join(ROOT, 'scripts', 'cursor-reply-watch.py');
    if (readCursorReplyWatchFromDotEnv() && existsSync(cursorWatchScript)) {
      log('cursor', 'Composer reply TTS watcher will start shortly after the voice daemon...');
      await start('cursor', 'python', ['scripts/cursor-reply-watch.py'], { delayMs: 500 });
    }

    const cursorGrpcScript = path.join(ROOT, 'scripts', 'cursor-grpc-watch.py');
    if (readCursorGrpcWatchFromDotEnv() && existsSync(cursorGrpcScript)) {
      log('grpc', 'Cursor gRPC stream watcher will start in 900 ms...');
      await start('grpc', 'python', ['scripts/cursor-grpc-watch.py'], { delayMs: 900 });
    }

    const thinkingOcrScript = path.join(ROOT, 'scripts', 'cursor-thinking-ocr.py');
    if (readSageOcrFromDotEnv() && existsSync(thinkingOcrScript)) {
      log('sage', 'SAGE (Head of Research) thinking OCR will start in 1.2 s...');
      await start('sage', 'python', ['scripts/cursor-thinking-ocr.py'], { delayMs: 1200 });
    }

    const argusScript = path.join(ROOT, 'scripts', 'argus.py');
    if (readArgusFromDotEnv() && existsSync(argusScript)) {
      log('argus', 'ARGUS (pending-accept watcher) will start in 1.5 s...');
      await start('argus', 'python', ['scripts/argus.py'], { delayMs: 1500 });
    }

    const silenceScript = path.join(ROOT, 'scripts', 'friday-silence-watch.py');
    if (readSilenceWatchFromDotEnv() && existsSync(silenceScript)) {
      log('echo', 'ECHO silence watcher will start in five seconds...');
      await start('echo', 'python', ['scripts/friday-silence-watch.py'], { delayMs: 5000 });
    }

    if (process.platform === 'win32') {
      const winNotifyScript = path.join(ROOT, 'scripts', 'win-notify-watch.py');
      if (readWinNotifyFromDotEnv() && existsSync(winNotifyScript)) {
        log('winnotify', 'Windows toast notification watcher will start in 3.5 s...');
        await start('winnotify', 'python', ['scripts/win-notify-watch.py'], { delayMs: 3500 });
      }
    } else if (process.platform === 'darwin') {
      const macNotifyScript = path.join(ROOT, 'scripts', 'mac-notify-watch.py');
      if (readMacNotifyFromDotEnv() && existsSync(macNotifyScript)) {
        log('macnotify', 'macOS notification watcher (SSE) will start in 3.5 s...');
        await start('macnotify', 'python', ['scripts/mac-notify-watch.py'], { delayMs: 3500 });
      }
    }

    const ambientOn =
      readFridayAmbientFromDotEnv() ||
      ['1', 'true', 'yes', 'on'].includes(String(process.env.FRIDAY_AMBIENT || '').toLowerCase());
    const ambientScript = path.join(ROOT, 'scripts', 'friday-ambient.py');
    if (ambientOn && existsSync(ambientScript)) {
      log('ambient', 'Jarvis ambient daemon will start in 4.5 s...');
      await start('ambient', 'python', ['scripts/friday-ambient.py'], { delayMs: 4500 });
    }

    // Background music scheduler — plays a song every FRIDAY_MUSIC_INTERVAL_MIN minutes
    const musicSchedOn = ['1', 'true', 'yes', 'on'].includes(
      String(process.env.FRIDAY_MUSIC_SCHEDULER || '').toLowerCase(),
    );
    const musicSchedScript = path.join(ROOT, 'scripts', 'friday-music-scheduler.py');
    if (musicSchedOn && existsSync(musicSchedScript)) {
      log('music', 'background music scheduler will start in 6 s...');
      await start('music', 'python', ['scripts/friday-music-scheduler.py'], { delayMs: 6000 });
    }
  }

  const trackerScript = path.join(ROOT, 'scripts', 'friday-action-tracker.py');
  if (
    (MODE === 'all' || MODE === 'server') &&
    readFridayActionTrackerFromDotEnv() &&
    existsSync(trackerScript)
  ) {
    log('tracker', 'action tracker (Gmail, WhatsApp, Postgres) will start in 7.5 s...');
    await start('tracker', 'python', ['scripts/friday-action-tracker.py'], { delayMs: 7500 });
  }

  if (procs.length === 0) {
    process.stdout.write(
      `${C.warn}[openclaw] No child processes started for mode ${MODE} — check script paths and .env toggles.${C.reset}\n`,
    );
    process.exit(1);
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
