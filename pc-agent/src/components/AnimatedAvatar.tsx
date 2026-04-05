import React, { useEffect, useRef, useState } from 'react';
import { AvatarCache, getAvatarConfig, SPEAKING_ANIMATIONS } from '../data/voiceAvatars';
import styles from '../styles/listen.module.css';

export interface AnimatedAvatarProps {
  voiceId: string;
  isSpeaking?: boolean;
  size?: 'small' | 'medium' | 'large';
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
  const avatarRef = useRef<HTMLDivElement>(null);
  const lipsRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const eyesRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<number | null>(null);
  const [animationPhase, setAnimationPhase] = useState(0);

  const config = AvatarCache.getOrDefault(voiceId);

  const sizeMap = {
    small: 48,
    medium: 72,
    large: 120,
  };

  const size_px = sizeMap[size];

  // Lip sync animation
  useEffect(() => {
    if (!isSpeaking || !lipsRef.current) return;

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
  }, [isSpeaking]);

  // Head movement animation
  useEffect(() => {
    if (!isSpeaking || !headRef.current) return;

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
  }, [isSpeaking]);

  // Eye animation (blink)
  useEffect(() => {
    if (!isSpeaking || !eyesRef.current) return;

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
  }, [isSpeaking]);

  return (
    <div
      className={`${styles['avatar-container']} ${styles[`avatar-${size}`]}`}
      style={{
        '--primary-color': config.primaryColor,
        '--secondary-color': config.secondaryColor,
      } as React.CSSProperties}
    >
      <div
        ref={avatarRef}
        className={`${styles.avatar} ${styles[`avatar-${config.style}`]}`}
        style={{
          width: size_px,
          height: size_px,
          borderColor: config.primaryColor,
        }}
      >
        {/* Head container */}
        <div ref={headRef} className={styles['avatar-head']} style={{ transition: 'none' }}>
          {/* Background */}
          <div className={styles['avatar-bg']} style={{ backgroundColor: config.secondaryColor }} />

          {/* Eyes */}
          <div ref={eyesRef} className={styles['avatar-eyes']}>
            <div className={styles.eye} />
            <div className={styles.eye} />
          </div>

          {/* Emoji/Face */}
          <div className={styles['avatar-face']}>{config.emoji}</div>

          {/* Mouth/Lips */}
          <div ref={lipsRef} className={styles['avatar-lips']} style={{ backgroundColor: config.primaryColor }} />
        </div>

        {/* Speaking indicator pulse */}
        {isSpeaking && <div className={styles['avatar-pulse']} style={{ borderColor: config.primaryColor }} />}
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
