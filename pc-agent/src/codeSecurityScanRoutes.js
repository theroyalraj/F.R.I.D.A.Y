/**
 * /security/code-scan — static source pattern scan (not npm audit).
 */
import express from 'express';
import {
  runCodeSecurityScan,
  readCodeScanCache,
  writeCodeScanCache,
  defaultRepoRootFromModule,
} from './codeSecurityScan.js';

/**
 * @param {(type: string, data?: Record<string, unknown>) => void} broadcastEvent
 */
export function createCodeSecurityScanRouter(broadcastEvent) {
  const router = express.Router();
  router.use(express.json({ limit: '32kb' }));

  function repoRoot() {
    const override = String(process.env.OPENCLAW_REPO_ROOT || '').trim();
    return override || defaultRepoRootFromModule();
  }

  router.get('/status', async (_req, res, next) => {
    try {
      const cached = await readCodeScanCache(repoRoot());
      res.json({
        ok: true,
        lastRun: cached,
      });
    } catch (e) {
      next(e);
    }
  });

  router.post('/run', async (_req, res, next) => {
    try {
      const root = repoRoot();
      const out = await runCodeSecurityScan({ repoRoot: root });
      await writeCodeScanCache(root, out);
      broadcastEvent('code_security_scan_complete', {
        summary: out.summary,
        findingCount: out.findings.length,
      });
      res.json({ ok: true, result: out });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
