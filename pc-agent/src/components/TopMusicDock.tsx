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
  onStopSpeaking?: () => void;
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
  onStopSpeaking,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<'play' | 'stop' | null>(null);
  const [musicVol, setMusicVol] = useState(20);
  const [musicAutoplay, setMusicAutoplay] = useState(true);
  const volDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const lastPlayedRef = useRef('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const h = { ...authHeaders() as Record<string, string> };
        const [rv, ra] = await Promise.all([
          fetch('/voice/music/volume', { headers: h }),
          fetch('/voice/music/autoplay', { headers: h }),
        ]);
        const [jv, ja] = await Promise.all([rv.json().catch(() => ({})), ra.json().catch(() => ({}))]);
        if (cancelled) return;
        if (rv.ok && typeof jv.volume === 'number') setMusicVol(jv.volume);
        if (ra.ok && typeof ja.enabled === 'boolean') setMusicAutoplay(ja.enabled);
      } catch {
        /* keep defaults */
      }
    })();
    return () => {
      cancelled = true;
      if (volDebounceRef.current) {
        window.clearTimeout(volDebounceRef.current);
        volDebounceRef.current = null;
      }
    };
  }, [authHeaders]);

  const persistMusicAutoplay = useCallback(
    async (enabled: boolean) => {
      let previous = true;
      setMusicAutoplay((p) => {
        previous = p;
        return enabled;
      });
      try {
        const r = await fetch('/voice/music/autoplay', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders() as Record<string, string>,
          },
          body: JSON.stringify({ enabled }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.ok === false) {
          setMusicAutoplay(previous);
          showToast(typeof j.error === 'string' ? j.error : 'Auto music setting failed', 'error');
        }
      } catch {
        setMusicAutoplay(previous);
        showToast('Auto music setting failed', 'error');
      }
    },
    [authHeaders, showToast],
  );

  const persistMusicVolume = useCallback(
    async (v: number) => {
      try {
        const r = await fetch('/voice/music/volume', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders() as Record<string, string>,
          },
          body: JSON.stringify({ volume: v }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.ok === false) {
          showToast(typeof j.detail === 'string' ? j.detail : 'Volume save failed', 'error');
        }
      } catch {
        showToast('Volume save failed', 'error');
      }
    },
    [authHeaders, showToast],
  );

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
          {speakingPersonaKey && onStopSpeaking && (
            <button
              type="button"
              className={`${styles['music-dock-btn']} ${styles['music-dock-btn-stop']}`}
              onClick={onStopSpeaking}
              disabled={busy !== null}
              title="Stop speaking (ends TTS)"
            >
              {'\u26D4'}
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className={styles['music-dock-expand']} role="region" aria-label="Maestro music">
          <p className={styles['music-dock-hint']}>
            Maestro uses yt-dlp search on this machine — try an artist, track, or &ldquo;lofi jazz&rdquo;.
          </p>
          <div className={styles['music-dock-controls-row']}>
            <div
              className={styles['music-dock-volume-col']}
              title="Background music playback level on this machine"
            >
              <span className={styles['music-dock-volume-val-vertical']} aria-live="polite">
                {musicVol}%
              </span>
              <label className={styles['music-dock-volume-vertical-label']} htmlFor="music-dock-volume">
                Level
              </label>
              <input
                id="music-dock-volume"
                type="range"
                className={styles['music-dock-volume-slider-vertical']}
                min={0}
                max={100}
                value={musicVol}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={musicVol}
                {...({ orient: 'vertical' } as React.InputHTMLAttributes<HTMLInputElement>)}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (!Number.isFinite(v)) return;
                  setMusicVol(Math.round(v));
                  if (volDebounceRef.current) window.clearTimeout(volDebounceRef.current);
                  volDebounceRef.current = window.setTimeout(() => {
                    volDebounceRef.current = null;
                    void persistMusicVolume(Math.round(v));
                  }, 400);
                }}
              />
            </div>
            <div
              className={styles['music-dock-autoplay-col']}
              title="Scheduler, ambient clips, startup or task-done songs. Manual play still works."
            >
              <span className={styles['music-dock-autoplay-label']} id="music-dock-autoplay-lbl">
                Auto bg
              </span>
              <input
                type="checkbox"
                role="switch"
                className={styles['music-dock-autoplay-switch']}
                checked={musicAutoplay}
                onChange={(e) => void persistMusicAutoplay(e.target.checked)}
                aria-checked={musicAutoplay}
                aria-labelledby="music-dock-autoplay-lbl"
              />
            </div>
            <div className={styles['music-dock-search-col']}>
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
          </div>
        </div>
      )}
    </div>
  );
};

export default TopMusicDock;
