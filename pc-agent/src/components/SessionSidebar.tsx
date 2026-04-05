import React, { useState, useEffect, useCallback } from 'react';
import SessionCard from './SessionCard';
import CurrentVoiceShowcase from './CurrentVoiceShowcase';
import styles from '../styles/listen.module.css';

interface VoiceSession {
  context: string;
  voice: string;
  setAt: string;
  lastUsed: string;
  status: 'active' | 'idle';
  metadata?: {
    gender?: 'M' | 'F' | 'Neutral';
    locale?: string;
    description?: string;
    icon?: string;
    color?: string;
  };
}

interface SessionSidebarProps {
  sessions: VoiceSession[];
  currentVoice: string;
  currentVoiceLabel?: string;
  currentVoiceIcon?: string;
  currentVoiceColor?: string;
  currentVoiceDescription?: string;
  isLoading?: boolean;
  onVoiceChange?: (voice: string) => void;
  theme?: 'light' | 'dark';
}

/**
 * SessionSidebar: Right-side panel showing active and idle voice sessions.
 * Features animated session cards sorted by status and recency.
 * Includes a featured CurrentVoiceShowcase at the bottom.
 */
const SessionSidebar: React.FC<SessionSidebarProps> = ({
  sessions,
  currentVoice,
  currentVoiceLabel = 'Current Voice',
  currentVoiceIcon = '🎙️',
  currentVoiceColor = '#8b5cf6',
  currentVoiceDescription = 'Default voice for this session',
  isLoading = false,
  onVoiceChange,
  theme = 'dark',
}) => {
  const [sortedSessions, setSortedSessions] = useState<VoiceSession[]>([]);

  // Sort sessions: active first, then by lastUsed descending
  useEffect(() => {
    const sorted = [...sessions].sort((a, b) => {
      if (a.status !== b.status) {
        return a.status === 'active' ? -1 : 1;
      }
      return new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime();
    });
    setSortedSessions(sorted);
  }, [sessions]);

  const extractLocaleFromVoice = (voiceId: string): string => {
    // Extract locale from voice ID like "en-US-EmmaMultilingualNeural"
    const match = voiceId.match(/^([a-z]{2}-[A-Z]{2})/);
    return match ? match[1] : 'en-US';
  };

  return (
    <div className={`${styles['session-sidebar']} ${styles[`session-sidebar-${theme}`]}`}>
      <div className={styles['session-sidebar-header']}>
        <h2 className={styles['session-sidebar-title']}>Voice Sessions</h2>
        {isLoading && <span className={styles['session-sidebar-loading']}>⟳</span>}
      </div>

      <div className={styles['session-sidebar-scroll']}>
        {sortedSessions.length === 0 ? (
          <div className={styles['session-sidebar-empty']}>
            <div className={styles['session-sidebar-empty-icon']}>🎙️</div>
            <div className={styles['session-sidebar-empty-text']}>
              No active sessions yet
            </div>
          </div>
        ) : (
          <div className={styles['session-cards-container']}>
            {sortedSessions.map((session) => (
              <SessionCard
                key={session.context}
                context={session.context}
                voice={session.voice}
                label={
                  session.metadata?.description
                    ? session.voice.replace(/([A-Z][a-z]+)/g, ' $1').trim()
                    : session.voice
                }
                description={session.metadata?.description || session.voice}
                status={session.status}
                lastUsed={session.lastUsed}
                icon={session.metadata?.icon || '🎙️'}
                color={session.metadata?.color || '#8b5cf6'}
              />
            ))}
          </div>
        )}

        {/* Featured current voice showcase */}
        <div className={styles['session-sidebar-divider']} />
        <CurrentVoiceShowcase
          icon={currentVoiceIcon}
          name={currentVoiceLabel}
          locale={extractLocaleFromVoice(currentVoice)}
          gender="Neutral"
          description={currentVoiceDescription}
          color={currentVoiceColor}
          rate={100}
          isActive={true}
        />
      </div>
    </div>
  );
};

export default SessionSidebar;
