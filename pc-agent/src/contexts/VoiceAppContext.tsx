import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import {
  mergePersona,
  loadPersonaOverrides,
  inferPersonaKeyFromVoice,
  USER_BUBBLE_PERSONA,
  type ChatBubblePersona,
  type CompanyPersonaKey,
  type PersonaOverride,
  type PersonaCatalog,
} from '../data/companyPersonas';

export type ConnectionStatus = 'offline' | 'listening' | 'processing' | 'speaking';

export interface ChatBubble {
  id: string;
  type: 'user' | 'friday' | 'error' | 'divider';
  text: string;
  ts: number;
  /** Present for user / friday / error lines — name, designation, voice id, description */
  persona?: ChatBubblePersona;
}

export interface VoiceAppContextType {
  connectionStatus: ConnectionStatus;
  listenMuted: boolean;
  exchanges: number;
  uptime: number;
  lastHeardText: string;
  edgeVoices: Array<{ voice: string; label: string }>;
  currentVoice: string;
  theme: 'light' | 'dark';
  bubbles: ChatBubble[];
  toasts: Array<{ id: string; message: string; type: 'info' | 'error' | 'success' }>;
  activePersonaKey: CompanyPersonaKey | 'custom';
  personaOverrides: Record<string, PersonaOverride>;
  /** Merged roster from GET /settings/personas (Postgres + defaults); null = use bundled COMPANY_PERSONAS only. */
  personaCatalog: PersonaCatalog | null;

  setConnectionStatus: (status: ConnectionStatus) => void;
  setListenMuted: (muted: boolean) => void;
  setExchanges: (count: number) => void;
  incrementExchanges: () => void;
  setUptime: (ms: number) => void;
  setLastHeardText: (text: string) => void;
  setEdgeVoices: (voices: Array<{ voice: string; label: string }>) => void;
  setCurrentVoice: (voice: string) => void;
  setTheme: (theme: 'light' | 'dark') => void;
  setActivePersonaKey: (key: CompanyPersonaKey | 'custom') => void;
  setPersonaCatalog: (c: PersonaCatalog | null) => void;
  refreshPersonaOverrides: () => void;
  getReplyPersona: () => ChatBubblePersona;
  addBubble: (bubble: Omit<ChatBubble, 'id'>) => void;
  clearBubbles: () => void;
  showToast: (message: string, type?: 'info' | 'error' | 'success') => void;
  dismissToast: (id: string) => void;
  postEvent: (type: string, text?: string) => void;
}

const VoiceAppContext = createContext<VoiceAppContextType | undefined>(undefined);

export const VoiceAppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('offline');
  const [listenMuted, setListenMuted] = useState(false);
  const [exchanges, setExchanges] = useState(0);
  const [uptime, setUptime] = useState(0);
  const [lastHeardText, setLastHeardText] = useState('');
  const [edgeVoices, setEdgeVoices] = useState<Array<{ voice: string; label: string }>>([]);
  const [currentVoice, setCurrentVoice] = useState('en-US-AvaMultilingualNeural');
  const [activePersonaKey, setActivePersonaKey] = useState<CompanyPersonaKey | 'custom'>('jarvis');
  const [personaOverrides, setPersonaOverrides] = useState<Record<string, PersonaOverride>>(() =>
    typeof window !== 'undefined' ? loadPersonaOverrides() : {},
  );
  const [personaCatalog, setPersonaCatalog] = useState<PersonaCatalog | null>(null);
  const personaCatalogRef = useRef<PersonaCatalog | null>(null);
  useEffect(() => {
    personaCatalogRef.current = personaCatalog;
  }, [personaCatalog]);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window !== 'undefined') {
      return (localStorage.getItem('friday.theme') as 'light' | 'dark' | null) ?? 'dark';
    }
    return 'dark';
  });
  const [bubbles, setBubbles] = useState<ChatBubble[]>([]);
  const [toasts, setToasts] = useState<Array<{ id: string; message: string; type: 'info' | 'error' | 'success' }>>([]);

  const toastIdRef = useRef(0);
  const dedupeSeen = useRef(new Map<string, number>());
  const MAX_BUBBLES = 80;
  const DEDUPE_WINDOW_MS = 8000;

  useEffect(() => {
    localStorage.setItem('friday.theme', theme);
  }, [theme]);

  const refreshPersonaOverrides = useCallback(() => {
    setPersonaOverrides(loadPersonaOverrides());
  }, []);

  const getReplyPersona = useCallback(
    () => mergePersona(activePersonaKey, personaOverrides, currentVoice, personaCatalog),
    [activePersonaKey, personaOverrides, currentVoice, personaCatalog],
  );

  const incrementExchanges = useCallback(() => {
    setExchanges((e) => e + 1);
  }, []);

  const addBubble = useCallback((bubble: Omit<ChatBubble, 'id'>) => {
    const id = `bubble-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const key = `${bubble.type}:${bubble.text}`;

    const lastSeen = dedupeSeen.current.get(key);
    if (lastSeen && Date.now() - lastSeen < DEDUPE_WINDOW_MS) {
      return;
    }
    dedupeSeen.current.set(key, Date.now());

    setBubbles((prev) => {
      const updated = [...prev, { ...bubble, id }];
      if (updated.length > MAX_BUBBLES) {
        return updated.slice(updated.length - MAX_BUBBLES);
      }
      return updated;
    });

    if (bubble.type === 'friday') {
      incrementExchanges();
    }
  }, [incrementExchanges]);

  const clearBubbles = useCallback(() => {
    setBubbles([]);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    (message: string, type: 'info' | 'error' | 'success' = 'info') => {
      const id = `toast-${toastIdRef.current++}`;
      setToasts((prev) => [...prev, { id, message, type }]);
      setTimeout(() => dismissToast(id), 2800);
    },
    [dismissToast],
  );

  const postEvent = useCallback(
    (type: string, text = '') => {
      switch (type) {
        case 'daemon_start':
        case 'server_start':
          setConnectionStatus('listening');
          addBubble({ type: 'divider', text: 'FRIDAY ONLINE', ts: Date.now() });
          break;
        case 'daemon_disconnect':
          setConnectionStatus('offline');
          break;
        case 'listening':
        case 'daemon_reconnect':
          setConnectionStatus('listening');
          setLastHeardText('');
          break;
        case 'heard':
          setConnectionStatus('processing');
          setLastHeardText(text);
          addBubble({ type: 'user', text, ts: Date.now(), persona: USER_BUBBLE_PERSONA });
          break;
        case 'thinking':
        case 'speak':
          setConnectionStatus('speaking');
          break;
        case 'reply':
          addBubble({
            type: 'friday',
            text,
            ts: Date.now(),
            persona: mergePersona(activePersonaKey, personaOverrides, currentVoice, personaCatalogRef.current),
          });
          break;
        case 'error':
          addBubble({
            type: 'error',
            text,
            ts: Date.now(),
            persona: mergePersona(activePersonaKey, personaOverrides, currentVoice, personaCatalogRef.current),
          });
          break;
        case 'voice_changed':
          if (text.trim()) {
            setCurrentVoice(text.trim());
            setActivePersonaKey(inferPersonaKeyFromVoice(text.trim(), personaCatalogRef.current));
          }
          break;
        default:
          break;
      }
    },
    [addBubble, activePersonaKey, personaOverrides, currentVoice],
  );

  const value: VoiceAppContextType = {
    connectionStatus,
    listenMuted,
    exchanges,
    uptime,
    lastHeardText,
    edgeVoices,
    currentVoice,
    theme,
    bubbles,
    toasts,
    activePersonaKey,
    personaOverrides,
    personaCatalog,

    setConnectionStatus,
    setListenMuted,
    setExchanges,
    incrementExchanges,
    setUptime,
    setLastHeardText,
    setEdgeVoices,
    setCurrentVoice,
    setTheme,
    setActivePersonaKey,
    setPersonaCatalog,
    refreshPersonaOverrides,
    getReplyPersona,
    addBubble,
    clearBubbles,
    showToast,
    dismissToast,
    postEvent,
  };

  return <VoiceAppContext.Provider value={value}>{children}</VoiceAppContext.Provider>;
};

export const useVoiceApp = (): VoiceAppContextType => {
  const context = useContext(VoiceAppContext);
  if (!context) {
    throw new Error('useVoiceApp must be used within VoiceAppProvider');
  }
  return context;
};
