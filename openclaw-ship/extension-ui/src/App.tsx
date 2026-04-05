import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const LS_BASE = 'openclaw.extension.agentBaseUrl';
const LS_BEARER = 'openclaw.extension.bearer';

type Bubble = { id: string; role: 'user' | 'friday' | 'sys' | 'err'; text: string; ts: number };

function normalizeBase(url: string): string {
  return url.replace(/\/+$/, '') || 'http://127.0.0.1:3847';
}

function isExtension(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
}

async function storageGet(): Promise<{ baseUrl: string; bearer: string }> {
  if (isExtension() && chrome.storage?.local) {
    return new Promise((resolve) => {
      chrome.storage.local.get([LS_BASE, LS_BEARER], (r) => {
        resolve({
          baseUrl: normalizeBase(String(r[LS_BASE] || 'http://127.0.0.1:3847')),
          bearer: String(r[LS_BEARER] || ''),
        });
      });
    });
  }
  return {
    baseUrl: normalizeBase(localStorage.getItem(LS_BASE) || 'http://127.0.0.1:3847'),
    bearer: localStorage.getItem(LS_BEARER) || '',
  };
}

async function storageSet(baseUrl: string, bearer: string): Promise<void> {
  const b = normalizeBase(baseUrl);
  if (isExtension() && chrome.storage?.local) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [LS_BASE]: b, [LS_BEARER]: bearer }, () => resolve());
    });
  }
  localStorage.setItem(LS_BASE, b);
  localStorage.setItem(LS_BEARER, bearer);
}

/** Dev: Vite proxy — use same origin. Prod/extension: full agent URL. */
function apiOrigin(baseUrl: string): string {
  if (import.meta.env.DEV) return '';
  return baseUrl;
}

function authHeaders(bearer: string): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'ngrok-skip-browser-warning': '1',
  };
  if (bearer.trim()) h.Authorization = `Bearer ${bearer.trim()}`;
  return h;
}

export default function App() {
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:3847');
  const [bearer, setBearer] = useState('');
  const [draftBase, setDraftBase] = useState('http://127.0.0.1:3847');
  const [draftBearer, setDraftBearer] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [pingOk, setPingOk] = useState<boolean | null>(null);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sseState, setSseState] = useState<'off' | 'live' | 'err'>('off');
  const chatRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);

  const origin = useMemo(() => apiOrigin(baseUrl), [baseUrl]);

  useEffect(() => {
    void storageGet().then(({ baseUrl: b, bearer: t }) => {
      setBaseUrl(b);
      setBearer(t);
      setDraftBase(b);
      setDraftBearer(t);
      if (b && t) setSettingsOpen(false);
    });
  }, []);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [bubbles]);

  const pushBubble = useCallback((role: Bubble['role'], text: string) => {
    setBubbles((prev) => [
      ...prev,
      { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, role, text, ts: Date.now() },
    ]);
  }, []);

  // SSE (no auth on GET /voice/stream)
  useEffect(() => {
    const url = `${origin}/voice/stream`;
    let closed = false;
    let attempt = 0;
    const tms: number[] = [];

    const connect = () => {
      if (closed) return;
      try {
        esRef.current?.close();
        const es = new EventSource(url);
        esRef.current = es;
        es.onopen = () => {
          attempt = 0;
          setSseState('live');
        };
        es.onmessage = (ev) => {
          if (ev.data.startsWith(':')) return;
          try {
            const data = JSON.parse(ev.data) as { type?: string; text?: string };
            const t = data.type || 'event';
            const body = typeof data.text === 'string' && data.text ? data.text : JSON.stringify(data).slice(0, 200);
            if (['sse_connected', 'heartbeat'].includes(t)) return;
            pushBubble('sys', `${t}: ${body}`);
          } catch {
            /* ignore */
          }
        };
        es.onerror = () => {
          setSseState('err');
          es.close();
          if (closed) return;
          attempt += 1;
          const delay = Math.min(12_000, 1000 * 1.6 ** Math.min(attempt, 8));
          const tid = window.setTimeout(connect, delay);
          tms.push(tid);
        };
      } catch {
        setSseState('err');
      }
    };

    connect();
    return () => {
      closed = true;
      tms.forEach(clearTimeout);
      esRef.current?.close();
      esRef.current = null;
    };
  }, [origin, pushBubble]);

  const ping = useCallback(async () => {
    try {
      const r = await fetch(`${origin}/voice/ping`, { headers: { 'ngrok-skip-browser-warning': '1' } });
      setPingOk(r.ok);
      if (!r.ok) pushBubble('err', `Ping failed: HTTP ${r.status}`);
    } catch (e) {
      setPingOk(false);
      pushBubble('err', `Ping failed: ${String((e as Error).message || e)}`);
    }
  }, [origin, pushBubble]);

  useEffect(() => {
    void ping();
    const iv = setInterval(() => void ping(), 25_000);
    return () => clearInterval(iv);
  }, [ping]);

  const saveSettings = async () => {
    const b = normalizeBase(draftBase);
    await storageSet(b, draftBearer);
    setBaseUrl(b);
    setBearer(draftBearer);
    setSettingsOpen(false);
    void ping();
    pushBubble('sys', `Saved agent base ${b}`);
  };

  const sendChat = async () => {
    const text = input.trim();
    if (!text || sending) return;
    if (!bearer.trim()) {
      pushBubble('err', 'Set Bearer token (PC_AGENT_SECRET or JWT) in Settings.');
      setSettingsOpen(true);
      return;
    }
    setInput('');
    setSending(true);
    pushBubble('user', text);
    try {
      const res = await fetch(`${origin}/voice/command`, {
        method: 'POST',
        headers: authHeaders(bearer),
        body: JSON.stringify({
          text,
          source: 'ui',
          userId: 'openclaw-extension',
        }),
      });
      const data = (await res.json()) as { summary?: string; error?: string; speakAsync?: boolean };
      if (data.summary) {
        pushBubble('friday', data.summary);
        if (data.speakAsync !== false) {
          fetch(`${origin}/voice/speak-async`, {
            method: 'POST',
            headers: authHeaders(bearer),
            body: JSON.stringify({ text: data.summary }),
          }).catch(() => {});
        }
      } else if (data.error) {
        pushBubble('err', data.error);
      } else {
        pushBubble('err', res.ok ? 'Empty response' : `HTTP ${res.status}`);
      }
    } catch (e) {
      pushBubble('err', String((e as Error).message || e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="logo">Friday</span>
          <span className="sub">OpenClaw portable UI</span>
        </div>
        <div className="status">
          <span className={pingOk ? 'dot ok' : pingOk === false ? 'dot bad' : 'dot'} title="voice/ping" />
          <span className="sse" data-state={sseState}>
            SSE {sseState}
          </span>
          {isExtension() && <span className="badge">extension</span>}
          <button type="button" className="ghost" onClick={() => setSettingsOpen((o) => !o)}>
            Settings
          </button>
        </div>
      </header>

      {settingsOpen && (
        <section className="panel settings">
          <p className="hint">
            Runs anywhere: static hosting, local file server, or load <code>dist/</code> as an unpacked browser extension.
            Point this at your <strong>pc-agent</strong> host (port 3847 by default). Use the same Bearer value as{' '}
            <code>PC_AGENT_SECRET</code> or a Listen UI JWT.
          </p>
          <label>
            Agent base URL
            <input
              value={draftBase}
              onChange={(e) => setDraftBase(e.target.value)}
              placeholder="http://127.0.0.1:3847"
              autoComplete="url"
            />
          </label>
          <label>
            Bearer token
            <input
              type="password"
              value={draftBearer}
              onChange={(e) => setDraftBearer(e.target.value)}
              placeholder="PC_AGENT_SECRET or JWT"
              autoComplete="off"
            />
          </label>
          <div className="row">
            <button type="button" onClick={() => void saveSettings()}>
              Save
            </button>
            <button type="button" className="ghost" onClick={() => void ping()}>
              Test ping
            </button>
          </div>
        </section>
      )}

      <main className="chat-wrap">
        <div className="chat" ref={chatRef}>
          {bubbles.length === 0 && (
            <p className="empty">Send a message to run a task on the agent. Voice daemon events appear here over SSE.</p>
          )}
          {bubbles.map((b) => (
            <div key={b.id} className={`bubble ${b.role}`}>
              {b.text}
            </div>
          ))}
        </div>
        <div className="composer">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Message Friday…"
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && void sendChat()}
            disabled={sending}
          />
          <button type="button" disabled={sending || !input.trim()} onClick={() => void sendChat()}>
            Send
          </button>
        </div>
      </main>
    </div>
  );
}
