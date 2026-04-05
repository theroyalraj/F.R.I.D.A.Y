/**
 * /security/scan — daily npm audit status, manual run, SSE + todos + optional Windows notify.
 */
import express from 'express';
import {
  defaultRepoRoot,
  runDailySecurityScan,
  getScanStatus,
  totalHighPlusCritical,
} from './dailySecurityScan.js';
import { addTodo, getTodos, LEGACY_TODO_SCOPE } from './todosDb.js';

const TODO_SOURCE = 'openclaw_security_scan';

export function envBoolSecurity(name, defaultVal) {
  const v = String(process.env[name] || '').trim().toLowerCase();
  if (!v) return defaultVal;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  return defaultVal;
}

function todoScopeFromReq(req) {
  if (req.user?.orgId != null && req.user?.id) {
    return { orgId: String(req.user.orgId), userId: String(req.user.id) };
  }
  return LEGACY_TODO_SCOPE;
}

/**
 * @param {import('./todosDb.js').TodoScope} scope
 */
async function maybeAddSecurityTodo(scope, audit) {
  if (!envBoolSecurity('OPENCLAW_SECURITY_SCAN_TODO', true)) return null;
  const s = audit?.summary;
  if (!s) return null;
  const n = totalHighPlusCritical(s);
  if (n <= 0) return null;

  const todos = await getTodos(scope);
  const open = todos.filter((t) => !t.done && t.source === TODO_SOURCE);
  if (open.length) return null;

  const title = `Security: npm audit reports ${n} high or critical issue${n === 1 ? '' : 's'}`;
  const detail = `Run npm audit at repo root or Listen → Security scan. Last scan: ${audit.ranAt || ''}`;
  return addTodo(
    { title, detail, priority: 'high', source: TODO_SOURCE, pinned: true, silentRemind: false },
    scope,
  );
}

/**
 * Shared post-scan SSE + optional todo + Windows notify (startup or HTTP).
 * @param {(type: string, data?: Record<string, unknown>) => void} broadcastEvent
 * @param {import('./todosDb.js').TodoScope} todoScope
 * @param {{ log?: { warn?: (o: unknown, m: string) => void } }} [opts]
 */
export async function broadcastScanOutcome(broadcastEvent, out, todoScope, opts = {}) {
  if (!out) return;
  if (out.skipped) {
    broadcastEvent('security_scan_complete', {
      skipped: true,
      reason: out.reason,
      msUntilNextFullScan: out.msUntilNextFullScan,
      lastFullScanAt: out.state?.lastFullScanAt,
    });
    return;
  }
  const audit = out.audit;
  if (!audit) return;
  const summary = audit.summary || {};
  const hi = totalHighPlusCritical(summary);
  broadcastEvent('security_scan_complete', {
    skipped: false,
    lastFullScanAt: out.state?.lastFullScanAt,
    summary,
    exitCode: audit.exitCode,
    highOrCritical: hi,
  });

  if (hi > 0 && envBoolSecurity('OPENCLAW_SECURITY_SCAN_WIN_NOTIFY', true)) {
    broadcastEvent('win_notify', {
      app: 'OpenClaw',
      title: 'Security scan',
      body: `npm audit: ${summary.critical || 0} critical, ${summary.high || 0} high. Check Listen Security scan.`,
    });
  }

  try {
    const todo = await maybeAddSecurityTodo(todoScope, audit);
    if (todo) {
      broadcastEvent('todo_added', { todo });
    }
  } catch (e) {
    opts.log?.warn?.({ err: String(e?.message || e) }, 'security scan todo skipped');
  }
}

/**
 * @param {(type: string, data?: Record<string, unknown>) => void} broadcastEvent
 */
export function createSecurityScanRouter(broadcastEvent) {
  const router = express.Router();
  router.use(express.json({ limit: '32kb' }));

  let scanInFlight = null;

  function repoRoot() {
    const override = String(process.env.OPENCLAW_REPO_ROOT || '').trim();
    return override || defaultRepoRoot();
  }

  router.get('/status', async (_req, res, next) => {
    try {
      const status = await getScanStatus(repoRoot());
      res.json({ ok: true, ...status });
    } catch (e) {
      next(e);
    }
  });

  router.post('/run', async (req, res, next) => {
    const force = Boolean(req.body?.force);
    const root = repoRoot();

    const run = async () => {
      const out = await runDailySecurityScan({
        repoRoot: root,
        force,
        respectCache: !force,
      });
      await broadcastScanOutcome(broadcastEvent, out, todoScopeFromReq(req), { log: req.log });
      return out;
    };

    try {
      if (scanInFlight) {
        const waited = await scanInFlight;
        return res.json({ ok: true, deduped: true, result: formatScanResponse(waited) });
      }
      scanInFlight = run().finally(() => {
        scanInFlight = null;
      });
      const out = await scanInFlight;
      res.json({ ok: true, result: formatScanResponse(out) });
    } catch (e) {
      scanInFlight = null;
      next(e);
    }
  });

  return router;
}

function formatScanResponse(out) {
  if (out.skipped) {
    return {
      skipped: true,
      reason: out.reason,
      msUntilNextFullScan: out.msUntilNextFullScan,
      lastFullScanAt: out.state?.lastFullScanAt || null,
    };
  }
  return {
    skipped: false,
    lastFullScanAt: out.state?.lastFullScanAt,
    audit: {
      summary: out.audit?.summary,
      exitCode: out.audit?.exitCode,
      parseError: out.audit?.parseError,
      auditError: out.audit?.auditError,
      ranAt: out.audit?.ranAt,
    },
  };
}
