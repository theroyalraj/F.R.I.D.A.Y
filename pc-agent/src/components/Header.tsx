import React, { useMemo } from 'react';
import { useVoiceApp } from '../contexts/VoiceAppContext';
import { useUptime } from '../hooks/useUptime';
import styles from '../styles/listen.module.css';

const Header: React.FC = () => {
  const {
    connectionStatus,
    theme,
    setTheme,
    edgeVoices,
    currentVoice,
    setCurrentVoice,
    exchanges,
    setUptime,
  } = useVoiceApp();

  const [uptime] = useUptime(setUptime);

  const isConnected = connectionStatus !== 'offline';
  const connStatusLabel = connectionStatus.toUpperCase();

  // Group voices by locale
  const groupedVoices = useMemo(() => {
    const groups: { [locale: string]: typeof edgeVoices } = {};
    edgeVoices.forEach(v => {
      const locale = v.voice.split('-').slice(0, 2).join('-');
      if (!groups[locale]) groups[locale] = [];
      groups[locale].push(v);
    });
    return groups;
  }, [edgeVoices]);

  const handleThemeToggle = () => {
    setTheme(theme === 'light' ? 'dark' : 'light');
  };

  const handleVoiceChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newVoice = e.target.value;
    setCurrentVoice(newVoice);

    // Post to server
    fetch('/voice/set-voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice: newVoice }),
    }).catch(err => console.error('Failed to set voice:', err));
  };

  return (
    <header className={styles.header}>
      <div className={styles.brand}>
        <span className={styles['brand-name']}>F · R · I · D · A · Y</span>
        <span className={styles['brand-sub']}>Voice Daemon Monitor &nbsp;//&nbsp; OpenClaw</span>
      </div>

      <div className={styles['header-right']}>
        {/* Connection status */}
        <div className={styles['conn-badge']} role="status" aria-live="polite">
          <div className={`${styles['conn-dot']} ${isConnected ? styles.connected : ''}`} aria-hidden="true"></div>
          <span id="connLabel">{connStatusLabel}</span>
        </div>

        {/* Uptime */}
        <div className={styles['uptime-label']} aria-label="Uptime">
          UP <span>{uptime}</span>
        </div>

        {/* Voice picker */}
        {edgeVoices.length > 0 && (
          <div className={styles['voice-picker-wrap']} aria-label="Server voice">
            <span className={styles['voice-picker-label']}>TTS</span>
            <select
              className={styles['hud-select']}
              value={currentVoice}
              onChange={handleVoiceChange}
              aria-label="Select server TTS voice"
            >
              {Object.entries(groupedVoices).map(([locale, voices]) => (
                <optgroup key={locale} label={locale}>
                  {voices.map(v => (
                    <option key={v.voice} value={v.voice}>
                      {v.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
        )}

        {/* Theme toggle */}
        <button
          className={styles['theme-btn']}
          onClick={handleThemeToggle}
          aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
          title={`Theme: ${theme}`}
        >
          {theme === 'light' ? '🌙' : '☀️'}
        </button>

        {/* Exchange counter */}
        <div className={styles['exchange-counter']} aria-label="Exchanges">
          <span className={styles['exchange-count']}>{exchanges}</span>
          <span className={styles['exchange-label']}>EXCHANGES</span>
        </div>
      </div>
    </header>
  );
};

export default Header;
