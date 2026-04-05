import React, { useMemo, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import styles from '../styles/auth.module.css';

type Props = {
  onBack: () => void;
  theme?: 'light' | 'dark';
};

const SALUTATIONS = [
  { value: '', label: 'No title' },
  { value: 'Mr.', label: 'Mr.' },
  { value: 'Ms.', label: 'Ms.' },
  { value: 'Mx.', label: 'Mx.' },
  { value: 'Dr.', label: 'Dr.' },
  { value: 'Prof.', label: 'Prof.' },
] as const;

const SignupPage: React.FC<Props> = ({ onBack, theme = 'dark' }) => {
  const { signup } = useAuth();
  const [salutation, setSalutation] = useState('');
  const [givenName, setGivenName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const composedName = useMemo(() => {
    const g = givenName.trim();
    if (!g) return '';
    const s = salutation.trim();
    return s ? `${s} ${g}` : g;
  }, [salutation, givenName]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!composedName) {
      setErr('Please enter your name (you can pick a title from the dropdown first).');
      return;
    }
    setBusy(true);
    try {
      await signup(email.trim(), password, composedName);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Signup failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`${styles.authWrap} ${theme === 'light' ? styles.light : ''}`}>
      <div className={styles.card}>
        <h1 className={styles.title}>Create account</h1>
        <p className={styles.sub}>
          Corporate email domains share one organization; the first user is admin. Consumer email gets a personal org.
        </p>
        {err ? <div className={styles.err}>{err}</div> : null}
        <form onSubmit={(e) => void submit(e)} autoComplete="on" method="post" action="#">
          <div className={styles.field}>
            <label htmlFor="su-salutation">How should we address you? (title)</label>
            <select
              id="su-salutation"
              name="honorific-prefix"
              value={salutation}
              onChange={(e) => setSalutation(e.target.value)}
              autoComplete="honorific-prefix"
            >
              {SALUTATIONS.map((o) => (
                <option key={o.value || 'none'} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor="su-given">Your name</label>
            <input
              id="su-given"
              name="given-name"
              value={givenName}
              onChange={(e) => setGivenName(e.target.value)}
              autoComplete="given-name"
              placeholder="Given name or full name"
              required
            />
            {composedName ? (
              <span className={styles.hint} aria-live="polite">
                Saved as: {composedName}
              </span>
            ) : null}
          </div>
          <div className={styles.field}>
            <label htmlFor="su-email">Email</label>
            <input
              id="su-email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="su-password">Password (8+ characters)</label>
            <input
              id="su-password"
              name="password"
              type="password"
              autoComplete="new-password"
              placeholder="At least 8 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
            />
          </div>
          <div className={styles.actions}>
            <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={onBack} disabled={busy}>
              Back
            </button>
            <button type="submit" className={styles.btn} disabled={busy}>
              {busy ? 'Creating…' : 'Sign up'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default SignupPage;
