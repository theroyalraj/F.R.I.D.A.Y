# Friday Listen UI — Complete Redesign Implementation Guide

> **Purpose:** Hand this document to Cursor. It contains every file path, every line of code,
> every architectural decision, and every Cursor rule reference needed to implement the full
> redesign without asking a single clarifying question.

---

## Table of Contents

1. [Current Architecture Summary](#1-current-architecture-summary)
2. [Cursor TTS Rules Reference](#2-cursor-tts-rules-reference)
3. [Voice Metadata Catalogue](#3-voice-metadata-catalogue)
4. [Redis Persistence Extensions](#4-redis-persistence-extensions)
5. [New Server Endpoint: GET /voice/sessions](#5-new-server-endpoint-get-voicesessions)
6. [React State Extensions (VoiceAppContext)](#6-react-state-extensions-voiceappcontext)
7. [New Hook: useVoiceSessions](#7-new-hook-usevoicesessions)
8. [New Component: LaunchOverlay](#8-new-component-launchoverlay)
9. [New Component: VoiceAvatar](#9-new-component-voiceavatar)
10. [New Component: SessionCard](#10-new-component-sessioncard)
11. [New Component: CurrentVoiceShowcase](#11-new-component-currentvoiceshowcase)
12. [New Component: SessionSidebar](#12-new-component-sessionsidebar)
13. [Updated Component: FridayListenApp](#13-updated-component-fridaylistenapp)
14. [Updated Component: AnimatedOrb (Launch + State Animations)](#14-updated-component-animatedorb)
15. [Updated Component: Header (Modern Design)](#15-updated-component-header)
16. [Updated Component: FeedPanel (Enhanced)](#16-updated-component-feedpanel)
17. [Complete CSS Rewrite: listen.module.css](#17-complete-css-rewrite)
18. [Build and Deploy](#18-build-and-deploy)
19. [Testing Checklist](#19-testing-checklist)

---

## 1. Current Architecture Summary

### File Locations

```
pc-agent/
  src/
    components/
      FridayListenApp.tsx    ← Main app (REWRITE)
      AnimatedOrb.tsx         ← Orb with rings (ENHANCE)
      OrbRings.tsx            ← 4 rotating rings (KEEP)
      OrbPanel.tsx            ← Orb + status (KEEP)
      Waveform.tsx            ← 11-bar SVG wave (KEEP)
      Header.tsx              ← Top bar (ENHANCE)
      FeedPanel.tsx           ← Chat feed (ENHANCE)
      ChatBubble.tsx          ← Single message (KEEP)
      Footer.tsx              ← Bottom bar (KEEP)
      Toast.tsx               ← Notifications (KEEP)
      --- NEW ---
      LaunchOverlay.tsx       ← Boot animation
      VoiceAvatar.tsx         ← Gender-based avatar
      SessionCard.tsx         ← Voice session card
      CurrentVoiceShowcase.tsx← Featured voice panel
      SessionSidebar.tsx      ← Right panel container
    contexts/
      VoiceAppContext.tsx     ← Global state (EXTEND)
    hooks/
      useSSEStream.ts         ← SSE connection (KEEP)
      useUptime.ts            ← Uptime tracker (KEEP)
      useAnimeAnimation.ts    ← anime.js hooks (KEEP)
      --- NEW ---
      useVoiceSessions.ts     ← Poll /voice/sessions
    styles/
      listen.module.css       ← All styles (FULL REWRITE)
    --- NEW ---
    utils/
      voiceMetadata.ts        ← Voice catalogue with avatars
    main.tsx                  ← Entry point (KEEP)
  index.html                 ← HTML template (KEEP)
  vite.config.ts              ← Build config (KEEP)

  src/                        ← Server-side (Node.js)
    server.js                 ← Express routes (ADD endpoint)
    voiceRedis.js             ← Redis voice persistence (EXTEND)
    edgeTts.js                ← Voice catalogue + blocking (READ ONLY)
```

### Existing Redis Schema

```
Key pattern:   friday:voice:context:{name}
Hash fields:   voice, set_at, last_used, status
Contexts:      api, cursor:main, cursor:subagent
Status:        Computed dynamically (active if last_used < 5min ago, else idle)
```

### Existing SSE Event Types (from friday-listen.py)

```
daemon_start    → Voice daemon online
server_start    → PC Agent started
listening       → Ready for command
heard           → User spoke (text in payload)
thinking        → Agent processing
speak           → Agent speaking (text in payload)
reply           → Agent response (text in payload)
error           → Error occurred
voice_changed   → Voice selection changed
```

---

## 2. Cursor TTS Rules Reference

> **Why this matters:** The UI must visualise ALL speaking activity. Cursor agents speak
> through multiple channels. The UI needs to show which session is speaking and what.

### Speaking Channels (all fire `friday-speak.py`)

| Channel | Env Vars | When | Voice Pool |
|---------|----------|------|------------|
| **Main Cursor** | `FRIDAY_TTS_PRIORITY=1`, `BYPASS_CURSOR_DEFER=true` | Acknowledgement, completion summary | Main session voice |
| **Subagent** | `FRIDAY_TTS_SESSION=subagent`, `PRIORITY=1`, `BYPASS=true` | Subagent narration | Adult pool (never Ana/child) |
| **Thinking** | `FRIDAY_TTS_THINKING=1`, `PRIORITY=1`, `BYPASS=true` | Extended reasoning narration | Singleton lock (one at a time) |
| **Cursor-reply** | `FRIDAY_TTS_SESSION=cursor-reply` | Reading Composer replies aloud | Third voice from picker |
| **Listen daemon** | via `speak()` in `friday-listen.py` | Voice command responses | Session sticky voice |
| **Ambient** | `friday-ambient.py` | Periodic chatter (60-120s) | Session voice |
| **Listen UI** | via `POST /voice/speak-async` | Orb button responses | Jarvis rate/pitch |

### Speaking Lifecycle (what the UI should show)

```
1. USER SPEAKS → "heard" event → Show user bubble + processing state
2. AGENT THINKS → "thinking" event → Show processing state + amber orb
3. AGENT REPLIES → "reply" event → Show Friday bubble
4. AGENT SPEAKS → "speak" event → Show speaking state + green orb + waveform
5. DONE → "listening" event → Return to listening state
```

### Session Voice Assignment

Each context gets a unique voice from `pick-session-voice.py`:
- `cursor:main` — Main Cursor agent voice
- `cursor:subagent` — Subagent voice (adult pool only)
- `cursor:cursor-reply` — Composer reply reader voice
- `api` — PC Agent / Listen UI voice

These are persisted in Redis under `friday:voice:context:{name}`.

---

## 3. Voice Metadata Catalogue

### File: `pc-agent/src/utils/voiceMetadata.ts`

```typescript
/**
 * Voice metadata catalogue — maps Edge TTS voice IDs to display metadata.
 * Used by SessionCard, VoiceAvatar, and CurrentVoiceShowcase components.
 *
 * Source of truth: EDGE_TTS_VOICE_CATALOGUE in pc-agent/src/edgeTts.js
 */

export interface VoiceMetadata {
  gender: 'M' | 'F';
  locale: string;
  flag: string;
  shortName: string;
  description: string;
  icon: string;
  color: string;
}

export const VOICE_METADATA: Record<string, VoiceMetadata> = {
  'en-US-EmmaMultilingualNeural': {
    gender: 'F', locale: 'en-US', flag: '\u{1F1FA}\u{1F1F8}',
    shortName: 'Emma',
    description: 'Expressive, warm multilingual female',
    icon: '\u{1F469}\u{200D}\u{1F4BC}', color: '#FF6B9D',
  },
  'en-US-AndrewMultilingualNeural': {
    gender: 'M', locale: 'en-US', flag: '\u{1F1FA}\u{1F1F8}',
    shortName: 'Andrew',
    description: 'Clear, friendly multilingual male',
    icon: '\u{1F468}\u{200D}\u{1F4BC}', color: '#4ECDC4',
  },
  'en-US-BrianMultilingualNeural': {
    gender: 'M', locale: 'en-US', flag: '\u{1F1FA}\u{1F1F8}',
    shortName: 'Brian',
    description: 'Smooth, professional male',
    icon: '\u{1F468}\u{200D}\u{1F4BB}', color: '#45B7D1',
  },
  'en-US-AvaMultilingualNeural': {
    gender: 'F', locale: 'en-US', flag: '\u{1F1FA}\u{1F1F8}',
    shortName: 'Ava',
    description: 'Bright, articulate female',
    icon: '\u{1F469}\u{200D}\u{1F52C}', color: '#96CEB4',
  },
  'en-US-ChristopherNeural': {
    gender: 'M', locale: 'en-US', flag: '\u{1F1FA}\u{1F1F8}',
    shortName: 'Christopher',
    description: 'Deep, confident male',
    icon: '\u{1F9D4}', color: '#6C5CE7',
  },
  'en-US-GuyNeural': {
    gender: 'M', locale: 'en-US', flag: '\u{1F1FA}\u{1F1F8}',
    shortName: 'Guy',
    description: 'Clear anchor-style male',
    icon: '\u{1F468}\u{200D}\u{1F3A4}', color: '#A8E6CF',
  },
  'en-US-EricNeural': {
    gender: 'M', locale: 'en-US', flag: '\u{1F1FA}\u{1F1F8}',
    shortName: 'Eric',
    description: 'Calm, natural male',
    icon: '\u{1F468}\u{200D}\u{1F3EB}', color: '#DDA0DD',
  },
  'en-US-AriaNeural': {
    gender: 'F', locale: 'en-US', flag: '\u{1F1FA}\u{1F1F8}',
    shortName: 'Aria',
    description: 'Natural, warm female',
    icon: '\u{1F469}\u{200D}\u{1F3A4}', color: '#FFB6C1',
  },
  'en-US-JennyNeural': {
    gender: 'F', locale: 'en-US', flag: '\u{1F1FA}\u{1F1F8}',
    shortName: 'Jenny',
    description: 'Friendly assistant female',
    icon: '\u{1F469}\u{200D}\u{1F4BB}', color: '#87CEEB',
  },
  'en-US-DavisNeural': {
    gender: 'M', locale: 'en-US', flag: '\u{1F1FA}\u{1F1F8}',
    shortName: 'Davis',
    description: 'Confident, engaging male',
    icon: '\u{1F468}\u{200D}\u{2696}\u{FE0F}', color: '#98D8C8',
  },
  'en-US-NancyNeural': {
    gender: 'F', locale: 'en-US', flag: '\u{1F1FA}\u{1F1F8}',
    shortName: 'Nancy',
    description: 'Calm, reassuring female',
    icon: '\u{1F469}\u{200D}\u{2696}\u{FE0F}', color: '#F7DC6F',
  },
  'en-GB-LibbyNeural': {
    gender: 'F', locale: 'en-GB', flag: '\u{1F1EC}\u{1F1E7}',
    shortName: 'Libby',
    description: 'Natural British female',
    icon: '\u{1F478}', color: '#C39BD3',
  },
  'en-GB-SoniaNeural': {
    gender: 'F', locale: 'en-GB', flag: '\u{1F1EC}\u{1F1E7}',
    shortName: 'Sonia',
    description: 'Polished, expressive British female',
    icon: '\u{1F451}', color: '#F5B7B1',
  },
  'en-IE-ConnorNeural': {
    gender: 'M', locale: 'en-IE', flag: '\u{1F1EE}\u{1F1EA}',
    shortName: 'Connor',
    description: 'Warm Irish male',
    icon: '\u{2618}\u{FE0F}', color: '#82E0AA',
  },
  'en-IN-NeerjaExpressiveNeural': {
    gender: 'F', locale: 'en-IN', flag: '\u{1F1EE}\u{1F1F3}',
    shortName: 'Neerja',
    description: 'Expressive Indian English female',
    icon: '\u{1F64F}', color: '#F0B27A',
  },
  'en-IN-PrabhatNeural': {
    gender: 'M', locale: 'en-IN', flag: '\u{1F1EE}\u{1F1F3}',
    shortName: 'Prabhat',
    description: 'Indian English male',
    icon: '\u{1F64B}\u{200D}\u{2642}\u{FE0F}', color: '#AED6F1',
  },
  'en-AU-NatashaNeural': {
    gender: 'F', locale: 'en-AU', flag: '\u{1F1E6}\u{1F1FA}',
    shortName: 'Natasha',
    description: 'Australian female',
    icon: '\u{1F428}', color: '#FADBD8',
  },
  'en-CA-LiamNeural': {
    gender: 'M', locale: 'en-CA', flag: '\u{1F1E8}\u{1F1E6}',
    shortName: 'Liam',
    description: 'Canadian male',
    icon: '\u{1F341}', color: '#D5F5E3',
  },
  'en-CA-ClaraNeural': {
    gender: 'F', locale: 'en-CA', flag: '\u{1F1E8}\u{1F1E6}',
    shortName: 'Clara',
    description: 'Canadian female',
    icon: '\u{2744}\u{FE0F}', color: '#D6EAF8',
  },
};

/** Context display names for session cards */
export const CONTEXT_LABELS: Record<string, { label: string; description: string; icon: string }> = {
  'api':              { label: 'Friday Agent',      description: 'PC Agent / Listen UI voice',                icon: '\u{1F916}' },
  'cursor:main':      { label: 'Cursor Main',       description: 'Main Cursor agent voice',                   icon: '\u{1F4BB}' },
  'cursor:subagent':  { label: 'Cursor Subagent',   description: 'Task subagent voice (adult pool)',           icon: '\u{26A1}' },
  'cursor:cursor-reply': { label: 'Composer Reader', description: 'Reads Composer replies aloud',              icon: '\u{1F4AC}' },
  'listen':           { label: 'Listen Daemon',     description: 'Always-on voice command handler',            icon: '\u{1F3A4}' },
  'ambient':          { label: 'Ambient Chatter',   description: 'Periodic ambient commentary',                icon: '\u{1F30A}' },
};

/**
 * Look up metadata for a voice ID. Returns a fallback if unknown.
 */
export function getVoiceMetadata(voiceId: string): VoiceMetadata {
  return VOICE_METADATA[voiceId] || {
    gender: 'M' as const,
    locale: 'en-US',
    flag: '\u{1F310}',
    shortName: voiceId.split('-').slice(2).join(' ').replace('Neural', '').trim() || 'Unknown',
    description: 'Neural voice',
    icon: '\u{1F399}\u{FE0F}',
    color: '#95A5A6',
  };
}

/**
 * Look up context label info. Returns a fallback if unknown.
 */
export function getContextLabel(context: string): { label: string; description: string; icon: string } {
  return CONTEXT_LABELS[context] || {
    label: context,
    description: `Voice context: ${context}`,
    icon: '\u{1F50A}',
  };
}

/**
 * Format relative time (e.g., "2s ago", "5m ago", "2h ago")
 */
export function formatRelativeTime(isoDate: string | null): string {
  if (!isoDate) return 'never';
  const diffMs = Date.now() - new Date(isoDate).getTime();
  if (diffMs < 0) return 'just now';
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
```

---

## 4. Redis Persistence Extensions

### File: `pc-agent/src/voiceRedis.js`

**ADD** this new exported function after `getAllVoiceContexts()`:

```javascript
/**
 * Return all voice contexts enriched with voice metadata.
 * Each entry includes: context, voice, set_at, last_used, status,
 * plus metadata from the voice catalogue (gender, locale, description, icon, color).
 *
 * @returns {Promise<Array<{context, voice, set_at, last_used, status, metadata}>>}
 */
export async function getAllVoiceSessionsWithMetadata() {
  const contexts = await getAllVoiceContexts();

  // Import voice catalogue from edgeTts.js
  const { EDGE_TTS_VOICE_CATALOGUE } = await import('./edgeTts.js');

  // Build lookup from catalogue
  const catalogueLookup = {};
  for (const entry of EDGE_TTS_VOICE_CATALOGUE) {
    catalogueLookup[entry.voice] = entry;
  }

  return contexts.map((ctx) => {
    const catalogueEntry = catalogueLookup[ctx.voice] || null;
    return {
      ...ctx,
      metadata: catalogueEntry
        ? {
            gender: catalogueEntry.gender || 'Male',
            locale: catalogueEntry.lang || 'en-US',
            description: catalogueEntry.desc || 'Neural voice',
          }
        : {
            gender: 'Male',
            locale: 'en-US',
            description: 'Neural voice',
          },
    };
  });
}
```

> **Note:** The full avatar/icon/color mapping lives in the React `voiceMetadata.ts` utility
> (Section 3). The server returns the voice ID; the client maps it to rich metadata.

---

## 5. New Server Endpoint: GET /voice/sessions

### File: `pc-agent/src/server.js`

**ADD** this import at the top (alongside existing `getAllVoiceContexts`):

```javascript
import { getAllVoiceContexts, getAllVoiceSessionsWithMetadata } from './voiceRedis.js';
```

**ADD** this route **after** the existing `voiceRouter.get('/status', ...)` block (around line 448):

```javascript
/** Return all voice sessions with metadata for the dashboard UI.
 * Enriches Redis contexts with voice catalogue info (gender, locale, description).
 * Polled by the React listen UI every 5 seconds.
 */
voiceRouter.get('/sessions', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const sessions = await getAllVoiceSessionsWithMetadata();
    res.json({ ok: true, sessions });
  } catch (err) {
    // Fallback: return contexts without metadata enrichment
    try {
      const contexts = await getAllVoiceContexts();
      res.json({ ok: true, sessions: contexts.map(c => ({ ...c, metadata: null })) });
    } catch {
      res.json({ ok: true, sessions: [] });
    }
  }
});
```

---

## 6. React State Extensions (VoiceAppContext)

### File: `pc-agent/src/contexts/VoiceAppContext.tsx`

**ADD** these type definitions after the existing `ChatBubble` interface:

```typescript
export interface VoiceSession {
  context: string;
  voice: string;
  setAt: string | null;
  lastUsed: string | null;
  status: 'active' | 'idle';
  metadata: {
    gender: string;
    locale: string;
    description: string;
  } | null;
  isSpeaking: boolean;
  recentText: string;
}
```

**ADD** these fields to the `VoiceAppContextType` interface:

```typescript
  // Voice Sessions (from Redis via /voice/sessions)
  voiceSessions: VoiceSession[];
  setVoiceSessions: (sessions: VoiceSession[]) => void;
  updateSessionSpeaking: (context: string, isSpeaking: boolean, text?: string) => void;

  // Launch animation state
  launchComplete: boolean;
  setLaunchComplete: (done: boolean) => void;
```

**ADD** these state variables inside `VoiceAppProvider`:

```typescript
  const [voiceSessions, setVoiceSessions] = useState<VoiceSession[]>([]);
  const [launchComplete, setLaunchComplete] = useState(false);
```

**ADD** this action function:

```typescript
  const updateSessionSpeaking = useCallback((context: string, isSpeaking: boolean, text?: string) => {
    setVoiceSessions(prev =>
      prev.map(s =>
        s.context === context
          ? { ...s, isSpeaking, recentText: text || s.recentText }
          : s
      )
    );
  }, []);
```

**EXTEND** the `postEvent` function to handle speaking status:

```typescript
      case 'speak':
        setConnectionStatus('speaking');
        // Mark the active session as speaking
        updateSessionSpeaking('api', true, text);
        break;
      case 'reply':
        setConnectionStatus('listening');
        addBubble({ type: 'friday', text, ts: Date.now() });
        // Mark speaking as done
        updateSessionSpeaking('api', false);
        break;
```

**ADD** all new fields to the `value` object passed to `VoiceAppContext.Provider`.

---

## 7. New Hook: useVoiceSessions

### File: `pc-agent/src/hooks/useVoiceSessions.ts`

```typescript
import { useEffect, useRef, useCallback } from 'react';
import { VoiceSession } from '../contexts/VoiceAppContext';

const POLL_INTERVAL_MS = 5000;

/**
 * Polls GET /voice/sessions every 5 seconds.
 * Merges server data with local isSpeaking state (from SSE events).
 */
export function useVoiceSessions(
  onSessionsUpdate: (sessions: VoiceSession[]) => void,
  baseUrl = ''
): void {
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const localSpeakingRef = useRef<Map<string, { isSpeaking: boolean; recentText: string }>>(new Map());
  const callbackRef = useRef(onSessionsUpdate);

  useEffect(() => {
    callbackRef.current = onSessionsUpdate;
  }, [onSessionsUpdate]);

  const fetchSessions = useCallback(async () => {
    try {
      const url = `${baseUrl || window.location.origin}/voice/sessions`;
      const res = await fetch(url);
      const data = await res.json();

      if (data.ok && Array.isArray(data.sessions)) {
        // Merge server data with local speaking state
        const merged: VoiceSession[] = data.sessions.map((s: any) => {
          const local = localSpeakingRef.current.get(s.context);
          return {
            context: s.context,
            voice: s.voice,
            setAt: s.set_at || null,
            lastUsed: s.last_used || null,
            status: s.status || 'idle',
            metadata: s.metadata || null,
            isSpeaking: local?.isSpeaking || false,
            recentText: local?.recentText || '',
          };
        });

        callbackRef.current(merged);
      }
    } catch (err) {
      console.error('Failed to fetch voice sessions:', err);
    }
  }, [baseUrl]);

  useEffect(() => {
    // Fetch immediately on mount
    fetchSessions();

    // Then poll every 5 seconds
    intervalRef.current = setInterval(fetchSessions, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [fetchSessions]);
}
```

---

## 8. New Component: LaunchOverlay

### File: `pc-agent/src/components/LaunchOverlay.tsx`

```tsx
import React, { useRef, useEffect, useState } from 'react';
import styles from '../styles/listen.module.css';

interface LaunchOverlayProps {
  onComplete: () => void;
}

const LaunchOverlay: React.FC<LaunchOverlayProps> = ({ onComplete }) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<'logo' | 'status' | 'fadeout'>('logo');

  useEffect(() => {
    // Phase 1: Show logo (0 - 800ms)
    const t1 = setTimeout(() => setPhase('status'), 800);

    // Phase 2: Show status text (800 - 2000ms)
    const t2 = setTimeout(() => setPhase('fadeout'), 2000);

    // Phase 3: Fade out and signal complete (2000 - 2800ms)
    const t3 = setTimeout(() => {
      onComplete();
    }, 2800);

    // anime.js launch sequence
    const anime = (window as any).anime;
    if (anime && overlayRef.current) {
      // Logo text animation
      anime({
        targets: overlayRef.current.querySelector('.launch-title'),
        opacity: [0, 1],
        translateY: [20, 0],
        duration: 600,
        easing: 'easeOutQuad',
      });

      // Status text fade in
      setTimeout(() => {
        anime({
          targets: overlayRef.current?.querySelector('.launch-status'),
          opacity: [0, 1],
          duration: 400,
          easing: 'easeInOutQuad',
        });
      }, 800);

      // Overlay fade out
      setTimeout(() => {
        anime({
          targets: overlayRef.current,
          opacity: [1, 0],
          duration: 800,
          easing: 'easeInOutQuad',
        });
      }, 2000);
    }

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [onComplete]);

  return (
    <div ref={overlayRef} className={styles['launch-overlay']}>
      <div className={styles['launch-content']}>
        <div className={`${styles['launch-title']} launch-title`}>
          F R I D A Y
        </div>
        <div className={`${styles['launch-subtitle']} launch-status`}>
          {phase === 'logo' && 'Initializing...'}
          {phase === 'status' && 'Voice daemon connecting...'}
          {phase === 'fadeout' && 'Systems online.'}
        </div>
        <div className={styles['launch-bar']}>
          <div
            className={styles['launch-bar-fill']}
            style={{
              width: phase === 'logo' ? '30%' : phase === 'status' ? '70%' : '100%',
            }}
          />
        </div>
      </div>
    </div>
  );
};

export default LaunchOverlay;
```

---

## 9. New Component: VoiceAvatar

### File: `pc-agent/src/components/VoiceAvatar.tsx`

```tsx
import React from 'react';
import { getVoiceMetadata } from '../utils/voiceMetadata';
import styles from '../styles/listen.module.css';

interface VoiceAvatarProps {
  voiceId: string;
  size?: 'sm' | 'md' | 'lg';
  isSpeaking?: boolean;
  showGlow?: boolean;
}

const VoiceAvatar: React.FC<VoiceAvatarProps> = ({
  voiceId,
  size = 'md',
  isSpeaking = false,
  showGlow = false,
}) => {
  const meta = getVoiceMetadata(voiceId);
  const sizeClass = styles[`avatar-${size}`];

  return (
    <div
      className={`${styles.avatar} ${sizeClass} ${isSpeaking ? styles['avatar-speaking'] : ''}`}
      style={{
        borderColor: meta.color,
        boxShadow: showGlow || isSpeaking ? `0 0 12px ${meta.color}40` : 'none',
      }}
      title={`${meta.shortName} (${meta.locale})`}
    >
      <span className={styles['avatar-icon']}>{meta.icon}</span>
      {isSpeaking && (
        <div className={styles['avatar-speaking-ring']} style={{ borderColor: meta.color }} />
      )}
    </div>
  );
};

export default VoiceAvatar;
```

---

## 10. New Component: SessionCard

### File: `pc-agent/src/components/SessionCard.tsx`

```tsx
import React, { useRef, useEffect } from 'react';
import { VoiceSession } from '../contexts/VoiceAppContext';
import { getVoiceMetadata, getContextLabel, formatRelativeTime } from '../utils/voiceMetadata';
import VoiceAvatar from './VoiceAvatar';
import styles from '../styles/listen.module.css';

interface SessionCardProps {
  session: VoiceSession;
  index: number;
}

const SessionCard: React.FC<SessionCardProps> = ({ session, index }) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const meta = getVoiceMetadata(session.voice);
  const ctxLabel = getContextLabel(session.context);

  // Card entrance animation
  useEffect(() => {
    const anime = (window as any).anime;
    if (anime && cardRef.current) {
      anime({
        targets: cardRef.current,
        opacity: [0, 1],
        translateY: [16, 0],
        scale: [0.95, 1],
        duration: 400,
        delay: index * 80,
        easing: 'easeOutBack',
      });
    }
  }, [index]);

  return (
    <div
      ref={cardRef}
      className={`${styles['session-card']} ${session.isSpeaking ? styles['session-speaking'] : ''}`}
      style={{
        borderLeftColor: meta.color,
        opacity: 0, /* initial state before anime.js */
      }}
    >
      <div className={styles['session-card-header']}>
        <VoiceAvatar
          voiceId={session.voice}
          size="sm"
          isSpeaking={session.isSpeaking}
        />
        <div className={styles['session-card-info']}>
          <div className={styles['session-card-name']}>
            {meta.shortName}
            <span className={styles['session-card-locale']}>
              {meta.flag} {meta.locale}
            </span>
          </div>
          <div className={styles['session-card-context']}>
            {ctxLabel.icon} {ctxLabel.label}
          </div>
        </div>
        <div className={`${styles['session-status-dot']} ${styles[`status-${session.status}`]}`}
             title={session.status === 'active' ? 'Active' : 'Idle'} />
      </div>

      <div className={styles['session-card-desc']}>
        {meta.description}
      </div>

      <div className={styles['session-card-footer']}>
        <span className={styles['session-card-time']}>
          {session.status === 'active' ? '\u{2705}' : '\u{23F3}'} {formatRelativeTime(session.lastUsed)}
        </span>
        {session.isSpeaking && (
          <span className={styles['session-speaking-label']}>Speaking...</span>
        )}
      </div>

      {/* Mini waveform when speaking */}
      {session.isSpeaking && (
        <div className={styles['session-waveform']}>
          {Array.from({ length: 7 }).map((_, i) => (
            <div
              key={i}
              className={styles['session-wave-bar']}
              style={{
                animationDelay: `${i * 0.1}s`,
                backgroundColor: meta.color,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default SessionCard;
```

---

## 11. New Component: CurrentVoiceShowcase

### File: `pc-agent/src/components/CurrentVoiceShowcase.tsx`

```tsx
import React from 'react';
import { useVoiceApp } from '../contexts/VoiceAppContext';
import { getVoiceMetadata } from '../utils/voiceMetadata';
import VoiceAvatar from './VoiceAvatar';
import styles from '../styles/listen.module.css';

const CurrentVoiceShowcase: React.FC = () => {
  const { currentVoice, connectionStatus } = useVoiceApp();
  const meta = getVoiceMetadata(currentVoice);
  const isSpeaking = connectionStatus === 'speaking';

  return (
    <div className={styles['voice-showcase']}>
      <div className={styles['showcase-header']}>CURRENT VOICE</div>

      <div className={styles['showcase-body']}>
        <VoiceAvatar
          voiceId={currentVoice}
          size="lg"
          isSpeaking={isSpeaking}
          showGlow
        />

        <div className={styles['showcase-details']}>
          <div className={styles['showcase-name']}>{meta.shortName}</div>
          <div className={styles['showcase-locale']}>
            {meta.flag} {meta.locale} &middot; {meta.gender === 'F' ? 'Female' : 'Male'}
          </div>
          <div className={styles['showcase-desc']}>{meta.description}</div>
        </div>
      </div>

      {/* Speaking indicator */}
      {isSpeaking && (
        <div className={styles['showcase-speaking']}>
          <div className={styles['showcase-wave']}>
            {Array.from({ length: 11 }).map((_, i) => (
              <div
                key={i}
                className={styles['showcase-wave-bar']}
                style={{
                  animationDelay: `${i * 0.08}s`,
                  backgroundColor: meta.color,
                }}
              />
            ))}
          </div>
          <span className={styles['showcase-speaking-text']}>Speaking...</span>
        </div>
      )}
    </div>
  );
};

export default CurrentVoiceShowcase;
```

---

## 12. New Component: SessionSidebar

### File: `pc-agent/src/components/SessionSidebar.tsx`

```tsx
import React from 'react';
import { useVoiceApp } from '../contexts/VoiceAppContext';
import { useVoiceSessions } from '../hooks/useVoiceSessions';
import SessionCard from './SessionCard';
import CurrentVoiceShowcase from './CurrentVoiceShowcase';
import styles from '../styles/listen.module.css';

const SessionSidebar: React.FC = () => {
  const { voiceSessions, setVoiceSessions } = useVoiceApp();

  // Poll /voice/sessions every 5 seconds
  useVoiceSessions((sessions) => {
    setVoiceSessions(sessions);
  });

  // Sort: active first, then by lastUsed descending
  const sorted = [...voiceSessions].sort((a, b) => {
    if (a.status === 'active' && b.status !== 'active') return -1;
    if (b.status === 'active' && a.status !== 'active') return 1;
    const ta = a.lastUsed ? new Date(a.lastUsed).getTime() : 0;
    const tb = b.lastUsed ? new Date(b.lastUsed).getTime() : 0;
    return tb - ta;
  });

  return (
    <div className={styles['session-sidebar']}>
      {/* Sessions Header */}
      <div className={styles['sidebar-header']}>
        <span className={styles['sidebar-title']}>VOICE SESSIONS</span>
        <span className={styles['sidebar-count']}>
          {voiceSessions.filter(s => s.status === 'active').length} active
        </span>
      </div>

      {/* Session Cards Grid (2 columns) */}
      <div className={styles['session-grid']}>
        {sorted.length === 0 && (
          <div className={styles['session-empty']}>
            No voice sessions tracked yet.
            <br />
            Sessions appear when voices are used.
          </div>
        )}
        {sorted.map((session, index) => (
          <SessionCard key={session.context} session={session} index={index} />
        ))}
      </div>

      {/* Current Voice Showcase (featured at bottom) */}
      <CurrentVoiceShowcase />
    </div>
  );
};

export default SessionSidebar;
```

---

## 13. Updated Component: FridayListenApp

### File: `pc-agent/src/components/FridayListenApp.tsx`

**FULL REWRITE:**

```tsx
import React, { useEffect, useState, useCallback } from 'react';
import { useVoiceApp } from '../contexts/VoiceAppContext';
import { useSSEStream } from '../hooks/useSSEStream';
import LaunchOverlay from './LaunchOverlay';
import Header from './Header';
import OrbPanel from './OrbPanel';
import FeedPanel from './FeedPanel';
import SessionSidebar from './SessionSidebar';
import Footer from './Footer';
import ToastContainer from './Toast';
import styles from '../styles/listen.module.css';

const FridayListenApp: React.FC = () => {
  const {
    postEvent,
    setEdgeVoices,
    theme,
    connectionStatus,
    launchComplete,
    setLaunchComplete,
  } = useVoiceApp();

  // Fetch available voices on mount
  useEffect(() => {
    const fetchVoices = async () => {
      try {
        const res = await fetch('/voice/voices');
        const data = await res.json();
        if (data.voices) {
          setEdgeVoices(data.voices);
        }
      } catch (err) {
        console.error('Failed to fetch voices:', err);
      }
    };
    fetchVoices();
  }, [setEdgeVoices]);

  // Subscribe to SSE stream
  useSSEStream(useCallback((event: any) => {
    if (event.type === 'sse_disconnected') {
      postEvent('daemon_disconnect');
    } else if (event.type === 'sse_connected') {
      postEvent('daemon_start', 'Voice daemon online.');
    } else {
      postEvent(event.type, event.text || '');
    }
  }, [postEvent]));

  const handleLaunchComplete = useCallback(() => {
    setLaunchComplete(true);
  }, [setLaunchComplete]);

  const stateClass = `state-${connectionStatus}`;

  return (
    <div className={`${styles.app} ${theme === 'dark' ? styles.dark : ''} ${styles[stateClass]}`}>
      {/* Launch overlay (shown only on first load) */}
      {!launchComplete && <LaunchOverlay onComplete={handleLaunchComplete} />}

      {/* Background layers */}
      <div className={styles['hex-bg']} aria-hidden="true" />
      <div className={styles.vignette} aria-hidden="true" />
      <div className={styles.scanlines} aria-hidden="true" />

      {/* HUD corner brackets */}
      <div className={`${styles.corner} ${styles['corner--tl']}`} aria-hidden="true" />
      <div className={`${styles.corner} ${styles['corner--tr']}`} aria-hidden="true" />
      <div className={`${styles.corner} ${styles['corner--bl']}`} aria-hidden="true" />
      <div className={`${styles.corner} ${styles['corner--br']}`} aria-hidden="true" />

      {/* Main layout */}
      <div className={styles.layout} role="main">
        <Header />

        <div className={styles['main-content']}>
          {/* Left: Orb + Feed */}
          <div className={styles['left-panel']}>
            <OrbPanel />
            <FeedPanel />
          </div>

          {/* Right: Voice Sessions Sidebar */}
          <SessionSidebar />
        </div>

        <Footer />
      </div>

      {/* Toasts */}
      <ToastContainer />
    </div>
  );
};

export default FridayListenApp;
```

---

## 14. Updated Component: AnimatedOrb

### File: `pc-agent/src/components/AnimatedOrb.tsx`

**ADD** launch animation at the top of the component:

```tsx
  // Launch animation (scale from 0 → 1 on mount)
  useEffect(() => {
    const anime = (window as any).anime;
    if (!anime || !orbRef.current) return;

    anime({
      targets: orbRef.current,
      scale: [0, 1],
      opacity: [0, 1],
      duration: 800,
      delay: 1200, // After launch overlay begins fading
      easing: 'easeOutElastic(1, .6)',
    });
  }, []);
```

**ADD** state transition animation (glow color change):

```tsx
  // Smooth glow color transition when state changes
  useEffect(() => {
    const anime = (window as any).anime;
    if (!anime) return;

    const glowEl = document.querySelector(`.${styles['orb-glow']}`);
    if (!glowEl) return;

    const colors = {
      offline: 'rgba(14, 165, 233, 0.3)',
      listening: 'rgba(14, 165, 233, 0.5)',
      processing: 'rgba(180, 83, 9, 0.6)',
      speaking: 'rgba(5, 150, 105, 0.6)',
    };

    anime({
      targets: glowEl,
      backgroundColor: colors[connectionStatus],
      duration: 400,
      easing: 'easeInOutQuad',
    });
  }, [connectionStatus]);
```

---

## 15. Updated Component: Header

No structural changes needed. Just ensure the existing Header renders well with the new CSS.

---

## 16. Updated Component: FeedPanel

**ADD** a header section above the scroll area:

```tsx
  return (
    <div className={styles['feed-panel']}>
      <div className={styles['feed-header']}>
        <span className={styles['feed-title']}>CONVERSATION</span>
        <span className={styles['feed-count']}>{bubbles.length} messages</span>
      </div>
      <div className={styles['feed-scroll']} ref={feedScrollRef}>
        {bubbles.map(bubble => (
          <ChatBubble key={bubble.id} bubble={bubble} />
        ))}
      </div>
    </div>
  );
```

---

## 17. Complete CSS Rewrite

### File: `pc-agent/src/styles/listen.module.css`

> **This is the most critical file.** The entire visual identity comes from here.
> Completely replace the existing file with the content below.
> Design principles: glassmorphism, HUD aesthetic, state-driven colors, smooth transitions.

**Key design changes from current:**

1. **Layout:** Split into `left-panel` (60%) + `session-sidebar` (40%)
2. **Cards:** Glassmorphic session cards with colored left border
3. **Launch overlay:** Full-screen with gradient + progress bar
4. **Avatars:** Circular with border color matching voice metadata
5. **Session grid:** 2-column CSS grid
6. **Speaking indicators:** Pulsing dots + mini waveforms
7. **Showcase:** Featured current voice with large avatar
8. **Responsive:** Stacks vertically on mobile

**New CSS classes to add (append to existing file or replace):**

```css
/* ═══════════════════════════════════════════════════════
   LAUNCH OVERLAY
═══════════════════════════════════════════════════════ */
.launch-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: linear-gradient(135deg, #010508 0%, #0a1628 50%, #010508 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
}

.launch-content {
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
}

.launch-title {
  font-family: var(--sans);
  font-size: 2.5rem;
  font-weight: 700;
  letter-spacing: 0.4em;
  color: var(--cyan);
  text-shadow: 0 0 30px rgba(14, 165, 233, 0.4);
  opacity: 0;
}

.launch-subtitle {
  font-family: var(--mono);
  font-size: 0.85rem;
  letter-spacing: 0.1em;
  color: rgba(0, 212, 255, 0.6);
  opacity: 0;
  min-height: 1.2em;
}

.launch-bar {
  width: 200px;
  height: 2px;
  background: rgba(0, 212, 255, 0.15);
  border-radius: 1px;
  overflow: hidden;
}

.launch-bar-fill {
  height: 100%;
  background: var(--cyan);
  border-radius: 1px;
  transition: width 0.8s ease;
  box-shadow: 0 0 8px var(--cyan);
}

/* ═══════════════════════════════════════════════════════
   LAYOUT — 60/40 SPLIT
═══════════════════════════════════════════════════════ */
.main-content {
  display: grid;
  grid-template-columns: 1fr 380px;
  gap: 0;
  overflow: hidden;
  flex: 1;
}

.left-panel {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 20px 24px;
  gap: 16px;
}

/* ═══════════════════════════════════════════════════════
   SESSION SIDEBAR
═══════════════════════════════════════════════════════ */
.session-sidebar {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border-left: 1px solid rgba(0, 212, 255, 0.08);
  background: rgba(1, 5, 8, 0.4);
  backdrop-filter: blur(8px);
  overflow-y: auto;
}

.sidebar-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(0, 212, 255, 0.1);
}

.sidebar-title {
  font-family: var(--mono);
  font-size: 0.75rem;
  letter-spacing: 0.15em;
  color: var(--cyan);
  font-weight: 600;
}

.sidebar-count {
  font-family: var(--mono);
  font-size: 0.7rem;
  color: var(--green);
  letter-spacing: 0.05em;
}

/* ═══════════════════════════════════════════════════════
   SESSION GRID (2-column)
═══════════════════════════════════════════════════════ */
.session-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  flex: 1;
  align-content: start;
}

.session-empty {
  grid-column: 1 / -1;
  text-align: center;
  color: rgba(0, 212, 255, 0.3);
  font-size: 0.8rem;
  padding: 24px 0;
  font-family: var(--mono);
}

/* ═══════════════════════════════════════════════════════
   SESSION CARD
═══════════════════════════════════════════════════════ */
.session-card {
  background: rgba(255, 255, 255, 0.03);
  backdrop-filter: blur(6px);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-left: 3px solid var(--cyan);
  border-radius: 6px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  transition: all 0.2s;
  cursor: default;
}

.session-card:hover {
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(255, 255, 255, 0.12);
  transform: translateY(-1px);
}

.session-speaking {
  border-color: var(--green) !important;
  box-shadow: 0 0 12px rgba(5, 150, 105, 0.15);
}

.session-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.session-card-info {
  flex: 1;
  min-width: 0;
}

.session-card-name {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 6px;
}

.session-card-locale {
  font-size: 0.65rem;
  color: rgba(226, 232, 240, 0.5);
  font-family: var(--mono);
}

.session-card-context {
  font-size: 0.7rem;
  color: rgba(0, 212, 255, 0.5);
  font-family: var(--mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-card-desc {
  font-size: 0.72rem;
  color: rgba(226, 232, 240, 0.4);
  line-height: 1.3;
}

.session-card-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.session-card-time {
  font-family: var(--mono);
  font-size: 0.65rem;
  color: rgba(0, 212, 255, 0.4);
}

.session-speaking-label {
  font-size: 0.65rem;
  color: var(--green);
  font-weight: 600;
  animation: pulse-text 1s infinite;
}

@keyframes pulse-text {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

/* Session status dot */
.session-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-active {
  background: var(--green);
  box-shadow: 0 0 6px var(--green);
}

.status-idle {
  background: rgba(226, 232, 240, 0.3);
}

/* Session mini waveform */
.session-waveform {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  height: 16px;
  padding-top: 4px;
}

.session-wave-bar {
  width: 3px;
  border-radius: 1px;
  animation: session-bar-bounce 0.8s ease-in-out infinite alternate;
}

@keyframes session-bar-bounce {
  0% { height: 3px; }
  100% { height: 14px; }
}

/* ═══════════════════════════════════════════════════════
   VOICE AVATAR
═══════════════════════════════════════════════════════ */
.avatar {
  border-radius: 50%;
  border: 2px solid var(--cyan);
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(1, 5, 8, 0.6);
  position: relative;
  flex-shrink: 0;
  transition: all 0.3s;
}

.avatar-sm { width: 32px; height: 32px; }
.avatar-md { width: 48px; height: 48px; }
.avatar-lg { width: 72px; height: 72px; }

.avatar-sm .avatar-icon { font-size: 0.9rem; }
.avatar-md .avatar-icon { font-size: 1.3rem; }
.avatar-lg .avatar-icon { font-size: 2rem; }

.avatar-speaking {
  animation: avatar-pulse 1.5s ease-in-out infinite;
}

@keyframes avatar-pulse {
  0%, 100% { box-shadow: 0 0 4px transparent; }
  50% { box-shadow: 0 0 16px var(--green); }
}

.avatar-speaking-ring {
  position: absolute;
  inset: -4px;
  border: 2px solid;
  border-radius: 50%;
  animation: ring-expand 1.5s ease-out infinite;
  opacity: 0;
}

@keyframes ring-expand {
  0% { transform: scale(1); opacity: 0.6; }
  100% { transform: scale(1.3); opacity: 0; }
}

/* ═══════════════════════════════════════════════════════
   CURRENT VOICE SHOWCASE
═══════════════════════════════════════════════════════ */
.voice-showcase {
  background: rgba(255, 255, 255, 0.03);
  backdrop-filter: blur(6px);
  border: 1px solid rgba(0, 212, 255, 0.1);
  border-radius: 8px;
  padding: 14px;
  margin-top: auto;
}

.showcase-header {
  font-family: var(--mono);
  font-size: 0.7rem;
  letter-spacing: 0.15em;
  color: rgba(0, 212, 255, 0.5);
  padding-bottom: 10px;
  border-bottom: 1px solid rgba(0, 212, 255, 0.08);
  margin-bottom: 12px;
}

.showcase-body {
  display: flex;
  align-items: center;
  gap: 14px;
}

.showcase-details {
  flex: 1;
}

.showcase-name {
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--text);
}

.showcase-locale {
  font-size: 0.75rem;
  color: rgba(0, 212, 255, 0.6);
  font-family: var(--mono);
  margin-top: 2px;
}

.showcase-desc {
  font-size: 0.78rem;
  color: rgba(226, 232, 240, 0.5);
  margin-top: 6px;
  line-height: 1.3;
}

.showcase-speaking {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid rgba(0, 212, 255, 0.08);
}

.showcase-wave {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 20px;
}

.showcase-wave-bar {
  width: 3px;
  border-radius: 1px;
  animation: showcase-bar 0.6s ease-in-out infinite alternate;
}

@keyframes showcase-bar {
  0% { height: 4px; }
  100% { height: 18px; }
}

.showcase-speaking-text {
  font-size: 0.72rem;
  font-family: var(--mono);
  color: var(--green);
  letter-spacing: 0.05em;
}

/* ═══════════════════════════════════════════════════════
   FEED PANEL (ENHANCED)
═══════════════════════════════════════════════════════ */
.feed-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid rgba(0, 212, 255, 0.08);
}

.feed-title {
  font-family: var(--mono);
  font-size: 0.7rem;
  letter-spacing: 0.15em;
  color: rgba(0, 212, 255, 0.5);
}

.feed-count {
  font-family: var(--mono);
  font-size: 0.65rem;
  color: rgba(226, 232, 240, 0.3);
}

/* ═══════════════════════════════════════════════════════
   RESPONSIVE
═══════════════════════════════════════════════════════ */
@media (max-width: 1024px) {
  .main-content {
    grid-template-columns: 1fr;
  }
  .session-sidebar {
    border-left: none;
    border-top: 1px solid rgba(0, 212, 255, 0.08);
    max-height: 50vh;
  }
  .session-grid {
    grid-template-columns: 1fr 1fr;
  }
}

@media (max-width: 640px) {
  .session-grid {
    grid-template-columns: 1fr;
  }
  .showcase-body {
    flex-direction: column;
    text-align: center;
  }
}
```

> **IMPORTANT:** Append the above CSS classes to the EXISTING `listen.module.css`.
> Do NOT remove any existing classes — the orb, rings, waveform, header, footer,
> and bubble styles all still apply. Only ADD the new classes above and update
> the `.main-content` grid definition from `1fr 320px` to `1fr 380px`.

---

## 18. Build and Deploy

### Step-by-step

```bash
# 1. Navigate to pc-agent
cd D:\code\openclaw\pc-agent

# 2. Install dependencies (if not already installed)
npm install

# 3. Build the React app
npm run ui:build

# 4. Verify build output
ls dist/
# Should see: index.html, index.css, listen.js

# 5. Restart the PC Agent to pick up new routes
npm start

# 6. Open in browser
# http://127.0.0.1:3847/friday/listen
```

### Development mode

```bash
# Run Vite dev server with hot reload
npm run ui:dev
# Opens http://localhost:5173 with proxy to http://127.0.0.1:3847
```

---

## 19. Testing Checklist

### Visual Tests
- [ ] Launch overlay appears for ~2.5 seconds with progress bar
- [ ] Orb scales in with elastic animation after launch
- [ ] Header shows brand, connection badge, uptime, voice picker, theme toggle
- [ ] Left panel: Orb + status text + conversation feed
- [ ] Right panel: Session sidebar with 2-column grid
- [ ] Session cards show avatar, name, locale, context, status dot
- [ ] Current Voice Showcase at bottom of sidebar with large avatar
- [ ] Dark/light theme toggle works and persists

### Functional Tests
- [ ] SSE stream connects and shows real-time events
- [ ] User speech appears as user bubble
- [ ] Agent replies appear as Friday bubbles
- [ ] Orb click toggles mute/unmute + sends command
- [ ] Voice picker changes voice (POST /voice/set-voice)
- [ ] Session cards auto-refresh every 5 seconds from Redis
- [ ] Speaking sessions show mini waveform + "Speaking..." label
- [ ] Status dots: green = active, gray = idle

### Animation Tests
- [ ] Launch overlay fades in logo, then status, then out
- [ ] Orb launch: scale 0→1 with elastic easing
- [ ] Ring speeds vary by state (offline slow, speaking fast)
- [ ] Session cards slide in with staggered delay
- [ ] Avatar pulses when session is speaking
- [ ] Mini waveform bars bounce when speaking
- [ ] Glow color transitions smoothly between states

### API Tests
- [ ] `GET /voice/sessions` returns array of sessions with metadata
- [ ] `GET /voice/status` returns raw Redis contexts
- [ ] `GET /voice/voices` returns filtered catalogue
- [ ] `POST /voice/speak-async` triggers TTS
- [ ] Sessions persist across page reloads (Redis)

### Edge Cases
- [ ] No Redis running → sessions array empty, no errors
- [ ] No voice sessions in Redis → "No sessions tracked" message
- [ ] SSE disconnects → reconnects with backoff, badge updates
- [ ] Mobile viewport → sidebar stacks below, single-column grid

---

## Architecture Decisions

| Decision | Rationale |
|----------|-----------|
| CSS Modules (not Tailwind) | Matches existing codebase, no build changes needed |
| Context API (not Redux) | Simple enough state, no complex middleware needed |
| anime.js CDN (not npm) | npm install had version conflicts, CDN is reliable |
| Polling /voice/sessions (not SSE) | Sessions change slowly (5min idle), SSE overkill |
| Voice metadata in client (not server) | Rich UI data (icons, colors) is display concern |
| 2-column session grid | User chose grid layout with showcase at bottom |
| Launch overlay with progress bar | Professional AI agent feel, sets UX expectations |

---

## File Creation Order (for Cursor)

Execute in this order to avoid import errors:

1. `pc-agent/src/utils/voiceMetadata.ts` (no deps)
2. `pc-agent/src/hooks/useVoiceSessions.ts` (deps: VoiceAppContext types)
3. `pc-agent/src/contexts/VoiceAppContext.tsx` (extend existing)
4. `pc-agent/src/voiceRedis.js` (extend existing — add `getAllVoiceSessionsWithMetadata`)
5. `pc-agent/src/server.js` (add `GET /voice/sessions` route)
6. `pc-agent/src/components/VoiceAvatar.tsx`
7. `pc-agent/src/components/LaunchOverlay.tsx`
8. `pc-agent/src/components/SessionCard.tsx`
9. `pc-agent/src/components/CurrentVoiceShowcase.tsx`
10. `pc-agent/src/components/SessionSidebar.tsx`
11. `pc-agent/src/components/FridayListenApp.tsx` (rewrite)
12. `pc-agent/src/components/AnimatedOrb.tsx` (enhance)
13. `pc-agent/src/components/FeedPanel.tsx` (enhance)
14. `pc-agent/src/styles/listen.module.css` (append new classes)
15. Build: `npm run ui:build`

---

## Cursor Rules to Follow During Implementation

When implementing this plan, follow these `.cursor/rules/` speaking rules:

1. **acknowledge-before-planning.mdc** — Speak "Got it. Redesigning the Friday listen UI with sessions and animations." before starting
2. **friday-thinking-sounds.mdc** — Use phase-appropriate filler phrases during work
3. **narrate-thinking.mdc** — Narrate reasoning about component structure
4. **friday-narrate.mdc** — Speak verbose completion summary after finishing
5. **subagent-speak-priority.mdc** — If using subagents, set `FRIDAY_TTS_SESSION=subagent` + `PRIORITY=1`
6. **completion-read-memory.mdc** — Re-read changed files before speaking completion summary

**TTS invocation pattern for Cursor:**
```powershell
cd d:\code\openclaw; $env:FRIDAY_TTS_PRIORITY='1'; $env:FRIDAY_TTS_BYPASS_CURSOR_DEFER='true'; python skill-gateway/scripts/friday-speak.py "message here"
```

---

*Document generated 2026-04-05. Hand to Cursor for execution.*
