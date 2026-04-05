/**
 * Server-side cron for periodic spoken briefings (todos, actions, commits).
 * Uses node-cron (standard wall-clock scheduling) instead of setInterval drift.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function envBool(key, defaultVal = false) {
  const v = String(process.env[key] ?? '').trim().toLowerCase();
  if (v === '') return defaultVal;
  return ['1', 'true', 'yes', 'on'].includes(v);
}

/**
 * @param {import('pino').Logger} log
 */
export function startBriefingCron(log) {
  if (!envBool('FRIDAY_BRIEFING_GATEWAY_CRON', false)) {
    return null;
  }
  if (!envBool('FRIDAY_TRACKER_ENABLED', true)) {
    log.info('briefingCron: FRIDAY_TRACKER_ENABLED is off — skipping cron');
    return null;
  }
  if (!(process.env.OPENCLAW_DATABASE_URL || '').trim()) {
    log.warn('briefingCron: OPENCLAW_DATABASE_URL missing — skipping cron');
    return null;
  }
  const expr = (process.env.FRIDAY_BRIEFING_CRON_EXPR || '*/15 * * * *').trim();
  if (!cron.validate(expr)) {
    log.error({ expr }, 'briefingCron: invalid FRIDAY_BRIEFING_CRON_EXPR — disabled');
    return null;
  }

  const tz = (process.env.FRIDAY_BRIEFING_CRON_TZ || process.env.TZ || '').trim();
  const opts = {};
  if (tz) opts.timezone = tz;

  const task = cron.schedule(
    expr,
    () => {
      const py = process.env.PYTHON || 'python';
      const script = path.join(REPO_ROOT, 'scripts', 'friday-action-tracker.py');
      log.info({ expr }, 'briefingCron: firing action-tracker --once --skip-ingestion --gateway-cron');
      const child = spawn(py, [script, '--once', '--skip-ingestion', '--gateway-cron'], {
        cwd: REPO_ROOT,
        env: { ...process.env },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let errBuf = '';
      child.stderr?.on('data', (c) => {
        errBuf += c.toString();
      });
      child.on('close', (code) => {
        if (code !== 0) {
          log.warn({ code, stderrTail: errBuf.slice(-800) }, 'briefingCron: action-tracker exited non-zero');
        }
      });
      child.on('error', (err) => {
        log.error({ err }, 'briefingCron: failed to spawn action-tracker');
      });
    },
    opts,
  );

  log.info(
    { expr, tz: tz || 'system default' },
    'briefingCron: scheduled (node-cron)',
  );
  return task;
}
