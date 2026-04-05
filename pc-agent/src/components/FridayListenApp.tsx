import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useVoiceApp } from '../contexts/VoiceAppContext';
import { useSSEStream } from '../hooks/useSSEStream';
import { useUptime } from '../hooks/useUptime';
import ToastContainer from './Toast';
import SpeakStylePanel from './SpeakStylePanel';
import EchoPersonalityPanel from './EchoPersonalityPanel';
import VoiceSiriOverlay from './VoiceSiriOverlay';
import MiniNotifyOrb from './MiniNotifyOrb';
import { IntegrationsRail } from './IntegrationsRail';
import { PersonaRosterModal } from './PersonaRosterModal';
import LaunchOverlay from './LaunchOverlay';
import AnimatedAvatar from './AnimatedAvatar';
import TopMusicDock from './TopMusicDock';
import {
  COMPANY_PERSONAS,
  SPEAKING_PERSONA_ORDER,
  PERSONA_ORB_PALETTES,
  mergePersona,
  inferPersonaKeyFromVoice,
  personaIcon,
  shortVoiceLabel,
  USER_BUBBLE_PERSONA,
  type CompanyPersonaKey,
  type PersonaCatalog,
} from '../data/companyPersonas';
import type { ChatBubble } from '../contexts/VoiceAppContext';
import styles from '../styles/listen.module.css';

const INTEGRATIONS_NARROW_MQ = '(max-width: 1100px)';
/** Shared with /friday voice.html — same Claude model preference */
const LS_CLAUDE_MODEL = 'friday.claudeModel';
const LS_ALWAYS_SPEAK = 'friday.alwaysSpeakViaUi';

/* ── Voice metadata ───────────────────────────────────────── */
interface VoiceMeta { icon: string; color: string; shortName: string; }

const VOICE_META: Record<string, VoiceMeta> = {
  'en-US-EmmaMultilingualNeural': { icon: '\uD83D\uDC69\u200D\uD83D\uDCBC', color: '#a78bfa', shortName: 'Emma' },
  'en-US-AriaNeural':             { icon: '\uD83D\uDC69', color: '#f472b6', shortName: 'Aria' },
  'en-US-JennyNeural':            { icon: '\uD83D\uDE4B\u200D\u2640\uFE0F', color: '#fb923c', shortName: 'Jenny' },
  'en-US-NancyNeural':            { icon: '\uD83E\uDDD1\u200D\uD83D\uDCBB', color: '#38bdf8', shortName: 'Nancy' },
  'en-US-GuyNeural':              { icon: '\uD83D\uDC68\u200D\uD83D\uDCBC', color: '#34d399', shortName: 'Guy' },
  'en-US-ChristopherNeural':      { icon: '\uD83D\uDC68', color: '#60a5fa', shortName: 'Christopher' },
  'en-US-DavisNeural':            { icon: '\uD83E\uDDD4', color: '#a3e635', shortName: 'Davis' },
  'en-US-EricNeural':             { icon: '\uD83D\uDC68\u200D\uD83D\uDD2C', color: '#fbbf24', shortName: 'Eric' },
  'en-GB-LibbyNeural':            { icon: '\uD83D\uDC69\u200D\uD83C\uDF93', color: '#c084fc', shortName: 'Libby' },
  'en-GB-SoniaNeural':            { icon: '\uD83D\uDC78', color: '#e879f9', shortName: 'Sonia' },
  'en-IN-NeerjaExpressiveNeural': { icon: '\uD83D\uDC83', color: '#fb7185', shortName: 'Neerja' },
  'en-IN-PrabhatNeural':          { icon: '\uD83D\uDC68\u200D\uD83C\uDFEB', color: '#2dd4bf', shortName: 'Prabhat' },
  'en-AU-NatashaNeural':          { icon: '\uD83E\uDDD1\u200D\uD83C\uDFA4', color: '#f97316', shortName: 'Natasha' },
  'en-CA-LiamNeural':             { icon: '\uD83E\uDDD1', color: '#22d3ee', shortName: 'Liam' },
  'en-CA-ClaraNeural':            { icon: '\uD83D\uDC69\u200D\uD83C\uDFA8', color: '#a78bfa', shortName: 'Clara' },
  'en-US-AndrewMultilingualNeural': { icon: '\uD83E\uDDD1\u200D\uD83D\uDD2C', color: '#94a3b8', shortName: 'Andrew' },
  'en-US-BrianMultilingualNeural': { icon: '\uD83C\uDFAD', color: '#a8a29e', shortName: 'Brian' },
  'en-US-AvaMultilingualNeural': { icon: '\uD83D\uDC69\u200D\uD83D\uDCBC', color: '#f0abfc', shortName: 'Ava' },
  'en-IE-ConnorNeural':           { icon: '\uD83D\uDCE1', color: '#7dd3fc', shortName: 'Connor' },
};

function vm(id: string): VoiceMeta {
  return VOICE_META[id] || { icon: '\uD83C\uDF99\uFE0F', color: '#8b5cf6', shortName: id.replace(/.*-(\w+)Neural$/, '$1') || id };
}

/* ── Context labels ───────────────────────────────────────── */
const CTX: Record<string, { label: string; desc: string }> = {
  'api':              { label: 'Listen UI',     desc: 'Web dashboard' },
  'cursor:main':      { label: 'Cursor',        desc: 'IDE agent' },
  'cursor:subagent':  { label: 'Cursor Task',   desc: 'Sub-agent' },
  'cursor:reply':     { label: 'Cursor Reply',  desc: 'Reply narration' },
  'cursor:thinking':  { label: 'Thinking',      desc: 'Thought narration' },
};

/* ── @mention targets ─────────────────────────────────────── */
const MENTION_TARGETS = [
  { id: 'friday', label: 'Friday', desc: 'AI assistant', icon: '\u26A1' },
  { id: 'cursor', label: 'Cursor', desc: 'IDE agent', icon: '\uD83D\uDCBB' },
  { id: 'speak', label: 'Speak', desc: 'Say aloud via TTS', icon: '\uD83D\uDD0A' },
  { id: 'all', label: 'All', desc: 'Broadcast to all', icon: '\uD83D\uDCE2' },
];

/* ── Types ────────────────────────────────────────────────── */
interface VoiceSession { context: string; voice: string; set_at: string; last_used: string; status: 'active' | 'idle'; }
interface EdgeVoice { voice: string; lang: string; gender: string; desc: string; }
interface CelebrationPayload { song: string; askText: string; delayMsBeforeAsk: number; }

/** Prior turns for Friday fast path (Anthropic multi-turn + prompt cache on system). */
function bubblesToConversationTail(bubbles: ChatBubble[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const b of bubbles) {
    if (b.type === 'user') out.push({ role: 'user', content: b.text });
    else if (b.type === 'friday') out.push({ role: 'assistant', content: b.text });
  }
  return out.slice(-14);
}

/* ═══ Main App ════════════════════════════════════════════════ */
const FridayListenApp: React.FC = () => {
  const {
    postEvent, setEdgeVoices, theme, setTheme,
    connectionStatus, setConnectionStatus,
    listenMuted, setListenMuted,
    exchanges, lastHeardText,
    edgeVoices, currentVoice, setCurrentVoice,
    bubbles, addBubble, showToast, setUptime,
    activePersonaKey, setActivePersonaKey, personaOverrides, refreshPersonaOverrides, getReplyPersona,
    personaCatalog, setPersonaCatalog,
    speakingPersonaKey,
    peripheralSpeak,
    musicOrbCaption,
    miniOrb,
    dismissMiniOrb,
    dnd, setDnd,
    winNotifications, dismissWinNotification,
    cursorDoneNotifications, dismissCursorDone, clearAllCursorDone,
  } = useVoiceApp();
  const { authHeaders } = useAuth();

  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [sessions, setSessions] = useState<VoiceSession[]>([]);
  const [speakingText, setSpeakingText] = useState('');
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionIdx, setMentionIdx] = useState(0);
  const chatRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);
  const celebrationAskTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** SSE drops briefly on agent restart — avoid flashing Offline when HTTP is fine */
  const sseOfflineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [uptime] = useUptime(setUptime);
  const [integrationsDrawerOpen, setIntegrationsDrawerOpen] = useState(
    () => typeof window !== 'undefined' && !window.matchMedia(INTEGRATIONS_NARROW_MQ).matches,
  );
  const [isNarrow, setIsNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(INTEGRATIONS_NARROW_MQ).matches,
  );
  const [personaModalOpen, setPersonaModalOpen] = useState(false);
  const [winNotifyPanelOpen, setWinNotifyPanelOpen] = useState(false);
  const [agentPanelOpen, setAgentPanelOpen] = useState(false);
  const [celebrationOffer, setCelebrationOffer] = useState<CelebrationPayload | null>(null);
  const [claudeModel, setClaudeModel] = useState(() => {
    try {
      return typeof localStorage !== 'undefined' ? localStorage.getItem(LS_CLAUDE_MODEL) || 'auto' : 'auto';
    } catch {
      return 'auto';
    }
  });
  const [openclawStrip, setOpenclawStrip] = useState<{
    gwOk: boolean;
    agentOk: boolean;
    fromDb: boolean;
    roleCount: number;
    err?: string;
  } | null>(null);
  const [launchOverlayVisible, setLaunchOverlayVisible] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [alwaysSpeakViaUi, setAlwaysSpeakViaUi] = useState(() => {
    try { return localStorage.getItem(LS_ALWAYS_SPEAK) === 'true'; } catch { return false; }
  });

  const toggleAlwaysSpeak = useCallback(() => {
    setAlwaysSpeakViaUi((prev) => {
      const next = !prev;
      try { localStorage.setItem(LS_ALWAYS_SPEAK, String(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const clearCelebrationOffer = useCallback(() => {
    if (celebrationAskTimerRef.current) {
      clearTimeout(celebrationAskTimerRef.current);
      celebrationAskTimerRef.current = null;
    }
    setCelebrationOffer(null);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia(INTEGRATIONS_NARROW_MQ);
    const apply = () => {
      const narrow = mq.matches;
      setIsNarrow(narrow);
      if (narrow) setIntegrationsDrawerOpen(false);
      else setIntegrationsDrawerOpen(true);
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  // Merged voice-agent personas from Postgres (openclaw_settings.voice_agent_personas)
  useEffect(() => {
    fetch('/settings/personas', { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.merged && typeof d.merged === 'object') {
          setPersonaCatalog(d.merged as PersonaCatalog);
        }
      })
      .catch(() => {});
  }, [authHeaders, setPersonaCatalog]);

  // Fetch voices + align active persona with server session voice (catalog may load later)
  useEffect(() => {
    fetch('/voice/voices', { headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => {
        if (d.voices) setEdgeVoices(d.voices);
        if (d.active) {
          setCurrentVoice(d.active);
          setActivePersonaKey(inferPersonaKeyFromVoice(d.active, null));
        }
      })
      .catch(() => {});
  }, [setEdgeVoices, setCurrentVoice, setActivePersonaKey, authHeaders]);

  useEffect(() => {
    if (!personaCatalog) return;
    setActivePersonaKey(inferPersonaKeyFromVoice(currentVoice, personaCatalog));
  }, [personaCatalog, currentVoice, setActivePersonaKey]);

  // OpenClaw stack status (proxies skill-gateway) — visible by default on Listen
  useEffect(() => {
    const tick = () => {
      fetch('/openclaw/status')
        .then((r) => r.json())
        .then((j) => {
          setOpenclawStrip({
            gwOk: j.ok === true,
            agentOk: j.pcAgent?.ok === true,
            fromDb: j.personas?.fromDatabase === true,
            roleCount: Array.isArray(j.personas?.roles) ? j.personas.roles.length : 0,
            err: j.ok === false ? String(j.error || '').slice(0, 120) : undefined,
          });
        })
        .catch((e) =>
          setOpenclawStrip({
            gwOk: false,
            agentOk: false,
            fromDb: false,
            roleCount: 0,
            err: String(e.message || e).slice(0, 80),
          }),
        );
    };
    tick();
    const iv = setInterval(tick, 25000);
    return () => clearInterval(iv);
  }, []);

  // Poll sessions
  useEffect(() => {
    const poll = () => fetch('/voice/status', { headers: authHeaders() }).then(r => r.json())
      .then(d => { if (d.ok) setSessions(d.contexts || []); }).catch(() => {});
    poll();
    const iv = setInterval(poll, 5000);
    return () => clearInterval(iv);
  }, [authHeaders]);

  // Agent reachability — header status must not depend on SSE alone (SSE errors on restarts / proxies).
  useEffect(() => {
    let cancelled = false;
    const ping = async () => {
      try {
        const r = await fetch('/voice/ping');
        const j = await r.json();
        if (cancelled || !r.ok || !j?.ok) return;
        setConnectionStatus((s) => (s === 'offline' ? 'listening' : s));
      } catch {
        /* ignore */
      }
    };
    void ping();
    const iv = setInterval(ping, 6000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [setConnectionStatus]);

  useEffect(
    () => () => {
      if (sseOfflineTimerRef.current) {
        clearTimeout(sseOfflineTimerRef.current);
        sseOfflineTimerRef.current = null;
      }
    },
    [],
  );

  // SSE
  useSSEStream((event) => {
    if (event.type === 'sse_disconnected') {
      if (sseOfflineTimerRef.current) clearTimeout(sseOfflineTimerRef.current);
      sseOfflineTimerRef.current = setTimeout(() => {
        sseOfflineTimerRef.current = null;
        postEvent('daemon_disconnect');
      }, 2200);
    } else if (event.type === 'sse_connected') {
      if (sseOfflineTimerRef.current) {
        clearTimeout(sseOfflineTimerRef.current);
        sseOfflineTimerRef.current = null;
      }
      // Do not use daemon_start here — every SSE reconnect would add another "FRIDAY ONLINE" divider.
      postEvent('sse_stream_open');
    } else if (event.type === 'speak_style_changed') window.dispatchEvent(new CustomEvent('openclaw:speak-style-changed'));
    else if (event.type === 'echo_personality_changed') window.dispatchEvent(new CustomEvent('openclaw:echo-personality-changed'));
    else if (event.type === 'voice_changed') {
      const ev = event as { voice?: string; text?: string };
      const v = typeof ev.voice === 'string' && ev.voice ? ev.voice : (ev.text || '');
      // Voice changed: update active persona BEFORE any speak event arrives
      postEvent('voice_changed', v);
    } else if (event.type === 'win_notify') {
      const wne = event as { app?: string; title?: string; body?: string };
      postEvent('win_notify', wne.title || '', {
        ...(wne as unknown as Record<string, unknown>),
      } as import('../contexts/VoiceAppContext').VoicePostEventOptions);
    } else if (event.type === 'dnd_changed') {
      const de = event as { dnd?: boolean };
      postEvent('dnd_changed', '', { ...(de as unknown as Record<string, unknown>) } as import('../contexts/VoiceAppContext').VoicePostEventOptions);
    } else if (event.type === 'cursor_agent_done') {
      const ce = event as { task?: string; detail?: string };
      postEvent('cursor_agent_done', ce.task || '', { ...(ce as unknown as Record<string, unknown>) } as import('../contexts/VoiceAppContext').VoicePostEventOptions);
    } else if (event.type === 'music_play') {
      const me = event as { type: string; text?: string; seconds?: number };
      const seconds = typeof me.seconds === 'number' && Number.isFinite(me.seconds) ? me.seconds : 30;
      const caption = typeof me.text === 'string' && me.text.trim() ? me.text.trim() : 'Playing…';
      postEvent('music_play', caption, { musicSeconds: seconds, musicPersonaKey: 'maestro' });
      const line = /^playing/i.test(caption) ? caption : `Playing: ${caption}`;
      addBubble({
        type: 'friday',
        text: line,
        ts: Date.now(),
        persona: mergePersona('maestro', personaOverrides, currentVoice, personaCatalog),
      });
    } else {
      const evTs = typeof event.ts === 'number' ? event.ts : 0;
      const sseStaleSpeak =
        (event.type === 'speak' || event.type === 'thinking') &&
        evTs > 0 &&
        Date.now() - evTs > 240_000;

      // If a speak event carries an explicit voice field, snap persona first
      if ((event.type === 'speak' || event.type === 'thinking') && event.voice) {
        postEvent('voice_changed', String(event.voice));
      }

      const chan = typeof (event as { channel?: string }).channel === 'string'
        ? (event as { channel?: string }).channel
        : undefined;
      const pKey = typeof (event as { personaKey?: string }).personaKey === 'string'
        ? (event as { personaKey?: string }).personaKey
        : undefined;

      if (!sseStaleSpeak) {
        postEvent(event.type, event.text || '', {
          speakChannel: chan,
          speakPersonaKey: pKey,
        });
      } else if (event.type === 'listening' || event.type === 'reply' || event.type === 'error') {
        postEvent(event.type, event.text || '');
      }

      if (!sseStaleSpeak && event.type === 'speak' && (event.text || '').trim()) {
        addBubble({
          type: 'friday',
          text: (event.text || '').trim(),
          ts: Date.now(),
          persona: mergePersona(activePersonaKey, personaOverrides, currentVoice, personaCatalog),
        });
      }
      if (!sseStaleSpeak && (event.type === 'speak' || event.type === 'thinking')) {
        setSpeakingText(event.text || 'Speaking...');
      }
      if (event.type === 'listening' || event.type === 'reply') setSpeakingText('');
      // "Always Speak via UI" — play SSE reply through the browser even when Python daemons are silent
      if (event.type === 'reply' && alwaysSpeakViaUi && event.text?.trim()) {
        fetch('/voice/speak-async', {
          method: 'POST',
          headers: { ...authHeaders() as Record<string, string>, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: event.text }),
        }).catch(() => {});
      }
    }
  });

  const prevConnRef = useRef(connectionStatus);
  useEffect(() => {
    if (prevConnRef.current === 'speaking' && connectionStatus === 'listening') {
      setSpeakingText('');
    }
    prevConnRef.current = connectionStatus;
  }, [connectionStatus]);

  // Auto-scroll chat
  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [bubbles]);

  // Glow anim
  useEffect(() => {
    const anime = (window as any).anime;
    if (!anime || !glowRef.current) return;
    const blob = glowRef.current.querySelector(`.${styles['glow-blob']}`) as HTMLElement;
    if (!blob) return;
    const a = anime({ targets: blob, rotate: 360, duration: 8000, easing: 'linear', loop: true });
    return () => a.pause();
  }, []);

  // @mention filtering
  const filteredMentions = useMemo(() =>
    MENTION_TARGETS.filter(t => t.label.toLowerCase().includes(mentionFilter.toLowerCase())),
    [mentionFilter]
  );

  // Send message
  const handleSend = useCallback(async () => {
    const raw = inputText.trim();
    if (!raw || sending) return;
    clearCelebrationOffer();
    setSending(true);
    setInputText('');
    setShowMentions(false);

    // Parse @mentions
    const mentions = [...raw.matchAll(/@(\w+)/g)].map(m => m[1].toLowerCase());
    const ROUTING_TAGS = new Set(['speak', 'cursor']);
    const personaMention = mentions.find((m) => {
      if (ROUTING_TAGS.has(m)) return false;
      if (m in COMPANY_PERSONAS) return true;
      if (personaCatalog && typeof personaCatalog === 'object' && m in personaCatalog) return true;
      return false;
    });
    const text = raw.replace(/@\w+\s*/g, '').trim() || raw;

    const conversationTail = bubblesToConversationTail(bubbles);

    addBubble({ type: 'user', text: raw, ts: Date.now(), persona: USER_BUBBLE_PERSONA });

    if (mentions.includes('speak')) {
      setSending(false);
      setConnectionStatus('speaking');
      setSpeakingText(text);
      fetch('/voice/speak-async', {
        method: 'POST',
        headers: { ...authHeaders() as Record<string, string>, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
        .then(() => {
          addBubble({
            type: 'friday',
            text: `\uD83D\uDD0A Speaking: "${text}"`,
            ts: Date.now(),
            persona: getReplyPersona(),
          });
        })
        .catch(() => setConnectionStatus('listening'));
      inputRef.current?.focus();
      return;
    }

    setConnectionStatus('processing');
    let pendingJarvisSpeak = false;
    try {
      const res = await fetch('/voice/command', {
        method: 'POST', headers: { ...authHeaders() as Record<string, string> },
        body: JSON.stringify({
          text,
          source: mentions.includes('cursor') ? 'cursor-ui' : 'ui',
          userId: 'friday-ui',
          ...(mentions.includes('cursor') ? { target: 'cursor' } : {}),
          ...(claudeModel ? { claudeModel } : {}),
          ...(conversationTail.length ? { conversationTail } : {}),
          ...(personaMention
            ? { assignedPersona: personaMention, taskAssigned: true }
            : {}),
        }),
      });
      const data = await res.json();
      if (data.summary) {
        const pk =
          typeof data.replyPersonaKey === 'string' ? (data.replyPersonaKey as CompanyPersonaKey) : null;
        const replyVoice =
          typeof data.replyVoice === 'string' && data.replyVoice.trim() ? data.replyVoice.trim() : '';
        const replyPersona =
          pk && personaCatalog
            ? mergePersona(pk, personaOverrides, replyVoice || currentVoice, personaCatalog)
            : getReplyPersona();
        addBubble({ type: 'friday', text: data.summary, ts: Date.now(), persona: replyPersona });
        if (alwaysSpeakViaUi || data.speakAsync !== false) {
          pendingJarvisSpeak = true;
          setConnectionStatus('speaking');
          fetch('/voice/speak-async', {
            method: 'POST', headers: { ...authHeaders() as Record<string, string> },
            body: JSON.stringify({
              text: data.summary,
              ...(replyVoice ? { voice: replyVoice } : {}),
              ...(pk ? { personaKey: pk } : {}),
            }),
          }).catch(() => setConnectionStatus('listening'));
        }
      } else if (data.error) {
        addBubble({ type: 'error', text: data.error, ts: Date.now(), persona: getReplyPersona() });
      }
      if (data.deferredOpenRouter) {
        pendingJarvisSpeak = true;
      }
      if (data.ok && data.celebration?.song && data.celebration?.askText) {
        const cel = data.celebration as CelebrationPayload;
        setCelebrationOffer({
          song: cel.song,
          askText: cel.askText,
          delayMsBeforeAsk: cel.delayMsBeforeAsk ?? 4000,
        });
        celebrationAskTimerRef.current = setTimeout(() => {
          celebrationAskTimerRef.current = null;
          fetch('/voice/speak-async', {
            method: 'POST',
            headers: { ...authHeaders() as Record<string, string> },
            body: JSON.stringify({ text: cel.askText }),
          }).catch(() => {});
        }, cel.delayMsBeforeAsk ?? 4000);
      }
    } catch (err) {
      addBubble({ type: 'error', text: String(err), ts: Date.now(), persona: getReplyPersona() });
    } finally {
      setSending(false);
      if (!pendingJarvisSpeak) {
        setConnectionStatus('listening');
      }
      inputRef.current?.focus();
    }
  }, [
    inputText,
    sending,
    bubbles,
    addBubble,
    setConnectionStatus,
    authHeaders,
    getReplyPersona,
    clearCelebrationOffer,
    claudeModel,
    alwaysSpeakViaUi,
    personaCatalog,
    personaOverrides,
    currentVoice,
  ]);

  const onCelebrationPlay = useCallback(async () => {
    if (celebrationAskTimerRef.current) {
      clearTimeout(celebrationAskTimerRef.current);
      celebrationAskTimerRef.current = null;
    }
    setCelebrationOffer(null);
    try {
      await fetch('/voice/celebration', {
        method: 'POST',
        headers: { ...authHeaders() as Record<string, string>, 'Content-Type': 'application/json' },
        body: JSON.stringify({ accept: true }),
      });
      showToast('Playing celebration clip', 'success');
    } catch {
      showToast('Could not start playback', 'error');
    }
  }, [authHeaders, showToast]);

  const onCelebrationFocus = useCallback(async () => {
    if (celebrationAskTimerRef.current) {
      clearTimeout(celebrationAskTimerRef.current);
      celebrationAskTimerRef.current = null;
    }
    setCelebrationOffer(null);
    try {
      await fetch('/voice/celebration', {
        method: 'POST',
        headers: { ...authHeaders() as Record<string, string>, 'Content-Type': 'application/json' },
        body: JSON.stringify({ accept: false }),
      });
      showToast('Focus recap on speakers', 'info');
    } catch {
      showToast('Focus recap failed', 'error');
    }
  }, [authHeaders, showToast]);

  // Input handling with @mention detection
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setInputText(val);

    // Detect @mention in progress
    const atMatch = val.match(/@(\w*)$/);
    if (atMatch) {
      setShowMentions(true);
      setMentionFilter(atMatch[1]);
      setMentionIdx(0);
    } else {
      setShowMentions(false);
    }
  };

  const insertMention = (target: string) => {
    const newText = inputText.replace(/@\w*$/, `@${target} `);
    setInputText(newText);
    setShowMentions(false);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showMentions && filteredMentions.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIdx(i => Math.min(i + 1, filteredMentions.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIdx(i => Math.max(i - 1, 0)); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && showMentions)) {
        e.preventDefault();
        insertMention(filteredMentions[mentionIdx].id);
        return;
      }
      if (e.key === 'Escape') { setShowMentions(false); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleOrbClick = () => {
    const m = !listenMuted;
    setListenMuted(m);
    showToast(m ? 'Muted' : 'Listening', 'info');
    if (!m) setConnectionStatus('listening');
  };

  const applyVoice = useCallback((v: string, toast: string) => {
    setCurrentVoice(v);
    fetch('/voice/set-voice', {
      method: 'POST',
      headers: { ...authHeaders() as Record<string, string> },
      body: JSON.stringify({ voice: v }),
    })
      .then(() => showToast(toast, 'success'))
      .catch(() => {});
  }, [authHeaders, showToast]);

  const handlePersonaTeamChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const key = e.target.value as CompanyPersonaKey | 'custom';
    setActivePersonaKey(key);
    if (key === 'custom') return;
    const row = personaCatalog?.[key as string];
    const v = (row?.voice?.trim() || COMPANY_PERSONAS[key].voice);
    const nm = row?.name?.trim() || COMPANY_PERSONAS[key].name;
    applyVoice(v, `${nm} · team voice`);
  };

  const handleCatalogueVoiceChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    setActivePersonaKey('custom');
    applyVoice(v, `Catalogue · ${vm(v).shortName}`);
  };

  const handleClaudeModelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    setClaudeModel(v);
    try {
      localStorage.setItem(LS_CLAUDE_MODEL, v);
    } catch {
      /* ignore */
    }
    const label = v === 'auto' ? 'Auto routing — OpenRouter free / Sonnet / Opus by task type'
      : v === 'openrouter-free' ? 'Using OpenRouter free tier for all replies'
      : 'Claude model updated';
    showToast(label, 'info');
  };

  const handleFileClick = () => fileRef.current?.click();
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    showToast(`File: ${file.name} (${(file.size / 1024).toFixed(1)}KB)`, 'info');
    // Future: upload to server or attach to command
    addBubble({ type: 'user', text: `\uD83D\uDCCE Attached: ${file.name}`, ts: Date.now(), persona: USER_BUBBLE_PERSONA });
    e.target.value = '';
  };

  const isConnected = connectionStatus !== 'offline';
  const stateIcons: Record<string, string> = { offline: '\u2606', listening: '\uD83C\uDF99\uFE0F', processing: '\u26A1', speaking: '\uD83D\uDD0A' };
  const statusLabels: Record<string, string> = { offline: 'Offline', listening: 'Listening', processing: 'Thinking...', speaking: 'Speaking' };
  const headerStatusLabel =
    connectionStatus === 'speaking' && peripheralSpeak
      ? peripheralSpeak.channel === 'mail'
        ? 'Speaking · Mail'
        : 'Speaking · WhatsApp'
      : statusLabels[connectionStatus];
  const curMeta = vm(currentVoice);
  const replyPersona = mergePersona(activePersonaKey, personaOverrides, currentVoice, personaCatalog);

  // Sidebar orb: use the speaking persona's colour + icon while TTS is active
  const speakOrbPalette = speakingPersonaKey
    ? (speakingPersonaKey === 'custom' ? PERSONA_ORB_PALETTES.custom : (PERSONA_ORB_PALETTES[speakingPersonaKey] ?? PERSONA_ORB_PALETTES.jarvis))
    : null;
  const speakOrbIcon = speakingPersonaKey ? personaIcon(speakingPersonaKey) : null;
  const speakOrbName = speakingPersonaKey && speakingPersonaKey !== 'custom'
    ? (personaCatalog?.[speakingPersonaKey]?.name?.trim() || COMPANY_PERSONAS[speakingPersonaKey].name)
    : null;

  const formatTime = (ts: number) => new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  const timeAgo = (iso: string) => {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m`;
    return `${Math.floor(ms / 3600000)}h`;
  };

  return (
    <div className={`${styles.app} ${theme === 'light' ? styles.light : ''}`}>
      {launchOverlayVisible && (
        <LaunchOverlay onFadeComplete={() => setLaunchOverlayVisible(false)} />
      )}
      <VoiceSiriOverlay
        open={connectionStatus === 'speaking' && !peripheralSpeak}
        theme={theme}
        caption={(speakingText.trim() || musicOrbCaption.trim()) || undefined}
        personaKey={speakingPersonaKey}
        personaName={
          speakingPersonaKey && speakingPersonaKey !== 'custom'
            ? (personaCatalog?.[speakingPersonaKey]?.name?.trim() || COMPANY_PERSONAS[speakingPersonaKey].name)
            : undefined
        }
        personaTitle={
          speakingPersonaKey && speakingPersonaKey !== 'custom'
            ? (personaCatalog?.[speakingPersonaKey]?.title?.trim() || COMPANY_PERSONAS[speakingPersonaKey].title)
            : undefined
        }
      />
      <MiniNotifyOrb
        visible={miniOrb != null}
        icon={miniOrb?.icon ?? '\u2728'}
        caption={miniOrb?.caption ?? ''}
        personaKey={miniOrb?.personaKey ?? 'jarvis'}
        theme={theme}
        onDismiss={dismissMiniOrb}
      />
      {/* Glow */}
      <div ref={glowRef} className={`${styles['glow-wrap']} ${styles[`glow-${connectionStatus}`]}`}>
        <div className={styles['glow-blob']} />
        <div className={styles['glow-bloom']} />
      </div>

      {/* Top bar */}
      <div className={styles['top-bar']}>
        <div className={styles['top-left']}>
          <span className={styles['brand-text']}>Friday</span>
          <div className={`${styles['status-pill']} ${styles[`status-pill--${connectionStatus}`]}`}>
            <div className={`${styles['status-dot']} ${isConnected ? styles.active : ''}`} />
            <span>{headerStatusLabel}</span>
          </div>
          <span className={styles['top-meta']}>UP {uptime}</span>
        </div>
        {/* Music search bar */}
        <div className={styles['top-music-slot']}>
          <TopMusicDock
            theme={theme}
            musicOrbCaption={musicOrbCaption}
            speakingPersonaKey={speakingPersonaKey}
            authHeaders={authHeaders}
            showToast={showToast}
          />
        </div>
        <div className={styles['top-right']}>
          {isNarrow && (
            <button
              type="button"
              className={styles['top-btn']}
              onClick={() => setIntegrationsDrawerOpen(true)}
              title="Mail and WhatsApp"
            >
              {'\uD83D\uDCE7'}
            </button>
          )}
          <span className={styles['top-meta']}>{exchanges} msgs</span>
          <button
            className={`${styles['top-btn']} ${alwaysSpeakViaUi ? styles['top-btn-active'] : ''}`}
            onClick={toggleAlwaysSpeak}
            title={alwaysSpeakViaUi ? 'Always Speak via UI — ON (click to turn off)' : 'Always Speak via UI — OFF (click to enable)'}
            aria-pressed={alwaysSpeakViaUi}
          >
            {alwaysSpeakViaUi ? '\uD83D\uDD0A' : '\uD83D\uDD07'}
          </button>
          <button
            className={`${styles['top-btn']} ${dnd ? styles['top-btn-dnd'] : ''}`}
            onClick={() => { setDnd(!dnd); showToast(dnd ? 'Do Not Disturb off' : 'Do Not Disturb on — speech silenced', dnd ? 'info' : 'success'); }}
            title={dnd ? 'Do Not Disturb ON — click to disable' : 'Do Not Disturb OFF — click to enable'}
            aria-pressed={dnd}
          >
            {dnd ? '\uD83D\uDD15' : '\uD83D\uDD14'}
          </button>
          {/* Agent counts (derived from session poll — always visible once sessions load) */}
          {(() => {
            const working = sessions.filter((s) => s.status === 'active').length;
            const free    = sessions.filter((s) => s.status === 'idle').length;
            if (sessions.length === 0) return null;
            return (
              <button
                type="button"
                className={`${styles['top-btn']} ${styles['top-btn-agents']} ${cursorDoneNotifications.length > 0 ? styles['top-btn-agents-done'] : ''}`}
                onClick={() => setAgentPanelOpen((v) => !v)}
                title={`${working} working · ${free} free — click to see Cursor agent completions`}
              >
                <span className={styles['agent-working-dot']} />
                {working > 0 ? `${working}W` : '0W'}
                {' · '}
                {free > 0 ? `${free}F` : '0F'}
                {cursorDoneNotifications.length > 0 && (
                  <span className={styles['agent-done-badge']}>{cursorDoneNotifications.length > 9 ? '9+' : cursorDoneNotifications.length}</span>
                )}
              </button>
            );
          })()}
          {winNotifications.length > 0 && (
            <button
              className={`${styles['top-btn']} ${styles['top-btn-notify']}`}
              onClick={() => setWinNotifyPanelOpen((v) => !v)}
              title="Windows notifications"
              aria-label={`${winNotifications.length} Windows notification${winNotifications.length === 1 ? '' : 's'}`}
            >
              {'🪟'}
              <span className={styles['notify-badge']}>{winNotifications.length > 9 ? '9+' : winNotifications.length}</span>
            </button>
          )}
          <button className={styles['top-btn']} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? '\u2600\uFE0F' : '\uD83C\uDF19'}
          </button>
          <SpeakStylePanel showToast={showToast} />
          <EchoPersonalityPanel showToast={showToast} edgeVoices={edgeVoices} theme={theme} />
        </div>
      </div>

      {openclawStrip && (
        <div className={styles['openclaw-status-bar']} role="status" aria-live="polite">
          <span className={styles['openclaw-status-brand']}>OpenClaw</span>
          <span className={openclawStrip.gwOk ? styles['oc-ok'] : styles['oc-bad']}>
            gateway {openclawStrip.gwOk ? 'OK' : 'down'}
          </span>
          <span className={openclawStrip.agentOk ? styles['oc-ok'] : styles['oc-bad']}>
            agent {openclawStrip.agentOk ? 'OK' : 'down'}
          </span>
          {openclawStrip.roleCount > 0 && (
            <span className={styles['oc-meta']}>
              roster {openclawStrip.roleCount}
              {openclawStrip.fromDb ? ' · Postgres' : ' · defaults'}
            </span>
          )}
          {openclawStrip.err && <span className={styles['oc-err']}>{openclawStrip.err}</span>}
          {(() => {
            const working = sessions.filter((s) => s.status === 'active').length;
            const free = sessions.filter((s) => s.status === 'idle').length;
            return (
              <button
                type="button"
                className={styles['oc-agents-btn']}
                onClick={() => setAgentPanelOpen(true)}
                title="Click to view detailed agent panel"
              >
                <span className={styles['oc-agents-icon']}>⚡</span>
                <span>{working} working</span>
                <span className={styles['oc-agents-sep']}>·</span>
                <span>{free} free</span>
              </button>
            );
          })()}
        </div>
      )}

      {/* Main layout: sidebar + chat */}
      <div className={styles['main-layout']}>
        {/* Left sidebar: orb + sessions */}
        <div className={styles.sidebar}>
          {/* Orb */}
          <div
            className={`${styles['orb-area']} ${styles[`orb-${connectionStatus}`]} ${
              connectionStatus === 'listening' && !listenMuted ? styles['orb-siri-listen'] : ''
            }`}
            style={
              speakOrbPalette
                ? ({ '--orb-persona-color': speakOrbPalette.primary } as React.CSSProperties)
                : undefined
            }
            onClick={handleOrbClick}
            role="button"
            tabIndex={0}
          >
            <div className={styles['orb-circle']}>
              <span
                className={`${styles['orb-icon']} ${listenMuted ? styles['orb-icon-muted'] : ''}`}
                style={speakOrbPalette ? { color: speakOrbPalette.primary, filter: `drop-shadow(0 0 8px ${speakOrbPalette.primary})` } : undefined}
              >
                {listenMuted ? '\u2298' : (speakOrbIcon && connectionStatus === 'speaking' ? speakOrbIcon : stateIcons[connectionStatus])}
              </span>
              {connectionStatus === 'listening' && !listenMuted && <Waveform />}
            </div>
          </div>
          <div
            className={styles['orb-label']}
            style={speakOrbPalette && connectionStatus === 'speaking' ? { color: speakOrbPalette.primary } : undefined}
          >
            {listenMuted ? 'Muted' : (speakOrbName && connectionStatus === 'speaking' ? speakOrbName : statusLabels[connectionStatus])}
          </div>

          {/* Speaking indicator */}
          {speakingText && (
            <div className={styles['speaking-indicator']}>
              <div className={styles['speaking-bars']}>
                <span /><span /><span /><span />
              </div>
              <span className={styles['speaking-text']}>{speakingText.slice(0, 60)}{speakingText.length > 60 ? '...' : ''}</span>
            </div>
          )}

          {/* Sessions */}
          <div className={styles['sessions-section']}>
            <div className={styles['sessions-heading']}>Sessions</div>
            {sessions.map(s => {
              const ctxLabel = CTX[s.context] || { label: s.context, desc: '' };
              const meta = vm(s.voice);
              return (
                <div key={s.context} className={styles['session-row']}>
                  <span className={styles['session-icon']} style={{ color: meta.color }}>{meta.icon}</span>
                  <div className={styles['session-details']}>
                    <div className={styles['session-label']}>{ctxLabel.label}</div>
                    <div className={styles['session-desc']}>{meta.shortName}</div>
                  </div>
                  <div className={styles['session-right']}>
                    <span className={`${styles['session-status']} ${styles[`session-${s.status}`]}`} />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Team speaker + voice pool */}
          <div className={styles['voice-card']}>
            <div className={styles['voice-card-top']}>
              <span className={styles['voice-card-icon']} style={{ color: curMeta.color }}>{curMeta.icon}</span>
              <div className={styles['voice-card-info']}>
                <span className={styles['voice-card-name']}>{replyPersona.name}</span>
                <span className={styles['voice-card-role']}>{replyPersona.title}</span>
              </div>
            </div>
            <div className={styles['voice-card-row-label']}>Who speaks (default replies)</div>
            <select
              className={styles['voice-card-select']}
              value={activePersonaKey}
              onChange={handlePersonaTeamChange}
              aria-label="Team speaker"
            >
              {SPEAKING_PERSONA_ORDER.map((key) => {
                const p = mergePersona(key, personaOverrides, currentVoice, personaCatalog);
                return (
                  <option key={key} value={key}>
                    {p.name} — {p.title}
                  </option>
                );
              })}
              <option value="custom">Custom — catalogue only</option>
            </select>
            <div className={styles['voice-card-row-label']}>Edge voice catalogue</div>
            <select
              className={styles['voice-card-select']}
              value={currentVoice}
              onChange={handleCatalogueVoiceChange}
              aria-label="Edge TTS voice"
            >
              {(edgeVoices as EdgeVoice[]).map((v) => (
                <option key={v.voice} value={v.voice}>
                  {vm(v.voice).shortName} — {v.lang} {v.gender}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={styles['voice-card-edit-roster']}
              onClick={() => setPersonaModalOpen(true)}
            >
              Edit designations &amp; descriptions
            </button>
            <div className={styles['voice-card-row-label']}>Claude model (chat)</div>
            <select
              className={styles['voice-card-select']}
              value={claudeModel}
              onChange={handleClaudeModelChange}
              aria-label="Claude or OpenRouter model"
            >
              <option value="auto">Auto — smart routing (free / Sonnet / Opus)</option>
              <option value="haiku">Haiku — fastest</option>
              <option value="sonnet">Sonnet — coding and technical</option>
              <option value="opus">Opus — research and deep reasoning</option>
              <option value="openrouter-free">OpenRouter free — simple chat only</option>
              <option value="inherit">CLI default — no dash dash model</option>
            </select>
          </div>
        </div>

        {/* Right: Chat area */}
        <div className={styles['chat-area']}>
          <div className={styles['chat-header']}>
            <span className={styles['chat-title']}>Friday Chat</span>
            <span className={styles['chat-subtitle']}>Type a message or use @cursor, @speak, @all</span>
          </div>

          {/* Messages */}
          <div className={styles['chat-messages']} ref={chatRef}>
            {bubbles.length === 0 && (
              <div className={styles['chat-empty']}>
                <div className={styles['chat-empty-icon']}>{stateIcons[connectionStatus]}</div>
                <div className={styles['chat-empty-text']}>Start a conversation</div>
                <div className={styles['chat-empty-hint']}>
                  Type a message below or use voice commands.
                  Try <strong>@cursor</strong> to send to IDE, <strong>@speak</strong> to say aloud.
                </div>
              </div>
            )}
            {bubbles.map(b => {
              if (b.type === 'divider') return (
                <div key={b.id} className={styles['chat-divider']}>
                  <span>{b.text}</span>
                </div>
              );
              const isFriday = b.type === 'friday';
              const isError = b.type === 'error';
              const isUser = b.type === 'user';
              const av = b.persona?.voice ? vm(b.persona.voice) : curMeta;
              // Check if this message's voice is currently speaking
              const isCurrentlySpeaking = isFriday && b.persona?.voice &&
                connectionStatus === 'speaking' && speakingPersonaKey &&
                inferPersonaKeyFromVoice(b.persona.voice, personaCatalog) === speakingPersonaKey;
              return (
                <div key={b.id} className={`${styles['chat-msg']} ${styles[`msg-${b.type}`]}`}>
                  {(isFriday || isError) && (
                    <div className={styles['msg-avatar']}>
                      {isError ? (
                        <div style={{ fontSize: '1.5rem' }}>⚠️</div>
                      ) : isFriday && b.persona?.voice ? (
                        <AnimatedAvatar
                          voiceId={b.persona.voice}
                          isSpeaking={isCurrentlySpeaking}
                          size="small"
                          showLabel={false}
                        />
                      ) : (
                        av.icon
                      )}
                    </div>
                  )}
                  <div className={styles['msg-content']}>
                    {isFriday && (
                      <>
                        <span className={styles['msg-sender']}>{b.persona?.name || 'Friday'}</span>
                        {b.persona && (
                          <>
                            <div className={styles['msg-persona-meta']}>
                              <span>{b.persona.title}</span>
                              <span className={styles['msg-persona-dot']}>·</span>
                              <span>
                                Voice {shortVoiceLabel(b.persona.voice)}
                                {b.persona.voice ? ` (${b.persona.voice})` : ''}
                              </span>
                            </div>
                            {b.persona.personality ? (
                              <div className={styles['msg-persona-desc']}>{b.persona.personality}</div>
                            ) : null}
                          </>
                        )}
                      </>
                    )}
                    {isError && (
                      <>
                        <span className={styles['msg-sender']} style={{ color: '#ff4d6a' }}>
                          {b.persona?.name ? `${b.persona.name} (error)` : 'Error'}
                        </span>
                        {b.persona ? (
                          <div className={styles['msg-persona-meta']}>
                            <span>{b.persona.title}</span>
                            <span className={styles['msg-persona-dot']}>·</span>
                            <span>Voice {shortVoiceLabel(b.persona.voice)}</span>
                          </div>
                        ) : null}
                      </>
                    )}
                    {isUser && (
                      <>
                        <span className={styles['msg-sender']}>{b.persona?.name || 'You'}</span>
                        {b.persona ? (
                          <>
                            <div className={styles['msg-persona-meta']}>
                              <span>{b.persona.title}</span>
                              <span className={styles['msg-persona-dot']}>·</span>
                              <span>{b.persona.voice}</span>
                            </div>
                            {b.persona.personality ? (
                              <div className={styles['msg-persona-desc']}>{b.persona.personality}</div>
                            ) : null}
                          </>
                        ) : null}
                      </>
                    )}
                    <div className={styles['msg-bubble']}>{b.text}</div>
                    <span className={styles['msg-time']}>{formatTime(b.ts)}</span>
                  </div>
                  {isUser && (
                    <div className={styles['msg-avatar-user']}>You</div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Input area */}
          <div className={styles['chat-input-area']}>
            {celebrationOffer && (
              <div className={styles['celebration-bar']} role="region" aria-label="Task complete — optional music">
                <span className={styles['celebration-bar-text']}>
                  Task wrapped — optional clip: <strong>{celebrationOffer.song}</strong>. Tap Play after the summary, or Focus for a quick voice recap of the busiest channels.
                </span>
                <div className={styles['celebration-bar-actions']}>
                  <button type="button" className={`${styles['celebration-bar-btn']} ${styles['celebration-bar-btn-play']}`} onClick={onCelebrationPlay}>
                    Play clip
                  </button>
                  <button type="button" className={`${styles['celebration-bar-btn']} ${styles['celebration-bar-btn-focus']}`} onClick={onCelebrationFocus}>
                    Focus recap
                  </button>
                  <button type="button" className={`${styles['celebration-bar-btn']} ${styles['celebration-bar-btn-dismiss']}`} onClick={clearCelebrationOffer}>
                    Dismiss
                  </button>
                </div>
              </div>
            )}
            {/* @mention autocomplete */}
            {showMentions && filteredMentions.length > 0 && (
              <div className={styles['mention-popup']}>
                {filteredMentions.map((t, i) => (
                  <div
                    key={t.id}
                    className={`${styles['mention-item']} ${i === mentionIdx ? styles['mention-active'] : ''}`}
                    onClick={() => insertMention(t.id)}
                    onMouseEnter={() => setMentionIdx(i)}
                  >
                    <span className={styles['mention-icon']}>{t.icon}</span>
                    <div className={styles['mention-info']}>
                      <span className={styles['mention-label']}>@{t.label}</span>
                      <span className={styles['mention-desc']}>{t.desc}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className={styles['chat-input-row']}>
              <button className={styles['attach-btn']} onClick={handleFileClick} title="Attach file">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
              </button>
              <input type="file" ref={fileRef} onChange={handleFileChange} style={{ display: 'none' }} />
              <input
                ref={inputRef}
                className={styles['chat-input']}
                type="text"
                placeholder="Message Friday... (@ for mentions)"
                value={inputText}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                disabled={sending}
                autoComplete="off"
              />
              <button className={styles['send-btn']} onClick={handleSend}
                disabled={!inputText.trim() || sending}>
                {sending ? '\u23F3' : '\u2191'}
              </button>
            </div>
          </div>
        </div>

        <IntegrationsRail
          authHeaders={authHeaders}
          showToast={showToast}
          theme={theme}
          drawerOpen={integrationsDrawerOpen}
          onDrawerClose={() => setIntegrationsDrawerOpen(false)}
          isNarrow={isNarrow}
          peripheralSpeak={peripheralSpeak}
          speakingPersonaKey={speakingPersonaKey}
        />
      </div>

      <PersonaRosterModal
        open={personaModalOpen}
        onClose={() => setPersonaModalOpen(false)}
        theme={theme}
        onSaved={refreshPersonaOverrides}
      />

      {/* Windows Notification Panel */}
      {winNotifyPanelOpen && (
        <div className={`${styles['win-notify-panel']} ${theme === 'light' ? styles['win-notify-panel-light'] : ''}`}>
          <div className={styles['win-notify-head']}>
            <span>{'🪟'} Windows Notifications</span>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              {winNotifications.length > 0 && (
                <button
                  type="button"
                  className={styles['win-notify-clear']}
                  onClick={() => winNotifications.forEach((n) => dismissWinNotification(n.id))}
                >
                  Clear all
                </button>
              )}
              <button
                type="button"
                className={styles['win-notify-close']}
                onClick={() => setWinNotifyPanelOpen(false)}
                aria-label="Close notifications"
              >
                ✕
              </button>
            </div>
          </div>
          <div className={styles['win-notify-list']}>
            {winNotifications.length === 0 ? (
              <div className={styles['win-notify-empty']}>No notifications yet</div>
            ) : (
              winNotifications.map((n) => (
                <div key={n.id} className={styles['win-notify-row']}>
                  <div className={styles['win-notify-row-head']}>
                    <span className={styles['win-notify-app']}>{n.app}</span>
                    <span className={styles['win-notify-time']}>
                      {new Date(n.ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}
                    </span>
                    <button
                      type="button"
                      className={styles['win-notify-dismiss']}
                      onClick={() => dismissWinNotification(n.id)}
                      aria-label="Dismiss"
                    >✕</button>
                  </div>
                  {n.title && <div className={styles['win-notify-title']}>{n.title}</div>}
                  {n.body && n.body !== n.title && (
                    <div className={styles['win-notify-body']}>{n.body}</div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Agent Panel — Cursor done notifications + live working/free counts */}
      {agentPanelOpen && (() => {
        const working = sessions.filter((s) => s.status === 'active').length;
        const free    = sessions.filter((s) => s.status === 'idle').length;
        return (
          <div className={`${styles['agent-panel']} ${theme === 'light' ? styles['agent-panel-light'] : ''}`}>
            <div className={styles['agent-panel-head']}>
              <span>{'⚡'} Agents</span>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                <span className={styles['agent-count-working']}>{working} working</span>
                <span className={styles['agent-count-free']}>{free} free</span>
                {cursorDoneNotifications.length > 0 && (
                  <button type="button" className={styles['agent-panel-clear']} onClick={clearAllCursorDone}>
                    Clear
                  </button>
                )}
                <button type="button" className={styles['agent-panel-close']} onClick={() => setAgentPanelOpen(false)} aria-label="Close">✕</button>
              </div>
            </div>
            <div className={styles['agent-sessions-row']}>
              {sessions.map((s) => (
                <span
                  key={s.context}
                  className={`${styles['agent-session-chip']} ${s.status === 'active' ? styles['agent-session-active'] : styles['agent-session-idle']}`}
                  title={`${s.context} · ${s.voice || 'no voice'} · ${s.status}`}
                >
                  {s.context.replace('cursor:', '').replace('api', 'listen')}
                </span>
              ))}
            </div>
            <div className={styles['agent-done-list']}>
              {cursorDoneNotifications.length === 0 ? (
                <div className={styles['agent-done-empty']}>No agent completions yet</div>
              ) : (
                cursorDoneNotifications.map((n) => (
                  <div key={n.id} className={styles['agent-done-row']}>
                    <div className={styles['agent-done-row-head']}>
                      <span className={styles['agent-done-check']}>{'✓'}</span>
                      <span className={styles['agent-done-time']}>
                        {new Date(n.ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}
                      </span>
                      <button type="button" className={styles['agent-done-dismiss']} onClick={() => dismissCursorDone(n.id)} aria-label="Dismiss">✕</button>
                    </div>
                    <div className={styles['agent-done-task']}>{n.task}</div>
                    {n.detail && n.detail !== n.task && (
                      <div className={styles['agent-done-detail']}>{n.detail}</div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        );
      })()}

      <ToastContainer />
    </div>
  );
};

/* ── Waveform ─────────────────────────────────────────────── */
const Waveform: React.FC = () => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const anime = (window as any).anime;
    if (!anime || !ref.current) return;
    const bars = ref.current.querySelectorAll(`.${styles['wave-bar']}`);
    if (!bars.length) return;
    const a = anime({ targets: bars, scaleY: [0.3, 1], duration: 800, easing: 'easeInOutSine',
      delay: (_el: Element, i: number) => i * 80, direction: 'alternate', loop: true });
    return () => a.pause();
  }, []);
  return (
    <div ref={ref} className={styles['waveform-container']}>
      <svg className={styles.waveform} viewBox="0 0 84 16" preserveAspectRatio="xMidYMax meet">
        {Array.from({ length: 9 }).map((_, i) => (
          <rect key={i} className={styles['wave-bar']} x={i * 9 + 1} y={3} width={5} height={10} rx={2} />
        ))}
      </svg>
    </div>
  );
};

export default FridayListenApp;
