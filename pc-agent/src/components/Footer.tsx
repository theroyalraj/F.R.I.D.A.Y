import React from 'react';
import styles from '../styles/listen.module.css';

const Footer: React.FC = () => {
  return (
    <footer className={styles.footer}>
      <div className={styles['footer-agent']} id="footerAgent">
        {typeof window !== 'undefined' ? window.location.host : 'localhost:3847'}
      </div>
      <div className={styles['footer-divider']}>—</div>
      <div className={styles['footer-tts']}>
        <span className={styles['footer-label']}>TTS</span>
        <span className={styles['footer-provider']}>Edge (Microsoft Neural)</span>
      </div>
    </footer>
  );
};

export default Footer;
