#!/usr/bin/env node
/**
 * Daily full npm audit (workspace root). Respects 24h cache unless --force.
 * Used by Task Scheduler / cron; same logic as pc-agent /security/scan/run.
 */
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runDailySecurityScan,
  defaultRepoRoot,
} from '../pc-agent/src/dailySecurityScan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot =
  String(process.env.OPENCLAW_REPO_ROOT || '').trim() ||
  path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const force = args.includes('--force') || args.includes('-f');
const ignoreCache = args.includes('--ignore-cache');

async function main() {
  const out = await runDailySecurityScan({
    repoRoot,
    force: force || ignoreCache,
    respectCache: !force && !ignoreCache,
  });
  console.log(JSON.stringify(out, null, 2));
  if (!out.skipped && out.audit) {
    const s = out.audit.summary;
    const hi = (s?.high || 0) + (s?.critical || 0);
    if (hi > 0 || out.audit.parseError) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(String(e?.message || e));
  process.exitCode = 2;
});
