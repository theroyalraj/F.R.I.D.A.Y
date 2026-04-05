import React, { useEffect, useRef } from 'react';
import styles from '../styles/listen.module.css';

interface LaunchOverlayProps {
  onFadeComplete?: () => void;
}

/**
 * LaunchOverlay: Full-screen gradient overlay with animated launch text.
 * Fades out after 2.5 seconds using anime.js.
 */
const LaunchOverlay: React.FC<LaunchOverlayProps> = ({ onFadeComplete }) => {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const anime = (window as any).anime;
    if (!anime || !overlayRef.current) return;

    const timeline = anime.timeline({ autoplay: true });

    // Text pulse in and out (800ms total), then fade out overlay after 2.5s total
    timeline.add({
      targets: `.${styles['launch-text']}`,
      opacity: [0, 1],
      scale: [0.8, 1],
      duration: 400,
      easing: 'easeOutQuad',
    });

    timeline.add(
      {
        targets: `.${styles['launch-text']}`,
        opacity: [1, 0.3],
        duration: 400,
        easing: 'easeInOutQuad',
      },
      '+=800'
    );

    // Fade out entire overlay
    timeline.add(
      {
        targets: overlayRef.current,
        opacity: [1, 0],
        duration: 800,
        easing: 'easeInOutQuad',
        complete: () => {
          // Hide overlay after animation completes
          if (overlayRef.current) {
            overlayRef.current.style.pointerEvents = 'none';
          }
          onFadeComplete?.();
        },
      },
      '+=1200'
    );

    return () => timeline.pause();
  }, [onFadeComplete]);

  return (
    <div ref={overlayRef} className={styles['launch-overlay']}>
      <div className={styles['launch-gradient']} />
      <div className={styles['launch-content']}>
        <div className={styles['launch-text']}>
          ⚡ FRIDAY AWAKENING...
        </div>
      </div>
    </div>
  );
};

export default LaunchOverlay;
