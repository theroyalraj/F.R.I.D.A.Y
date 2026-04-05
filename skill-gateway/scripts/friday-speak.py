#!/usr/bin/env python3
"""
Friday TTS — edge-tts neural voice, plays to a named Windows audio device.

Usage:
  python friday-speak.py "Task complete, sir."
  python friday-speak.py --output path/to/out.mp3 "Text"   # write MP3, no playback
  python friday-speak.py --stdout "Text"                    # pipe MP3 bytes to stdout

Env vars (all optional):
  FRIDAY_TTS_VOICE   edge-tts voice name  (default: en-US-EmmaMultilingualNeural)
  FRIDAY_TTS_DEVICE  audio device substring (default: "" = Windows default device)
                     set to "Echo Dot", "WH-1000XM3", etc. to lock a specific output
  FRIDAY_TTS_RATE    speed               (default: +7.5% ≈ 1.075× vs baseline)
  FRIDAY_TTS_PITCH   pitch               (default: +2Hz — slightly bright / engaged)
  FRIDAY_TTS_VOLUME  volume              (default: +0%)
  FRIDAY_TTS_CACHE   MP3 cache dir       (default: %TEMP%/friday-tts-cache)
                     set to "" to disable cache
  FRIDAY_TTS_SESSION  when set to "subagent", session voice is read from
                     subagent_voice in .session-voice.json (Task subagents)
  FRIDAY_TTS_VOICE_BLOCK  comma-separated Edge voice ids never spoken — overrides
                     sticky session / env if they point at a blocked voice
  FRIDAY_TTS_USE_SESSION_STICKY_VOICE  set false so FRIDAY_TTS_VOICE from this
                     process env wins over .session-voice.json (e.g. ambient alt voice)
  FRIDAY_TTS_PRIORITY  when true (1/true/on): voice-daemon / urgent playback —
                     stops competing friday-player + ambient TTS, clears the TTS
                     lock, then speaks immediately; if ambient was mid-line, replays
                     it afterward with a short apology (friday-listen sets this).
  FRIDAY_TTS_INTERRUPT_MUSIC  set to ui (or true/yes/on) to allow fading/stopping
                     friday-play background music. Default: other TTS does not cut music
                     (Redis friday:music:active + local PID/session guard).
  FRIDAY_DEFER_SPEAK_WHEN_CURSOR  Windows: skip playback when Cursor (or
                     FRIDAY_DEFER_FOCUS_EXES) is foreground — default true so voice
                     mode in the IDE is not doubled with Jarvis TTS.
  FRIDAY_TTS_BYPASS_CURSOR_DEFER  When true, play anyway (startup greetings, Cursor
                     agent narration, etc.). Set by fridaySpeak.js for gateway boot.
  FRIDAY_TTS_THINKING_RATE  optional fixed Edge rate when FRIDAY_TTS_THINKING is on;
                     when unset, rate scales with utterance length (faster short, slower long).
  FRIDAY_TTS_MAX_PLAYBACK_SEC  Hard cap on ffplay seconds per utterance for every session
                     when set (0 or false = no limit). When unset: no cap for normal TTS;
                     for FRIDAY_TTS_SESSION=cursor-reply or subagent (long transcript reads),
                     caps at FRIDAY_TTS_QUERY_MAX_PLAYBACK_SEC (default 60). On cap: kill
                     player only — no spoken line (avoid mixer volume tricks that garble later plays).

Good voices (respect FRIDAY_TTS_VOICE_BLOCK in .env — blocked ids are never used):
  en-US-EmmaMultilingualNeural  US female multilingual — repo default when env unset
  en-US-GuyNeural               US male neural
  en-IN-NeerjaExpressiveNeural  Indian English / Hinglish
  hi-IN-SwaraNeural             Hindi female

Latency notes:
  • Cache HIT  → audio starts in ~50 ms  (disk read + ffplay init)
  • Cache MISS → audio starts in ~150 ms (edge-tts first chunk arrives fast;
                 streaming pipes chunks to ffplay as they arrive and saves to
                 cache simultaneously — no wait for full download)
  • Semantic cache: text is normalised before hashing so near-identical phrases
    ("Done. sir." / "done, sir") share the same cached MP3.
"""
import atexit
import asyncio
import hashlib
import io
import os
import random
import unicodedata
import re
import signal as _signal
import subprocess
import sys
import tempfile
import threading
import time
import platform
import warnings
from pathlib import Path

_REPO_SCRIPTS = Path(__file__).resolve().parent.parent.parent / "scripts"
if str(_REPO_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_REPO_SCRIPTS))
from friday_speaker import thinking_tts_rate_for_length

# Python 3.14 Windows: ProactorEventLoop breaks aiohttp SSL/WebSocket (WinError 64
# on speech.platform.bing.com). SelectorEventLoop restores stable edge-tts.
if platform.system() == "Windows":
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        try:
            asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
        except AttributeError:
            pass  # removed in Python 3.16+

import socket
import aiohttp
import edge_tts

# Force IPv4 for aiohttp — IPv6 routes to speech.platform.bing.com are unreliable
# on some Windows networks (connection reset during TLS handshake).
_orig_tcp_init = aiohttp.TCPConnector.__init__
def _ipv4_tcp_init(self, *args, **kwargs):
    kwargs.setdefault("family", socket.AF_INET)
    _orig_tcp_init(self, *args, **kwargs)
aiohttp.TCPConnector.__init__ = _ipv4_tcp_init

from friday_platform_audio import find_output_device_id as _find_device_id
from friday_platform_audio import get_default_output_id as _get_default_output_id
from friday_platform_audio import set_default_endpoint as _set_default_endpoint
from friday_music_lock import friday_play_music_hold_active, may_interrupt_music_from_tts

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_ENV_FILE = _REPO_ROOT / ".env"
if _ENV_FILE.exists():
    for line in _ENV_FILE.read_text(encoding="utf-8").splitlines():
        t = line.strip()
        if not t or t.startswith("#") or "=" not in t:
            continue
        k, _, rest = t.partition("=")
        k = k.strip()
        v = rest.split("#", 1)[0].strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v

# ── Thinking openers (prepended to FRIDAY_TTS_THINKING speaks) ────────────────
_THINKING_OPENERS = (
    "Hmm. ", "Interesting — ", "Actually — ", "Wait — ", "Hang on — ",
    "Hold on a second — ", "That's a good question — ",
    "Now that I look at this — ", "Okay, this is nuanced — ",
    "There's a subtlety here — ", "This is worth unpacking — ",
    "So here's what's happening — ", "Let me reason through this — ",
    "Okay, thinking this through — ", "The thing to notice here is — ",
    "This is more involved than it looks — ", "Let me connect the dots here — ",
    "Right. ", "So — ", "Now — ", "Right, so — ", "Okay, so — ",
    "Here's the thing — ", "The key insight is — ", "What matters here is — ",
    "From what I can tell — ", "Based on what I'm seeing — ",
    "If I'm reading this correctly — ", "The way this works is — ",
    "So the pattern here is — ", "What's going on under the hood is — ",
    "Let me think — ", "Let me see — ", "Let me check — ",
    "Let me dig into this — ", "Let me trace through this — ",
    "Okay, pulling this apart — ", "Let me walk through the logic — ",
    "Bear with me on this one — ",
    "I want to make sure I get this right — ",
    "Okay, working through this step by step — ",
    "Okay — ", "Alright — ", "Right then — ", "So look — ",
    "Okay, here's my read — ", "So basically — ", "Yeah, so — ",
    "Alright, so — ", "Let me break this down — ",
    "Okay, let me lay this out — ",
    "Oh boy. ", "Oh no. ", "Wow, okay — ", "Who wrote this? ",
    "Yikes — ", "Well that's creative — ", "Brave choice — ",
    "Oh, we're doing this are we — ",
    "Someone was feeling adventurous — ", "This is a cry for help — ",
    "Bold strategy, let's see if it pays off — ",
    "I have questions. Many questions — ",
    "Tell me you didn't test this — ",
    "I'm not mad, I'm just disappointed — ",
    "Whoever did this owes me an explanation — ",
    "This has big 'it works on my machine' energy — ",
    "Ah yes, the classic 'fix it later' approach — ",
    "I see someone chose violence today — ",
    "Pain. Pure pain — ", "This code has a certain chaotic energy — ",
    "It's giving spaghetti code — ", "First time? ",
    "Skill issue detected — ", "This ain't it, chief — ",
    "We need to talk — ", "So anyway, I started blasting — ",
    "Confused screaming — ", "Task failed successfully — ",
    "Not gonna lie — ", "Top ten anime betrayals — ",
    "How do I even begin — ", "Bro really said 'trust me' — ",
    "You see what happened was — ",
    "Ladies and gentlemen, we got him — ", "Outstanding move — ",
    "I'm going to pretend I didn't see that — ",
    "Modern problems require modern solutions — ",
    "That's rough, buddy — ", "They don't know — ", "Big brain time — ",
)

# ── Arg parsing ───────────────────────────────────────────────────────────────
_args  = sys.argv[1:]
OUTPUT = None
STDOUT = False

if "--output" in _args:
    i      = _args.index("--output")
    OUTPUT = _args[i + 1]
    _args  = _args[:i] + _args[i + 2:]
elif "--stdout" in _args:
    STDOUT = True
    _args  = [a for a in _args if a != "--stdout"]

TEXT   = " ".join(_args).strip()
# Normalise immediately — every downstream path (cache key, edge-tts, SAPI) gets clean text.
# The function is defined later in this file; we call it after full module load below.
_RAW_TEXT = TEXT
VOICE  = os.environ.get("FRIDAY_TTS_VOICE",  "en-US-EmmaMultilingualNeural")

# Session-sticky voice: .session-voice.json overrides the env default above
# unless FRIDAY_TTS_USE_SESSION_STICKY_VOICE is false (ambient alternate voice).
# FRIDAY_TTS_SESSION=subagent → use subagent_voice (pick-session-voice --subagent).
# FRIDAY_TTS_SESSION=cursor-reply → use cursor_reply_voice (pick-session-voice --cursor-reply).
_SESSION_KIND = os.environ.get("FRIDAY_TTS_SESSION", "").strip().lower()
_SESSION_STICKY = os.environ.get("FRIDAY_TTS_USE_SESSION_STICKY_VOICE", "true").strip().lower() not in (
    "0", "false", "no", "off",
)
_SESSION_VOICE_FILE = Path(__file__).resolve().parent.parent.parent / ".session-voice.json"
_PICK_SCRIPT = Path(__file__).resolve().parent / "pick-session-voice.py"
_session_loaded = False
try:
    import json as _json
    _sv = _json.loads(_SESSION_VOICE_FILE.read_text(encoding="utf-8"))
    if _SESSION_KIND == "subagent" and _sv.get("subagent_voice"):
        VOICE = _sv["subagent_voice"]
    elif _SESSION_KIND == "cursor-reply" and _sv.get("cursor_reply_voice"):
        VOICE = _sv["cursor_reply_voice"]
    elif _sv.get("voice") and _SESSION_STICKY:
        VOICE = _sv["voice"]
    _session_loaded = True
except Exception:
    pass

if not _session_loaded and _PICK_SCRIPT.exists():
    try:
        import subprocess as _sp_init
        _pick_args = [sys.executable, str(_PICK_SCRIPT)]
        if _SESSION_KIND == "subagent":
            _pick_args.append("--subagent")
        elif _SESSION_KIND == "cursor-reply":
            _pick_args.append("--cursor-reply")
        _pick_env = {**os.environ}
        if _SESSION_KIND:
            _pick_env["FRIDAY_TTS_SESSION"] = _SESSION_KIND
        _pick_env["FRIDAY_PICK_SESSION_NO_WELCOME"] = "true"
        _sp_init.Popen(
            _pick_args,
            env=_pick_env,
            cwd=str(_SESSION_VOICE_FILE.parent),
            stdout=_sp_init.DEVNULL,
            stderr=_sp_init.DEVNULL,
            **({} if sys.platform != "win32" else {"creationflags": 0x08000000}),
        )
    except Exception:
        pass

_blocked_tts = {v.strip() for v in os.environ.get("FRIDAY_TTS_VOICE_BLOCK", "").split(",") if v.strip()}
_blocked_tts |= {
    "en-AU-WilliamNeural",
    "en-AU-WilliamMultilingualNeural",
    "en-GB-RyanNeural",
    "en-GB-ThomasNeural",
}
if VOICE in _blocked_tts:
    _pref = os.environ.get("FRIDAY_TTS_VOICE", "en-US-EmmaMultilingualNeural").strip() or "en-US-EmmaMultilingualNeural"
    if _pref not in _blocked_tts:
        VOICE = _pref
    else:
        VOICE = "en-US-EmmaMultilingualNeural"

RATE   = os.environ.get("FRIDAY_TTS_RATE",   "+7.5%")
PITCH  = os.environ.get("FRIDAY_TTS_PITCH",  "+2Hz")
VOLUME = os.environ.get("FRIDAY_TTS_VOLUME", "+0%")

# Populated in speak() when FRIDAY_CURSOR_THINKING_VOICE_POOL is set and _is_thinking is True.
_thinking_voice_pool: list[str] = []
DEVICE = os.environ.get("FRIDAY_TTS_DEVICE", "").strip()

_cache_env = os.environ.get("FRIDAY_TTS_CACHE", "").strip()
CACHE_DIR: Path | None = None
if _cache_env == "":
    # Default: use temp dir
    CACHE_DIR = Path(tempfile.gettempdir()) / "friday-tts-cache"
elif _cache_env.lower() in ("0", "false", "off", "none", "disabled"):
    CACHE_DIR = None  # disabled
else:
    CACHE_DIR = Path(_cache_env)

if CACHE_DIR is not None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

# Timestamp file for ambient silence monitor (playback paths only; not --output/--stdout).
TTS_TS_FILE     = Path(tempfile.gettempdir()) / "friday-tts-ts"
TTS_ACTIVE_FILE = Path(tempfile.gettempdir()) / "friday-tts-active"  # exists while speech is playing
# Written by friday-ambient speak_blocking while a line is playing (for priority replay).
AMBIENT_SPEAKING_FILE = Path(tempfile.gettempdir()) / "friday-ambient-speaking.txt"
# Thinking singleton — at most one thinking-narration speak in the pipeline at a time.
THINKING_SINGLETON_FILE = Path(tempfile.gettempdir()) / "friday-thinking-singleton"
# Global singleton generation — each speak bumps a monotonic counter on entry.
# Queued speaks check their generation before acquiring the playback lock: if a
# newer generation exists, the queued speak exits (it's been superseded).
# Ensures only the LATEST speak plays — no pile-up from concurrent fire-and-forget calls.
TTS_GENERATION_FILE = Path(tempfile.gettempdir()) / "friday-tts-generation"


def _write_last_spoken_ts() -> None:
    """Record wall-clock time when TTS playback finished (friday-ambient.py polls this)."""
    try:
        TTS_TS_FILE.write_text(str(time.time()), encoding="utf-8")
    except OSError:
        pass


_REDIS_TTS_GEN_KEY = "friday:tts:generation"
_REDIS_TTS_GEN_TTL = 120  # 2 min auto-expire

def _bump_tts_generation() -> int:
    """Atomically INCR the global TTS generation counter in Redis. Falls back to file."""
    r = _get_redis_client()
    if r is not None:
        try:
            nxt = r.incr(_REDIS_TTS_GEN_KEY)
            r.expire(_REDIS_TTS_GEN_KEY, _REDIS_TTS_GEN_TTL)
            return int(nxt)
        except Exception:
            pass
    # File fallback
    try:
        cur = int(TTS_GENERATION_FILE.read_text().strip()) if TTS_GENERATION_FILE.exists() else 0
    except (OSError, ValueError):
        cur = 0
    nxt = cur + 1
    try:
        TTS_GENERATION_FILE.write_text(str(nxt), encoding="utf-8")
    except OSError:
        pass
    return nxt


def _current_tts_generation() -> int:
    r = _get_redis_client()
    if r is not None:
        try:
            val = r.get(_REDIS_TTS_GEN_KEY)
            if val is not None:
                return int(val)
        except Exception:
            pass
    # File fallback
    try:
        return int(TTS_GENERATION_FILE.read_text().strip()) if TTS_GENERATION_FILE.exists() else 0
    except (OSError, ValueError):
        return 0


def _playback_superseded(my_gen: int) -> bool:
    """True if a newer speak bumped the global generation — do not start overlapping audio.

    Priority pre-empt clears the file lock and kills friday-player, but another process
    can already be inside _speak_inner (e.g. mid Edge download).  Without this check it
    would still call _play_ffplay and talk over the newer utterance.
    """
    if OUTPUT or STDOUT:
        return False
    cur = _current_tts_generation()
    if cur > my_gen:
        print(
            f"[friday-speak] superseded before playback (gen {my_gen} < {cur}) — skipping audio",
            flush=True,
        )
        return True
    return False


# ── Human-speech normaliser ────────────────────────────────────────────────────
_SMALL = [
    "zero","one","two","three","four","five","six","seven","eight","nine","ten",
    "eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen",
    "eighteen","nineteen","twenty",
]

def _n2w(n: str) -> str:
    try:
        i = int(float(n))
        if 0 <= i <= 20:
            return _SMALL[i]
    except (ValueError, IndexError):
        pass
    return n


def _strip_redacted_placeholders(text: str) -> str:
    """Remove privacy / tool-result tokens so Edge never speaks the word redacted."""
    if not text:
        return text
    t = text
    # Unicode-normalise (homoglyph tricks in logs)
    try:
        t = unicodedata.normalize("NFKC", t)
    except Exception:
        pass
    subs = (
        r"(?i)\*+\s*redacted\s*\*+",
        r"(?i)`\s*redacted\s*`",
        r"(?i)<\s*redacted[^>]*>",
        r"(?i)\[\s*redacted\s*\]",
        r"(?i)\{\s*redacted\s*\}",
        r"(?i)\(\s*redacted\s*\)",
        r"(?i)\bredacted\s*[:;.,!?…]+\s*",
        r"(?i)\bredacted\b",
        r"(?i)\bREDACTED\b",
    )
    for pat in subs:
        t = re.sub(pat, " ", t)
    return re.sub(r"\s{2,}", " ", t).strip()


def normalize_for_speech(text: str) -> str:
    """
    Convert any text to clean, speakable English before handing it to edge-tts.

    Strips markdown, code, URLs, symbols, and converts technical patterns
    (env var names, units, percentages, paths) to natural words.
    """
    if not text:
        return text
    t = _strip_redacted_placeholders(text)

    # Devanagari (Hindi, etc.): skip English-centric rewrites — they garble TTS.
    if re.search(r"[\u0900-\u097F]", t):
        t = re.sub(r"```[\s\S]*?```", " ", t)
        t = re.sub(r"`[^`]+`", " ", t)
        t = re.sub(r"https?://\S+", "", t)
        t = re.sub(r"[\U0001F000-\U0001FFFF]", " ", t)
        t = re.sub(r"[\u2600-\u27BF]", " ", t)
        t = re.sub(r"\s{2,}", " ", t).strip()
        if len(t) > 3800:
            t = t[:3800] + "."
        t = _strip_redacted_placeholders(t)
        return t.strip()

    # Code blocks and inline code
    t = re.sub(r"```[\s\S]*?```", " ", t)
    t = re.sub(r"`[^`]+`", " ", t)

    # Markdown headings
    t = re.sub(r"^#{1,6}\s+", "", t, flags=re.MULTILINE)

    # Bold / italic
    t = re.sub(r"\*{1,3}([^*]+)\*{1,3}", r"\1", t)
    t = re.sub(r"_{1,2}([^_]+)_{1,2}", r"\1", t)

    # Markdown links [label](url) → label
    t = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", t)

    # Bare URLs
    t = re.sub(r"https?://\S+", "", t)

    # Bullet / list leaders
    t = re.sub(r"^[ \t]*[-*•◦▸▶]+[ \t]+", "", t, flags=re.MULTILINE)
    t = re.sub(r"^\s*\d+[.)]\s+", "", t, flags=re.MULTILINE)

    # Markdown horizontal rules
    t = re.sub(r"^[-*_]{3,}\s*$", "", t, flags=re.MULTILINE)

    # HTML entities
    t = (t.replace("&amp;", " and ").replace("&lt;", " less than ")
          .replace("&gt;", " greater than ").replace("&rarr;", " to ")
          .replace("&larr;", " from ").replace("&nbsp;", " "))
    t = re.sub(r"&#\d+;", " ", t)

    # Emoji (basic Unicode ranges)
    t = re.sub(r"[\U0001F000-\U0001FFFF]", " ", t)
    t = re.sub(r"[\u2600-\u27BF]", " ", t)

    # KEY=VALUE env vars  →  "key set to value"
    t = re.sub(
        r"\b([A-Z][A-Z0-9_]{2,})=([^\s,]+)",
        lambda m: f"{m.group(1).lower().replace('_', ' ')} set to {m.group(2)}",
        t,
    )
    # lowercase key=value  e.g.  silence=12s  →  silence: twelve seconds
    t = re.sub(
        r"\b([a-z][a-z_]{2,})=(\S+)",
        lambda m: f"{m.group(1).replace('_', ' ')}: {m.group(2)}",
        t,
    )
    # (key_word: value) parentheticals  e.g. (exit_code: 0)  →  exit code: zero
    t = re.sub(
        r"\(([a-z][a-z_]+):\s*([^)]+)\)",
        lambda m: m.group(1).replace("_", " ") + ": " + m.group(2).strip(),
        t,
    )

    # ALL_CAPS identifiers  →  lowercase words
    t = re.sub(
        r"\b([A-Z]{2,}[_][A-Z0-9_]+)\b",
        lambda m: m.group(0).lower().replace("_", " "),
        t,
    )

    # snake_case / kebab-case / file.ext identifiers
    t = re.sub(
        r"\b([a-z][a-zA-Z0-9]*[-_.][a-zA-Z0-9._-]+)\b",
        lambda m: m.group(0).replace("-", " ").replace("_", " ").replace(".", " dot "),
        t,
    )

    # Slash paths  /voice/set-voice  →  voice set voice
    t = re.sub(
        r"/([a-z][-a-z0-9/]+)",
        lambda m: " " + m.group(1).replace("/", " ").replace("-", " "),
        t,
    )

    # Units & symbols → words
    t = re.sub(r"(\d+(?:\.\d+)?)\s*%",        lambda m: f"{m.group(1)} percent",         t)
    t = re.sub(r"(\d+(?:\.\d+)?)\s*ms\b",     lambda m: f"{m.group(1)} milliseconds",    t, flags=re.IGNORECASE)
    t = re.sub(r"(\d+(?:\.\d+)?)\s*s\b",      lambda m: f"{_n2w(m.group(1))} seconds",   t)
    t = re.sub(r"(\d+(?:\.\d+)?)\s*kb\b",     lambda m: f"{m.group(1)} kilobytes",       t, flags=re.IGNORECASE)
    t = re.sub(r"(\d+(?:\.\d+)?)\s*mb\b",     lambda m: f"{m.group(1)} megabytes",       t, flags=re.IGNORECASE)
    t = re.sub(r"(\d+(?:\.\d+)?)\s*°\s*([CF])",
               lambda m: f"{m.group(1)} degrees {'celsius' if m.group(2)=='C' else 'fahrenheit'}", t)
    t = re.sub(r"\$(\d[\d,]*)",               lambda m: f"{m.group(1).replace(',','')} dollars", t)

    # Punctuation / symbols
    t = re.sub(r"\s*[—–]\s*", ", ", t)          # em/en dash → comma pause
    t = re.sub(r" \| ", ", ", t)                 # pipe → comma
    t = re.sub(r"\s*[-=]>\s*", " to ", t)        # arrows
    t = re.sub(r"(\w)/(\w)", r"\1 or \2", t)     # a/b → a or b
    t = re.sub(r"\.{3}|…", ", ", t)              # ellipsis → pause
    t = re.sub(r"\n{2,}", ". ", t)               # blank lines → sentence break
    t = re.sub(r"\n", " ", t)                    # single newlines → space

    # Collapse whitespace
    t = re.sub(r"\s{2,}", " ", t).strip()

    # Cap length
    if len(t) > 3800:
        t = t[:3800] + "."

    t = _strip_redacted_placeholders(t)
    t = re.sub(r"\s{2,}", " ", t).strip()
    return t


# ── Semantic / normalised cache key ───────────────────────────────────────────
def _normalize_text(text: str) -> str:
    """
    Normalise text before hashing so near-identical phrases share a cache entry.

    Transforms applied (in order):
      • strip leading/trailing whitespace
      • collapse internal whitespace to single spaces
      • lowercase everything
      • strip trailing sentence-ending punctuation  (.  !  ?  …)
      • strip a trailing "sir" suffix (with optional punctuation) so
        "Task complete, sir." and "Task complete, sir" and
        "task complete sir" all resolve to the same key
    """
    t = text.strip()
    t = re.sub(r'\s+', ' ', t)          # multi-space → single space
    t = t.lower()
    t = re.sub(r'[.!?\u2026]+$', '', t) # trailing sentence enders
    t = t.strip()
    # Normalise trailing ", sir" / " sir" / "sir." so phrasing variants collapse
    t = re.sub(r'[,\s]+sir[.!?]*$', ' sir', t)
    t = t.strip()
    return t


def _cache_key() -> str:
    normalised = _normalize_text(TEXT)
    key = f"{normalised}|{VOICE}|{RATE}|{PITCH}|{VOLUME}"
    return hashlib.md5(key.encode()).hexdigest()

def _cache_path() -> Path | None:
    if CACHE_DIR is None:
        return None
    return CACHE_DIR / f"{_cache_key()}.mp3"

def _load_cache() -> bytes | None:
    p = _cache_path()
    if p and p.exists() and p.stat().st_size > 100:
        return p.read_bytes()
    return None

def _save_cache(data: bytes):
    p = _cache_path()
    if p:
        try:
            p.write_bytes(data)
        except Exception:
            pass


# ── Edge-TTS fetch (full download — used for --output / --stdout) ─────────────
async def _fetch_mp3_network(retries: int = 2) -> bytes:
    """Download full MP3 via edge-tts. Retries with backoff before raising."""
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            communicate = edge_tts.Communicate(TEXT, VOICE, rate=RATE, pitch=PITCH, volume=VOLUME)
            buf = io.BytesIO()
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    buf.write(chunk["data"])
            if buf.tell() > 0:
                return buf.getvalue()
            raise RuntimeError("empty audio response")
        except Exception as exc:
            last_err = exc
            if attempt < retries:
                wait = attempt * 2.0
                print(f"[friday-speak] attempt {attempt} failed ({exc.__class__.__name__}), retry in {wait}s", file=sys.stderr, flush=True)
                await asyncio.sleep(wait)
    raise last_err


def _split_thinking_sentences(text: str, max_chars: int = 320) -> list[str]:
    """Split thinking text at sentence boundaries, merge short fragments, cap chunk size."""
    raw = [s.strip() for s in re.split(r'(?<=[.!?…])\s+', text) if s.strip()]
    if not raw:
        return [text] if text.strip() else []
    chunks: list[str] = []
    cur = ""
    for s in raw:
        if cur and len(cur) + 1 + len(s) > max_chars:
            chunks.append(cur)
            cur = s
        else:
            cur = (cur + " " + s).strip() if cur else s
    if cur:
        chunks.append(cur)
    return chunks


# ── Windows mixer volume guard ─────────────────────────────────────────────────
def _fix_ffplay_volume(pid: int, target: float = 1.0, timeout: float = 2.0) -> None:
    """
    Poll the Windows audio session for friday-player PID and force volume to 100%.

    Windows remembers per-app mixer volume by executable name. We use
    friday-player.exe (a copy of ffplay) so its name has no stored preference.
    This guard catches any edge case where the session still starts below target.
    """
    try:
        from pycaw.utils import AudioUtilities
        deadline = time.time() + timeout
        while time.time() < deadline:
            sessions = AudioUtilities.GetAllSessions()
            for s in sessions:
                try:
                    if s.Process and s.Process.pid == pid and s.SimpleAudioVolume:
                        current = s.SimpleAudioVolume.GetMasterVolume()
                        if current < target - 0.01:
                            s.SimpleAudioVolume.SetMasterVolume(target, None)
                            print(f"[friday-speak] fixed player mixer volume {current:.0%} → {target:.0%}", flush=True)
                        return
                except Exception:
                    pass
            time.sleep(0.05)
    except Exception:
        pass


# ── SAPI helpers (playback-timeout hint + Edge-offline fallback) ───────────────
def _sapi_voice_setup_ps() -> str:
    """PowerShell fragment: SelectVoice(name) or gender hint. Matches FRIDAY_WIN_TTS_* in .env."""
    win_voice = os.environ.get("FRIDAY_WIN_TTS_VOICE", "").strip()
    gender_raw = os.environ.get("FRIDAY_WIN_TTS_GENDER", "").strip().lower()
    if win_voice:
        esc = win_voice.replace("`", "``").replace('"', '`"')
        return f'$s.SelectVoice("{esc}"); '
    if gender_raw == "male":
        return "$s.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::Male); "
    # Default female — aligns with default Edge voice (Emma) when offline
    return "$s.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::Female); "


def _offline_speak_short(message: str) -> None:
    """Brief offline TTS: Windows SAPI or macOS `say` (Edge timeout / cap paths)."""
    try:
        safe = (message or "").replace("'", " ").replace('"', " ")[:200]
        if not safe.strip():
            return
        sysname = platform.system()
        if sysname == "Darwin":
            voice = os.environ.get("FRIDAY_MACOS_SAY_VOICE", "").strip()
            cmd = ["say"]
            if voice:
                cmd.extend(["-v", voice])
            cmd.append(safe)
            print(f"[friday-speak] say short: {safe[:80]!r}...", flush=True)
            subprocess.run(cmd, timeout=15, capture_output=True)
            _write_last_spoken_ts()
            return
        print(f"[friday-speak] SAPI short: {safe[:80]!r}...", flush=True)
        voice_ps = _sapi_voice_setup_ps()
        _kwargs: dict = {"timeout": 15, "capture_output": True}
        if sysname == "Windows":
            _kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "Add-Type -AssemblyName System.Speech; "
             "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
             + voice_ps
             + f"$s.Speak('{safe}')"],
            **_kwargs,
        )
        _write_last_spoken_ts()
    except Exception as exc:
        print(f"friday-speak: offline short speak failed — {exc}", file=sys.stderr)


# ── Playback duration cap (wall-clock ffplay time per utterance) ───────────────
def _get_max_playback_sec() -> float:
    """0 = no limit. Explicit FRIDAY_TTS_MAX_PLAYBACK_SEC wins; else session defaults."""
    raw = os.environ.get("FRIDAY_TTS_MAX_PLAYBACK_SEC", "").strip().lower()
    if raw:
        if raw in ("0", "false", "off", "no", "none"):
            return 0.0
        try:
            return max(0.0, float(raw))
        except ValueError:
            return 0.0
    if _SESSION_KIND in ("cursor-reply", "subagent"):
        q_raw = os.environ.get("FRIDAY_TTS_QUERY_MAX_PLAYBACK_SEC", "60").strip().lower()
        if q_raw in ("0", "false", "off", "no", "none"):
            return 0.0
        try:
            return max(0.0, float(q_raw))
        except ValueError:
            return 60.0
    return 0.0


def _terminate_playback_proc(proc: subprocess.Popen) -> None:
    try:
        proc.kill()
    except Exception:
        pass
    try:
        proc.wait(timeout=8)
    except Exception:
        pass


def _stop_playback_after_cap(proc: subprocess.Popen) -> None:
    """Kill ffplay when playback budget exceeded; update ts — no TTS, no mixer ducking."""
    _terminate_playback_proc(proc)
    _write_last_spoken_ts()


# ── ffplay (plays from bytes via temp file) ────────────────────────────────────
def _play_ffplay(mp3_data: bytes, my_gen: int | None = None) -> None:
    if my_gen is not None and _playback_superseded(my_gen):
        return
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
        f.write(mp3_data)
        tmp = f.name

    kwargs: dict = {
        "stdin":  subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
    }
    if platform.system() == "Windows":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW

    try:
        proc = subprocess.Popen(
            ["friday-player", "-nodisp", "-autoexit", "-loglevel", "quiet", tmp],
            **kwargs,
        )
        threading.Thread(target=_fix_ffplay_volume, args=(proc.pid,), daemon=True).start()
        max_pb = _get_max_playback_sec()
        if max_pb > 0:
            try:
                proc.wait(timeout=max_pb)
            except subprocess.TimeoutExpired:
                print("[friday-speak] playback timed out — stopping player (silent)", flush=True)
                _stop_playback_after_cap(proc)
                return
        else:
            proc.wait()
        if proc.returncode not in (0, None):
            raise subprocess.CalledProcessError(proc.returncode, "ffplay")
        _write_last_spoken_ts()
    except subprocess.CalledProcessError as e:
        print(f"friday-speak: ffplay error {e.returncode}", file=sys.stderr)
        sys.exit(1)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


# ── Streaming playback (cache-miss fast path) ──────────────────────────────────
async def _stream_and_play(switch_done: threading.Event, my_gen: int) -> None:
    """
    Stream edge-tts audio chunks directly to ffplay stdin while simultaneously
    building the cache entry on disk.

    The producer task starts immediately and buffers incoming audio chunks in an
    asyncio.Queue.  We wait (asynchronously — without blocking the event loop)
    for the Bluetooth device switch to complete, then hand off buffered + future
    chunks to ffplay.  By the time the switch finishes (~300 ms) several hundred
    milliseconds of audio are already buffered, so playback starts with no
    additional wait.
    """
    loop = asyncio.get_event_loop()
    audio_q: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=0)
    cache_buf = io.BytesIO()
    produce_exc: list[Exception] = []

    async def _produce():
        try:
            communicate = edge_tts.Communicate(TEXT, VOICE, rate=RATE, pitch=PITCH, volume=VOLUME)
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    await audio_q.put(chunk["data"])
        except Exception as exc:
            produce_exc.append(exc)
        finally:
            await audio_q.put(None)  # sentinel — always sent

    producer = asyncio.create_task(_produce())

    # Wait for BT device switch without blocking the event loop
    await loop.run_in_executor(None, lambda: switch_done.wait(2.0))

    if _playback_superseded(my_gen):
        producer.cancel()
        try:
            await producer
        except asyncio.CancelledError:
            pass
        return

    kwargs: dict = {
        "stdin":  subprocess.PIPE,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
    }
    if platform.system() == "Windows":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW

    proc = subprocess.Popen(
        ["friday-player", "-nodisp", "-autoexit", "-loglevel", "quiet", "-"],
        **kwargs,
    )
    threading.Thread(target=_fix_ffplay_volume, args=(proc.pid,), daemon=True).start()
    play_start = time.monotonic()
    max_pb = _get_max_playback_sec()

    def _remaining_play() -> float | None:
        if max_pb <= 0:
            return None
        return max_pb - (time.monotonic() - play_start)

    timed_out = False
    pipe_ok = True
    try:
        while True:
            rem = _remaining_play()
            if rem is not None and rem <= 0:
                timed_out = True
                break
            try:
                if rem is not None:
                    data = await asyncio.wait_for(audio_q.get(), timeout=rem)
                else:
                    data = await audio_q.get()
            except asyncio.TimeoutError:
                timed_out = True
                break
            if data is None:
                break
            cache_buf.write(data)
            if pipe_ok:
                try:
                    proc.stdin.write(data)
                    proc.stdin.flush()
                except (BrokenPipeError, OSError):
                    pipe_ok = False  # ffplay exited early — keep draining queue for cache
    finally:
        try:
            proc.stdin.close()
        except OSError:
            pass

    if timed_out:
        producer.cancel()
        try:
            await producer
        except asyncio.CancelledError:
            pass
        print("[friday-speak] streaming cut off — playback budget exceeded (silent)", flush=True)
        _stop_playback_after_cap(proc)
        return

    await producer

    rem_fin = _remaining_play()
    if max_pb > 0 and rem_fin is not None and rem_fin <= 0:
        _stop_playback_after_cap(proc)
        return

    try:
        if max_pb > 0 and rem_fin is not None:
            await loop.run_in_executor(None, lambda rf=rem_fin: proc.wait(timeout=rf))
        else:
            await loop.run_in_executor(None, proc.wait)
    except subprocess.TimeoutExpired:
        print("[friday-speak] streaming playback timed out after stdin closed (silent)", flush=True)
        _stop_playback_after_cap(proc)
        return

    _write_last_spoken_ts()

    if produce_exc:
        raise produce_exc[0]

    audio_data = cache_buf.getvalue()
    if len(audio_data) > 100:
        _save_cache(audio_data)
        print(f"[friday-speak] cached {len(audio_data)} bytes for next time", flush=True)


# ── Music fade-out ─────────────────────────────────────────────────────────────
def _fade_and_stop_music(fade_sec: float = 1.5, steps: int = 20) -> None:
    """
    Fade out ONLY the startup song (friday-play.py's ffplay process) before TTS speaks.
    Targets the specific PID from friday-play.pid so TTS voices are never accidentally faded.
    Skipped while friday-play holds music unless FRIDAY_TTS_INTERRUPT_MUSIC=ui.
    """
    if friday_play_music_hold_active() and not may_interrupt_music_from_tts():
        print(
            "[friday-speak] music hold active — skip fade (set FRIDAY_TTS_INTERRUPT_MUSIC=ui to duck)",
            flush=True,
        )
        return
    pid_file = Path(tempfile.gettempdir()) / "friday-play.pid"
    if not pid_file.exists():
        return

    try:
        song_pid = int(pid_file.read_text().strip())
    except Exception:
        return

    try:
        from pycaw.utils import AudioUtilities

        sessions = AudioUtilities.GetAllSessions()
        music_sessions = [
            s for s in sessions
            if s.Process and s.Process.pid == song_pid and s.SimpleAudioVolume
        ]

        if music_sessions:
            step_time = fade_sec / steps
            for i in range(steps + 1):
                vol = 1.0 - (i / steps)
                for s in music_sessions:
                    try:
                        s.SimpleAudioVolume.SetMasterVolume(vol, None)
                    except Exception:
                        pass
                if i < steps:
                    time.sleep(step_time)
            print(f"[friday-speak] song faded out (PID {song_pid})", flush=True)
    except ImportError:
        pass
    except Exception as exc:
        print(f"[friday-speak] fade-out skipped ({exc.__class__.__name__}: {exc})", file=sys.stderr, flush=True)

    try:
        os.kill(song_pid, _signal.SIGTERM)
        pid_file.unlink(missing_ok=True)
    except Exception:
        pass


def _kill_friday_player_processes() -> None:
    """Stop any in-flight TTS playback from friday-speak (friday-player / ffplay)."""
    if platform.system() == "Windows":
        try:
            subprocess.run(
                ["taskkill", "/IM", "friday-player.exe", "/F"],
                capture_output=True,
                stdin=subprocess.DEVNULL,
                timeout=12,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except Exception:
            pass
        return
    # macOS/Linux: friday-player is often a renamed ffplay
    for sig in ("friday-player", "ffplay"):
        try:
            subprocess.run(
                ["pkill", "-f", sig],
                capture_output=True,
                stdin=subprocess.DEVNULL,
                timeout=8,
            )
        except Exception:
            pass
    try:
        import psutil  # type: ignore

        for p in psutil.process_iter(["name"]):
            n = (p.info.get("name") or "").lower()
            if n in ("friday-player", "friday-player.exe", "ffplay"):
                try:
                    p.kill()
                except Exception:
                    pass
    except Exception:
        pass


def _try_break_redis_tts_lock() -> None:
    """Release ambient's distributed lock so a priority speak can proceed."""
    r = _get_redis_client()
    if r is None:
        return
    try:
        r.delete("friday:tts:lock")
    except Exception:
        pass


# ── Redis client (lazy, shared) ──────────────────────────────────────────────
_redis_c = None
_redis_c_tried = False

def _get_redis_client():
    global _redis_c, _redis_c_tried
    if _redis_c_tried:
        return _redis_c
    _redis_c_tried = True
    url = os.environ.get("OPENCLAW_REDIS_URL", "").strip() or os.environ.get("FRIDAY_AMBIENT_REDIS_URL", "").strip() or "redis://127.0.0.1:6379"
    try:
        import redis as _redis
        _redis_c = _redis.Redis.from_url(url, decode_responses=True, socket_timeout=2)
        _redis_c.ping()
    except Exception:
        _redis_c = None
    return _redis_c


# ── Redis distributed TTS lock ───────────────────────────────────────────────
_REDIS_TTS_LOCK_KEY = "friday:tts:lock"
_REDIS_TTS_LOCK_TTL = 120  # 2 min auto-expire — covers long TTS + network retries
_TTS_ACTIVE_LOCK_TTL = 120.0  # file lock matches Redis TTL
_own_redis_token: str | None = None

def _acquire_redis_tts_lock(priority: bool = False, timeout: float = 60.0) -> bool:
    """Acquire Redis lock before speaking.  Returns True when safe to proceed."""
    global _own_redis_token
    r = _get_redis_client()
    if r is None:
        return True  # fail-open
    import uuid as _uuid
    token = f"{os.getpid()}:{_uuid.uuid4().hex[:8]}"
    if priority:
        try:
            r.delete(_REDIS_TTS_LOCK_KEY)
        except Exception:
            pass
        time.sleep(0.05)
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if r.set(_REDIS_TTS_LOCK_KEY, token, nx=True, ex=_REDIS_TTS_LOCK_TTL):
                _own_redis_token = token
                return True
        except Exception:
            return True
        time.sleep(0.08)
    return False

def _release_redis_tts_lock() -> None:
    global _own_redis_token
    if not _own_redis_token:
        return
    r = _get_redis_client()
    if r is None:
        return
    try:
        holder = r.get(_REDIS_TTS_LOCK_KEY)
        if holder == _own_redis_token:
            r.delete(_REDIS_TTS_LOCK_KEY)
    except Exception:
        pass
    _own_redis_token = None


# ── Edge TTS rate-limit guard ────────────────────────────────────────────────
_REDIS_TTS_LAST_KEY = "friday:tts:last_call"
_MIN_TTS_GAP_SEC = 0.15

def _rate_limit_ok() -> bool:
    """Return True if enough time has passed since the last TTS call."""
    r = _get_redis_client()
    if r is None:
        return True
    try:
        last = r.get(_REDIS_TTS_LAST_KEY)
        if last and (time.time() - float(last)) < _MIN_TTS_GAP_SEC:
            return False
    except Exception:
        pass
    return True

def _stamp_tts_call() -> None:
    r = _get_redis_client()
    if r is None:
        return
    try:
        r.set(_REDIS_TTS_LAST_KEY, str(time.time()), ex=300)
    except Exception:
        pass


def _release_own_tts_lock() -> None:
    """
    Remove TTS_ACTIVE_FILE only if this process is the recorded holder.
    Safe to call multiple times; no-ops if the file is absent or owned by
    a different PID.  Called from both the speak() finally-block AND atexit
    so the lock is always released even when the process is killed (SIGTERM).
    """
    try:
        pid, _ = _read_tts_lock_info()
        if pid is not None and pid == os.getpid():
            TTS_ACTIVE_FILE.unlink(missing_ok=True)
    except Exception:
        pass
    _release_redis_tts_lock()


atexit.register(_release_own_tts_lock)


def _sigterm_handler(*_args) -> None:
    """Convert SIGTERM into a normal Python exit so atexit handlers fire."""
    sys.exit(0)


try:
    _signal.signal(_signal.SIGTERM, _sigterm_handler)
except (OSError, ValueError):
    # Can fail if not the main thread or on unsupported platforms — safe to ignore.
    pass


_REDIS_THINKING_KEY = "friday:tts:thinking_singleton"
_THINKING_SINGLETON_TTL = 45  # seconds — auto-expire in Redis AND file fallback
_own_thinking_token: str | None = None


def _try_acquire_thinking_singleton() -> bool:
    """Atomic try-acquire for thinking narration via Redis (file fallback). Returns True if won."""
    global _own_thinking_token
    import uuid as _uuid
    token = f"{os.getpid()}:{_uuid.uuid4().hex[:8]}"
    r = _get_redis_client()
    if r is not None:
        try:
            if r.set(_REDIS_THINKING_KEY, token, nx=True, ex=_THINKING_SINGLETON_TTL):
                _own_thinking_token = token
                return True
            holder = r.get(_REDIS_THINKING_KEY)
            if holder:
                try:
                    holder_pid = int(str(holder).split(":")[0])
                    if not _pid_alive(holder_pid):
                        r.delete(_REDIS_THINKING_KEY)
                        if r.set(_REDIS_THINKING_KEY, token, nx=True, ex=_THINKING_SINGLETON_TTL):
                            _own_thinking_token = token
                            return True
                except (ValueError, IndexError):
                    r.delete(_REDIS_THINKING_KEY)
                    if r.set(_REDIS_THINKING_KEY, token, nx=True, ex=_THINKING_SINGLETON_TTL):
                        _own_thinking_token = token
                        return True
            return False
        except Exception:
            pass
    # File fallback
    try:
        fd = os.open(str(THINKING_SINGLETON_FILE), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        try:
            os.write(fd, f"{os.getpid()}\n{time.time()}".encode())
        finally:
            os.close(fd)
        _own_thinking_token = token
        return True
    except FileExistsError:
        pass
    try:
        raw = THINKING_SINGLETON_FILE.read_text(encoding="utf-8").strip()
        lines = raw.split("\n", 1)
        holder_pid = int(lines[0])
        created_at = float(lines[1]) if len(lines) > 1 else 0.0
        stale = (time.time() - created_at) > _THINKING_SINGLETON_TTL
        if stale or not _pid_alive(holder_pid):
            THINKING_SINGLETON_FILE.unlink(missing_ok=True)
            try:
                fd = os.open(str(THINKING_SINGLETON_FILE), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                try:
                    os.write(fd, f"{os.getpid()}\n{time.time()}".encode())
                finally:
                    os.close(fd)
                _own_thinking_token = token
                return True
            except FileExistsError:
                return False
    except Exception:
        pass
    return False


def _release_thinking_singleton() -> None:
    """Release the thinking singleton (Redis + file) only if this process owns it."""
    global _own_thinking_token
    r = _get_redis_client()
    if r is not None and _own_thinking_token:
        try:
            holder = r.get(_REDIS_THINKING_KEY)
            if holder == _own_thinking_token:
                r.delete(_REDIS_THINKING_KEY)
        except Exception:
            pass
    try:
        raw = THINKING_SINGLETON_FILE.read_text(encoding="utf-8").strip()
        pid_str = raw.split("\n", 1)[0]
        if int(pid_str) == os.getpid():
            THINKING_SINGLETON_FILE.unlink(missing_ok=True)
    except Exception:
        pass
    _own_thinking_token = None


atexit.register(_release_thinking_singleton)


def _read_preempted_ambient_line() -> str | None:
    """If ambient was speaking, grab its line for an apology replay; clear the file."""
    if not AMBIENT_SPEAKING_FILE.exists():
        return None
    try:
        raw = AMBIENT_SPEAKING_FILE.read_text(encoding="utf-8").strip()
        if raw:
            AMBIENT_SPEAKING_FILE.unlink(missing_ok=True)
            return raw[:2000]
    except OSError:
        pass
    return None


def _preempt_for_priority_tts() -> str | None:
    """
    Voice replies take precedence over ambient / stuck TTS: stop music, kill
    friday-player, clear file + Redis locks, then return ambient text to replay.
    """
    replay = _read_preempted_ambient_line()
    _fade_and_stop_music()
    _kill_friday_player_processes()
    try:
        TTS_ACTIVE_FILE.unlink(missing_ok=True)
    except OSError:
        pass
    _try_break_redis_tts_lock()
    print("[friday-speak] priority pre-empt: cleared competing playback", flush=True)
    return replay


def _play_priority_followup(ambient_line: str) -> None:
    """Non-priority child speak: apology + replay of the line ambient was saying."""
    apology = "Sorry — I'm repeating myself; I talked over that. " + ambient_line.strip()
    apology = normalize_for_speech(apology)
    if len(apology) > 3800:
        apology = apology[:3797] + "."
    env = {k: v for k, v in os.environ.items() if k != "FRIDAY_TTS_PRIORITY"}
    kwargs: dict = {
        "capture_output": True,
        "timeout": 180,
        "stdin": subprocess.DEVNULL,
    }
    if platform.system() == "Windows":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), apology],
            env=env,
            **kwargs,
        )
    except Exception as exc:
        print(f"[friday-speak] priority follow-up speak failed: {exc}", file=sys.stderr, flush=True)


# ── SAPI fallback ──────────────────────────────────────────────────────────────
def _sapi_speak() -> None:
    """Offline fallback when Edge TTS network fails: Windows SAPI or macOS `say`."""
    try:
        safe = TEXT.replace("'", " ").replace('"', " ")[:400]
        sysname = platform.system()
        if sysname == "Darwin":
            voice = os.environ.get("FRIDAY_MACOS_SAY_VOICE", "").strip()
            cmd = ["say"]
            if voice:
                cmd.extend(["-v", voice])
            cmd.append(safe)
            print(f"[friday-speak] say fallback (Edge offline): text={safe[:60]!r}...", flush=True)
            subprocess.run(cmd, timeout=120, capture_output=False)
            _write_last_spoken_ts()
            return
        win_voice = os.environ.get("FRIDAY_WIN_TTS_VOICE", "").strip()
        gend = os.environ.get("FRIDAY_WIN_TTS_GENDER", "").strip().lower() or "(default female hint)"
        who = win_voice if win_voice else gend
        print(f"[friday-speak] SAPI fallback (Edge offline): voice={who!r} text={safe[:60]!r}...", flush=True)
        voice_ps = _sapi_voice_setup_ps()
        _kwargs: dict = {"timeout": 30}
        if sysname == "Windows":
            _kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "Add-Type -AssemblyName System.Speech; "
             "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
             + voice_ps
             + f"$s.Speak('{safe}')"],
            **_kwargs,
        )
        _write_last_spoken_ts()
    except Exception as sapi_err:
        print(f"friday-speak: offline TTS also failed — {sapi_err}", file=sys.stderr)


def _read_tts_lock_info() -> tuple:
    """Read (pid, write_timestamp) from TTS_ACTIVE_FILE. Returns (None, None) on failure.
    Format: '{PID}\\n{timestamp}' — timestamp is time.time() when the lock was acquired.
    Backward-compatible: plain '{PID}' (no timestamp) yields (pid, None).
    """
    try:
        raw = TTS_ACTIVE_FILE.read_text(encoding="utf-8").strip()
        if not raw:
            return None, None
        lines = raw.split("\n", 1)
        pid = int(lines[0])
        ts = float(lines[1]) if len(lines) > 1 else None
        return pid, ts
    except (OSError, ValueError):
        return None, None


def _read_tts_lock_pid() -> int | None:
    pid, _ = _read_tts_lock_info()
    return pid


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if platform.system() == "Windows":
        try:
            import ctypes

            k32 = ctypes.windll.kernel32
            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
            if not h:
                return False
            k32.CloseHandle(h)
            return True
        except Exception:
            return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


# ── Main ───────────────────────────────────────────────────────────────────────
async def speak():
    global TEXT, RATE
    TEXT = normalize_for_speech(_RAW_TEXT)
    _raw_stripped = (_RAW_TEXT or "").strip()
    if not TEXT or not TEXT.strip():
        if not _raw_stripped:
            print("friday-speak: no text provided", file=sys.stderr)
            sys.exit(1)
        print("[friday-speak] skipping - no speakable text after sanitise", flush=True)
        sys.exit(0)
    # Leftover noise only (e.g. every token was a placeholder)
    _letters_digits = re.sub(r"[^a-zA-Z0-9\u0900-\u097F]", "", TEXT)
    if len(_letters_digits) < 2:
        print("[friday-speak] skipping - text too short after sanitise", flush=True)
        sys.exit(0)

    # For playback (not --output/--stdout) signal to ambient that TTS is active.
    is_playback = not (OUTPUT or STDOUT)
    _priority = os.environ.get("FRIDAY_TTS_PRIORITY", "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )
    _is_thinking = os.environ.get("FRIDAY_TTS_THINKING", "").strip().lower() in (
        "1", "true", "yes", "on",
    )

    if _is_thinking:
        _opener_chance_raw = os.environ.get("FRIDAY_CURSOR_THINKING_OPENER_CHANCE", "0.35").strip()
        try:
            _opener_chance = float(_opener_chance_raw)
        except ValueError:
            _opener_chance = 0.35
        if _opener_chance > 1.0:
            _opener_chance = min(_opener_chance / 100.0, 1.0)
        if random.random() < _opener_chance:
            _opener = random.choice(_THINKING_OPENERS)
            TEXT = _opener + TEXT
            print(f"[friday-speak] thinking opener: {_opener.strip()}", flush=True)
        _think_fixed = os.environ.get("FRIDAY_TTS_THINKING_RATE", "").strip() or None
        RATE = thinking_tts_rate_for_length(len(TEXT), incremental=False, fixed_rate=_think_fixed)
        print(f"[friday-speak] thinking rate {RATE} for {len(TEXT)} chars", flush=True)
        # Resolve thinking voice: env override → session file → keep current.
        _think_voice = os.environ.get("FRIDAY_TTS_THINKING_VOICE", "").strip()
        if not _think_voice:
            try:
                import json as _json_tv
                _sv_tv = _json_tv.loads(_SESSION_VOICE_FILE.read_text(encoding="utf-8"))
                _think_voice = _sv_tv.get("thinking_voice", "").strip()
            except Exception:
                pass
        if _think_voice and _think_voice not in _blocked_tts:
            global VOICE  # must declare global — local assignment would shadow the module-level var
            VOICE = _think_voice
            print(f"[friday-speak] thinking voice: {VOICE}", flush=True)
        elif not _think_voice and _PICK_SCRIPT.exists():
            # No thinking voice in session yet — spawn picker in background (no-welcome).
            try:
                import subprocess as _sp_tv
                _sp_tv.Popen(
                    [sys.executable, str(_PICK_SCRIPT), "--thinking"],
                    cwd=str(_SESSION_VOICE_FILE.parent),
                    stdout=_sp_tv.DEVNULL,
                    stderr=_sp_tv.DEVNULL,
                    env={**os.environ, "FRIDAY_PICK_SESSION_NO_WELCOME": "true"},
                    **({} if sys.platform != "win32" else {"creationflags": 0x08000000}),
                )
            except Exception:
                pass

        # Per-sentence voice rotation pool — FRIDAY_CURSOR_THINKING_VOICE_POOL
        global _thinking_voice_pool
        _tv_pool_raw = os.environ.get("FRIDAY_CURSOR_THINKING_VOICE_POOL", "").strip()
        _thinking_voice_pool = []
        if _tv_pool_raw:
            _pool_cands = [v.strip() for v in _tv_pool_raw.split(",") if v.strip()]
            _thinking_voice_pool = [v for v in _pool_cands if v not in _blocked_tts]
            if len(_thinking_voice_pool) > 1:
                print(f"[friday-speak] thinking voice pool ({len(_thinking_voice_pool)}): {', '.join(_thinking_voice_pool)}", flush=True)
            else:
                _thinking_voice_pool = []  # need at least 2 to rotate

    preempted_replay: str | None = None
    _my_gen = 0
    if is_playback:
        # Cursor / IDE voice: do not play TTS over the same session as dictation.
        _bypass = os.environ.get("FRIDAY_TTS_BYPASS_CURSOR_DEFER", "").strip().lower() in (
            "1", "true", "yes", "on",
        )
        # Priority replies (task results, urgent notify) must never be swallowed by IDE focus.
        _ds = os.environ.get("FRIDAY_DEFER_SPEAK_WHEN_CURSOR", "true").strip().lower()
        if (
            not _bypass
            and not _priority
            and _ds not in ("0", "false", "no", "off")
            and platform.system() in ("Windows", "Darwin")
        ):
            _scripts_dir = Path(__file__).resolve().parent.parent.parent / "scripts"
            if str(_scripts_dir) not in sys.path:
                sys.path.insert(0, str(_scripts_dir))
            try:
                from friday_win_focus import should_defer_voice_for_cursor

                if should_defer_voice_for_cursor():
                    print(
                        "[friday-speak] deferred playback — Cursor (or configured IDE) has focus",
                        flush=True,
                    )
                    sys.exit(0)
            except Exception:
                pass
        # ── Thinking singleton: at most one thinking narration in the pipeline ──
        if _is_thinking:
            if not _try_acquire_thinking_singleton():
                print("[friday-speak] thinking singleton busy — skipping (another thinking speak is active)", flush=True)
                sys.exit(0)

        # Bump generation before pre-empt so in-flight older speaks see stale gen immediately,
        # and waiters in the file-lock loop exit without overlapping playback.
        _my_gen = _bump_tts_generation()
        if _priority:
            preempted_replay = _preempt_for_priority_tts()

        # ── Redis distributed lock — serialises ALL callers system-wide ──
        if not _acquire_redis_tts_lock(priority=_priority, timeout=60.0):
            print("[friday-speak] timed out waiting for Redis TTS lock — skipping", flush=True)
            sys.exit(0)
        _stamp_tts_call()

        # ── Global serialisation: wait for any other speak instance to finish ──
        # Uses O_CREAT|O_EXCL for atomic lock acquisition on NTFS — eliminates
        # the TOCTOU race where two processes both see the file absent and both
        # proceed to speak simultaneously.
        #
        # Never use write_text to "take" the lock after a timeout — several waiters
        # can all pass that branch at once and play overlapping audio.  Instead:
        # drop stale locks when the recorded PID is dead, extend wait if holder is
        # alive past 60 s (long lines), and always re-enter the O_EXCL race.
        _wait_deadline = time.time() + 60.0
        while True:
            # Superseded: a newer speak process has started — drop out silently.
            if _current_tts_generation() > _my_gen:
                print(f"[friday-speak] superseded (gen {_my_gen} < {_current_tts_generation()}) — exiting", flush=True)
                _release_redis_tts_lock()
                sys.exit(0)

            # Atomic try-acquire: only ONE process wins the O_CREAT|O_EXCL race.
            try:
                fd = os.open(str(TTS_ACTIVE_FILE), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                try:
                    os.write(fd, f"{os.getpid()}\n{time.time()}".encode())
                finally:
                    os.close(fd)
                # Orphan friday-player from a crashed holder would bypass the file lock
                # appearing "free" while still playing — clear before we speak.
                _kill_friday_player_processes()
                break  # lock acquired — proceed to speak
            except FileExistsError:
                pass  # another process holds the lock — fall through to wait

            # Stale lock: corrupt file, dead PID, or TTL expired (guards against PID reuse on Windows).
            try:
                if TTS_ACTIVE_FILE.exists():
                    lp, lts = _read_tts_lock_info()
                    _ttl_expired = lts is not None and (time.time() - lts) > _TTS_ACTIVE_LOCK_TTL
                    if lp is None or _ttl_expired or not _pid_alive(lp):
                        _kill_friday_player_processes()
                        TTS_ACTIVE_FILE.unlink(missing_ok=True)
                        continue
            except OSError:
                pass

            if _priority:
                # Another friday-speak still starting — pre-empt again and retry.
                _preempt_for_priority_tts()
                await asyncio.sleep(0.08)
                continue

            if time.time() > _wait_deadline:
                try:
                    lp, lts = _read_tts_lock_info()
                    _ttl_expired = lts is not None and (time.time() - lts) > _TTS_ACTIVE_LOCK_TTL
                    if lp is not None and not _ttl_expired and _pid_alive(lp):
                        _wait_deadline = time.time() + 60.0
                    else:
                        _kill_friday_player_processes()
                        TTS_ACTIVE_FILE.unlink(missing_ok=True)
                except OSError:
                    pass
                await asyncio.sleep(0.05)
                continue

            await asyncio.sleep(0.10)

    try:
        await _speak_inner(_my_gen)
    finally:
        if is_playback:
            _release_own_tts_lock()
            if _is_thinking:
                _release_thinking_singleton()

    if is_playback and _priority and preempted_replay:
        _play_priority_followup(preempted_replay)


async def _speak_inner(my_gen: int) -> None:
    # Kick off device-switch lookup in a background thread while we start the
    # TTS request — BT switch and stream overlap instead of running sequentially.
    if not (OUTPUT or STDOUT) and _playback_superseded(my_gen):
        return
    use_device = DEVICE and DEVICE.lower() not in ("", "default", "none")
    device_result: list = [None]   # [(target_id, target_name, original_id) | None | False]
    switch_done  = threading.Event()

    def _prepare_device():
        if not use_device:
            switch_done.set()
            return
        try:
            res = _find_device_id(DEVICE)
            if not res:
                device_result[0] = False
                switch_done.set()
                return
            target_id, target_name = res
            original_id = _get_default_output_id()
            if original_id and original_id == target_id:
                device_result[0] = (target_id, target_name, None)
                switch_done.set()
                return
            _set_default_endpoint(target_id)
            time.sleep(0.3)   # BT wake-up
            device_result[0] = (target_id, target_name, original_id)
        except Exception as exc:
            print(f"[friday-speak] device prep failed: {exc}", file=sys.stderr, flush=True)
            device_result[0] = False
        finally:
            switch_done.set()

    threading.Thread(target=_prepare_device, daemon=True).start()

    # ── --output / --stdout: always need full MP3 bytes ───────────────────────
    if OUTPUT or STDOUT:
        cached = _load_cache()
        if cached:
            print(f"[friday-speak] cache hit ({len(cached)} bytes)", flush=True)
            mp3_data = cached
        else:
            try:
                mp3_data = await _fetch_mp3_network()
                _save_cache(mp3_data)
            except Exception as exc:
                print(f"friday-speak: edge-tts failed — {exc}", file=sys.stderr, flush=True)
                sys.exit(1)

        switch_done.wait(timeout=5)
        _restore_device(device_result)

        if OUTPUT:
            with open(OUTPUT, "wb") as f:
                f.write(mp3_data)
            print(f"[friday-speak] wrote {len(mp3_data)} bytes -> {OUTPUT}", flush=True)
        else:
            sys.stdout.buffer.write(mp3_data)
            sys.stdout.buffer.flush()
        return

    # ── Thinking pool mode: one voice per span, rotate between spans ───────────
    # Voice changes between calls (different spans/threads), not between sentences.
    # Redis INCR tracks which pool slot to use across separate subprocess calls.
    if _thinking_voice_pool and not OUTPUT and not STDOUT:
        global TEXT, VOICE
        _pool_orig_text = TEXT
        _pool_orig_voice = VOICE
        # Pick one voice for this entire span using a persistent cross-call counter.
        _span_voice = _thinking_voice_pool[0]
        try:
            _rv = _get_redis_client()
            if _rv is not None:
                _span_idx = int(_rv.incr("friday:tts:thinking_pool_idx")) - 1
                _span_voice = _thinking_voice_pool[_span_idx % len(_thinking_voice_pool)]
            else:
                _span_voice = random.choice(_thinking_voice_pool)
        except Exception:
            _span_voice = random.choice(_thinking_voice_pool)
        print(f"[friday-speak] thinking pool span voice: {_span_voice}", flush=True)
        _max_pc = int(os.environ.get("FRIDAY_CURSOR_THINKING_MAX_CHUNK_CHARS", "320"))
        _sentences = _split_thinking_sentences(TEXT, max_chars=max(80, min(_max_pc, 1200)))
        _fade_and_stop_music()
        switch_done.wait(timeout=10)
        for _si, _sent in enumerate(_sentences):
            if _playback_superseded(my_gen):
                break
            TEXT = _sent
            VOICE = _span_voice  # same voice for every sentence in this span
            _mp3_cached = _load_cache()
            if _mp3_cached:
                print(f"[friday-speak] pool [{_si + 1}/{len(_sentences)}] cache hit voice={VOICE}", flush=True)
                _play_with_device(_mp3_cached, device_result, use_device, my_gen)
            else:
                try:
                    _mp3 = await _fetch_mp3_network(retries=2)
                    _save_cache(_mp3)
                    _play_with_device(_mp3, device_result, use_device, my_gen)
                    print(f"[friday-speak] pool [{_si + 1}/{len(_sentences)}] via {VOICE}", flush=True)
                except Exception as _pool_exc:
                    print(f"[friday-speak] pool sentence {_si + 1} failed: {_pool_exc}", file=sys.stderr, flush=True)
            if _si < len(_sentences) - 1 and not _playback_superseded(my_gen):
                await asyncio.sleep(random.uniform(0.18, 0.42))
        TEXT = _pool_orig_text
        VOICE = _pool_orig_voice
        _restore_device(device_result)
        return

    # ── Playback mode ─────────────────────────────────────────────────────────
    cached = _load_cache()

    if cached:
        # Fast path: cache hit — wait for device, play from bytes
        print(f"[friday-speak] cache hit ({len(cached)} bytes)", flush=True)
        switch_done.wait(timeout=10)
        if _playback_superseded(my_gen):
            return
        _fade_and_stop_music()
        _play_with_device(cached, device_result, use_device, my_gen)
        return

    # Cache miss — download full MP3 then play from file (clean audio, no pipe stutter).
    # Set FRIDAY_TTS_STREAM=true to restore low-latency pipe-to-player streaming.
    _use_stream = os.environ.get("FRIDAY_TTS_STREAM", "false").strip().lower() in (
        "1", "true", "yes", "on",
    )
    _fade_and_stop_music()

    if _use_stream:
        try:
            await _stream_and_play(switch_done, my_gen)
            print(f"[friday-speak] streamed via {VOICE}", flush=True)
        except Exception as exc:
            print(f"[friday-speak] stream failed ({exc.__class__.__name__}) — falling back to full download…", file=sys.stderr, flush=True)
            _use_stream = False  # fall through to download path below

    if not _use_stream:
        try:
            mp3_data = await _fetch_mp3_network(retries=2)
            if _playback_superseded(my_gen):
                _save_cache(mp3_data)
                switch_done.wait(timeout=10)
                _restore_device(device_result)
                return
            _save_cache(mp3_data)
            switch_done.wait(timeout=10)
            _play_with_device(mp3_data, device_result, use_device, my_gen)
            print(f"[friday-speak] played via {VOICE} (full download)", flush=True)
        except Exception as dl_exc:
            print(f"friday-speak: edge-tts download failed — {dl_exc}", file=sys.stderr, flush=True)
            if platform.system() == "Darwin":
                hint = "macOS: optional FRIDAY_MACOS_SAY_VOICE for the built-in say command."
            elif platform.system() == "Windows":
                hint = "Set FRIDAY_WIN_TTS_VOICE (e.g. Microsoft Zira Desktop) or FRIDAY_WIN_TTS_GENDER."
            else:
                hint = "Configure offline speech or restore network access to Edge TTS."
            print(
                "[friday-speak] Cannot reach Microsoft Edge TTS (speech.platform.bing.com). "
                f"Check network, VPN, firewall, or DNS — falling back to offline TTS. {hint}",
                file=sys.stderr,
                flush=True,
            )
            switch_done.wait(timeout=2)
            _restore_device(device_result)
            if not _playback_superseded(my_gen):
                _sapi_speak()
            sys.exit(1)

    _restore_device(device_result)


# ── Device helpers ─────────────────────────────────────────────────────────────
def _restore_device(device_result: list) -> None:
    """Restore the original default audio device if we switched it."""
    info = device_result[0]
    if info and info is not False:
        _tid, _tname, original_id = info
        if original_id:
            try:
                _set_default_endpoint(original_id)
                print(f"[friday-speak] restored default output", flush=True)
            except Exception:
                pass


def _play_with_device(mp3_data: bytes, device_result: list, use_device: bool, my_gen: int) -> None:
    """Play mp3_data respecting the device switch that already happened."""
    info = device_result[0]

    if use_device and info is not False:
        if info is None:
            print(f"[friday-speak] device switch timed out — using default", file=sys.stderr, flush=True)
            _play_ffplay(mp3_data, my_gen)
            return
        target_id, target_name, original_id = info
        try:
            _play_ffplay(mp3_data, my_gen)
            print(f"[friday-speak] played via {VOICE} on {target_name}", flush=True)
        finally:
            if original_id:
                try:
                    _set_default_endpoint(original_id)
                    print(f"[friday-speak] restored default output", flush=True)
                except Exception:
                    pass
        return

    print(f"[friday-speak] playing via {VOICE} on default audio device", flush=True)
    _play_ffplay(mp3_data, my_gen)


asyncio.run(speak())
