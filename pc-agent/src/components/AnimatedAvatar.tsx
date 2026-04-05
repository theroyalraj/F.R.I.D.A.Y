import React, { useEffect, useRef } from 'react';
import { OC_AVATAR_PX } from '../data/avatarTokens';
import { AvatarCache, getAvatarConfig, SPEAKING_ANIMATIONS } from '../data/voiceAvatars';
import styles from '../styles/listen.module.css';

function useSpeakingPhotoPulse(isSpeaking: boolean, imgRef: React.RefObject<HTMLImageElement | null>) {
  useEffect(() => {
    if (!isSpeaking || !imgRef.current) return;
    let phase = 0;
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      const open = SPEAKING_ANIMATIONS.lips[phase % SPEAKING_ANIMATIONS.lips.length]?.openness ?? 0;
      const s = 1 + open * 0.04;
      if (imgRef.current) imgRef.current.style.transform = `scale(${s})`;
      phase++;
      t = setTimeout(tick, 90);
    };
    tick();
    return () => {
      clearTimeout(t);
      if (imgRef.current) imgRef.current.style.transform = '';
    };
  }, [isSpeaking, imgRef]);
}

export interface AnimatedAvatarProps {
  voiceId: string;
  isSpeaking?: boolean;
  size?: 'small' | 'medium' | 'large' | 'hero' | 'zoom';
  showLabel?: boolean;
}

/**
 * Animated avatar component for voice speakers
 * Displays Disney or realistic style avatars with lip-sync and head movements
 */
const AnimatedAvatar: React.FC<AnimatedAvatarProps> = ({
  voiceId,
  isSpeaking = false,
  size = 'medium',
  showLabel = true,
}) => {
  const lipsRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const eyesRef = useRef<HTMLDivElement>(null);
  const photoRef = useRef<HTMLImageElement>(null);
  const animationRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const config = AvatarCache.getOrDefault(voiceId);
  const photoUrl = config.photoUrl?.trim();
  useSpeakingPhotoPulse(Boolean(photoUrl && isSpeaking), photoRef);

  const sizeMap = {
    small: OC_AVATAR_PX.animatedSmall,
    medium: OC_AVATAR_PX.animatedMedium,
    large: OC_AVATAR_PX.animatedLarge,
    hero: OC_AVATAR_PX.animatedHero,
    zoom: OC_AVATAR_PX.animatedZoom,
  };

  const size_px = sizeMap[size];
  const layoutSize: 'small' | 'medium' | 'large' =
    size === 'hero' || size === 'zoom' ? 'large' : size;

  // Lip sync animation (emoji avatars only)
  useEffect(() => {
    if (photoUrl || !isSpeaking || !lipsRef.current) return;

    let phase = 0;
    const animate = () => {
      const anim = SPEAKING_ANIMATIONS.lips[phase % SPEAKING_ANIMATIONS.lips.length];
      if (lipsRef.current) {
        lipsRef.current.style.scaleY = `${0.5 + anim.openness * 0.5}`;
      }
      phase++;
      animationRef.current = setTimeout(animate, anim.duration);
    };

    animate();
    return () => {
      if (animationRef.current) clearTimeout(animationRef.current);
    };
  }, [isSpeaking, photoUrl]);

  // Head movement animation
  useEffect(() => {
    if (photoUrl || !isSpeaking || !headRef.current) return;

    let phase = 0;
    const animate = () => {
      const anim = SPEAKING_ANIMATIONS.head[phase % SPEAKING_ANIMATIONS.head.length];
      if (headRef.current) {
        headRef.current.style.transform = `rotate(${anim.tilt}deg) translateY(${anim.bob}px)`;
      }
      phase++;
      animationRef.current = setTimeout(animate, anim.duration);
    };

    animate();
    return () => {
      if (animationRef.current) clearTimeout(animationRef.current);
    };
  }, [isSpeaking, photoUrl]);

  // Eye animation (blink)
  useEffect(() => {
    if (photoUrl || !isSpeaking || !eyesRef.current) return;

    let phase = 0;
    const animate = () => {
      const anim = SPEAKING_ANIMATIONS.eyes[phase % SPEAKING_ANIMATIONS.eyes.length];
      if (eyesRef.current) {
        eyesRef.current.style.opacity = `${1 - anim.blink}`;
      }
      phase++;
      animationRef.current = setTimeout(animate, anim.duration);
    };

    animate();
    return () => {
      if (animationRef.current) clearTimeout(animationRef.current);
    };
  }, [isSpeaking, photoUrl]);

  return (
    <div
      className={`${styles['avatar-container']} ${styles[`avatar-${layoutSize}`]}`}
      style={{
        '--primary-color': config.primaryColor,
        '--secondary-color': config.secondaryColor,
      } as React.CSSProperties}
    >
      <div
        className={`${styles.avatar} ${photoUrl ? styles['avatar-photo'] : styles[`avatar-${config.style}`]}`}
        style={{
          width: size_px,
          height: size_px,
          borderColor: config.primaryColor,
        }}
      >
        {photoUrl ? (
          <>
            <img
              ref={photoRef}
              className={styles['avatar-photo-img']}
              src={photoUrl}
              alt=""
              width={size_px}
              height={size_px}
              loading="lazy"
              decoding="async"
            />
            {isSpeaking ? (
              <div className={styles['avatar-pulse']} style={{ borderColor: config.primaryColor }} />
            ) : null}
          </>
        ) : (
          <>
            <div ref={headRef} className={styles['avatar-head']} style={{ transition: 'none' }}>
              <div className={styles['avatar-bg']} style={{ backgroundColor: config.secondaryColor }} />
              <div ref={eyesRef} className={styles['avatar-eyes']}>
                <div className={styles.eye} />
                <div className={styles.eye} />
              </div>
              <div className={styles['avatar-face']}>{config.emoji}</div>
              <div ref={lipsRef} className={styles['avatar-lips']} style={{ backgroundColor: config.primaryColor }} />
            </div>
            {isSpeaking && <div className={styles['avatar-pulse']} style={{ borderColor: config.primaryColor }} />}
          </>
        )}
      </div>

      {/* Label */}
      {showLabel && (
        <div className={styles['avatar-label']} style={{ color: config.primaryColor }}>
          {config.name}
        </div>
      )}
    </div>
  );
};

export default AnimatedAvatar;
