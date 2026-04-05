import { test } from 'node:test';
import assert from 'node:assert';
import { mkdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  parseNpmAuditJson,
  computeScanDecision,
  msUntilNextFullScan,
  totalHighPlusCritical,
  pathsForRepo,
  readScanState,
  acquireScanLock,
  releaseScanLock,
  runDailySecurityScan,
} from '../src/dailySecurityScan.js';

test('parseNpmAuditJson: npm metadata.vulnerabilities', () => {
  const raw = JSON.stringify({
    metadata: {
      vulnerabilities: { info: 1, low: 2, moderate: 3, high: 1, critical: 0 },
    },
  });
  const p = parseNpmAuditJson(raw);
  assert.deepStrictEqual(p.summary, {
    info: 1,
    low: 2,
    moderate: 3,
    high: 1,
    critical: 0,
  });
  assert.equal(totalHighPlusCritical(p.summary), 1);
});

test('parseNpmAuditJson: invalid JSON', () => {
  const p = parseNpmAuditJson('not-json');
  assert.ok(p.parseError);
  assert.equal(totalHighPlusCritical(p.summary), 0);
});

test('computeScanDecision: force always runs', () => {
  const state = { lastFullScanAt: new Date().toISOString() };
  const d = computeScanDecision(state, Date.now(), true, 86400000);
  assert.equal(d.run, true);
  assert.equal(d.reason, 'force');
});

test('computeScanDecision: cache valid within 24h', () => {
  const state = { lastFullScanAt: new Date().toISOString() };
  const now = Date.now();
  const d = computeScanDecision(state, now, false, 24 * 60 * 60 * 1000);
  assert.equal(d.run, false);
  assert.ok(d.msRemaining > 0);
});

test('computeScanDecision: expired cache', () => {
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const d = computeScanDecision({ lastFullScanAt: old }, Date.now(), false, 24 * 60 * 60 * 1000);
  assert.equal(d.run, true);
  assert.equal(d.reason, 'cache_expired');
});

test('msUntilNextFullScan: zero when never scanned', () => {
  assert.equal(msUntilNextFullScan({}, Date.now(), 86400000), 0);
});

test('runDailySecurityScan: skips when cache file is fresh (no npm)', async () => {
  const tmp = await mkTmpRepo();
  try {
    const { statePath } = pathsForRepo(tmp);
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({
        lastFullScanAt: new Date().toISOString(),
        lastResult: { summary: { critical: 0, high: 0, moderate: 0, low: 0, info: 0 } },
      }),
      'utf8',
    );
    const out = await runDailySecurityScan({ repoRoot: tmp, force: false, respectCache: true });
    assert.equal(out.skipped, true);
    assert.equal(out.reason, 'cache_valid');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('lock file prevents parallel second run in same window', async () => {
  const tmp = await mkTmpRepo();
  try {
    const { lockPath } = pathsForRepo(tmp);
    const a = await acquireScanLock(lockPath);
    assert.equal(a.ok, true);
    const b = await acquireScanLock(lockPath);
    assert.equal(b.ok, false);
    assert.equal(b.busy, true);
    await releaseScanLock(lockPath);
    const c = await acquireScanLock(lockPath);
    assert.equal(c.ok, true);
    await releaseScanLock(lockPath);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readScanState round-trip', async () => {
  const tmp = await mkTmpRepo();
  try {
    const { statePath } = pathsForRepo(tmp);
    const payload = { lastFullScanAt: '2020-01-01T00:00:00.000Z', lastResult: { x: 1 } };
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify(payload), 'utf8');
    const read = await readScanState(statePath);
    assert.deepStrictEqual(read.lastFullScanAt, payload.lastFullScanAt);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

async function mkTmpRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'oc-sec-'));
  await writeFile(
    path.join(tmp, 'package.json'),
    JSON.stringify({ name: 't', private: true, version: '1.0.0' }),
    'utf8',
  );
  return tmp;
}
