/**
 * Friday · Voice Daemon — listen.js
 * Client-side controller for /friday/listen
 *
 * Responsibilities:
 *  - Theme persistence (localStorage)
 *  - Server voice picker (Edge TTS)
 *  - SSE event stream → state machine + chat bubbles
 *  - Orb click → stop / resume listening toggle
 *  - Uptime clock
 */

(() => {
  'use strict';

  const AGENT  = window.location.origin;
  const STREAM = `${AGENT}/voice/stream`;

  /** @param {string} id @returns {HTMLElement} */
  const $ = id => document.getElementById(id);

  /* ── Constants ──────────────────────────────────────────────────── */
  const LS_THEME         = 'friday.theme';
  const DEDUPE_WINDOW_MS = 8_000;
  const MAX_BUBBLES      = 80;
  const RECONNECT_BASE   = 1_000;
  const RECONNECT_MAX    = 12_000;
  const RECONNECT_FACTOR = 1.6;

  const STATES = {
    offline:    { label: 'OFFLINE',    detail: 'Waiting for voice daemon…',  icon: '\u2358',         cls: 'state-offline'    },
    listening:  { label: 'LISTENING',  detail: 'Ready for your command.',     icon: '\uD83C\uDF99',   cls: 'state-listening'  },
    processing: { label: 'PROCESSING', detail: 'Routing to Friday agent…',    icon: '\u26A1',         cls: 'state-processing' },
    speaking:   { label: 'SPEAKING',   detail: 'Friday is responding…',       icon: '\uD83D\uDD0A',   cls: 'state-speaking'   },
  };

  /* ── State ───────────────────────────────────────────────────────── */
  let startTs        = null;
  let uptimeInterval = null;
  let reconnectDelay = RECONNECT_BASE;
  let es             = null;
  let exchanges      = 0;
  let listenMuted    = false;
  let edgeVoicesLoaded = false;

  const dedupeSeen   = new Map();

  /* ── Theme ───────────────────────────────────────────────────────── */
  function applyTheme(theme) {
    const isDark = theme === 'dark';
    document.body.classList.toggle('dark', isDark);
    $('themeBtn').textContent = isDark ? 'Light mode' : 'Dark mode';
  }

  function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem(LS_THEME); } catch (_) {}
    applyTheme(saved || 'light');
  }

  $('themeBtn').addEventListener('click', () => {
    const next = document.body.classList.contains('dark') ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem(LS_THEME, next); } catch (_) {}
  });

  /* ── Voice picker ────────────────────────────────────────────────── */
  const voicePicker = $('serverVoicePicker');

  function showToast(msg) {
    const el = document.createElement('div');
    el.className   = 'voice-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2_800);
  }

  async function loadVoices() {
    try {
      const r = await fetch('/voice/voices');
      const d = await r.json();
      if (!d.ok || !d.voices?.length) return;

      const active = d.active || '';
      voicePicker.innerHTML = '';

      // Group by locale
      const GROUP_KEYS = ['British English','American English','Indian English','Australian English','Canadian English','Other'];
      const groups = {};
      for (const v of d.voices) {
        const key = v.lang.startsWith('en-GB') ? 'British English'    :
                    v.lang.startsWith('en-US') ? 'American English'   :
                    v.lang.startsWith('en-IN') ? 'Indian English'     :
                    v.lang.startsWith('en-AU') ? 'Australian English' :
                    v.lang.startsWith('en-CA') ? 'Canadian English'   : 'Other';
        (groups[key] = groups[key] || []).push(v);
      }

      for (const grpKey of GROUP_KEYS) {
        if (!groups[grpKey]) continue;
        const optgrp   = document.createElement('optgroup');
        optgrp.label   = grpKey;
        for (const v of groups[grpKey]) {
          const opt       = document.createElement('option');
          opt.value       = v.voice;
          opt.textContent = `${v.voice.replace('Neural','').replace(/^en-\w\w-/,'')}  [${v.gender}] — ${v.desc}`;
          if (v.voice === active) opt.selected = true;
          optgrp.appendChild(opt);
        }
        voicePicker.appendChild(optgrp);
      }

      $('footerVoice').textContent         = active || d.provider;
      $('voicePickerWrap').style.display   = d.provider === 'edge' ? 'flex' : 'none';
      edgeVoicesLoaded                     = true;
    } catch (_) {}
  }

  voicePicker.addEventListener('change', async () => {
    const voice = voicePicker.value;
    if (!voice) return;
    voicePicker.disabled = true;
    try {
      const r = await fetch('/voice/set-voice', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ voice }),
      });
      const d = await r.json();
      if (d.ok) {
        $('footerVoice').textContent = d.active;
        showToast(`Voice → ${d.active}`);
      }
    } catch (_) {
      showToast('Could not change voice — server unreachable');
    } finally {
      voicePicker.disabled = false;
    }
  });

  /* ── State machine ───────────────────────────────────────────────── */
  function setState(name, detail) {
    const s         = STATES[name] || STATES.offline;
    const themeClass = document.body.classList.contains('dark') ? 'dark' : '';
    document.body.className          = [s.cls, themeClass].filter(Boolean).join(' ');
    $('statusText').textContent       = s.label;
    $('statusDetail').textContent     = detail || s.detail;
    // Only update orb icon if not in muted state
    if (!listenMuted) $('orbIcon').textContent = s.icon;
  }

  /* ── Chat bubbles ────────────────────────────────────────────────── */
  function fmtTime(ts) {
    return (ts ? new Date(ts) : new Date()).toLocaleTimeString('en-GB', { hour12: false });
  }
  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  function trimFeed(scroll) {
    while (scroll.children.length > MAX_BUBBLES) scroll.removeChild(scroll.firstChild);
    scroll.scrollTop = scroll.scrollHeight;
  }

  function addUserBubble(text, ts) {
    const scroll = $('feedScroll');
    const el     = document.createElement('div');
    el.className = 'bubble bubble-user';
    el.innerHTML = `<div class="bubble-body">${esc(text)}</div><div class="bubble-meta">${fmtTime(ts)}</div>`;
    scroll.appendChild(el);
    trimFeed(scroll);
  }

  function addFridayBubble(text, ts) {
    const scroll = $('feedScroll');
    const el     = document.createElement('div');
    el.className = 'bubble bubble-friday';
    el.innerHTML = `<div class="bubble-meta"><span class="b-name">FRIDAY</span>${fmtTime(ts)}</div><div class="bubble-body">${esc(text)}</div>`;
    scroll.appendChild(el);
    trimFeed(scroll);
    exchanges++;
    $('feedCount').textContent    = `${exchanges} exchange${exchanges !== 1 ? 's' : ''}`;
    $('footerEvents').textContent = String(exchanges);
  }

  function addErrorBubble(text, ts) {
    const scroll = $('feedScroll');
    const el     = document.createElement('div');
    el.className = 'bubble bubble-error';
    el.innerHTML = `<div class="bubble-meta">${fmtTime(ts)} &#9888; ERROR</div><div class="bubble-body">${esc(text)}</div>`;
    scroll.appendChild(el);
    scroll.scrollTop = scroll.scrollHeight;
  }

  function addDivider(label) {
    const scroll = $('feedScroll');
    const el     = document.createElement('div');
    el.className = 'sys-divider';
    el.innerHTML = `<span>${esc(label)}</span>`;
    scroll.appendChild(el);
    scroll.scrollTop = scroll.scrollHeight;
  }

  /* ── Deduplication ───────────────────────────────────────────────── */
  function shouldSkip(type, text) {
    if (!['heard', 'reply', 'error'].includes(type)) return false;
    const key  = `${type}:${String(text || '').trim()}`;
    const now  = Date.now();
    const prev = dedupeSeen.get(key);
    if (prev != null && now - prev < DEDUPE_WINDOW_MS) return true;
    dedupeSeen.set(key, now);
    for (const [k, t] of dedupeSeen) {
      if (now - t > DEDUPE_WINDOW_MS * 2) dedupeSeen.delete(k);
    }
    return false;
  }

  /* ── SSE event handler ───────────────────────────────────────────── */
  function handleEvent(raw) {
    let evt;
    try { evt = JSON.parse(raw); } catch { return; }
    const { type, text, ts } = evt;
    if (shouldSkip(type, text)) return;

    switch (type) {
      case 'daemon_start':
        startTs = ts || Date.now();
        startUptimeClock();
        setState('listening');
        addDivider('FRIDAY ONLINE');
        break;
      case 'server_start':
        if (!startTs) { startTs = ts || Date.now(); startUptimeClock(); }
        addDivider('SERVER READY');
        break;
      case 'listening':
        setState('listening', text);
        break;
      case 'heard':
        setState('processing', `"${text}"`);
        $('heardText').textContent = text || '—';
        addUserBubble(text, ts);
        break;
      case 'thinking':
        setState('processing', text || 'Routing to Friday agent…');
        break;
      case 'speak':
        setState('speaking', text);
        break;
      case 'reply':
        setState('listening');
        if (text) addFridayBubble(text, ts);
        break;
      case 'error':
        addErrorBubble(text, ts);
        break;
      case 'voice_changed':
        $('footerVoice').textContent = text || evt.voice || '—';
        if (!edgeVoicesLoaded) loadVoices();
        break;
    }
  }

  /* ── Uptime clock ────────────────────────────────────────────────── */
  function startUptimeClock() {
    if (uptimeInterval) clearInterval(uptimeInterval);
    uptimeInterval = setInterval(() => {
      if (!startTs) return;
      const d = Math.floor((Date.now() - startTs) / 1_000);
      const h = String(Math.floor(d / 3_600)).padStart(2, '0');
      const m = String(Math.floor((d % 3_600) / 60)).padStart(2, '0');
      const s = String(d % 60).padStart(2, '0');
      $('uptime').textContent = `${h}:${m}:${s}`;
    }, 1_000);
  }

  /* ── SSE connection ──────────────────────────────────────────────── */
  function setConn(live) {
    const dot = $('connDot');
    dot.classList.toggle('live', live);
    $('connLabel').textContent = live ? 'LIVE' : 'OFFLINE';
    if (live) {
      reconnectDelay = RECONNECT_BASE;
    } else {
      setState('offline');
    }
  }

  function connect() {
    if (es) { try { es.close(); } catch (_) {} }
    es = new EventSource(STREAM);
    es.addEventListener('open',    ()  => setConn(true));
    es.addEventListener('message', e   => { if (e.data && !e.data.startsWith(':')) handleEvent(e.data); });
    es.addEventListener('error',   ()  => {
      setConn(false);
      es.close();
      reconnectDelay = Math.min(reconnectDelay * RECONNECT_FACTOR, RECONNECT_MAX);
      setTimeout(connect, reconnectDelay);
    });
  }

  /* ── Orb — stop / resume toggle ─────────────────────────────────── */
  async function sendVoiceCommand(text) {
    try {
      await fetch(`${AGENT}/voice/command`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text, source: 'ui', userId: 'friday-ui' }),
      });
    } catch (_) {}
  }

  $('orbBtn').addEventListener('click', async () => {
    listenMuted = !listenMuted;
    const orb = $('orbBtn');

    if (listenMuted) {
      orb.classList.add('muted');
      orb.setAttribute('aria-label', 'Click to resume listening');
      orb.title = 'Click to resume listening';

      // Grab whatever was last heard and send it downstream immediately
      const lastHeard = ($('heardText').textContent || '').trim();
      if (lastHeard && lastHeard !== '—') {
        showToast(`Sending: "${lastHeard}"`);
        setState('processing', `Sending: "${lastHeard}"`);
        // Fire to agent async — show reply in bubble feed when it comes back
        (async () => {
          try {
            const r = await fetch(`${AGENT}/voice/command`, {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify({ text: lastHeard, source: 'ui', userId: 'friday-ui' }),
            });
            const d = await r.json();
            if (d?.summary) {
              addFridayBubble(d.summary, Date.now());
              setState('offline');
              // Speak the response via Jarvis voice daemon (fire-and-forget)
              fetch(`${AGENT}/voice/speak-async`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: d.summary }),
              }).catch(() => {});
            }
          } catch (_) {
            setState('offline');
          }
        })();
      } else {
        showToast('Listening paused — click orb to resume');
      }

    } else {
      orb.classList.remove('muted');
      orb.setAttribute('aria-label', 'Click to stop listening');
      orb.title = 'Click to stop listening';
      setState('listening');
      showToast('Listening resumed');
      await sendVoiceCommand('resume listening');
    }
  });

  /* ── Init ────────────────────────────────────────────────────────── */
  function init() {
    initTheme();
    $('footerAgent').textContent = window.location.host;

    fetch('/voice/ping')
      .then(r => r.json())
      .then(d => { if (d?.tts?.edgeVoice) $('footerVoice').textContent = d.tts.edgeVoice; })
      .catch(() => {});

    loadVoices();
    connect();
  }

  init();
})();
