import React, { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import styles from '../styles/listen.module.css';

export interface EdgeVoiceLite {
  voice: string;
  label?: string;
  lang?: string;
  gender?: string;
  desc?: string;
}

function humorHint(v: number): string {
  if (v < 20) return 'Earnest — almost no jokes.';
  if (v < 45) return 'Light wit when it lands naturally.';
  if (v < 70) return 'Often finds a funny angle — dry, kind.';
  if (v < 90) return 'Strong comic instinct — playful, sharp.';
  return 'Maximum levity — humour colours most check-ins.';
}

function warmthHint(v: number): string {
  if (v < 25) return 'Matter-of-fact, minimal cosy talk.';
  if (v < 55) return 'Friendly without being sappy.';
  if (v < 85) return 'Genuinely warm — you care how they are.';
  return 'Deep warmth — almost maternal presence.';
}

function directnessHint(v: number): string {
  if (v < 25) return 'Hints and gentle suggestions.';
  if (v < 55) return 'Clear when it matters.';
  if (v < 80) return 'Plain-spoken, respectful.';
  return 'Blunt and honest — no fluff.';
}

function curiosityHint(v: number): string {
  if (v < 25) return 'Statements only — barely any questions.';
  if (v < 55) return 'Occasionally wonders aloud.';
  if (v < 80) return 'Curious — invites a thought or two.';
  return 'Always probing — loves a good thread.';
}

function formalityHint(v: number): string {
  if (v < 25) return 'Very casual — mate energy.';
  if (v < 55) return 'Professional but relaxed.';
  if (v < 80) return 'Composed and articulate.';
  return 'Polished — almost butler-grade.';
}

export interface EchoState {
  humor: number;
  warmth: number;
  directness: number;
  curiosity: number;
  formality: number;
  idleSec: number;
  rearmSec: number;
  voice: string;
}

const SLIDER_KEYS = ['humor', 'warmth', 'directness', 'curiosity', 'formality'] as const;

const EchoPersonalityPanel: React.FC<{
  showToast: (m: string, t?: 'info' | 'error' | 'success') => void;
  edgeVoices: EdgeVoiceLite[];
  theme: string;
}> = ({ showToast, edgeVoices, theme }) => {
  const { authHeaders } = useAuth();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [st, setSt] = useState<EchoState>({
    humor: 40,
    warmth: 70,
    directness: 50,
    curiosity: 60,
    formality: 30,
    idleSec: 120,
    rearmSec: 300,
    voice: 'en-US-MichelleNeural',
  });

  const load = useCallback(async () => {
    try {
      const r = await fetch('/settings/echo', { headers: authHeaders() });
      const d = await r.json();
      if (d.ok !== false && typeof d.humor === 'number') {
        setSt({
          humor: Number(d.humor),
          warmth: Number(d.warmth),
          directness: Number(d.directness),
          curiosity: Number(d.curiosity),
          formality: Number(d.formality),
          idleSec: Number(d.idleSec) || 120,
          rearmSec: Number(d.rearmSec) || 300,
          voice: typeof d.voice === 'string' && d.voice ? d.voice : 'en-US-MichelleNeural',
        });
      }
    } catch {
      /* ignore */
    }
  }, [authHeaders]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const onSync = () => load();
    window.addEventListener('openclaw:echo-personality-changed', onSync);
    return () => window.removeEventListener('openclaw:echo-personality-changed', onSync);
  }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const r = await fetch('/settings/echo', {
        method: 'PUT',
        headers: { ...authHeaders() as Record<string, string>, 'Content-Type': 'application/json' },
        body: JSON.stringify(st),
      });
      const d = await r.json();
      if (d.ok !== false) {
        showToast('ECHO settings saved — Redis synced for the silence daemon', 'success');
        await load();
      } else {
        showToast(d.error || 'Save failed', 'error');
      }
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    const defaults: EchoState = {
      humor: 40,
      warmth: 70,
      directness: 50,
      curiosity: 60,
      formality: 30,
      idleSec: 120,
      rearmSec: 300,
      voice: 'en-US-MichelleNeural',
    };
    setSt(defaults);
    setSaving(true);
    try {
      const r = await fetch('/settings/echo', {
        method: 'PUT',
        headers: { ...authHeaders() as Record<string, string>, 'Content-Type': 'application/json' },
        body: JSON.stringify(defaults),
      });
      const d = await r.json();
      if (d.ok !== false) showToast('ECHO settings reset to defaults', 'info');
      else showToast(d.error || 'Reset failed', 'error');
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  const setSlider = (key: (typeof SLIDER_KEYS)[number], v: number) => {
    setSt((s) => ({ ...s, [key]: Math.max(0, Math.min(100, v)) }));
  };

  const light = theme === 'light';

  return (
    <div className={styles['echo-panel-wrap']}>
      <button
        type="button"
        className={styles['echo-panel-toggle']}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="ECHO — silence watcher personality"
      >
        ECHO {open ? '\u25BC' : '\u25B6'}
      </button>
      {open && (
        <div
          className={`${styles['echo-panel']} ${light ? styles['echo-panel-light'] : ''}`}
          role="region"
          aria-label="ECHO silence watcher"
        >
          <p className={styles['echo-panel-hint']}>
            Echo checks in after quiet stretches — lines are AI-generated from recent Cursor chats. Sliders steer tone;
            voice applies to ECHO only (not Jarvis).
          </p>

          <label className={styles['echo-panel-label']}>Humour ({st.humor})</label>
          <input
            type="range"
            min={0}
            max={100}
            value={st.humor}
            onChange={(e) => setSlider('humor', Number(e.target.value))}
            className={styles['echo-slider']}
          />
          <p className={styles['echo-slider-hint']}>{humorHint(st.humor)}</p>

          <label className={styles['echo-panel-label']}>Warmth ({st.warmth})</label>
          <input
            type="range"
            min={0}
            max={100}
            value={st.warmth}
            onChange={(e) => setSlider('warmth', Number(e.target.value))}
            className={styles['echo-slider']}
          />
          <p className={styles['echo-slider-hint']}>{warmthHint(st.warmth)}</p>

          <label className={styles['echo-panel-label']}>Directness ({st.directness})</label>
          <input
            type="range"
            min={0}
            max={100}
            value={st.directness}
            onChange={(e) => setSlider('directness', Number(e.target.value))}
            className={styles['echo-slider']}
          />
          <p className={styles['echo-slider-hint']}>{directnessHint(st.directness)}</p>

          <label className={styles['echo-panel-label']}>Curiosity ({st.curiosity})</label>
          <input
            type="range"
            min={0}
            max={100}
            value={st.curiosity}
            onChange={(e) => setSlider('curiosity', Number(e.target.value))}
            className={styles['echo-slider']}
          />
          <p className={styles['echo-slider-hint']}>{curiosityHint(st.curiosity)}</p>

          <label className={styles['echo-panel-label']}>Formality ({st.formality})</label>
          <input
            type="range"
            min={0}
            max={100}
            value={st.formality}
            onChange={(e) => setSlider('formality', Number(e.target.value))}
            className={styles['echo-slider']}
          />
          <p className={styles['echo-slider-hint']}>{formalityHint(st.formality)}</p>

          <div className={styles['echo-timing-row']}>
            <label className={styles['echo-panel-label']}>
              Idle sec
              <input
                type="number"
                min={30}
                max={86400}
                value={st.idleSec}
                onChange={(e) =>
                  setSt((s) => ({ ...s, idleSec: Math.max(30, Math.min(86400, Number(e.target.value) || 120)) }))
                }
                className={styles['echo-num']}
              />
            </label>
            <label className={styles['echo-panel-label']}>
              Rearm sec
              <input
                type="number"
                min={60}
                max={86400}
                value={st.rearmSec}
                onChange={(e) =>
                  setSt((s) => ({ ...s, rearmSec: Math.max(60, Math.min(86400, Number(e.target.value) || 300)) }))
                }
                className={styles['echo-num']}
              />
            </label>
          </div>

          <label className={styles['echo-panel-label']} htmlFor="echo-voice-select">
            ECHO voice (Edge)
          </label>
          <select
            id="echo-voice-select"
            className={styles['echo-select']}
            value={st.voice}
            onChange={(e) => setSt((s) => ({ ...s, voice: e.target.value }))}
          >
            {(edgeVoices.length ? edgeVoices : [{ voice: st.voice, label: st.voice }]).map((ev) => (
              <option key={ev.voice} value={ev.voice}>
                {ev.label || ev.voice}
              </option>
            ))}
          </select>

          <div className={styles['echo-panel-actions']}>
            <button type="button" className={styles['echo-btn']} onClick={save} disabled={saving}>
              {saving ? 'Saving\u2026' : 'Save'}
            </button>
            <button type="button" className={styles['echo-btn-secondary']} onClick={reset} disabled={saving}>
              Reset defaults
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default EchoPersonalityPanel;
