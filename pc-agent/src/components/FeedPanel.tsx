import React, { useEffect, useRef } from 'react';
import { useVoiceApp } from '../contexts/VoiceAppContext';
import ChatBubble from './ChatBubble';
import styles from '../styles/listen.module.css';

const FeedPanel: React.FC = () => {
  const { bubbles } = useVoiceApp();
  const feedScrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new bubbles appear
  useEffect(() => {
    if (feedScrollRef.current) {
      feedScrollRef.current.scrollTop = feedScrollRef.current.scrollHeight;
    }
  }, [bubbles]);

  return (
    <div className={styles['feed-panel']}>
      <div className={styles['feed-scroll']} ref={feedScrollRef}>
        {bubbles.map(bubble => (
          <ChatBubble key={bubble.id} bubble={bubble} />
        ))}
      </div>
    </div>
  );
};

export default FeedPanel;
