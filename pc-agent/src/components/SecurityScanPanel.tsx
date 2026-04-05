import React, { useCallback, useEffect, useState } from 'react';
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

interface Props {
  authHeaders: () => Record<string, string>;
  theme: 'light' | 'dark';
  showToast: (message: string, variant?: 'info' | 'success' | 'error') => void;
}

function sumHighCrit(s?: Summary) {
  if (!s) return 0;
  return (s.high || 0) + (s.critical || 0);
}

function formatEta(ms: number) {
  if (ms <= 0) return 'due now';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return `in ${h}h ${m}m`;
  return `in ${m}m`;
}

const SecurityScanPanel: React.FC<Props> = ({ authHeaders, theme, showToast }) => {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<StatusPayload | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const r = await fetch('/security/scan/status', { headers: authHeaders() });
      const j = (await r.json()) as StatusPayload;
      if (j.ok !== false) setStatus(j);
    } catch {
      setStatus(null);
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
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 45_000);
    return () => {
      window.removeEventListener('openclaw:security-scan-complete', onRefresh);
      window.clearInterval(id);
    };
  }, [load]);

  const runScan = async (force: boolean) => {
    try {
      setRunning(true);
      const r = await fetch('/security/scan/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ force }),
      });
      const j = await r.json();
      if (!r.ok) {
        showToast('Security scan request failed', 'error');
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
    } catch {
      showToast('Security scan failed', 'error');
    } finally {
      setRunning(false);
    }
  };

  const displaySummary = status?.lastResult?.summary;
  const hi = sumHighCrit(displaySummary);
  const badgeClass =
    hi > 0 ? styles['sec-scan-badge-bad'] : displaySummary ? styles['sec-scan-badge-ok'] : styles['sec-scan-badge-muted'];

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
          {loading ? '…' : hi > 0 ? `${hi} hi` : displaySummary ? 'ok' : '—'}
        </span>
        <span className={styles['sec-scan-chevron']}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className={styles['sec-scan-body']}>
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
          <p className={styles['sec-scan-hint']}>
            First full npm audit each day uses a twenty four hour cache. High or critical issues add a pinned todo and
            optional Windows notify.
          </p>
        </div>
      )}
    </div>
  );
};

export default SecurityScanPanel;
