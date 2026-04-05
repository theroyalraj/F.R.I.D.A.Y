import React, { useState, useEffect } from 'react';
import {
  COMPANY_PERSONAS,
  SPEAKING_PERSONA_ORDER,
  type CompanyPersonaKey,
  type PersonaOverride,
  loadPersonaOverrides,
  savePersonaOverrides,
} from '../data/companyPersonas';
import styles from '../styles/listen.module.css';

type Props = {
  open: boolean;
  onClose: () => void;
  theme: 'light' | 'dark';
  onSaved: () => void;
};

export const PersonaRosterModal: React.FC<Props> = ({ open, onClose, theme, onSaved }) => {
  const [draft, setDraft] = useState<Record<string, PersonaOverride>>({});

  useEffect(() => {
    if (open) setDraft(loadPersonaOverrides());
  }, [open]);

  if (!open) return null;

  const patch = (key: CompanyPersonaKey, field: 'title' | 'personality', value: string) => {
    setDraft((d) => ({
      ...d,
      [key]: { ...d[key], [field]: value },
    }));
  };

  const save = () => {
    savePersonaOverrides(draft);
    onSaved();
    onClose();
  };

  const resetKey = (key: CompanyPersonaKey) => {
    setDraft((d) => {
      const next = { ...d };
      delete next[key];
      savePersonaOverrides(next);
      return next;
    });
    onSaved();
  };

  return (
    <div
      className={`${styles['persona-modal-backdrop']}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="persona-roster-title"
      onClick={onClose}
    >
      <div
        className={`${styles['persona-modal']} ${theme === 'light' ? styles['persona-modal-light'] : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles['persona-modal-head']}>
          <h2 id="persona-roster-title" className={styles['persona-modal-title']}>
            Team roster
          </h2>
          <button type="button" className={styles['persona-modal-close']} onClick={onClose} aria-label="Close">
            {'\u2715'}
          </button>
        </div>
        <p className={styles['persona-modal-hint']}>
          Edit designation (title) and description (personality) for this browser only. Server-wide names, voices, and
          bios live in Postgres: use GET/PUT <code className={styles['persona-code']}>/settings/personas</code> (auth)
          — merged roster syncs to Redis for Python daemons.
        </p>
        <div className={styles['persona-modal-scroll']}>
          {SPEAKING_PERSONA_ORDER.map((key) => {
            const base = COMPANY_PERSONAS[key];
            const o = draft[key] || {};
            const titleVal = o.title !== undefined ? o.title : base.title;
            const persVal = o.personality !== undefined ? o.personality : base.personality;
            return (
              <div key={key} className={styles['persona-modal-card']}>
                <div className={styles['persona-modal-card-top']}>
                  <span className={styles['persona-modal-name']}>{base.name}</span>
                  <span className={styles['persona-modal-voice']}>{base.voice}</span>
                  <button type="button" className={styles['persona-modal-reset']} onClick={() => resetKey(key)}>
                    Reset
                  </button>
                </div>
                <label className={styles['persona-modal-label']}>Designation</label>
                <input
                  className={styles['persona-modal-input']}
                  value={titleVal}
                  onChange={(e) => patch(key, 'title', e.target.value)}
                  placeholder={base.title}
                />
                <label className={styles['persona-modal-label']}>Description</label>
                <textarea
                  className={styles['persona-modal-textarea']}
                  value={persVal}
                  onChange={(e) => patch(key, 'personality', e.target.value)}
                  rows={2}
                  placeholder={base.personality}
                />
              </div>
            );
          })}
        </div>
        <div className={styles['persona-modal-actions']}>
          <button type="button" className={styles['persona-modal-btn-secondary']} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={styles['persona-modal-btn-primary']} onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
};
