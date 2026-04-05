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

/** @type {unknown} */
let scheduledTask = null;

const fireState = {
  lastFiredAt: /** @type {string | null} */ (null),
  lastFinishedAt: /** @type {string | null} */ (null),
  lastExitCode: /** @type {number | null} */ (null),
  fireCount: 0,
  lastSpawnError: /** @type {string | null} */ (null),
};

/**
 * Live snapshot for GET /openclaw/status (reads current env + in-memory cron fires).
 */
export function getBriefingCronSnapshot() {
  const gatewayOn = envBool('FRIDAY_BRIEFING_GATEWAY_CRON', false);
  const trackerOn = envBool('FRIDAY_TRACKER_ENABLED', true);
  const dbOk = Boolean((process.env.OPENCLAW_DATABASE_URL || '').trim());
  const expr = (process.env.FRIDAY_BRIEFING_CRON_EXPR || '*/15 * * * *').trim();
  const tz = (process.env.FRIDAY_BRIEFING_CRON_TZ || process.env.TZ || '').trim();
  const exprValid = cron.validate(expr);

  /** @type {string | null} */
  let disabledReason = null;
  if (!gatewayOn) disabledReason = 'FRIDAY_BRIEFING_GATEWAY_CRON is off';
  else if (!trackerOn) disabledReason = 'FRIDAY_TRACKER_ENABLED is off';
  else if (!dbOk) disabledReason = 'OPENCLAW_DATABASE_URL is missing';
  else if (!exprValid) disabledReason = 'FRIDAY_BRIEFING_CRON_EXPR is invalid';

  const scheduled = scheduledTask != null;

  const skipMicPrompt = envBool('FRIDAY_BRIEFING_SKIP_MIC_PROMPT', false);

  return {
    gatewayCronEnvOn: gatewayOn,
    trackerEnabled: trackerOn,
    databaseConfigured: dbOk,
    skipMicPrompt,
    cronExpr: expr,
    cronExpressionValid: exprValid,
    timezone: tz || null,
    scheduled,
    lastFiredAt: fireState.lastFiredAt,
    lastFinishedAt: fireState.lastFinishedAt,
    lastExitCode: fireState.lastExitCode,
    fireCount: fireState.fireCount,
    lastSpawnError: fireState.lastSpawnError,
    disabledReason: scheduled ? null : disabledReason,
  };
}

/**
 * @param {import('pino').Logger} log
 */
export function startBriefingCron(log) {
  scheduledTask = null;
  fireState.lastSpawnError = null;

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
      fireState.lastFiredAt = new Date().toISOString();
      fireState.fireCount += 1;
      const py = process.env.PYTHON || 'python';
      const script = path.join(REPO_ROOT, 'scripts', 'friday-action-tracker.py');
      const skipMicPrompt = envBool('FRIDAY_BRIEFING_SKIP_MIC_PROMPT', false);
      const args = [script, '--once', '--skip-ingestion'];
      if (skipMicPrompt) args.push('--gateway-cron');
      log.info(
        { expr, skipMicPrompt },
        skipMicPrompt
          ? 'briefingCron: action-tracker (auto-yes, no mic)'
          : 'briefingCron: action-tracker (full check-in with mic)',
      );
      const child = spawn(py, args, {
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
        fireState.lastFinishedAt = new Date().toISOString();
        fireState.lastExitCode = code;
        if (code !== 0) {
          log.warn({ code, stderrTail: errBuf.slice(-800) }, 'briefingCron: action-tracker exited non-zero');
        }
      });
      child.on('error', (err) => {
        fireState.lastSpawnError = String(err?.message || err);
        log.error({ err }, 'briefingCron: failed to spawn action-tracker');
      });
    },
    opts,
  );

  scheduledTask = task;

  log.info(
    { expr, tz: tz || 'system default' },
    'briefingCron: scheduled (node-cron)',
  );
  return task;
}
