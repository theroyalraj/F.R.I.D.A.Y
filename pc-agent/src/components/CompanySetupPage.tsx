import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import styles from '../styles/auth.module.css';

type Props = {
  theme?: 'light' | 'dark';
};

const CompanySetupPage: React.FC<Props> = ({ theme = 'dark' }) => {
  const { company, updateCompany, refreshMe } = useAuth();
  const [step, setStep] = useState(1);
  const [name, setName] = useState(company?.name || '');
  const [description, setDescription] = useState(company?.description || '');
  const [mission, setMission] = useState(company?.mission || '');
  const [vision, setVision] = useState(company?.vision || '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const saveAll = async () => {
    setErr(null);
    setBusy(true);
    try {
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

  return (
    <div className={`${styles.authWrap} ${theme === 'light' ? styles.light : ''}`}>
      <div className={`${styles.card} ${styles.cardWide}`}>
        <h1 className={styles.title}>Company profile</h1>
        <p className={styles.steps}>Step {step} of 3 — this shapes voice replies for everyone in your organization</p>
        {err ? <div className={styles.err}>{err}</div> : null}

        {step === 1 && (
          <>
            <div className={styles.field}>
              <label htmlFor="co-name">Company name</label>
              <input id="co-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className={styles.field}>
              <label htmlFor="co-desc">Description</label>
              <textarea id="co-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div className={styles.actions}>
              <button type="button" className={styles.btn} onClick={() => setStep(2)} disabled={busy}>
                Next
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div className={styles.field}>
              <label htmlFor="co-mission">Mission</label>
              <textarea id="co-mission" value={mission} onChange={(e) => setMission(e.target.value)} />
            </div>
            <div className={styles.actions}>
              <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setStep(1)} disabled={busy}>
                Back
              </button>
              <button type="button" className={styles.btn} onClick={() => setStep(3)} disabled={busy}>
                Next
              </button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <div className={styles.field}>
              <label htmlFor="co-vision">Vision</label>
              <textarea id="co-vision" value={vision} onChange={(e) => setVision(e.target.value)} />
            </div>
            <div className={styles.actions}>
              <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setStep(2)} disabled={busy}>
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
