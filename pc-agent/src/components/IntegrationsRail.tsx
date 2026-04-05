import React, { useCallback, useEffect, useRef, useState } from 'react';
import { safeReadJson } from '../lib/fetchJson';
import TodoPanel from './TodoPanel';
import type { SpeakingPersonaKey } from '../contexts/VoiceAppContext';
import { COMPANY_PERSONAS, personaIcon, type CompanyPersonaKey } from '../data/companyPersonas';
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

type Props = {
  authHeaders: () => HeadersInit;
  showToast: (message: string, variant?: 'info' | 'success' | 'error') => void;
  theme: 'light' | 'dark';
  drawerOpen: boolean;
  onDrawerClose: () => void;
  isNarrow: boolean;
  peripheralSpeak: { channel: 'mail' | 'whatsapp'; text: string } | null;
  speakingPersonaKey: SpeakingPersonaKey;
};

/** Gmail IMAP is expensive; server caches in Redis ~10 min — client polls mail on this interval when auto is on. */
const GMAIL_POLL_MS = 600_000;

export const IntegrationsRail: React.FC<Props> = ({
  authHeaders,
  showToast,
  theme,
  drawerOpen,
  onDrawerClose,
  isNarrow,
  peripheralSpeak,
  speakingPersonaKey,
}) => {
  const [gmail, setGmail] = useState<GmailState>({
    unread: [],
    recent: [],
    error: null,
    loading: true,
    hasMoreUnread: false,
    hasMoreRecent: false,
  });
  const [selectedMail, setSelectedMail] = useState<MailRow | null>(null);
  const [markedMails, setMarkedMails] = useState<MarkedMail>({});
  const [archivingMails, setArchivingMails] = useState<{ [uid: string]: boolean }>({});
  const [isDragging, setIsDragging] = useState(false);
  const [lastGmailRefresh, setLastGmailRefresh] = useState<number>(Date.now());
  const [gmailAutoRefresh, setGmailAutoRefresh] = useState(true);
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
    const isMarking = !markedMails[uid];

    // Optimistic UI update
    setMarkedMails((prev) => ({
      ...prev,
      [uid]: isMarking,
    }));

    if (isMarking) {
      // Mark as unread and remove from unread list
      void (async () => {
        try {
          const r = await fetch('/integrations/mail/mark-unread', {
            method: 'POST',
            headers: { ...authHeaders() as Record<string, string>, 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid }),
          });
          if (!r.ok) {
            showToast('Failed to mark email', 'error');
            // Revert optimistic update on error
            setMarkedMails((prev) => { const n = { ...prev }; delete n[uid]; return n; });
            return;
          }
          // Remove from unread list after marking as done
          setGmail((g) => ({
            ...g,
            unread: g.unread.filter((m) => m.uid !== uid),
          }));
          showToast('Email marked as done', 'success');
        } catch (err) {
          showToast(String((err as Error).message || err), 'error');
          // Revert on error
          setMarkedMails((prev) => { const n = { ...prev }; delete n[uid]; return n; });
        }
      })();
    }
  };

  const archiveMail = async (uid: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setArchivingMails((prev) => ({ ...prev, [uid]: true }));
    try {
      const r = await fetch('/integrations/mail/archive', {
        method: 'POST',
        headers: { ...authHeaders() as Record<string, string>, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid }),
      });
      const d = await r.json();
      if (!r.ok) {
        showToast(d.error || `Archive failed (${r.status})`, 'error');
      } else {
        showToast('Email archived', 'success');
        setGmail((g) => ({
          ...g,
          unread: g.unread.filter((m) => m.uid !== uid),
          recent: g.recent.filter((m) => m.uid !== uid),
        }));
        if (selectedMail?.uid === uid) setSelectedMail(null);
      }
    } catch (err) {
      showToast(String((err as Error).message || err), 'error');
    } finally {
      setArchivingMails((prev) => { const n = { ...prev }; delete n[uid]; return n; });
    }
  };

  const refreshMail = useCallback(async (forceFresh = false) => {
    try {
      setGmail((g) => ({ ...g, loading: true }));
      const freshQ = forceFresh ? '&fresh=1' : '';
      const r = await fetch(
        `/integrations/gmail?unreadCount=${MAIL_BATCH}&recentCount=${MAIL_BATCH}&unreadOffset=0&recentOffset=0${freshQ}`,
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
      setLastGmailRefresh(Date.now());
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
        `/integrations/gmail?unreadCount=${MAIL_BATCH}&recentCount=${MAIL_BATCH}&unreadOffset=${uOff}&recentOffset=${rOff}&fresh=1`,
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

  const refreshAll = useCallback(async () => {
    setGmail((g) => ({ ...g, loading: true }));
    await refreshMail();
  }, [refreshMail]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    const onVis = () => {
      if (!document.hidden) void refreshAll();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refreshAll]);

  // Gmail: auto-refresh every 10 minutes (server caches IMAP in Redis; use Refresh button for immediate fetch).
  useEffect(() => {
    if (!gmailAutoRefresh || document.hidden) return;
    const gmailInterval = setInterval(() => {
      if (document.hidden) return;
      void refreshMail(false);
      setLastGmailRefresh(Date.now());
    }, GMAIL_POLL_MS);
    return () => clearInterval(gmailInterval);
  }, [gmailAutoRefresh, refreshMail]);

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

  const railClass = [
    styles['integrations-rail'],
    theme === 'light' ? styles['integrations-rail-light'] : '',
    isNarrow && drawerOpen ? styles['integrations-rail-open'] : '',
  ]
    .filter(Boolean)
    .join(' ');

  const mailSpeaking = peripheralSpeak?.channel === 'mail';
  const speakPersona =
    speakingPersonaKey && speakingPersonaKey !== 'custom'
      ? COMPANY_PERSONAS[speakingPersonaKey]
      : null;

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
      <aside ref={railRef} className={railClass} aria-label="Mail and tasks">
        <div
          className={`${styles['integrations-resize-handle']} ${isDragging ? styles['dragging'] : ''}`}
          onMouseDown={() => setIsDragging(true)}
          role="separator"
          aria-label="Resize email and chat panel"
        />
        <div className={styles['integrations-rail-inner']}>
          {isNarrow && (
            <div className={styles['integrations-mobile-head']}>
              <span>Mail and tasks</span>
              <button type="button" className={styles['integrations-close']} onClick={onDrawerClose} aria-label="Close">
                {'\u2715'}
              </button>
            </div>
          )}
          <div className={styles['integrations-todo-block']}>
            <TodoPanel authHeaders={authHeaders} theme={theme} />
          </div>
          <div
            className={`${styles['integrations-section']} ${mailSpeaking ? styles['integrations-section-speaking'] : ''}`}
          >
            <div className={styles['integrations-section-head']}>
              <span className={styles['integrations-title']}>Mail</span>
              <span className={styles['integrations-badge']}>{gmail.unread.length} unread</span>
              <button
                type="button"
                className={styles['integrations-refresh']}
                onClick={() => void refreshMail(true)}
                disabled={gmail.loading}
                title={`Last refreshed: ${new Date(lastGmailRefresh).toLocaleTimeString()}`}
              >
                {gmail.loading ? '⟳' : 'Refresh'}
              </button>
              <button
                type="button"
                className={`${styles['integrations-refresh']} ${gmailAutoRefresh ? styles['integrations-refresh-active'] : ''}`}
                onClick={() => setGmailAutoRefresh(!gmailAutoRefresh)}
                title={gmailAutoRefresh ? 'Auto-refresh ON (every 10 min, server Redis cache) — click to disable' : 'Auto-refresh OFF — click to enable'}
                style={{ fontSize: '0.75rem' }}
              >
                {gmailAutoRefresh ? '⚡' : '⏸'}
              </button>
            </div>
            {gmail.error && (
              <div className={styles['integrations-error']}>{gmail.error}</div>
            )}
            {mailSpeaking && (
              <div className={styles['integrations-speak-banner']} role="status" aria-live="polite">
                {speakPersona ? (
                  <span className={styles['integrations-speak-who']}>
                    <span className={styles['integrations-speak-icon']}>
                      {personaIcon(speakingPersonaKey as CompanyPersonaKey)}
                    </span>
                    <span>
                      {speakPersona.name} · speaking
                    </span>
                  </span>
                ) : (
                  <span>Speaking…</span>
                )}
                <span className={styles['integrations-speak-snippet']}>
                  {peripheralSpeak!.text.length > 140 ? `${peripheralSpeak!.text.slice(0, 137)}…` : peripheralSpeak!.text}
                </span>
              </div>
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
                      <div key={`u-${m.uid}`} className={styles['integrations-mail-row-wrap']}>
                        <button
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
                        <button
                          type="button"
                          className={styles['integrations-mail-archive']}
                          onClick={(e) => archiveMail(m.uid, e)}
                          disabled={archivingMails[m.uid]}
                          title="Archive (mark done)"
                          aria-label="Archive email"
                        >
                          {archivingMails[m.uid] ? '⋯' : '✓ Done'}
                        </button>
                      </div>
                    ))}
                  </>
                )}
                {gmail.recent.length > 0 && (
                  <>
                    <div className={styles['integrations-list-label']}>Recent</div>
                    {gmail.recent.map((m) => (
                      <div key={`r-${m.uid}`} className={styles['integrations-mail-row-wrap']}>
                        <button
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
                        <button
                          type="button"
                          className={styles['integrations-mail-archive']}
                          onClick={(e) => archiveMail(m.uid, e)}
                          disabled={archivingMails[m.uid]}
                          title="Archive (mark done)"
                          aria-label="Archive email"
                        >
                          {archivingMails[m.uid] ? '⋯' : '✓ Done'}
                        </button>
                      </div>
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
