import React from 'react';
import styles from '../styles/siriOrb.module.css';

export interface VoiceSiriOverlayProps {
  /** Show full-screen centre stage (TTS / thinking stream). */
  open: boolean;
  theme: 'dark' | 'light';
  /** Snippet under the orb (e.g. first line being spoken). */
  caption?: string;
}

/**
 * Siri-style assistant orb for the Listen UI while the stack is in a "speaking" phase.
 * Aesthetic aligned with SmoothUI Siri Orb (layers, glow, expanding rings) — CSS-only, no Motion dep.
 * @see https://smoothui.dev/docs/components/siri-orb
 */
const VoiceSiriOverlay: React.FC<VoiceSiriOverlayProps> = ({ open, theme, caption }) => {
  if (!open) return null;

  return (
    <div
      className={`${styles.root} ${theme === 'light' ? styles.light : ''}`}
      aria-hidden={false}
      role="status"
      aria-live="polite"
    >
      <div className={styles.vignette} />
      <div className={styles.stage}>
        <div className={styles.orbShell}>
          <div className={styles.halo} />
          <div className={styles.ring} data-i="0" />
          <div className={styles.ring} data-i="1" />
          <div className={styles.ring} data-i="2" />
          <div className={styles.waveDisk} />
          <div className={styles.core}>
            <div className={styles.coreShine} />
          </div>
        </div>
        {caption ? (
          <p className={styles.caption}>{caption}</p>
        ) : (
          <p className={styles.captionMuted}>Speaking</p>
        )}
      </div>
    </div>
  );
};

export default VoiceSiriOverlay;
