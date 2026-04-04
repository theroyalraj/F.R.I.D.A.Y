import React, { useRef, useEffect } from 'react';
import { ConnectionStatus } from '../contexts/VoiceAppContext';
import styles from '../styles/listen.module.css';

const OrbRings: React.FC<{ connectionStatus: ConnectionStatus }> = ({ connectionStatus }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<any>(null);

  // Ring speed varies by connection status
  const getRingDuration = (status: ConnectionStatus, ringNum: number): number => {
    const speeds = {
      offline: { 1: 8000, 2: 7000, 3: 12000, 4: 5000 },
      listening: { 1: 4000, 2: 7000, 3: 12000, 4: 5000 },
      processing: { 1: 2500, 2: 5500, 3: 9000, 4: 3500 },
      speaking: { 1: 1500, 2: 4000, 3: 7000, 4: 2500 },
    };
    return speeds[status][ringNum as keyof typeof speeds[ConnectionStatus]];
  };

  useEffect(() => {
    if (!containerRef.current) return;

    // Try to get anime from global scope or require it
    const anime = (window as any).anime;
    if (!anime) {
      console.warn('anime.js not loaded - ring animations will use CSS only');
      return;
    }

    // Kill previous timeline if it exists
    if (timelineRef.current) {
      timelineRef.current.pause();
    }

    // Create new timeline for rings
    const timeline = anime.timeline({
      autoplay: true,
      loop: true,
    });

    const ring1Duration = getRingDuration(connectionStatus, 1);
    const ring2Duration = getRingDuration(connectionStatus, 2);
    const ring3Duration = getRingDuration(connectionStatus, 3);
    const ring4Duration = getRingDuration(connectionStatus, 4);

    // Ring 1 - fast spin
    timeline.add(
      {
        targets: containerRef.current.querySelector(`.${styles['ring-1']}`),
        rotate: 360,
        duration: ring1Duration,
        easing: 'linear',
      },
      0
    );

    // Ring 2 - medium spin reverse
    timeline.add(
      {
        targets: containerRef.current.querySelector(`.${styles['ring-2']}`),
        rotate: -360,
        duration: ring2Duration,
        easing: 'linear',
      },
      0
    );

    // Ring 3 - slow spin
    timeline.add(
      {
        targets: containerRef.current.querySelector(`.${styles['ring-3']}`),
        rotate: 360,
        duration: ring3Duration,
        easing: 'linear',
      },
      0
    );

    // Ring 4 - medium spin reverse
    timeline.add(
      {
        targets: containerRef.current.querySelector(`.${styles['ring-4']}`),
        rotate: -360,
        duration: ring4Duration,
        easing: 'linear',
      },
      0
    );

    timelineRef.current = timeline;

    // Cleanup
    return () => {
      if (timelineRef.current) {
        timelineRef.current.pause();
      }
    };
  }, [connectionStatus]);

  return (
    <div ref={containerRef} className={styles['orb-wrap']}>
      <div className={styles['ring-1']}></div>
      <div className={styles['ring-2']}></div>
      <div className={styles['ring-3']}></div>
      <div className={styles['ring-4']}></div>
    </div>
  );
};

export default OrbRings;
