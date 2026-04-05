import React, { useCallback, useEffect, useRef, useState } from 'react';
import { safeReadJson } from '../lib/fetchJson';
import styles from '../styles/listen.module.css';

type MailRow = { uid: string; from: string; subject: string; date: string };
type MarkedMail = { [uid: string]: boolean };

const MAIL_BATCH = 8;

type GmailState = {
  unread: MailRow[];
  recent: MailRow[];
  error: string | null;
  loading: boolean;
  hasMoreUnread: boolean;
  hasMoreRecent: boolean;
};

type WaMsg = { id: string; from: string; text: string; ts: string };

type WaStatus = {
  connectionStatus: string | null;
  state: string | null;
  number: string | null;
  profileName: string | null;
  error: string | null;
  loading: boolean;
};

type Props = {
  authHeaders: () => HeadersInit;
  showToast: (message: string, variant?: 'info' | 'success' | 'error') => void;
  theme: 'light' | 'dark';
  drawerOpen: boolean;
  onDrawerClose: () => void;
  isNarrow: boolean;
};

const POLL_MS = 32_000;

export const IntegrationsRail: React.FC<Props> = ({
  authHeaders,
  showToast,
  theme,
  drawerOpen,
  onDrawerClose,
  isNarrow,
}) => {
  const [gmail, setGmail] = useState<GmailState>({
    unread: [],
    recent: [],
    error: null,
    loading: true,
    hasMoreUnread: false,
    hasMoreRecent: false,
  });
  const [waStatus, setWaStatus] = useState<WaStatus>({
    connectionStatus: null,
    state: null,
    number: null,
    profileName: null,
    error: null,
    loading: true,
  });
  const [waMessages, setWaMessages] = useState<WaMsg[]>([]);
  const [waMsgError, setWaMsgError] = useState<string | null>(null);
  const [waNumber, setWaNumber] = useState('');
  const [waText, setWaText] = useState('');
  const [waSending, setWaSending] = useState(false);
  const [selectedMail, setSelectedMail] = useState<MailRow | null>(null);
  const [markedMails, setMarkedMails] = useState<MarkedMail>({});
  const [isDragging, setIsDragging] = useState(false);
  const gmailRef = useRef(gmail);
  gmailRef.current = gmail;
  const railRef = useRef<HTMLDivElement>(null);

  // Load saved width from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem('friday.integrations.width');
      if (saved) {
        const width = Math.max(300, Math.min(800, parseInt(saved, 10)));
        document.documentElement.style.setProperty('--integrations-width', `${width}px`);
      }
    } catch {
      // Ignore
    }
  }, []);

  // Handle resize dragging
  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!railRef.current) return;
      const rect = railRef.current.parentElement?.getBoundingClientRect();
      if (!rect) return;

      const newWidth = rect.right - e.clientX;
      if (newWidth >= 300 && newWidth <= 800) {
        document.documentElement.style.setProperty('--integrations-width', `${newWidth}px`);
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      if (railRef.current) {
        const width = window
          .getComputedStyle(railRef.current)
          .width.replace('px', '');
        localStorage.setItem('friday.integrations.width', width);
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  const toggleMailMark = (uid: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setMarkedMails((prev) => ({
      ...prev,
      [uid]: !prev[uid],
    }));
  };

  const refreshMail = useCallback(async () => {
    try {
      setGmail((g) => ({ ...g, loading: true }));
      const r = await fetch(
        `/integrations/gmail?unreadCount=${MAIL_BATCH}&recentCount=${MAIL_BATCH}&unreadOffset=0&recentOffset=0`,
        { headers: authHeaders() },
      );
      const { data } = await safeReadJson(r);
      const d = data as {
        error?: string;
        unread?: unknown[];
        recent?: unknown[];
      };
      if (!r.ok || (d && typeof d.error === 'string' && !Array.isArray(d.unread))) {
        setGmail((g) => ({
          ...g,
          loading: false,
          error: d?.error || `HTTP ${r.status}`,
        }));
        return;
      }
      const unread = Array.isArray(d.unread) ? (d.unread as MailRow[]) : [];
      const recent = Array.isArray(d.recent) ? (d.recent as MailRow[]) : [];
      setGmail({
        unread,
        recent,
        error: null,
        loading: false,
        hasMoreUnread: unread.length >= MAIL_BATCH,
        hasMoreRecent: recent.length >= MAIL_BATCH,
      });
    } catch (e) {
      setGmail((g) => ({
        ...g,
        loading: false,
        error: String((e as Error).message || e),
      }));
    }
  }, [authHeaders]);

  const loadMoreMail = useCallback(async () => {
    try {
      setGmail((g) => ({ ...g, loading: true }));
      const uOff = gmailRef.current.unread.length;
      const rOff = gmailRef.current.recent.length;
      const r = await fetch(
        `/integrations/gmail?unreadCount=${MAIL_BATCH}&recentCount=${MAIL_BATCH}&unreadOffset=${uOff}&recentOffset=${rOff}`,
        { headers: authHeaders() },
      );
      const { data } = await safeReadJson(r);
      const d = data as { error?: string; unread?: unknown[]; recent?: unknown[] };
      if (!r.ok || (d && typeof d.error === 'string' && !Array.isArray(d.unread))) {
        setGmail((g) => ({
          ...g,
          loading: false,
          error: d?.error || `HTTP ${r.status}`,
        }));
        return;
      }
      const nu = Array.isArray(d.unread) ? (d.unread as MailRow[]) : [];
      const nr = Array.isArray(d.recent) ? (d.recent as MailRow[]) : [];
      setGmail((g) => {
        const uids = new Set(g.unread.map((x) => x.uid));
        const rids = new Set(g.recent.map((x) => x.uid));
        const mergedU = [...g.unread, ...nu.filter((x) => !uids.has(x.uid))];
        const mergedR = [...g.recent, ...nr.filter((x) => !rids.has(x.uid))];
        return {
          ...g,
          unread: mergedU,
          recent: mergedR,
          error: null,
          loading: false,
          hasMoreUnread: nu.length >= MAIL_BATCH,
          hasMoreRecent: nr.length >= MAIL_BATCH,
        };
      });
    } catch (e) {
      setGmail((g) => ({
        ...g,
        loading: false,
        error: String((e as Error).message || e),
      }));
    }
  }, [authHeaders]);

  const refreshWhatsApp = useCallback(async () => {
    try {
      const [metaR, stR, msgR] = await Promise.all([
        fetch('/integrations/whatsapp/meta', { headers: authHeaders() }),
        fetch('/integrations/whatsapp/status', { headers: authHeaders() }),
        fetch('/integrations/whatsapp/messages?limit=12', { headers: authHeaders() }),
      ]);
      const { data: metaRaw } = await safeReadJson(metaR);
      const meta = metaRaw as { defaultNumber?: string };
      if (metaR.ok && meta?.defaultNumber) {
        setWaNumber((n) => n || String(meta.defaultNumber));
      }

      const { data: stRaw } = await safeReadJson(stR);
      const st = stRaw as {
        error?: string;
        connectionStatus?: string | null;
        state?: string | null;
        number?: string | null;
      };
      if (!stR.ok) {
        setWaStatus({
          connectionStatus: null,
          state: null,
          number: null,
          profileName: null,
          error: st?.error || `HTTP ${stR.status}`,
          loading: false,
        });
      } else {
        const stFull = stRaw as typeof st & { profileName?: string | null };
        setWaStatus({
          connectionStatus: stFull.connectionStatus ?? null,
          state: stFull.state ?? null,
          number: stFull.number ?? null,
          profileName: stFull.profileName ?? null,
          error: null,
          loading: false,
        });
      }

      const { data: mjRaw } = await safeReadJson(msgR);
      const mj = mjRaw as { messages?: WaMsg[]; error?: string };
      if (msgR.ok && Array.isArray(mj.messages)) {
        setWaMessages(mj.messages);
        setWaMsgError(null);
      } else {
        setWaMsgError(mj.error || `messages HTTP ${msgR.status}`);
        setWaMessages([]);
      }
    } catch (e) {
      setWaStatus((s) => ({
        ...s,
        loading: false,
        error: String((e as Error).message || e),
      }));
      setWaMsgError(String((e as Error).message || e));
    }
  }, [authHeaders]);

  const refreshAll = useCallback(async () => {
    setGmail((g) => ({ ...g, loading: true }));
    setWaStatus((s) => ({ ...s, loading: true }));
    await Promise.all([refreshMail(), refreshWhatsApp()]);
  }, [refreshMail, refreshWhatsApp]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    const onVis = () => {
      if (!document.hidden) refreshAll();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refreshAll]);

  useEffect(() => {
    const iv = setInterval(() => {
      if (document.hidden) return;
      refreshAll();
    }, POLL_MS);
    return () => clearInterval(iv);
  }, [refreshAll]);

  useEffect(() => {
    if (gmail.unread.length > 0) {
      setSelectedMail((cur) => {
        if (cur && gmail.unread.some((u) => u.uid === cur.uid)) return cur;
        return gmail.unread[0];
      });
    } else if (gmail.recent.length > 0) {
      setSelectedMail((cur) => {
        if (cur && gmail.recent.some((u) => u.uid === cur.uid)) return cur;
        return gmail.recent[0];
      });
    } else {
      setSelectedMail(null);
    }
  }, [gmail.unread, gmail.recent]);

  const connectionOk =
    waStatus.connectionStatus === 'open' ||
    String(waStatus.state || '').toLowerCase() === 'open';

  const handleSendWa = async () => {
    const num = waNumber.replace(/\D/g, '');
    const text = waText.trim();
    if (!num || !text) {
      showToast('Enter number and message', 'error');
      return;
    }
    setWaSending(true);
    try {
      const r = await fetch('/integrations/whatsapp/send', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ number: num, text }),
      });
      const d = await r.json();
      if (!r.ok) {
        showToast(d.error || `Send failed (${r.status})`, 'error');
      } else {
        showToast('WhatsApp message sent', 'success');
        setWaText('');
        refreshWhatsApp();
      }
    } catch (e) {
      showToast(String((e as Error).message || e), 'error');
    } finally {
      setWaSending(false);
    }
  };

  const railClass = [
    styles['integrations-rail'],
    theme === 'light' ? styles['integrations-rail-light'] : '',
    isNarrow && drawerOpen ? styles['integrations-rail-open'] : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      {isNarrow && drawerOpen && (
        <button
          type="button"
          className={styles['integrations-backdrop']}
          aria-label="Close integrations"
          onClick={onDrawerClose}
        />
      )}
      <aside ref={railRef} className={railClass} aria-label="Mail and WhatsApp">
        <div
          className={`${styles['integrations-resize-handle']} ${isDragging ? styles['dragging'] : ''}`}
          onMouseDown={() => setIsDragging(true)}
          role="separator"
          aria-label="Resize email and chat panel"
        />
        <div className={styles['integrations-rail-inner']}>
          {isNarrow && (
            <div className={styles['integrations-mobile-head']}>
              <span>Mail and WhatsApp</span>
              <button type="button" className={styles['integrations-close']} onClick={onDrawerClose} aria-label="Close">
                {'\u2715'}
              </button>
            </div>
          )}
          <div className={styles['integrations-section']}>
            <div className={styles['integrations-section-head']}>
              <span className={styles['integrations-title']}>Mail</span>
              <span className={styles['integrations-badge']}>{gmail.unread.length} unread</span>
              <button
                type="button"
                className={styles['integrations-refresh']}
                onClick={() => refreshMail()}
                disabled={gmail.loading}
              >
                Refresh
              </button>
            </div>
            {gmail.error && (
              <div className={styles['integrations-error']}>{gmail.error}</div>
            )}
            <div className={styles['integrations-split']}>
              <div className={styles['integrations-mail-list']}>
                {gmail.loading && gmail.unread.length === 0 && gmail.recent.length === 0 && (
                  <div className={styles['integrations-muted']}>Loading…</div>
                )}
                {gmail.unread.length > 0 && (
                  <>
                    <div className={styles['integrations-list-label']}>Unread</div>
                    {gmail.unread.map((m) => (
                      <button
                        key={`u-${m.uid}`}
                        type="button"
                        className={`${styles['integrations-mail-row']} ${selectedMail?.uid === m.uid ? styles['integrations-mail-row-active'] : ''}`}
                        onClick={() => setSelectedMail(m)}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', width: '100%', minWidth: 0 }}>
                          <div
                            className={`${styles['integrations-mail-mark']} ${markedMails[m.uid] ? styles['marked'] : ''}`}
                            onClick={(e) => toggleMailMark(m.uid, e)}
                            role="checkbox"
                            aria-checked={markedMails[m.uid] ?? false}
                          >
                            {markedMails[m.uid] ? '✓' : ''}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <span className={styles['integrations-mail-subj']}>{m.subject || '(no subject)'}</span>
                            <div className={styles['integrations-mail-from']}>{m.from}</div>
                          </div>
                          <span style={{ fontSize: '0.52rem', color: 'rgba(255, 255, 255, 0.28)', flexShrink: 0, marginLeft: '6px' }}>
                            {shortFromDate(m).props.children}
                          </span>
                        </div>
                      </button>
                    ))}
                  </>
                )}
                {gmail.recent.length > 0 && (
                  <>
                    <div className={styles['integrations-list-label']}>Recent</div>
                    {gmail.recent.map((m) => (
                      <button
                        key={`r-${m.uid}`}
                        type="button"
                        className={`${styles['integrations-mail-row']} ${selectedMail?.uid === m.uid ? styles['integrations-mail-row-active'] : ''}`}
                        onClick={() => setSelectedMail(m)}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', width: '100%', minWidth: 0 }}>
                          <div
                            className={`${styles['integrations-mail-mark']} ${markedMails[m.uid] ? styles['marked'] : ''}`}
                            onClick={(e) => toggleMailMark(m.uid, e)}
                            role="checkbox"
                            aria-checked={markedMails[m.uid] ?? false}
                          >
                            {markedMails[m.uid] ? '✓' : ''}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <span className={styles['integrations-mail-subj']}>{m.subject || '(no subject)'}</span>
                            <div className={styles['integrations-mail-from']}>{m.from}</div>
                          </div>
                          <span style={{ fontSize: '0.52rem', color: 'rgba(255, 255, 255, 0.28)', flexShrink: 0, marginLeft: '6px' }}>
                            {shortFromDate(m).props.children}
                          </span>
                        </div>
                      </button>
                    ))}
                  </>
                )}
                {(gmail.hasMoreUnread || gmail.hasMoreRecent) && (
                  <button
                    type="button"
                    className={styles['integrations-refresh']}
                    style={{ width: '100%', marginTop: 8 }}
                    onClick={() => loadMoreMail()}
                    disabled={gmail.loading}
                  >
                    {gmail.loading ? 'Loading…' : 'Load more'}
                  </button>
                )}
              </div>
              <div className={styles['integrations-mail-detail']}>
                {selectedMail ? (
                  <>
                    <div className={styles['integrations-detail-subject']}>{selectedMail.subject}</div>
                    <div className={styles['integrations-detail-meta']}>
                      <span>{selectedMail.from}</span>
                      <span>{selectedMail.date}</span>
                    </div>
                    <div className={styles['integrations-muted']}>
                      Open Gmail for full message (UID {selectedMail.uid})
                    </div>
                  </>
                ) : (
                  <div className={styles['integrations-muted']}>No mail loaded</div>
                )}
              </div>
            </div>
          </div>

          <div className={styles['integrations-section']}>
            <div className={styles['integrations-section-head']}>
              <span className={styles['integrations-title']}>WhatsApp</span>
              <span
                className={`${styles['integrations-wa-pill']} ${connectionOk ? styles['integrations-wa-ok'] : styles['integrations-wa-bad']}`}
              >
                {waStatus.loading ? '…' : waStatus.connectionStatus || waStatus.state || 'unknown'}
              </span>
              <button
                type="button"
                className={styles['integrations-refresh']}
                onClick={() => refreshWhatsApp()}
                disabled={waStatus.loading}
              >
                Refresh
              </button>
            </div>
            {waStatus.error && (
              <div className={styles['integrations-error']}>{waStatus.error}</div>
            )}
            {(waStatus.profileName || waStatus.number) && (
              <div className={styles['integrations-muted']}>
                {waStatus.profileName ? `${waStatus.profileName} · ` : ''}
                {waStatus.number || ''}
              </div>
            )}
            <div className={styles['integrations-wa-msgs']}>
              <div className={styles['integrations-list-label']}>Recent inbound</div>
              {waMsgError && (
                <div className={styles['integrations-error']}>{waMsgError}</div>
              )}
              {waMessages.length === 0 && !waMsgError && (
                <div className={styles['integrations-muted']}>No messages yet</div>
              )}
              {waMessages.map((msg) => (
                <div key={msg.id} className={styles['integrations-wa-line']}>
                  <span className={styles['integrations-wa-from']}>+{msg.from}</span>
                  <span className={styles['integrations-wa-text']}>{msg.text}</span>
                </div>
              ))}
            </div>
            <div className={styles['integrations-wa-compose']}>
              <input
                type="text"
                className={styles['integrations-input']}
                placeholder="Number (digits)"
                value={waNumber}
                onChange={(e) => setWaNumber(e.target.value)}
                aria-label="WhatsApp number"
              />
              <textarea
                className={styles['integrations-textarea']}
                placeholder="Message (allowlisted numbers only)"
                value={waText}
                onChange={(e) => setWaText(e.target.value)}
                rows={3}
                aria-label="WhatsApp message text"
              />
              <button
                type="button"
                className={styles['integrations-send-wa']}
                onClick={handleSendWa}
                disabled={waSending || !connectionOk}
              >
                {waSending ? 'Sending…' : 'Send'}
              </button>
              {!connectionOk && (
                <div className={styles['integrations-muted']}>
                  Connect WhatsApp in Evolution to send from here
                </div>
              )}
            </div>
          </div>
        </div>
      </aside>
    </>
  );
};

function shortFromDate(m: MailRow): React.ReactNode {
  const fromShort = m.from.replace(/<[^>]+>/g, '').trim().slice(0, 36);
  return (
    <span className={styles['integrations-mail-meta']}>
      {fromShort} · {m.date}
    </span>
  );
}
