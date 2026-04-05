import React, { useEffect, useRef } from 'react';
import VoiceAvatar from './VoiceAvatar';
import styles from '../styles/listen.module.css';

interface SessionCardProps {
  context: string;
  voice: string;
  label: string;
  description: string;
  status: 'active' | 'idle';
  lastUsed: string;
  icon: string;
  color: string;
  isSpeaking?: boolean;
  waveform?: number[];
}

const timeAgo = (iso: string): string => {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  return `${Math.floor(ms / 3600000)}h ago`;
};

/**
 * SessionCard: Displays a voice session with avatar, status, description, and optional waveform.
 * Used in SessionSidebar to show active/idle voice contexts.
 */
const SessionCard: React.FC<SessionCardProps> = ({
  context,
  voice,
  label,
  description,
  status,
  lastUsed,
  icon,
  color,
  isSpeaking = false,
  waveform = [],
}) => {
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!cardRef.current) return;
    const anime = (window as any).anime;
    if (!anime) return;

    // Entrance animation
    anime({
      targets: cardRef.current,
      scale: [0.8, 1],
      opacity: [0, 1],
      duration: 400,
      easing: 'easeOutBack',
    });
  }, []);

  // Animate waveform bars if speaking
  useEffect(() => {
    if (!isSpeaking || waveform.length === 0) return;

    const bars = cardRef.current?.querySelectorAll(`.${styles['session-wave-bar']}`);
    if (!bars || bars.length === 0) return;

    const anime = (window as any).anime;
    if (!anime) return;

    const timeline = anime.timeline({ loop: true });
    waveform.forEach((amp, i) => {
      timeline.add(
        {
          targets: bars[i],
          scaleY: amp / 100,
          duration: 100,
          easing: 'linear',
        },
        i * 20
      );
    });

    return () => timeline.pause();
  }, [isSpeaking, waveform]);

  return (
    <div
      ref={cardRef}
      className={`${styles['session-card']} ${status === 'active' ? styles['session-card-active'] : ''} ${
        isSpeaking ? styles['session-card-speaking'] : ''
      }`}
      style={{ '--session-color': color } as React.CSSProperties}
    >
      <div className={styles['session-card-header']}>
        <VoiceAvatar
          icon={icon}
          name={label}
          size="small"
          color={color}
          isSpeaking={isSpeaking}
        />
        <div className={styles['session-card-title']}>
          <div className={styles['session-card-label']}>{label}</div>
          <div className={styles['session-card-context']}>
            {context} {status === 'active' ? '(active)' : '(idle)'}
          </div>
        </div>
      </div>

      <div className={styles['session-card-description']}>
        {description}
      </div>

      <div className={styles['session-card-meta']}>
        <span className={`${styles['session-card-status']} ${styles[`status-${status}`]}`}>
          {status === 'active' ? '●' : '○'} {status === 'active' ? 'Active' : 'Idle'}
        </span>
        <span className={styles['session-card-time']}>{timeAgo(lastUsed)}</span>
      </div>

      {isSpeaking && waveform.length > 0 && (
        <div className={styles['session-card-waveform']}>
          {waveform.map((amp, i) => (
            <div
              key={i}
              className={styles['session-wave-bar']}
              style={{
                height: `${amp}%`,
                minHeight: '2px',
                background: color,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default SessionCard;
