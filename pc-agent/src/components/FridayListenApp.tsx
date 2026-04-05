import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useVoiceApp } from '../contexts/VoiceAppContext';
import { useSSEStream } from '../hooks/useSSEStream';
import { useUptime } from '../hooks/useUptime';
import ToastContainer from './Toast';
import SpeakStylePanel from './SpeakStylePanel';
import styles from '../styles/listen.module.css';

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

/* ═══ Main App ════════════════════════════════════════════════ */
const FridayListenApp: React.FC = () => {
  const {
    postEvent, setEdgeVoices, theme, setTheme,
    connectionStatus, setConnectionStatus,
    listenMuted, setListenMuted,
    exchanges, lastHeardText,
    edgeVoices, currentVoice, setCurrentVoice,
    bubbles, addBubble, showToast, setUptime,
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
  const [uptime] = useUptime(setUptime);

  // Fetch voices
  useEffect(() => {
    fetch('/voice/voices', { headers: authHeaders() }).then(r => r.json())
      .then(d => { if (d.voices) setEdgeVoices(d.voices); if (d.active) setCurrentVoice(d.active); })
      .catch(() => {});
  }, [setEdgeVoices, setCurrentVoice, authHeaders]);

  // Poll sessions
  useEffect(() => {
    const poll = () => fetch('/voice/status', { headers: authHeaders() }).then(r => r.json())
      .then(d => { if (d.ok) setSessions(d.contexts || []); }).catch(() => {});
    poll();
    const iv = setInterval(poll, 5000);
    return () => clearInterval(iv);
  }, [authHeaders]);

  // SSE
  useSSEStream((event) => {
    if (event.type === 'sse_disconnected') postEvent('daemon_disconnect');
    else if (event.type === 'sse_connected') postEvent('daemon_start', 'Voice daemon online.');
    else if (event.type === 'speak_style_changed') window.dispatchEvent(new CustomEvent('openclaw:speak-style-changed'));
    else {
      postEvent(event.type, event.text || '');
      // Track speaking state
      if (event.type === 'speak' || event.type === 'thinking') setSpeakingText(event.text || 'Speaking...');
      if (event.type === 'listening' || event.type === 'reply') setSpeakingText('');
    }
  });

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
    setSending(true);
    setInputText('');
    setShowMentions(false);

    // Parse @mentions
    const mentions = [...raw.matchAll(/@(\w+)/g)].map(m => m[1].toLowerCase());
    const text = raw.replace(/@\w+\s*/g, '').trim() || raw;

    addBubble({ type: 'user', text: raw, ts: Date.now() });

    // If @speak — just speak the text directly
    if (mentions.includes('speak')) {
      fetch('/voice/speak-async', {
        method: 'POST', headers: { ...authHeaders() as Record<string, string> },
        body: JSON.stringify({ text }),
      }).then(() => {
        addBubble({ type: 'friday', text: `\uD83D\uDD0A Speaking: "${text}"`, ts: Date.now() });
      }).catch(() => {});
      setSending(false);
      setConnectionStatus('speaking');
      setTimeout(() => setConnectionStatus('listening'), 3000);
      return;
    }

    setConnectionStatus('processing');
    try {
      const res = await fetch('/voice/command', {
        method: 'POST', headers: { ...authHeaders() as Record<string, string> },
        body: JSON.stringify({
          text,
          source: mentions.includes('cursor') ? 'cursor-ui' : 'ui',
          userId: 'friday-ui',
          ...(mentions.includes('cursor') ? { target: 'cursor' } : {}),
        }),
      });
      const data = await res.json();
      if (data.summary) {
        addBubble({ type: 'friday', text: data.summary, ts: Date.now() });
        // Auto-speak response
        fetch('/voice/speak-async', {
          method: 'POST', headers: { ...authHeaders() as Record<string, string> },
          body: JSON.stringify({ text: data.summary }),
        }).catch(() => {});
      } else if (data.error) {
        addBubble({ type: 'error', text: data.error, ts: Date.now() });
      }
    } catch (err) {
      addBubble({ type: 'error', text: String(err), ts: Date.now() });
    } finally {
      setSending(false);
      setConnectionStatus('listening');
      inputRef.current?.focus();
    }
  }, [inputText, sending, addBubble, setConnectionStatus, authHeaders]);

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

  const handleVoiceChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    setCurrentVoice(v);
    fetch('/voice/set-voice', { method: 'POST', headers: { ...authHeaders() as Record<string, string> }, body: JSON.stringify({ voice: v }) })
      .then(() => showToast(`Voice: ${vm(v).shortName}`, 'success')).catch(() => {});
  };

  const handleFileClick = () => fileRef.current?.click();
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    showToast(`File: ${file.name} (${(file.size / 1024).toFixed(1)}KB)`, 'info');
    // Future: upload to server or attach to command
    addBubble({ type: 'user', text: `\uD83D\uDCCE Attached: ${file.name}`, ts: Date.now() });
    e.target.value = '';
  };

  const isConnected = connectionStatus !== 'offline';
  const stateIcons: Record<string, string> = { offline: '\u2606', listening: '\uD83C\uDF99\uFE0F', processing: '\u26A1', speaking: '\uD83D\uDD0A' };
  const statusLabels: Record<string, string> = { offline: 'Offline', listening: 'Listening', processing: 'Thinking...', speaking: 'Speaking' };
  const curMeta = vm(currentVoice);

  const formatTime = (ts: number) => new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  const timeAgo = (iso: string) => {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m`;
    return `${Math.floor(ms / 3600000)}h`;
  };

  return (
    <div className={`${styles.app} ${theme === 'light' ? styles.light : ''}`}>
      {/* Glow */}
      <div ref={glowRef} className={`${styles['glow-wrap']} ${styles[`glow-${connectionStatus}`]}`}>
        <div className={styles['glow-blob']} />
        <div className={styles['glow-bloom']} />
      </div>

      {/* Top bar */}
      <div className={styles['top-bar']}>
        <div className={styles['top-left']}>
          <span className={styles['brand-text']}>Friday</span>
          <div className={styles['status-pill']}>
            <div className={`${styles['status-dot']} ${isConnected ? styles.active : ''}`} />
            <span>{statusLabels[connectionStatus]}</span>
          </div>
          <span className={styles['top-meta']}>UP {uptime}</span>
        </div>
        <div className={styles['top-right']}>
          <span className={styles['top-meta']}>{exchanges} msgs</span>
          <button className={styles['top-btn']} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? '\u2600\uFE0F' : '\uD83C\uDF19'}
          </button>
          <SpeakStylePanel showToast={showToast} />
        </div>
      </div>

      {/* Main layout: sidebar + chat */}
      <div className={styles['main-layout']}>
        {/* Left sidebar: orb + sessions */}
        <div className={styles.sidebar}>
          {/* Orb */}
          <div className={`${styles['orb-area']} ${styles[`orb-${connectionStatus}`]}`}
            onClick={handleOrbClick} role="button" tabIndex={0}>
            <div className={styles['orb-circle']}>
              <span className={`${styles['orb-icon']} ${listenMuted ? styles['orb-icon-muted'] : ''}`}>
                {listenMuted ? '\u2298' : stateIcons[connectionStatus]}
              </span>
              {connectionStatus === 'listening' && !listenMuted && <Waveform />}
            </div>
          </div>
          <div className={styles['orb-label']}>
            {listenMuted ? 'Muted' : statusLabels[connectionStatus]}
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

          {/* Voice picker */}
          <div className={styles['voice-card']}>
            <div className={styles['voice-card-top']}>
              <span className={styles['voice-card-icon']} style={{ color: curMeta.color }}>{curMeta.icon}</span>
              <div className={styles['voice-card-info']}>
                <span className={styles['voice-card-name']}>{curMeta.shortName}</span>
                <span className={styles['voice-card-role']}>Active voice</span>
              </div>
            </div>
            <select className={styles['voice-card-select']} value={currentVoice} onChange={handleVoiceChange}>
              {(edgeVoices as EdgeVoice[]).map(v => (
                <option key={v.voice} value={v.voice}>{vm(v.voice).shortName} - {v.lang} {v.gender}</option>
              ))}
            </select>
          </div>

          {/* Sessions */}
          <div className={styles['sessions-section']}>
            <div className={styles['sessions-heading']}>Sessions</div>
            {sessions.map(s => {
              const meta = vm(s.voice);
              const ctx = CTX[s.context] || { label: s.context, desc: '' };
              return (
                <div key={s.context} className={`${styles['session-row']} ${s.status === 'active' ? styles['session-active'] : ''}`}>
                  <span className={styles['session-icon']} style={{ color: meta.color }}>{meta.icon}</span>
                  <div className={styles['session-details']}>
                    <span className={styles['session-ctx']}>{ctx.label}</span>
                    <span className={styles['session-voice-name']}>{meta.shortName}</span>
                  </div>
                  <div className={styles['session-right']}>
                    <span className={`${styles['session-dot']} ${s.status === 'active' ? styles['dot-on'] : ''}`} />
                    <span className={styles['session-ago']}>{timeAgo(s.last_used)}</span>
                  </div>
                </div>
              );
            })}
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
              return (
                <div key={b.id} className={`${styles['chat-msg']} ${styles[`msg-${b.type}`]}`}>
                  {(isFriday || isError) && (
                    <div className={styles['msg-avatar']}>
                      {isError ? '\u26A0\uFE0F' : curMeta.icon}
                    </div>
                  )}
                  <div className={styles['msg-content']}>
                    {isFriday && <span className={styles['msg-sender']}>Friday</span>}
                    {isError && <span className={styles['msg-sender']} style={{ color: '#ff4d6a' }}>Error</span>}
                    <div className={styles['msg-bubble']}>{b.text}</div>
                    <span className={styles['msg-time']}>{formatTime(b.ts)}</span>
                  </div>
                  {b.type === 'user' && (
                    <div className={styles['msg-avatar-user']}>You</div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Input area */}
          <div className={styles['chat-input-area']}>
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
      </div>

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
