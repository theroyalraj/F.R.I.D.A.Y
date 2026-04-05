import React, { useEffect } from 'react';
import { useVoiceApp } from '../contexts/VoiceAppContext';
import { useSSEStream } from '../hooks/useSSEStream';
import Header from './Header';
import OrbPanel from './OrbPanel';
import FeedPanel from './FeedPanel';
import Footer from './Footer';
import ToastContainer from './Toast';
import styles from '../styles/listen.module.css';

const FridayListenApp: React.FC = () => {
  const { postEvent, setEdgeVoices, theme, connectionStatus } = useVoiceApp();

  // Fetch available voices on mount
  useEffect(() => {
    const fetchVoices = async () => {
      try {
        const res = await fetch('/voice/voices');
        const data = await res.json();
        if (data.voices) {
          setEdgeVoices(data.voices);
        }
      } catch (err) {
        console.error('Failed to fetch voices:', err);
      }
    };

    fetchVoices();
  }, [setEdgeVoices]);

  // Subscribe to SSE stream
  useSSEStream((event) => {
    if (event.type === 'sse_disconnected') {
      postEvent('daemon_disconnect');
    } else if (event.type === 'sse_connected') {
      postEvent('daemon_start', 'Voice daemon online.');
    } else {
      postEvent(event.type, event.text || '');
    }
  });

  return (
    <div className={`${styles.app} ${theme === 'dark' ? styles.dark : styles.light}`}>
      {/* Background layers */}
      <div className={styles['hex-bg']} aria-hidden="true"></div>
      <div className={styles.vignette} aria-hidden="true"></div>
      <div className={styles.scanlines} aria-hidden="true"></div>

      {/* HUD corner brackets */}
      <div className={`${styles.corner} ${styles['corner--tl']}`} aria-hidden="true"></div>
      <div className={`${styles.corner} ${styles['corner--tr']}`} aria-hidden="true"></div>
      <div className={`${styles.corner} ${styles['corner--bl']}`} aria-hidden="true"></div>
      <div className={`${styles.corner} ${styles['corner--br']}`} aria-hidden="true"></div>

      {/* Main layout */}
      <div className={styles.layout} role="main">
        <Header />

        <div className={styles['main-content']}>
          <OrbPanel />
          <FeedPanel />
        </div>

        <Footer />
      </div>

      {/* Toast notifications */}
      <ToastContainer />
    </div>
  );
};

export default FridayListenApp;
