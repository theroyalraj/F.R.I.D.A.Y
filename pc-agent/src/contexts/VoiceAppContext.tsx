import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import {
  mergePersona,
  loadPersonaOverrides,
  inferPersonaKeyFromVoice,
  USER_BUBBLE_PERSONA,
  COMPANY_PERSONAS,
  type ChatBubblePersona,
  type CompanyPersonaKey,
  type PersonaOverride,
  type PersonaCatalog,
} from '../data/companyPersonas';

/** Mail / WhatsApp / similar — full-screen Siri orb stays off; rail shows the activity */
function normalizePeripheralSpeakChannel(raw?: string): 'mail' | 'whatsapp' | null {
  if (!raw || typeof raw !== 'string') return null;
  const n = raw.trim().toLowerCase();
  if (n === 'mail' || n === 'gmail' || n === 'email' || n === 'inbox') return 'mail';
  if (n === 'whatsapp' || n === 'wa' || n === 'evolution') return 'whatsapp';
  return null;
}

function isCompanyPersonaKey(k: string): k is CompanyPersonaKey {
  return Object.prototype.hasOwnProperty.call(COMPANY_PERSONAS, k);
}

export type SpeakingPersonaKey = CompanyPersonaKey | 'custom' | null;

export type ConnectionStatus = 'offline' | 'listening' | 'processing' | 'speaking';

export interface ChatBubble {
  id: string;
  type: 'user' | 'friday' | 'error' | 'divider';
  text: string;
  ts: number;
  /** Present for user / friday / error lines — name, designation, voice id, description */
  persona?: ChatBubblePersona;
}

export interface VoicePostEventOptions {
  musicSeconds?: number;
  musicPersonaKey?: CompanyPersonaKey;
  /** When mail / WhatsApp etc. — centre overlay hidden, rail pulses */
  speakChannel?: string;
  /** Optional roster key from SSE (e.g. nova for Gmail) */
  speakPersonaKey?: string;
}

/** Mini orb payload (non-blocking notification, e.g. music). */
export interface MiniOrbState {
  icon: string;
  caption: string;
  personaKey: CompanyPersonaKey;
}

const MINI_ORB_HIDE_MS = Math.max(
  2000,
  (Number(import.meta.env.VITE_MINI_ORB_AUTO_HIDE_SEC) || 8) * 1000,
);

export interface VoiceAppContextType {
  connectionStatus: ConnectionStatus;
  /** Siri orb line while friday-play holds the floor after TTS (e.g. "Playing: …"). */
  musicOrbCaption: string;
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
  /**
   * The persona currently speaking (set on speak/thinking, cleared on listening/reply).
   * Null when no TTS is active. Used to tint the Siri orb per speaker.
   */
  speakingPersonaKey: SpeakingPersonaKey;
  /** Non-null when TTS is attributed to mail / WhatsApp — show in integrations rail only */
  peripheralSpeak: { channel: 'mail' | 'whatsapp'; text: string } | null;
  personaOverrides: Record<string, PersonaOverride>;
  /** Merged roster from GET /settings/personas (Postgres + defaults); null = use bundled COMPANY_PERSONAS only. */
  personaCatalog: PersonaCatalog | null;

  setConnectionStatus: (status: ConnectionStatus) => void;
  setSpeakingPersonaKey: (key: SpeakingPersonaKey) => void;
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
  /**
   * @returns When type is `listening`, `true` means the orb should keep showing (music continuation after TTS).
   */
  postEvent: (type: string, text?: string, opts?: VoicePostEventOptions) => void | boolean;
  /** Small fixed orb for background notifications (music, future mail / gRPC). */
  miniOrb: MiniOrbState | null;
  dismissMiniOrb: () => void;
  /** Do Not Disturb — silences all spoken daemons; UI still shows notifications. */
  dnd: boolean;
  setDnd: (enabled: boolean) => void;
  /** Live feed of Windows toast notifications from win-notify-watch. */
  winNotifications: WinNotification[];
  dismissWinNotification: (id: string) => void;
}

export interface WinNotification {
  id: string;
  app: string;
  title: string;
  body: string;
  ts: number;
}

const VoiceAppContext = createContext<VoiceAppContextType | undefined>(undefined);

export const VoiceAppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('offline');
  const [musicOrbCaption, setMusicOrbCaption] = useState('');
  const [speakingPersonaKey, setSpeakingPersonaKey] = useState<SpeakingPersonaKey>(null);
  const [listenMuted, setListenMuted] = useState(false);
  const [uptime, setUptime] = useState(0);
  const [lastHeardText, setLastHeardText] = useState('');
  const [edgeVoices, setEdgeVoices] = useState<Array<{ voice: string; label: string }>>([]);
  const [currentVoice, setCurrentVoice] = useState(() => {
    if (typeof window !== 'undefined') {
      return (localStorage.getItem('friday.session.voice') as string | null) ?? 'en-US-AvaMultilingualNeural';
    }
    return 'en-US-AvaMultilingualNeural';
  });
  const [activePersonaKey, setActivePersonaKey] = useState<CompanyPersonaKey | 'custom'>(() => {
    if (typeof window !== 'undefined') {
      return (localStorage.getItem('friday.session.personaKey') as CompanyPersonaKey | 'custom' | null) ?? 'jarvis';
    }
    return 'jarvis';
  });
  const [exchanges, setExchanges] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('friday.session.exchanges');
      return saved ? parseInt(saved, 10) : 0;
    }
    return 0;
  });
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
  const [bubbles, setBubbles] = useState<ChatBubble[]>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('friday.session.bubbles');
        return saved ? JSON.parse(saved) : [];
      } catch {
        return [];
      }
    }
    return [];
  });
  const [toasts, setToasts] = useState<Array<{ id: string; message: string; type: 'info' | 'error' | 'success' }>>([]);

  const toastIdRef = useRef(0);
  const dedupeSeen = useRef(new Map<string, number>());
  const MAX_BUBBLES = 80;
  const DEDUPE_WINDOW_MS = 8000;

  const [miniOrb, setMiniOrb] = useState<MiniOrbState | null>(null);
  const miniOrbTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [dnd, setDndState] = useState<boolean>(false);
  const [winNotifications, setWinNotifications] = useState<WinNotification[]>([]);
  const WIN_NOTIFY_MAX = 50;

  useEffect(() => {
    fetch('/settings/dnd')
      .then((r) => r.json())
      .then((d) => { if (typeof d?.dnd === 'boolean') setDndState(d.dnd); })
      .catch(() => {});
  }, []);

  const setDnd = useCallback((enabled: boolean) => {
    setDndState(enabled);
    fetch('/settings/dnd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }).catch(() => {});
  }, []);

  const dismissWinNotification = useCallback((id: string) => {
    setWinNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const musicVisualTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const musicVisualUntilRef = useRef(0);
  const activeMusicVisualRef = useRef<{ personaKey: CompanyPersonaKey; caption: string } | null>(null);
  const deferredMusicVisualRef = useRef<{
    seconds: number;
    personaKey: CompanyPersonaKey;
    caption: string;
  } | null>(null);
  const ttsActiveRef = useRef(false);
  const ttsWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** SSE reconnects and duplicate daemon_start/server_start must not flood chat with "FRIDAY ONLINE". */
  const fridayOnlineDividerShownRef = useRef(false);

  const [peripheralSpeak, setPeripheralSpeak] = useState<{
    channel: 'mail' | 'whatsapp';
    text: string;
  } | null>(null);

  const clearTtsWatchdog = useCallback(() => {
    if (ttsWatchdogRef.current) {
      clearTimeout(ttsWatchdogRef.current);
      ttsWatchdogRef.current = null;
    }
  }, []);

  const dismissMiniOrb = useCallback(() => {
    if (miniOrbTimerRef.current) {
      clearTimeout(miniOrbTimerRef.current);
      miniOrbTimerRef.current = null;
    }
    setMiniOrb(null);
  }, []);

  useEffect(
    () => () => {
      if (miniOrbTimerRef.current) clearTimeout(miniOrbTimerRef.current);
    },
    [],
  );

  const clearMusicVisualTimer = useCallback(() => {
    if (musicVisualTimerRef.current) {
      clearTimeout(musicVisualTimerRef.current);
      musicVisualTimerRef.current = null;
    }
    musicVisualUntilRef.current = 0;
    activeMusicVisualRef.current = null;
    setMusicOrbCaption('');
  }, []);

  /** Fallback when SSE replay leaves speak dangling, or listening is never emitted after TTS. */
  const scheduleTtsWatchdog = useCallback(
    (text: string) => {
      clearTtsWatchdog();
      const len = String(text || '').length;
      const ms = Math.min(180_000, Math.max(4_500, len * 70 + 2_500));
      ttsWatchdogRef.current = setTimeout(() => {
        ttsWatchdogRef.current = null;
        if (!ttsActiveRef.current) return;
        ttsActiveRef.current = false;
        clearMusicVisualTimer();
        setConnectionStatus('listening');
        setSpeakingPersonaKey(null);
        setPeripheralSpeak(null);
      }, ms);
    },
    [clearTtsWatchdog, clearMusicVisualTimer],
  );

  useEffect(
    () => () => {
      clearTtsWatchdog();
    },
    [clearTtsWatchdog],
  );

  const applyMusicVisual = useCallback(
    (d: { seconds: number; personaKey: CompanyPersonaKey; caption: string }) => {
      const sec = Math.min(600, Math.max(5, d.seconds));
      clearMusicVisualTimer();
      activeMusicVisualRef.current = { personaKey: d.personaKey, caption: d.caption };
      setMusicOrbCaption(d.caption);
      musicVisualUntilRef.current = Date.now() + sec * 1000;
      musicVisualTimerRef.current = setTimeout(() => {
        musicVisualTimerRef.current = null;
        musicVisualUntilRef.current = 0;
        activeMusicVisualRef.current = null;
        setMusicOrbCaption('');
        setConnectionStatus('listening');
        setSpeakingPersonaKey(null);
      }, sec * 1000);
      setConnectionStatus('speaking');
      setSpeakingPersonaKey(d.personaKey);
      setPeripheralSpeak(null);
    },
    [clearMusicVisualTimer],
  );

  useEffect(() => {
    localStorage.setItem('friday.theme', theme);
  }, [theme]);

  // Persist chat bubbles to localStorage for session recovery
  useEffect(() => {
    try {
      localStorage.setItem('friday.session.bubbles', JSON.stringify(bubbles));
    } catch {
      // Silently fail if localStorage is full or unavailable
    }
  }, [bubbles]);

  // Persist session state
  useEffect(() => {
    try {
      localStorage.setItem('friday.session.voice', currentVoice);
      localStorage.setItem('friday.session.personaKey', activePersonaKey);
      localStorage.setItem('friday.session.exchanges', String(exchanges));
    } catch {
      // Silently fail if localStorage is unavailable
    }
  }, [currentVoice, activePersonaKey, exchanges]);

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
    try {
      localStorage.removeItem('friday.session.bubbles');
      localStorage.removeItem('friday.session.exchanges');
    } catch {
      // Ignore
    }
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
    (type: string, text = '', opts?: VoicePostEventOptions) => {
      switch (type) {
        case 'sse_stream_open':
          setConnectionStatus('listening');
          break;
        case 'daemon_start':
        case 'server_start':
          setConnectionStatus('listening');
          if (!fridayOnlineDividerShownRef.current) {
            fridayOnlineDividerShownRef.current = true;
            addBubble({ type: 'divider', text: 'FRIDAY ONLINE', ts: Date.now() });
          }
          break;
        case 'daemon_disconnect':
          clearTtsWatchdog();
          ttsActiveRef.current = false;
          setPeripheralSpeak(null);
          setConnectionStatus('offline');
          break;
        case 'listening':
        case 'daemon_reconnect': {
          clearTtsWatchdog();
          ttsActiveRef.current = false;
          setPeripheralSpeak(null);
          if (deferredMusicVisualRef.current) {
            const d = deferredMusicVisualRef.current;
            deferredMusicVisualRef.current = null;
            applyMusicVisual(d);
            setLastHeardText('');
            return true;
          }
          const musicTimerLive =
            musicVisualTimerRef.current != null &&
            Date.now() < musicVisualUntilRef.current &&
            activeMusicVisualRef.current != null;
          if (musicTimerLive) {
            setConnectionStatus('speaking');
            const snap = activeMusicVisualRef.current;
            if (snap) {
              setSpeakingPersonaKey(snap.personaKey);
              setMusicOrbCaption(snap.caption);
            } else {
              setSpeakingPersonaKey('maestro');
            }
            setLastHeardText('');
            return true;
          }
          clearMusicVisualTimer();
          setConnectionStatus('listening');
          setLastHeardText('');
          setSpeakingPersonaKey(null);
          return false;
        }
        case 'heard':
          setConnectionStatus('processing');
          setLastHeardText(text);
          addBubble({ type: 'user', text, ts: Date.now(), persona: USER_BUBBLE_PERSONA });
          break;
        case 'thinking':
        case 'speak': {
          ttsActiveRef.current = true;
          setConnectionStatus('speaking');
          const periphery = normalizePeripheralSpeakChannel(opts?.speakChannel);
          const pKeyRaw = opts?.speakPersonaKey?.trim().toLowerCase();
          if (periphery) {
            setPeripheralSpeak({
              channel: periphery,
              text: String(text || '').slice(0, 200),
            });
            if (pKeyRaw && isCompanyPersonaKey(pKeyRaw)) {
              setSpeakingPersonaKey(pKeyRaw);
            } else if (periphery === 'mail') {
              setSpeakingPersonaKey('nova');
            } else {
              setSpeakingPersonaKey('dexter');
            }
          } else {
            setPeripheralSpeak(null);
            if (pKeyRaw && isCompanyPersonaKey(pKeyRaw)) {
              setSpeakingPersonaKey(pKeyRaw);
            } else {
              setSpeakingPersonaKey(activePersonaKey);
            }
          }
          scheduleTtsWatchdog(text);
          break;
        }
        case 'music_play': {
          const seconds = opts?.musicSeconds ?? 30;
          const personaKey = opts?.musicPersonaKey ?? 'maestro';
          const caption = text.trim() || 'Playing…';
          if (ttsActiveRef.current) {
            deferredMusicVisualRef.current = { seconds, personaKey, caption };
          } else {
            applyMusicVisual({ seconds, personaKey, caption });
          }
          setMiniOrb({
            icon: '\u266A',
            caption: caption.length > 200 ? `${caption.slice(0, 197)}...` : caption,
            personaKey,
          });
          if (miniOrbTimerRef.current) {
            clearTimeout(miniOrbTimerRef.current);
            miniOrbTimerRef.current = null;
          }
          miniOrbTimerRef.current = setTimeout(() => {
            miniOrbTimerRef.current = null;
            setMiniOrb(null);
          }, MINI_ORB_HIDE_MS);
          break;
        }
        case 'reply':
          setSpeakingPersonaKey(null);
          addBubble({
            type: 'friday',
            text,
            ts: Date.now(),
            persona: mergePersona(activePersonaKey, personaOverrides, currentVoice, personaCatalogRef.current),
          });
          break;
        case 'error':
          clearTtsWatchdog();
          ttsActiveRef.current = false;
          setPeripheralSpeak(null);
          setSpeakingPersonaKey(null);
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
        case 'win_notify': {
          // opts carries app/title/body injected from the SSE event in FridayListenApp
          const winApp   = (opts as unknown as Record<string, string> | undefined)?.app   ?? '';
          const winTitle = (opts as unknown as Record<string, string> | undefined)?.title ?? text;
          const winBody  = (opts as unknown as Record<string, string> | undefined)?.body  ?? '';
          const winId = `wn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          setWinNotifications((prev) => {
            const next = [{ id: winId, app: winApp, title: winTitle, body: winBody, ts: Date.now() }, ...prev];
            return next.slice(0, WIN_NOTIFY_MAX);
          });
          break;
        }
        case 'dnd_changed':
          // opts carries { dnd: boolean } injected from the SSE event
          if (typeof (opts as unknown as Record<string, unknown> | undefined)?.dnd === 'boolean') {
            setDndState((opts as unknown as { dnd: boolean }).dnd);
          }
          break;
        default:
          break;
      }
    },
    [
      addBubble,
      activePersonaKey,
      personaOverrides,
      currentVoice,
      applyMusicVisual,
      clearMusicVisualTimer,
      clearTtsWatchdog,
      scheduleTtsWatchdog,
    ],
  );

  const value: VoiceAppContextType = {
    connectionStatus,
    musicOrbCaption,
    speakingPersonaKey,
    peripheralSpeak,
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
    setSpeakingPersonaKey,
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
    miniOrb,
    dismissMiniOrb,
    dnd,
    setDnd,
    winNotifications,
    dismissWinNotification,
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
