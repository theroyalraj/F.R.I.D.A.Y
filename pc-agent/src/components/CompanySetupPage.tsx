import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { COMPANY_PERSONAS } from '../data/companyPersonas';
import {
  MISSION_TEMPLATES,
  OPENROUTER_SETUP_CHOICES,
  ORG_STARTERS,
  STORAGE_OPENROUTER_PREFERENCE,
  STORAGE_SUBAGENT_PREFERENCE,
  SUBAGENT_SETUP_KEYS,
  type SubagentSetupKey,
  VISION_TEMPLATES,
} from '../data/onboardingChoices';
import styles from '../styles/auth.module.css';

const TOTAL_STEPS = 5;

type Props = {
  theme?: 'light' | 'dark';
};

function readStoredSubagent(): SubagentSetupKey {
  try {
    const raw = localStorage.getItem(STORAGE_SUBAGENT_PREFERENCE);
    if (raw && (SUBAGENT_SETUP_KEYS as readonly string[]).includes(raw)) {
      return raw as SubagentSetupKey;
    }
  } catch {
    /* ignore */
  }
  return 'dexter';
}

function readStoredOpenRouterId(): string {
  try {
    const raw = localStorage.getItem(STORAGE_OPENROUTER_PREFERENCE);
    const c = OPENROUTER_SETUP_CHOICES.find((x) => x.id === raw);
    if (c && !c.disabled) return c.id;
  } catch {
    /* ignore */
  }
  return 'server_default';
}

const CompanySetupPage: React.FC<Props> = ({ theme = 'dark' }) => {
  const { company, updateCompany, refreshMe } = useAuth();
  const [step, setStep] = useState(1);
  const [starterId, setStarterId] = useState<string>('custom');
  const [name, setName] = useState(company?.name || '');
  const [description, setDescription] = useState(company?.description || '');
  const [missionTemplateId, setMissionTemplateId] = useState<string>('custom_m');
  const [mission, setMission] = useState(company?.mission || '');
  const [visionTemplateId, setVisionTemplateId] = useState<string>('custom_v');
  const [vision, setVision] = useState(company?.vision || '');
  const [subagentKey, setSubagentKey] = useState<SubagentSetupKey>('dexter');
  const [openRouterChoiceId, setOpenRouterChoiceId] = useState('server_default');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSubagentKey(readStoredSubagent());
    setOpenRouterChoiceId(readStoredOpenRouterId());
  }, []);

  const applyStarter = (id: string) => {
    setStarterId(id);
    const s = ORG_STARTERS.find((o) => o.id === id);
    if (!s) return;
    if (s.id === 'custom') return;
    setDescription(s.description);
    setName(s.name);
  };

  const applyMissionTemplate = (id: string) => {
    setMissionTemplateId(id);
    const t = MISSION_TEMPLATES.find((x) => x.id === id);
    if (!t || t.id === 'custom_m') return;
    setMission(t.text);
  };

  const applyVisionTemplate = (id: string) => {
    setVisionTemplateId(id);
    const t = VISION_TEMPLATES.find((x) => x.id === id);
    if (!t || t.id === 'custom_v') return;
    setVision(t.text);
  };

  const step1Valid = name.trim().length > 0;
  const step2Valid = mission.trim().length > 0;
  const step3Valid = vision.trim().length > 0;

  const subagentLabel = useMemo(() => {
    const p = COMPANY_PERSONAS[subagentKey];
    return p ? `${p.name} — ${p.title}` : subagentKey;
  }, [subagentKey]);

  const persistLocalPrefs = () => {
    try {
      localStorage.setItem(STORAGE_SUBAGENT_PREFERENCE, subagentKey);
      localStorage.setItem(STORAGE_OPENROUTER_PREFERENCE, openRouterChoiceId);
    } catch {
      /* ignore */
    }
  };

  const saveAll = async () => {
    setErr(null);
    setBusy(true);
    try {
      persistLocalPrefs();
      await updateCompany({
        name: name.trim(),
        description: description.trim(),
        mission: mission.trim(),
        vision: vision.trim(),
      });
      await refreshMe();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const onSubagentChange = (key: SubagentSetupKey) => {
    setSubagentKey(key);
    try {
      localStorage.setItem(STORAGE_SUBAGENT_PREFERENCE, key);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className={`${styles.authWrap} ${theme === 'light' ? styles.light : ''}`}>
      <div className={`${styles.card} ${styles.cardWide}`}>
        <h1 className={styles.title}>Company profile</h1>
        <p className={styles.steps}>
          Step {step} of {TOTAL_STEPS} — this shapes voice replies for everyone in your organization. Pick presets below;
          you can still edit every field.
        </p>
        {err ? <div className={styles.err}>{err}</div> : null}

        {step === 1 && (
          <>
            <div className={styles.field}>
              <label htmlFor="co-starter">What kind of workspace is this?</label>
              <select id="co-starter" value={starterId} onChange={(e) => applyStarter(e.target.value)}>
                {ORG_STARTERS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
              <span className={styles.hint}>
                Choosing a preset fills the description (and name for personal). Custom leaves you in full control.
              </span>
            </div>
            <div className={styles.field}>
              <label htmlFor="co-name">Company or team name</label>
              <input id="co-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Labs" />
            </div>
            <div className={styles.field}>
              <label htmlFor="co-desc">Short description</label>
              <textarea
                id="co-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                placeholder="What you do and who you serve"
              />
            </div>
            <div className={styles.actions}>
              <button type="button" className={styles.btn} onClick={() => setStep(2)} disabled={busy || !step1Valid}>
                Next
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div className={styles.field}>
              <label htmlFor="co-mission-preset">Mission — start from a template</label>
              <select
                id="co-mission-preset"
                value={missionTemplateId}
                onChange={(e) => applyMissionTemplate(e.target.value)}
              >
                {MISSION_TEMPLATES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <label htmlFor="co-mission">Mission (editable)</label>
              <textarea id="co-mission" value={mission} onChange={(e) => setMission(e.target.value)} rows={4} />
            </div>
            <div className={styles.actions}>
              <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setStep(1)} disabled={busy}>
                Back
              </button>
              <button type="button" className={styles.btn} onClick={() => setStep(3)} disabled={busy || !step2Valid}>
                Next
              </button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <div className={styles.field}>
              <label htmlFor="co-vision-preset">Vision — start from a template</label>
              <select
                id="co-vision-preset"
                value={visionTemplateId}
                onChange={(e) => applyVisionTemplate(e.target.value)}
              >
                {VISION_TEMPLATES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <label htmlFor="co-vision">Vision (editable)</label>
              <textarea id="co-vision" value={vision} onChange={(e) => setVision(e.target.value)} rows={4} />
            </div>
            <div className={styles.actions}>
              <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setStep(2)} disabled={busy}>
                Back
              </button>
              <button type="button" className={styles.btn} onClick={() => setStep(4)} disabled={busy || !step3Valid}>
                Next
              </button>
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <div className={styles.field}>
              <label htmlFor="co-subagent">Default Task subagent persona</label>
              <select
                id="co-subagent"
                value={subagentKey}
                onChange={(e) => onSubagentChange(e.target.value as SubagentSetupKey)}
              >
                {SUBAGENT_SETUP_KEYS.map((key) => {
                  const p = COMPANY_PERSONAS[key];
                  const label = p ? `${p.name} — ${p.title}` : key;
                  return (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  );
                })}
              </select>
              <span className={styles.hint}>
                Stored in this browser as your preferred subagent for Cursor Task-style runs. Main chat voice stays Jarvis.
                Currently selected: {subagentLabel}.
              </span>
            </div>
            <div className={styles.actions}>
              <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setStep(3)} disabled={busy}>
                Back
              </button>
              <button type="button" className={styles.btn} onClick={() => setStep(5)} disabled={busy}>
                Next
              </button>
            </div>
          </>
        )}

        {step === 5 && (
          <>
            <div className={styles.field}>
              <label htmlFor="co-openrouter">OpenRouter / task model preference</label>
              <select
                id="co-openrouter"
                value={openRouterChoiceId}
                onChange={(e) => setOpenRouterChoiceId(e.target.value)}
              >
                {OPENROUTER_SETUP_CHOICES.map((c) => (
                  <option key={c.id} value={c.id} disabled={Boolean(c.disabled)}>
                    {c.disabled ? `${c.label} (coming soon)` : c.label}
                  </option>
                ))}
              </select>
              <span className={styles.hint}>
                {
                  OPENROUTER_SETUP_CHOICES.find((c) => c.id === openRouterChoiceId)?.detail ??
                  'Choice is saved locally for a future release when the agent reads browser preferences.'
                }
              </span>
            </div>
            <div className={styles.actions}>
              <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setStep(4)} disabled={busy}>
                Back
              </button>
              <button type="button" className={styles.btn} onClick={() => void saveAll()} disabled={busy}>
                {busy ? 'Saving…' : 'Save and continue'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default CompanySetupPage;
