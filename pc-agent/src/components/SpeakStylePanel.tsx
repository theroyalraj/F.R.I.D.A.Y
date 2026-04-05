import React, { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import styles from '../styles/listen.module.css';

export type SpeakStyleState = {
  funny: boolean;
  snarky: boolean;
  bored: boolean;
  dry: boolean;
  warm: boolean;
  customPrompt: string;
};

const DEFAULT_LOCAL: SpeakStyleState = {
  funny: false,
  snarky: false,
  bored: false,
  dry: false,
  warm: false,
  customPrompt: '',
};

const SpeakStylePanel: React.FC<{ showToast: (m: string, t?: 'info' | 'error' | 'success') => void }> = ({
  showToast,
}) => {
  const { authHeaders } = useAuth();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [style, setStyle] = useState<SpeakStyleState>(DEFAULT_LOCAL);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/voice/speak-style', { headers: authHeaders() });
      const d = await r.json();
      if (d.ok && d.style) {
        setStyle({
          funny: Boolean(d.style.funny),
          snarky: Boolean(d.style.snarky),
          bored: Boolean(d.style.bored),
          dry: Boolean(d.style.dry),
          warm: Boolean(d.style.warm),
          customPrompt: typeof d.style.customPrompt === 'string' ? d.style.customPrompt : '',
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
    window.addEventListener('openclaw:speak-style-changed', onSync);
    return () => window.removeEventListener('openclaw:speak-style-changed', onSync);
  }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const r = await fetch('/voice/speak-style', {
        method: 'POST',
        headers: { ...authHeaders() as Record<string, string> },
        body: JSON.stringify(style),
      });
      const d = await r.json();
      if (d.ok) {
        showToast('Speak style saved', 'success');
        if (d.style) {
          setStyle({
            funny: Boolean(d.style.funny),
            snarky: Boolean(d.style.snarky),
            bored: Boolean(d.style.bored),
            dry: Boolean(d.style.dry),
            warm: Boolean(d.style.warm),
            customPrompt: typeof d.style.customPrompt === 'string' ? d.style.customPrompt : '',
          });
        }
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
    setStyle(DEFAULT_LOCAL);
    setSaving(true);
    try {
      const r = await fetch('/voice/speak-style', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(DEFAULT_LOCAL),
      });
      const d = await r.json();
      if (d.ok) showToast('Speak style cleared', 'info');
      else showToast(d.error || 'Reset failed', 'error');
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  const toggle = (key: keyof SpeakStyleState) => {
    if (key === 'customPrompt') return;
    setStyle((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div className={styles['speak-style-wrap']}>
      <button
        type="button"
        className={styles['speak-style-toggle']}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        Speak style {open ? '\u25BC' : '\u25B6'}
      </button>
      {open && (
        <div className={styles['speak-style-panel']} role="region" aria-label="Global speak style">
          <p className={styles['speak-style-hint']}>
            Moods apply to voice, mic, WhatsApp, and the typed box here. They steer Claude before TTS; Edge rate and pitch pick up from Redis for every speak.
          </p>
          <div className={styles['speak-style-toggles']}>
            <label className={styles['speak-style-chip']}>
              <input
                type="checkbox"
                checked={style.funny}
                onChange={() => toggle('funny')}
              />
              Funny
            </label>
            <label className={styles['speak-style-chip']}>
              <input
                type="checkbox"
                checked={style.snarky}
                onChange={() => toggle('snarky')}
              />
              Snarky
            </label>
            <label className={styles['speak-style-chip']}>
              <input
                type="checkbox"
                checked={style.bored}
                onChange={() => toggle('bored')}
              />
              Bored
            </label>
            <label className={styles['speak-style-chip']}>
              <input
                type="checkbox"
                checked={style.dry}
                onChange={() => toggle('dry')}
              />
              Dry
            </label>
            <label className={styles['speak-style-chip']}>
              <input
                type="checkbox"
                checked={style.warm}
                onChange={() => toggle('warm')}
              />
              Warm
            </label>
          </div>
          <label className={styles['speak-style-label']} htmlFor="speak-style-custom">
            Extra instructions (optional)
          </label>
          <textarea
            id="speak-style-custom"
            className={styles['speak-style-textarea']}
            rows={3}
            maxLength={2000}
            placeholder="e.g. Drop in one film reference per reply when it fits."
            value={style.customPrompt}
            onChange={(e) => setStyle((s) => ({ ...s, customPrompt: e.target.value }))}
          />
          <div className={styles['speak-style-actions']}>
            <button type="button" className={styles['speak-style-btn']} onClick={save} disabled={saving}>
              {saving ? 'Saving\u2026' : 'Save'}
            </button>
            <button type="button" className={styles['speak-style-btnSecondary']} onClick={reset} disabled={saving}>
              Clear all
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default SpeakStylePanel;
