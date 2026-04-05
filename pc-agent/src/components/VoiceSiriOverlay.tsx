import React from 'react';
import {
  COMPANY_PERSONAS,
  PERSONA_ORB_PALETTES,
  personaIcon,
  type CompanyPersonaKey,
} from '../data/companyPersonas';
import styles from '../styles/siriOrb.module.css';

export interface VoiceSiriOverlayProps {
  /** Show full-screen centre stage (TTS / thinking stream). */
  open: boolean;
  theme: 'dark' | 'light';
  /** Snippet under the orb (e.g. first line being spoken). */
  caption?: string;
  /**
   * Which persona is currently speaking. Determines orb colour palette, icon, and badge text.
   * Null / undefined → fallback to Jarvis (default palette).
   */
  personaKey?: CompanyPersonaKey | 'custom' | null;
  /** Override display name (falls back to COMPANY_PERSONAS lookup). */
  personaName?: string;
  /** Override display title (falls back to COMPANY_PERSONAS lookup). */
  personaTitle?: string;
}

/**
 * Siri-style assistant orb for the Listen UI while the stack is in a "speaking" phase.
 * Each OpenClaw persona gets its own colour palette injected via CSS custom properties.
 * Aesthetic aligned with SmoothUI Siri Orb (layers, glow, expanding rings) — CSS-only.
 * @see https://smoothui.dev/docs/components/siri-orb
 */
const VoiceSiriOverlay: React.FC<VoiceSiriOverlayProps> = ({
  open,
  theme,
  caption,
  personaKey,
  personaName,
  personaTitle,
}) => {
  if (!open) return null;

  const key = personaKey ?? 'jarvis';
  const palette = key === 'custom' ? PERSONA_ORB_PALETTES.custom : (PERSONA_ORB_PALETTES[key] ?? PERSONA_ORB_PALETTES.jarvis);
  const icon = personaIcon(key);

  const staticPersona = key !== 'custom' ? COMPANY_PERSONAS[key] : null;
  const displayName = personaName ?? staticPersona?.name ?? 'Friday';
  const displayTitle = personaTitle ?? staticPersona?.title ?? '';

  const cssVars = {
    '--orb-primary': palette.primary,
    '--orb-secondary': palette.secondary,
    '--orb-complement': palette.complement,
  } as React.CSSProperties;

  return (
    <div
      className={`${styles.root} ${theme === 'light' ? styles.light : ''}`}
      aria-hidden={false}
      role="status"
      aria-live="polite"
      style={cssVars}
    >
      <div className={styles.vignette} />
      <div className={styles.stage}>
        {/* Persona badge */}
        <div className={styles.personaBadge}>
          <span className={styles.personaIcon}>{icon}</span>
          <span className={styles.personaName}>{displayName}</span>
          {displayTitle ? <span className={styles.personaTitle}>{displayTitle}</span> : null}
        </div>

        {/* Orb — Apple Siri–like full-sphere colour mass + soft rings (not a small inner pearl) */}
        <div className={styles.orbShell}>
          <div className={styles.halo} />
          <div className={styles.ring} data-i="0" />
          <div className={styles.ring} data-i="1" />
          <div className={styles.ring} data-i="2" />
          <div className={styles.orbBody}>
            <div className={styles.blobWrap} aria-hidden={true}>
              <div className={styles.siriBlob} data-b="0" />
              <div className={styles.siriBlob} data-b="1" />
              <div className={styles.siriBlob} data-b="2" />
              <div className={styles.siriBlob} data-b="3" />
            </div>
            <div className={styles.depthVignette} aria-hidden={true} />
            <div className={styles.surfaceShine} aria-hidden={true} />
            <div className={styles.rimGloss} aria-hidden={true} />
          </div>
        </div>

        {/* Caption / status */}
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
