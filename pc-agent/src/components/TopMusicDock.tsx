import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PERSONA_ORB_PALETTES } from '../data/companyPersonas';
import type { SpeakingPersonaKey } from '../contexts/VoiceAppContext';
import styles from '../styles/listen.module.css';

export type TopMusicDockProps = {
  theme: 'light' | 'dark';
  musicOrbCaption: string;
  speakingPersonaKey: SpeakingPersonaKey;
  authHeaders: () => HeadersInit;
  showToast: (message: string, type?: 'info' | 'error' | 'success') => void;
};

function stripPlayingPrefix(line: string): string {
  return line.replace(/^\s*playing\s*:\s*/i, '').trim();
}

/**
 * Compact Maestro strip in the header + expandable search / transport.
 */
const TopMusicDock: React.FC<TopMusicDockProps> = ({
  theme,
  musicOrbCaption,
  speakingPersonaKey,
  authHeaders,
  showToast,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<'play' | 'stop' | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const lastPlayedRef = useRef('');

  const maestroActive =
    Boolean(musicOrbCaption.trim()) &&
    (speakingPersonaKey === 'maestro' || /^playing/i.test(musicOrbCaption));

  const line = musicOrbCaption.trim()
    ? stripPlayingPrefix(musicOrbCaption).slice(0, 52) + (stripPlayingPrefix(musicOrbCaption).length > 52 ? '…' : '')
    : 'Nothing playing';

  const palette = PERSONA_ORB_PALETTES.maestro;

  useEffect(() => {
    if (!expanded) return;
    const onDoc = (e: MouseEvent) => {
      const el = wrapRef.current;
      if (el && !el.contains(e.target as Node)) setExpanded(false);
    };
    const t = window.setTimeout(() => document.addEventListener('mousedown', onDoc), 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('mousedown', onDoc);
    };
  }, [expanded]);

  const onToggleSearch = useCallback(() => {
    setExpanded((x) => {
      const next = !x;
      if (next && musicOrbCaption.trim()) {
        const stripped = stripPlayingPrefix(musicOrbCaption);
        setQuery((q) => (q.trim() ? q : stripped));
      }
      return next;
    });
  }, [musicOrbCaption]);

  const doPlay = useCallback(async () => {
    const q = query.trim();
    if (!q) {
      showToast('Enter a search first', 'info');
      return;
    }
    setBusy('play');
    try {
      const r = await fetch('/voice/music/play', {
        method: 'POST',
        headers: { ...authHeaders() as Record<string, string> },
        body: JSON.stringify({ query: q }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) {
        lastPlayedRef.current = q;
        showToast('Maestro is on it', 'success');
        setExpanded(false);
      } else {
        showToast(typeof j.detail === 'string' ? j.detail : 'Play request failed', 'error');
      }
    } catch {
      showToast('Play request failed', 'error');
    } finally {
      setBusy(null);
    }
  }, [query, authHeaders, showToast]);

  const doStop = useCallback(async () => {
    setBusy('stop');
    try {
      const r = await fetch('/voice/music/stop', {
        method: 'POST',
        headers: { ...authHeaders() as Record<string, string> },
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok !== false) {
        showToast('Playback stopped', 'info');
      } else {
        showToast(typeof j.detail === 'string' ? j.detail : 'Stop failed', 'error');
      }
    } catch {
      showToast('Stop failed', 'error');
    } finally {
      setBusy(null);
    }
  }, [authHeaders, showToast]);

  const replayLast = useCallback(() => {
    const q =
      query.trim() ||
      lastPlayedRef.current.trim() ||
      stripPlayingPrefix(musicOrbCaption).trim();
    if (q) {
      setQuery(q);
      void (async () => {
        setBusy('play');
        try {
          const r = await fetch('/voice/music/play', {
            method: 'POST',
            headers: { ...authHeaders() as Record<string, string> },
            body: JSON.stringify({ query: q }),
          });
          const j = await r.json().catch(() => ({}));
          if (r.ok && j.ok) {
            lastPlayedRef.current = q;
            showToast('Playing again', 'success');
          } else {
            showToast(typeof j.detail === 'string' ? j.detail : 'Play failed', 'error');
          }
        } catch {
          showToast('Play failed', 'error');
        } finally {
          setBusy(null);
        }
      })();
    } else {
      setExpanded(true);
      showToast('Search for a track first', 'info');
    }
  }, [query, authHeaders, showToast, musicOrbCaption]);

  return (
    <div ref={wrapRef} className={`${styles['music-dock']} ${theme === 'light' ? styles['music-dock-light'] : ''}`}>
      <div className={styles['music-dock-row']}>
        <div
          className={`${styles['music-dock-now']} ${maestroActive ? styles['music-dock-now-live'] : ''}`}
          style={{ '--music-accent': palette.primary } as React.CSSProperties}
          title={musicOrbCaption.trim() || 'Local player via Maestro'}
        >
          <span className={styles['music-dock-icon']} aria-hidden>
            {'\u266B'}
          </span>
          <span className={styles['music-dock-marquee']}>
            <span className={styles['music-dock-marquee-inner']}>{line}</span>
          </span>
          {maestroActive && <span className={styles['music-dock-pulse']} aria-hidden />}
        </div>

        <div className={styles['music-dock-transport']}>
          <button
            type="button"
            className={`${styles['music-dock-btn']} ${expanded ? styles['music-dock-btn-on'] : ''}`}
            onClick={onToggleSearch}
            title={expanded ? 'Close search' : 'Search and queue a track'}
            aria-expanded={expanded}
          >
            {'\uD83D\uDD0D'}
          </button>
          <button
            type="button"
            className={styles['music-dock-btn']}
            onClick={replayLast}
            disabled={busy !== null}
            title="Play — uses the box below if open, otherwise last or current track line"
          >
            {'\u25B6'}
          </button>
          <button
            type="button"
            className={`${styles['music-dock-btn']} ${styles['music-dock-btn-stop']}`}
            onClick={doStop}
            disabled={busy !== null}
            title="Stop local player (ends this ffplay session)"
          >
            {'\u23F9'}
          </button>
        </div>
      </div>

      {expanded && (
        <div className={styles['music-dock-expand']} role="region" aria-label="Music search">
          <p className={styles['music-dock-hint']}>
            Maestro uses yt-dlp search on this machine — try an artist, track, or &ldquo;lofi jazz&rdquo;.
          </p>
          <div className={styles['music-dock-search-row']}>
            <input
              type="search"
              className={styles['music-dock-input']}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), void doPlay())}
              placeholder="Artist, song, playlist vibe…"
              autoFocus
            />
            <button
              type="button"
              className={styles['music-dock-play-go']}
              onClick={() => void doPlay()}
              disabled={busy !== null || !query.trim()}
            >
              Play
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default TopMusicDock;
