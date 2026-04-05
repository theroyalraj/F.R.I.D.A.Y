import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import styles from '../styles/auth.module.css';

type Props = {
  onSignup: () => void;
  theme?: 'light' | 'dark';
};

const LoginPage: React.FC<Props> = ({ onSignup, theme = 'dark' }) => {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await login(email.trim(), password);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`${styles.authWrap} ${theme === 'light' ? styles.light : ''}`}>
      <div className={styles.card}>
        <h1 className={styles.title}>OpenClaw</h1>
        <p className={styles.sub}>Sign in to continue to Listen</p>
        {err ? <div className={styles.err}>{err}</div> : null}
        <form onSubmit={(e) => void submit(e)} autoComplete="on" method="post" action="#">
          <div className={styles.field}>
            <label htmlFor="login-email">Email</label>
            <input
              id="login-email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="username"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              placeholder="Enter your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <div className={styles.actions}>
            <button type="submit" className={styles.btn} disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </div>
        </form>
        <p className={styles.sub} style={{ marginTop: '1.25rem', marginBottom: 0 }}>
          No account?{' '}
          <button type="button" className={styles.linkBtn} onClick={onSignup}>
            Create one
          </button>
        </p>
      </div>

    </div>
  );
};

export default LoginPage;
