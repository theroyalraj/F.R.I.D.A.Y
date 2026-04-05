import React from 'react';
import { PERSONA_ORB_PALETTES, type CompanyPersonaKey } from '../data/companyPersonas';
import styles from '../styles/miniOrb.module.css';

export type MiniNotifyOrbProps = {
  visible: boolean;
  icon: string;
  caption: string;
  personaKey: CompanyPersonaKey;
  pulse?: boolean;
  theme: 'light' | 'dark';
  onDismiss: () => void;
};

const MiniNotifyOrb: React.FC<MiniNotifyOrbProps> = ({
  visible,
  icon,
  caption,
  personaKey,
  pulse = true,
  theme,
  onDismiss,
}) => {
  if (!visible) return null;
  const pal = PERSONA_ORB_PALETTES[personaKey] ?? PERSONA_ORB_PALETTES.jarvis;
  return (
    <button
      type="button"
      className={
        [
          styles.miniOrb,
          pulse ? styles.miniOrbPulse : '',
          theme === 'light' ? styles.miniOrbLight : '',
        ]
          .filter(Boolean)
          .join(' ')
      }
      style={
        {
          '--mini-orb-glow': pal.primary,
        } as React.CSSProperties
      }
      onClick={onDismiss}
      aria-label="Dismiss notification"
    >
      <span className={styles.miniOrbIcon} aria-hidden>
        {icon}
      </span>
      <span className={styles.miniOrbCaption}>{caption}</span>
    </button>
  );
};

export default MiniNotifyOrb;
