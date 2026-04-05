/**
 * Daily npm audit aggregate with 24h cache and file lock (CLI + pc-agent).
 */
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LOCK_STALE_MS = 20 * 60 * 1000;

/** @param {string} repoRoot */
export function pathsForRepo(repoRoot) {
  const cacheDir = path.join(repoRoot, '.cache');
  return {
    cacheDir,
    statePath: path.join(cacheDir, 'daily-security-scan.json'),
    lockPath: path.join(cacheDir, 'daily-security-scan.lock'),
  };
}

export function intervalMsFromEnv() {
  const h = Number(process.env.OPENCLAW_SECURITY_SCAN_INTERVAL_HOURS || 24);
  const hours = Number.isFinite(h) && h > 0 ? Math.min(h, 168) : 24;
  return hours * 60 * 60 * 1000;
}

function zeroSummary() {
  return { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
}

/**
 * @param {string} rawStdout
 */
export function parseNpmAuditJson(rawStdout) {
  let j;
  try {
    j = JSON.parse(rawStdout || '{}');
  } catch {
    return {
      parseError: 'invalid JSON',
      summary: zeroSummary(),
      auditError: String(rawStdout || '').slice(0, 500),
    };
  }
  const meta = j.metadata?.vulnerabilities;
  if (meta && typeof meta === 'object') {
    return {
      summary: {
        info: Number(meta.info) || 0,
        low: Number(meta.low) || 0,
        moderate: Number(meta.moderate) || 0,
        high: Number(meta.high) || 0,
        critical: Number(meta.critical) || 0,
      },
    };
  }
  if (j.error) {
    return {
      auditError: String(j.error?.summary || j.error),
      summary: zeroSummary(),
    };
  }
  return { summary: zeroSummary() };
}

/** @param {ReturnType<typeof zeroSummary>} summary */
export function totalHighPlusCritical(summary) {
  return (summary?.high || 0) + (summary?.critical || 0);
}

/**
 * @param {{ lastFullScanAt?: string|null }} state
 * @param {number} nowMs
 * @param {number} intervalMs
 */
export function msUntilNextFullScan(state, nowMs, intervalMs) {
  if (!state?.lastFullScanAt) return 0;
  const last = Date.parse(state.lastFullScanAt);
  if (!Number.isFinite(last)) return 0;
  return Math.max(0, last + intervalMs - nowMs);
}

/**
 * @param {{ lastFullScanAt?: string|null }} state
 * @param {number} nowMs
 * @param {boolean} force
 * @param {number} intervalMs
 */
export function computeScanDecision(state, nowMs, force, intervalMs) {
  if (force) return { run: true, reason: 'force' };
  if (!state?.lastFullScanAt) return { run: true, reason: 'never' };
  const remaining = msUntilNextFullScan(state, nowMs, intervalMs);
  if (remaining <= 0) return { run: true, reason: 'cache_expired' };
  return { run: false, reason: 'cache_valid', msRemaining: remaining };
}

/** @param {string} statePath */
export async function readScanState(statePath) {
  try {
    const raw = await readFile(statePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeScanState(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * @param {string} lockPath
 */
export async function acquireScanLock(lockPath) {
  const now = Date.now();
  if (existsSync(lockPath)) {
    try {
      const raw = await readFile(lockPath, 'utf8');
      const j = JSON.parse(raw);
      const started = Date.parse(j.startedAt);
      if (Number.isFinite(started) && now - started < LOCK_STALE_MS) {
        return { ok: false, busy: true };
      }
    } catch {
      /* stale */
    }
    try {
      await unlink(lockPath);
    } catch {
      /* ignore */
    }
  }
  await mkdir(path.dirname(lockPath), { recursive: true });
  await writeFile(
    lockPath,
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    'utf8',
  );
  return { ok: true };
}

export async function releaseScanLock(lockPath) {
  try {
    await unlink(lockPath);
  } catch {
    /* ignore */
  }
}

/**
 * @param {string} cwd
 */
export async function runNpmAuditJson(cwd) {
  // Use 'npm' without platform-specific .cmd extension.
  // execFile with shell:true ensures PATH resolution works correctly on all platforms.
  // Command is static with no user input, so shell:true is safe.
  const npm = 'npm';
  const env = { ...process.env, NO_COLOR: '1' };
  const opts = {
    cwd,
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
    env,
    shell: true,
  };
  try {
    const { stdout, stderr } = await execFileAsync(npm, ['audit', '--json'], opts);
    return { code: 0, stdout: stdout?.toString() || '', stderr: stderr?.toString() || '' };
  } catch (e) {
    const stdout = e.stdout?.toString() || '';
    const stderr = e.stderr?.toString() || '';
    const code = typeof e.code === 'number' ? e.code : 1;
    return { code, stdout, stderr };
  }
}

/**
 * @param {string} repoRoot
 */
export async function executeFullNpmAudit(repoRoot) {
  const r = await runNpmAuditJson(repoRoot);
  const parsed = parseNpmAuditJson(r.stdout || '{}');
  return {
    exitCode: r.code,
    stderrTail: (r.stderr || '').slice(-2000),
    ranAt: new Date().toISOString(),
    ...parsed,
  };
}

/**
 * @param {string} repoRoot
 */
export async function getScanStatus(repoRoot) {
  const { statePath } = pathsForRepo(repoRoot);
  const state = await readScanState(statePath);
  const intervalMs = intervalMsFromEnv();
  const nowMs = Date.now();
  const dec = computeScanDecision(state || {}, nowMs, false, intervalMs);
  const msUntil = dec.run ? 0 : dec.msRemaining || 0;
  return {
    lastFullScanAt: state?.lastFullScanAt || null,
    lastResult: state?.lastResult || null,
    intervalHours: intervalMs / (60 * 60 * 1000),
    msUntilNextFullScan: msUntil,
    nextFullScanEst:
      msUntil > 0 ? new Date(nowMs + msUntil).toISOString() : new Date(nowMs).toISOString(),
    cacheSaysRunDue: dec.run,
  };
}

/**
 * @param {{ repoRoot: string, force?: boolean, respectCache?: boolean }} opts
 */
export async function runDailySecurityScan(opts) {
  const { repoRoot, force = false, respectCache = true } = opts;
  const { statePath, lockPath } = pathsForRepo(repoRoot);
  const intervalMs = intervalMsFromEnv();
  const nowMs = Date.now();

  const state = (await readScanState(statePath)) || {};
  const decision = computeScanDecision(state, nowMs, force, intervalMs);

  if (respectCache && !decision.run) {
    return {
      skipped: true,
      reason: decision.reason,
      msUntilNextFullScan: decision.msRemaining,
      state,
    };
  }

  const lock = await acquireScanLock(lockPath);
  if (!lock.ok && lock.busy) {
    return {
      skipped: true,
      reason: 'lock_busy',
      state,
    };
  }

  try {
    const auditResult = await executeFullNpmAudit(repoRoot);
    const newState = {
      lastFullScanAt: new Date().toISOString(),
      lastResult: auditResult,
      intervalHours: intervalMs / (60 * 60 * 1000),
    };
    await writeScanState(statePath, newState);
    return {
      skipped: false,
      state: newState,
      audit: auditResult,
    };
  } finally {
    await releaseScanLock(lockPath);
  }
}

export function defaultRepoRoot() {
  return path.resolve(__dirname, '..', '..');
}
