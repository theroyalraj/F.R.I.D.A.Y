import React from 'react';
import { ChatBubble as IChatBubble } from '../contexts/VoiceAppContext';
import styles from '../styles/listen.module.css';

interface ChatBubbleProps {
  bubble: IChatBubble;
}

const ChatBubble: React.FC<ChatBubbleProps> = ({ bubble }) => {
  const formatTime = (ts: number): string => {
    const date = new Date(ts);
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
  };

  if (bubble.type === 'divider') {
    return (
      <div className={styles['bubble-divider']}>
        <span>{bubble.text}</span>
      </div>
    );
  }

  return (
    <div
      className={`${styles.bubble} ${styles[`bubble-${bubble.type}`]}`}
      key={bubble.id}
    >
      {bubble.type === 'error' && (
        <div className={styles['bubble-meta']}>
          <span className={styles['error-icon']}>⚠ ERROR</span>
        </div>
      )}
      {bubble.type === 'friday' && (
        <div className={styles['bubble-meta']}>
          <span className={styles['b-name']}>FRIDAY</span>
        </div>
      )}

      <div className={styles['bubble-body']}>
        {bubble.text}
      </div>

      <div className={styles['bubble-meta']}>
        <time className={styles['bubble-ts']}>{formatTime(bubble.ts)}</time>
      </div>
    </div>
  );
};

export default ChatBubble;
