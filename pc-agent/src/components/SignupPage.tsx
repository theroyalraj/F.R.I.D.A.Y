import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import styles from '../styles/auth.module.css';

type Props = {
  onBack: () => void;
  theme?: 'light' | 'dark';
};

const SignupPage: React.FC<Props> = ({ onBack, theme = 'dark' }) => {
  const { signup } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await signup(email.trim(), password, name.trim());
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
            <label htmlFor="su-name">Your name</label>
            <input
              id="su-name"
              name="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              placeholder="Full name"
            />
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
