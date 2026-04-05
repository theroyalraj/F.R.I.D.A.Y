import React, { useCallback, useEffect, useRef, useState } from 'react';
import styles from '../styles/listen.module.css';

type Summary = {
  info?: number;
  low?: number;
  moderate?: number;
  high?: number;
  critical?: number;
};

type StatusPayload = {
  ok?: boolean;
  lastFullScanAt?: string | null;
  lastResult?: { summary?: Summary; exitCode?: number; ranAt?: string };
  intervalHours?: number;
  msUntilNextFullScan?: number;
  nextFullScanEst?: string;
  cacheSaysRunDue?: boolean;
};

type CodeSummary = { high?: number; medium?: number; low?: number };

type CodeFinding = { file: string; line: number; ruleId: string; severity: string; note: string };

type CodeLastRun = {
  ranAt?: string;
  fileCount?: number;
  findings?: CodeFinding[];
  summary?: CodeSummary;
};

type CodeStatusPayload = { ok?: boolean; lastRun?: CodeLastRun | null };

interface Props {
  authHeaders: () => HeadersInit;
  theme: 'light' | 'dark';
  showToast: (message: string, variant?: 'info' | 'success' | 'error') => void;
  /** Full-width sidebar block (default) vs round Argus avatar + popover (integrations rail). */
  variant?: 'panel' | 'avatar';
}

function sumHighCrit(s?: Summary) {
  if (!s) return 0;
  return (s.high || 0) + (s.critical || 0);
}

function sumCodeHighMed(s?: CodeSummary) {
  if (!s) return 0;
  return (s.high || 0) + (s.medium || 0);
}

function formatEta(ms: number) {
  if (ms <= 0) return 'due now';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return `in ${h}h ${m}m`;
  return `in ${m}m`;
}

const SecurityScanPanel: React.FC<Props> = ({ authHeaders, theme, showToast, variant = 'panel' }) => {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [codeStatus, setCodeStatus] = useState<CodeStatusPayload | null>(null);
  const [runningCode, setRunningCode] = useState(false);
  const avatarWrapRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [rNpm, rCode] = await Promise.all([
        fetch('/security/scan/status', { headers: authHeaders() }),
        fetch('/security/code-scan/status', { headers: authHeaders() }),
      ]);
      if (rNpm.ok) {
        const text = await rNpm.text();
        if (text) {
          try {
            const j = JSON.parse(text) as StatusPayload;
            if (j.ok !== false) setStatus(j);
            else setStatus(null);
          } catch {
            setStatus(null);
          }
        } else setStatus(null);
      } else setStatus(null);

      if (rCode.ok) {
        const text = await rCode.text();
        if (text) {
          try {
            const j = JSON.parse(text) as CodeStatusPayload;
            if (j.ok !== false) setCodeStatus(j);
            else setCodeStatus(null);
          } catch {
            setCodeStatus(null);
          }
        } else setCodeStatus(null);
      } else setCodeStatus(null);
    } catch {
      setStatus(null);
      setCodeStatus(null);
    } finally {
      setLoading(false);
    }
  }, [authHeaders]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onRefresh = () => {
      void load();
    };
    window.addEventListener('openclaw:security-scan-complete', onRefresh);
    window.addEventListener('openclaw:code-security-scan-complete', onRefresh);
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 45_000);
    return () => {
      window.removeEventListener('openclaw:security-scan-complete', onRefresh);
      window.removeEventListener('openclaw:code-security-scan-complete', onRefresh);
      window.clearInterval(id);
    };
  }, [load]);

  useEffect(() => {
    if (variant !== 'avatar' || !open) return;
    const onDoc = (e: MouseEvent) => {
      const el = avatarWrapRef.current;
      if (el && !el.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [variant, open]);

  const runScan = async (force: boolean) => {
    try {
      setRunning(true);
      const r = await fetch('/security/scan/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ force }),
      });
      if (!r.ok) {
        showToast('Security scan request failed', 'error');
        return;
      }
      const text = await r.text();
      if (!text) {
        showToast('Security scan: empty response', 'error');
        return;
      }
      let j;
      try {
        j = JSON.parse(text);
      } catch {
        showToast('Security scan: invalid response format', 'error');
        return;
      }
      const res = j.result;
      if (res?.skipped && res.reason === 'cache_valid') {
        showToast(`Daily scan cached — next full run ${formatEta(status?.msUntilNextFullScan || 0)}`, 'info');
      } else if (res?.skipped && res.reason === 'lock_busy') {
        showToast('Another scan is running — wait a moment', 'info');
      } else if (res?.audit?.summary) {
        const hi = sumHighCrit(res.audit.summary);
        showToast(
          hi > 0
            ? `npm audit: ${res.audit.summary.critical || 0} critical, ${res.audit.summary.high || 0} high`
            : 'npm audit complete — no high or critical findings',
          hi > 0 ? 'error' : 'success',
        );
      } else {
        showToast('Security scan finished', 'success');
      }
      window.dispatchEvent(new CustomEvent('openclaw:todos-refresh'));
      await load();
    } catch (e) {
      showToast('Security scan failed', 'error');
    } finally {
      setRunning(false);
    }
  };

  const runCodeScan = async () => {
    try {
      setRunningCode(true);
      const r = await fetch('/security/code-scan/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({}),
      });
      if (!r.ok) {
        showToast('Code pattern scan request failed', 'error');
        return;
      }
      const j = await r.json().catch(() => ({}));
      const res = j.result as CodeLastRun | undefined;
      const s = res?.summary;
      const hm = sumCodeHighMed(s);
      showToast(
        hm > 0
          ? `Code scan: ${s?.high || 0} high, ${s?.medium || 0} medium pattern hits`
          : 'Code pattern scan complete — no high or medium hits',
        hm > 0 ? 'error' : 'success',
      );
      await load();
    } catch {
      showToast('Code pattern scan failed', 'error');
    } finally {
      setRunningCode(false);
    }
  };

  const displaySummary = status?.lastResult?.summary;
  const hi = sumHighCrit(displaySummary);
  const codeRun = codeStatus?.lastRun;
  const codeHi = codeRun?.summary?.high ?? 0;
  const codeMed = codeRun?.summary?.medium ?? 0;
  const badgeCount = Math.max(hi, codeHi);
  const badgeClass =
    badgeCount > 0 ? styles['sec-scan-badge-bad'] : displaySummary || codeRun ? styles['sec-scan-badge-ok'] : styles['sec-scan-badge-muted'];

  const topFindings = (codeRun?.findings || []).slice(0, 10);

  const body = open ? (
    <div className={variant === 'avatar' ? styles['sec-scan-avatar-body'] : styles['sec-scan-body']}>
      <div className={styles['sec-scan-popover-title']}>Dependencies · npm audit</div>
      <div className={styles['sec-scan-row']}>
        <span>Last full scan</span>
        <span className={styles['sec-scan-mono']}>
          {status?.lastFullScanAt ? new Date(status.lastFullScanAt).toLocaleString() : 'never'}
        </span>
      </div>
      {displaySummary && (
        <div className={styles['sec-scan-counts']}>
          <span>C {displaySummary.critical ?? 0}</span>
          <span>H {displaySummary.high ?? 0}</span>
          <span>M {displaySummary.moderate ?? 0}</span>
          <span>L {displaySummary.low ?? 0}</span>
        </div>
      )}
      <div className={styles['sec-scan-row']}>
        <span>Next scheduled</span>
        <span className={styles['sec-scan-mono']}>
          {!status?.cacheSaysRunDue && (status?.msUntilNextFullScan ?? 0) > 0
            ? formatEta(status.msUntilNextFullScan || 0)
            : 'due (cache expired or first run)'}
        </span>
      </div>
      <div className={styles['sec-scan-actions']}>
        <button
          type="button"
          className={styles['sec-scan-btn']}
          disabled={running}
          onClick={() => void runScan(false)}
        >
          {running ? 'Running…' : 'Run if due'}
        </button>
        <button
          type="button"
          className={`${styles['sec-scan-btn']} ${styles['sec-scan-btn-primary']}`}
          disabled={running}
          onClick={() => void runScan(true)}
        >
          Force full scan
        </button>
      </div>

      <div className={styles['sec-scan-popover-title']}>Source · pattern scan</div>
      <div className={styles['sec-scan-row']}>
        <span>Last code scan</span>
        <span className={styles['sec-scan-mono']}>
          {codeRun?.ranAt ? new Date(codeRun.ranAt).toLocaleString() : 'never'}
        </span>
      </div>
      {codeRun?.summary && (
        <div className={styles['sec-scan-counts']}>
          <span>H {codeHi}</span>
          <span>M {codeMed}</span>
          <span>L {codeRun.summary.low ?? 0}</span>
          <span>files {codeRun.fileCount ?? '—'}</span>
        </div>
      )}
      <div className={styles['sec-scan-actions']}>
        <button
          type="button"
          className={`${styles['sec-scan-btn']} ${styles['sec-scan-btn-primary']}`}
          disabled={runningCode}
          onClick={() => void runCodeScan()}
        >
          {runningCode ? 'Scanning…' : 'Run code scan'}
        </button>
      </div>
      {topFindings.length > 0 && (
        <ul className={styles['sec-scan-findings']}>
          {topFindings.map((f, i) => (
            <li key={`${f.file}:${f.line}:${f.ruleId}:${i}`} className={styles['sec-scan-finding']}>
              <span className={styles['sec-scan-mono']}>
                {f.severity} · {f.file}:{f.line}
              </span>
              <span className={styles['sec-scan-finding-note']}>{f.ruleId}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  ) : null;

  if (variant === 'avatar') {
    return (
      <div ref={avatarWrapRef} className={styles['sec-scan-avatar-wrap']}>
        <button
          type="button"
          className={`${styles['sec-scan-avatar-btn']} ${theme === 'light' ? styles['sec-scan-avatar-btn-light'] : ''}`}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="dialog"
          title="Argus — npm audit and code pattern scan"
        >
          <span className={styles['sec-scan-avatar-emoji']} aria-hidden>
            {'\uD83D\uDC6E'}
          </span>
          <span className={styles['sec-scan-sr-only']}>Open security scan panel</span>
          {!loading && badgeCount > 0 ? (
            <span className={styles['sec-scan-avatar-alert']} aria-hidden>
              {badgeCount > 9 ? '9+' : badgeCount}
            </span>
          ) : null}
          {loading ? <span className={styles['sec-scan-avatar-loading']} aria-hidden /> : null}
        </button>
        {open ? (
          <div
            className={`${styles['sec-scan-avatar-popover']} ${theme === 'light' ? styles['sec-scan-avatar-popover-light'] : ''}`}
            role="dialog"
            aria-label="Security scan"
          >
            {body}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={`${styles['sec-scan-wrap']} ${theme === 'light' ? styles['sec-scan-wrap-light'] : ''}`}
    >
      <button
        type="button"
        className={styles['sec-scan-toggle']}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={styles['sec-scan-toggle-label']}>Security scan</span>
        <span className={badgeClass} aria-hidden>
          {loading ? '…' : badgeCount > 0 ? `${badgeCount} hi` : displaySummary || codeRun ? 'ok' : '—'}
        </span>
        <span className={styles['sec-scan-chevron']}>{open ? '▾' : '▸'}</span>
      </button>
      {body}
    </div>
  );
};

export default SecurityScanPanel;
