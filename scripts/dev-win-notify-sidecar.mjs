/**
 * Starts win-notify-watch.py on Windows when FRIDAY_WIN_NOTIFY_WATCH is on.
 * Otherwise (or on non-Windows) stays alive as a no-op so pc-agent dev:all
 * does not exit and trigger concurrently kill-others-on-exit.
 */
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function readEnvBoolFromDotEnv(key, defaultVal) {
  const fromProc = process.env[key];
  if (fromProc !== undefined && String(fromProc).trim() !== '') {
    const low = String(fromProc).trim().toLowerCase();
    if (['0', 'false', 'no', 'off'].includes(low)) return false;
    if (['1', 'true', 'yes', 'on'].includes(low)) return true;
  }
  const envPath = path.join(root, '.env');
  if (!existsSync(envPath)) return defaultVal;
  try {
    const raw = readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      if (k !== key) continue;
      let v = t.slice(eq + 1).split('#')[0].trim().replace(/^["']|["']$/g, '');
      const low = v.toLowerCase();
      if (['0', 'false', 'no', 'off'].includes(low)) return false;
      return true;
    }
  } catch {
    /* ignore */
  }
  return defaultVal;
}

function stayAlive() {
  setInterval(() => {}, 86_400_000);
}

if (process.platform !== 'win32') {
  stayAlive();
} else if (!readEnvBoolFromDotEnv('FRIDAY_WIN_NOTIFY_WATCH', true)) {
  stayAlive();
} else {
  const script = path.join(root, 'scripts', 'win-notify-watch.py');
  const python = process.env.PYTHON ?? 'python';
  const child = spawn(python, [script], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  child.on('exit', (code, sig) => {
    process.exit(code ?? (sig ? 1 : 0));
  });
}
