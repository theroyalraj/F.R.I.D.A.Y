import React, { useRef, useEffect } from 'react';
import { useVoiceApp } from '../contexts/VoiceAppContext';
import OrbRings from './OrbRings';
import Waveform from './Waveform';
import styles from '../styles/listen.module.css';

const AnimatedOrb: React.FC<{
  onOrbClick: () => void;
}> = ({ onOrbClick }) => {
  const { connectionStatus, listenMuted } = useVoiceApp();
  const orbRef = useRef<HTMLDivElement>(null);

  const stateConfig = {
    offline: {
      icon: '☆',
      glowColor: 'var(--cyan)',
      breathing: false,
    },
    listening: {
      icon: '🎙️',
      glowColor: 'var(--cyan)',
      breathing: true,
    },
    processing: {
      icon: '⚡',
      glowColor: 'var(--amber)',
      breathing: false,
    },
    speaking: {
      icon: '🔊',
      glowColor: 'var(--green)',
      breathing: true,
    },
  };

  const config = stateConfig[connectionStatus];

  // Keyboard accessibility
  useEffect(() => {
    if (!orbRef.current) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        onOrbClick();
      }
    };

    orbRef.current.addEventListener('keydown', handleKeyDown);
    return () => orbRef.current?.removeEventListener('keydown', handleKeyDown);
  }, [onOrbClick]);

  return (
    <div className={styles['orb-container']}>
      <div
        ref={orbRef}
        className={`${styles.orb} ${listenMuted ? styles.muted : ''} ${styles[`state-${connectionStatus}`]}`}
        id="orbBtn"
        role="button"
        tabIndex={0}
        aria-label={listenMuted ? 'Click to resume listening' : 'Click to stop listening'}
        title={listenMuted ? 'Click to resume listening' : 'Click to stop listening'}
        onClick={onOrbClick}
      >
        <OrbRings connectionStatus={connectionStatus} />

        <div className={styles['orb-core']}>
          <div className={styles['orb-glow']} style={{ backgroundColor: config.glowColor }}></div>

          {!listenMuted ? (
            <div className={styles['orb-icon']} id="orbIcon">
              {config.icon}
            </div>
          ) : (
            <div className={styles['orb-muted-icon']}>⊘</div>
          )}

          <div className={styles['orb-stop-hint']} id="orbStopHint">
            {listenMuted ? '▶ RESUME' : '■ STOP'}
          </div>
        </div>

        {/* Waveform (appears when listening) */}
        {connectionStatus === 'listening' && <Waveform />}
      </div>
    </div>
  );
};

export default AnimatedOrb;
