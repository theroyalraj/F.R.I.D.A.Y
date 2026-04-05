import React from 'react';
import styles from '../styles/listen.module.css';

interface VoiceAvatarProps {
  icon: string;
  name: string;
  gender?: 'M' | 'F' | 'Neutral';
  color?: string;
  size?: 'small' | 'medium' | 'large';
  isSpeaking?: boolean;
  style?: React.CSSProperties;
}

/**
 * VoiceAvatar: Displays voice icon with optional metadata and speaking indicator.
 * Gender-based emojis: 👩‍💼 (F), 👨‍💼 (M), 🤖 (Neutral)
 */
const VoiceAvatar: React.FC<VoiceAvatarProps> = ({
  icon,
  name,
  gender = 'Neutral',
  color = '#8b5cf6',
  size = 'medium',
  isSpeaking = false,
  style,
}) => {
  const sizeClass = styles[`voice-avatar-${size}`] || styles['voice-avatar-medium'];

  return (
    <div
      className={`${styles['voice-avatar']} ${sizeClass} ${isSpeaking ? styles['voice-avatar-speaking'] : ''}`}
      style={{
        ...style,
        borderColor: color,
        boxShadow: isSpeaking ? `0 0 16px ${color}` : `0 0 8px rgba(0, 0, 0, 0.3)`,
      }}
      title={`${name} (${gender})`}
    >
      <div className={styles['voice-avatar-icon']} style={{ color }}>
        {icon}
      </div>
      {isSpeaking && <div className={styles['voice-avatar-pulse']} style={{ borderColor: color }} />}
    </div>
  );
};

export default VoiceAvatar;
