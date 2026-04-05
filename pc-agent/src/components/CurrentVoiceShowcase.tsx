import React, { useState } from 'react';
import VoiceAvatar from './VoiceAvatar';
import styles from '../styles/listen.module.css';

interface CurrentVoiceShowcaseProps {
  icon: string;
  name: string;
  locale: string;
  gender?: 'M' | 'F' | 'Neutral';
  description?: string;
  color?: string;
  rate?: number;
  onRateChange?: (rate: number) => void;
  isActive?: boolean;
}

/**
 * CurrentVoiceShowcase: Featured voice display panel.
 * Shows avatar, name, locale, gender, description, and optional rate slider.
 */
const CurrentVoiceShowcase: React.FC<CurrentVoiceShowcaseProps> = ({
  icon,
  name,
  locale,
  gender = 'Neutral',
  description = '',
  color = '#8b5cf6',
  rate = 100,
  onRateChange,
  isActive = true,
}) => {
  const [localRate, setLocalRate] = useState(rate);

  const handleRateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newRate = parseInt(e.target.value, 10);
    setLocalRate(newRate);
    onRateChange?.(newRate);
  };

  const genderLabel = gender === 'M' ? 'Male' : gender === 'F' ? 'Female' : 'Neutral';
  const localeEmoji = locale.includes('US') ? '🇺🇸' : locale.includes('GB') ? '🇬🇧' : locale.includes('AU') ? '🇦🇺' : locale.includes('IN') ? '🇮🇳' : locale.includes('CA') ? '🇨🇦' : '🌐';

  return (
    <div className={`${styles['voice-showcase']} ${isActive ? styles['voice-showcase-active'] : ''}`}>
      <div className={styles['voice-showcase-header']}>
        CURRENT VOICE
      </div>

      <div className={styles['voice-showcase-content']}>
        <div className={styles['voice-showcase-avatar']}>
          <VoiceAvatar
            icon={icon}
            name={name}
            gender={gender}
            color={color}
            size="large"
          />
        </div>

        <div className={styles['voice-showcase-name']}>
          {name}
        </div>

        <div className={styles['voice-showcase-meta']}>
          <span className={styles['voice-showcase-locale']}>
            {locale} {localeEmoji}
          </span>
          <span className={styles['voice-showcase-gender']}>
            {genderLabel}
          </span>
        </div>

        {description && (
          <div className={styles['voice-showcase-description']}>
            {description}
          </div>
        )}

        {onRateChange && (
          <div className={styles['voice-showcase-rate']}>
            <label htmlFor="voice-rate-slider" className={styles['voice-showcase-rate-label']}>
              Speech Rate
            </label>
            <div className={styles['voice-showcase-rate-container']}>
              <span className={styles['voice-showcase-rate-min']}>80%</span>
              <input
                id="voice-rate-slider"
                type="range"
                min="80"
                max="150"
                value={localRate}
                onChange={handleRateChange}
                className={styles['voice-showcase-rate-slider']}
                style={{
                  background: `linear-gradient(to right, ${color}, ${color} ${((localRate - 80) / 70) * 100}%, rgba(255, 255, 255, 0.1) ${((localRate - 80) / 70) * 100}%, rgba(255, 255, 255, 0.1))`,
                }}
              />
              <span className={styles['voice-showcase-rate-max']}>150%</span>
            </div>
            <div className={styles['voice-showcase-rate-display']}>
              {localRate}%
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default CurrentVoiceShowcase;
