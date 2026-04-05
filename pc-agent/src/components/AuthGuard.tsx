import React, { useState, useEffect } from 'react';
import { useAuth, isCompanyProfileEmpty } from '../contexts/AuthContext';
import { useVoiceApp } from '../contexts/VoiceAppContext';
import LoginPage from './LoginPage';
import SignupPage from './SignupPage';
import CompanySetupPage from './CompanySetupPage';
import styles from '../styles/auth.module.css';

type Props = {
  children: React.ReactNode;
};

const AuthGuard: React.FC<Props> = ({ children }) => {
  const { token, loading, role, company, isAdmin } = useAuth();
  const { theme } = useVoiceApp();
  const [authScreen, setAuthScreen] = useState<'login' | 'signup'>('login');

  // Auto-login for dev (env var or localStorage flag)
  useEffect(() => {
    if (!token && !loading && typeof window !== 'undefined') {
      const devToken = localStorage.getItem('friday.devAutoLogin');
      const isDevEnv = process.env.NODE_ENV === 'development' || window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost';
      if (isDevEnv && devToken) {
        localStorage.setItem('openclaw.jwt', devToken);
        window.location.reload();
      }
    }
  }, [token, loading]);

  if (loading) {
    return (
      <div className={`${styles.loading} ${theme === 'light' ? styles.light : ''}`}>
        Loading…
      </div>
    );
  }

  if (!token) {
    if (authScreen === 'signup') {
      return <SignupPage onBack={() => setAuthScreen('login')} theme={theme} />;
    }
    return <LoginPage onSignup={() => setAuthScreen('signup')} theme={theme} />;
  }

  if (isAdmin && isCompanyProfileEmpty(company)) {
    return <CompanySetupPage theme={theme} />;
  }

  return <>{children}</>;
};

export default AuthGuard;
