import React, { useRef, useEffect } from 'react';
import styles from '../styles/listen.module.css';

const Waveform: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<any>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const anime = (window as any).anime;
    if (!anime) {
      console.warn('anime.js not loaded - waveform animations will use CSS only');
      return;
    }

    // Kill previous timeline
    if (timelineRef.current) {
      timelineRef.current.pause();
    }

    // Create waveform animation timeline
    const timeline = anime.timeline({
      autoplay: true,
      loop: true,
    });

    const bars = containerRef.current.querySelectorAll(`.${styles['wave-bar']}`);
    const duration = 1800;

    bars.forEach((bar, index) => {
      const staggerDelay = index * 100;

      timeline.add(
        {
          targets: bar,
          scaleY: [
            { value: 0.3, duration: duration / 2, easing: 'easeInOutQuad' },
            { value: 1, duration: duration / 2, easing: 'easeInOutQuad' },
          ],
          opacity: [
            { value: 0.7, duration: duration, easing: 'linear' },
          ],
        },
        staggerDelay
      );
    });

    timelineRef.current = timeline;

    return () => {
      if (timelineRef.current) {
        timelineRef.current.pause();
      }
    };
  }, []);

  return (
    <div className={styles['waveform-container']}>
      <svg className={styles['waveform']} viewBox="0 0 120 40" xmlns="http://www.w3.org/2000/svg">
        {Array.from({ length: 11 }).map((_, i) => (
          <rect
            key={i}
            className={`${styles['wave-bar']} wave-bar-${i}`}
            x={i * 10 + 2}
            y="20"
            width="6"
            height="20"
            rx="2"
            fill="currentColor"
            opacity="0.5"
          />
        ))}
      </svg>
    </div>
  );
};

export default Waveform;
