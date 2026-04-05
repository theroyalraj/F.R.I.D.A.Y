import { useState, useEffect, useCallback } from 'react';

interface VoiceSessionMetadata {
  gender?: 'M' | 'F' | 'Neutral';
  locale?: string;
  description?: string;
  icon?: string;
  color?: string;
}

export interface VoiceSession {
  context: string;
  voice: string;
  setAt: string;
  lastUsed: string;
  status: 'active' | 'idle';
  metadata?: VoiceSessionMetadata;
  isSpeaking?: boolean;
}

interface UseVoiceSessionsOptions {
  pollInterval?: number;
  authHeaders?: () => Record<string, string>;
}

/**
 * useVoiceSessions: Hook for polling voice sessions from /voice/sessions endpoint.
 * Automatically refreshes every 3-5 seconds.
 */
export function useVoiceSessions(options: UseVoiceSessionsOptions = {}) {
  const { pollInterval = 4000, authHeaders } = options;
  const [sessions, setSessions] = useState<VoiceSession[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const headers = authHeaders ? authHeaders() : {};
      const response = await fetch('/voice/sessions', { headers });
      if (!response.ok) {
        throw new Error(`Failed to fetch sessions: ${response.statusText}`);
      }
      const data = await response.json();
      if (data.ok && Array.isArray(data.sessions)) {
        setSessions(data.sessions);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      console.error('Error fetching voice sessions:', err);
    } finally {
      setIsLoading(false);
    }
  }, [authHeaders]);

  // Poll on mount and when interval changes
  useEffect(() => {
    fetchSessions(); // Fetch immediately
    const interval = setInterval(fetchSessions, pollInterval);
    return () => clearInterval(interval);
  }, [fetchSessions, pollInterval]);

  return { sessions, isLoading, error, refetch: fetchSessions };
}
