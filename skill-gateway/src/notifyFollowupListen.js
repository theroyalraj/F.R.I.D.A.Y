/**
 * After a spoken notification (task done, /internal/speak), optionally spawn a one-shot
 * mic window: prompt + listen up to FRIDAY_NOTIFY_LISTEN_SEC, then route speech to pc-agent.
 * @see scripts/friday-notify-followup-listen.py
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FOLLOWUP_SCRIPT = path.resolve(__dirname, '../../scripts/friday-notify-followup-listen.py');

export function notifyFollowupListenEnabled(env = process.env) {
  if (env.FRIDAY_NOTIFY_LISTEN === 'false' || env.FRIDAY_NOTIFY_LISTEN === '0') return false;
  return existsSync(FOLLOWUP_SCRIPT);
}

/**
 * Fire-and-forget: run Python follow-up listener.
 * @param {import('pino').Logger} [log]
 */
export function spawnNotifyFollowupListen(log) {
  if (!notifyFollowupListenEnabled()) return;
  const child = spawn('python', [FOLLOWUP_SCRIPT], {
    env: { ...process.env },
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  child.stderr?.on('data', (buf) => {
    const line = buf.toString().trim();
    if (line) log?.warn({ notifyFollowup: line }, 'notify follow-up stderr');
  });
  child.on('error', (e) => log?.warn({ err: String(e.message) }, 'notifyFollowupListen spawn failed'));
  child.unref();
}
