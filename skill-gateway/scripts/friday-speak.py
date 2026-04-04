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
import unicodedata
import re
import signal as _signal
import subprocess
import sys
import tempfile
import threading
import time
import platform
from pathlib import Path

import edge_tts

from friday_win_audio import find_output_device_id as _find_device_id
from friday_win_audio import get_default_output_id as _get_default_output_id
from friday_win_audio import set_default_endpoint as _set_default_endpoint
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
try:
    import json as _json
    _sv = _json.loads(_SESSION_VOICE_FILE.read_text(encoding="utf-8"))
    if _SESSION_KIND == "subagent" and _sv.get("subagent_voice"):
        VOICE = _sv["subagent_voice"]
    elif _SESSION_KIND == "cursor-reply" and _sv.get("cursor_reply_voice"):
        VOICE = _sv["cursor_reply_voice"]
    elif _sv.get("voice") and _SESSION_STICKY:
        VOICE = _sv["voice"]
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


def _write_last_spoken_ts() -> None:
    """Record wall-clock time when TTS playback finished (friday-ambient.py polls this)."""
    try:
        TTS_TS_FILE.write_text(str(time.time()), encoding="utf-8")
    except OSError:
        pass


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
async def _fetch_mp3_network(retries: int = 1) -> bytes:
    """1 attempt then raise immediately — caller falls back to SAPI without delay."""
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


# ── ffplay (plays from bytes via temp file) ────────────────────────────────────
def _play_ffplay(mp3_data: bytes) -> None:
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
async def _stream_and_play(switch_done: threading.Event) -> None:
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

    pipe_ok = True
    try:
        while True:
            data = await audio_q.get()
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

    await loop.run_in_executor(None, proc.wait)
    _write_last_spoken_ts()

    # Re-raise any producer error after playback so caller can SAPI-fallback
    if produce_exc:
        raise produce_exc[0]

    audio_data = cache_buf.getvalue()
    if len(audio_data) > 100:
        _save_cache(audio_data)
        print(f"[friday-speak] cached {len(audio_data)} bytes for next time", flush=True)

    # Ensure producer task is fully awaited (it should be done by now)
    await producer


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
    """Stop any in-flight TTS playback from friday-speak (friday-player.exe)."""
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
    try:
        import psutil  # type: ignore

        for p in psutil.process_iter(["name"]):
            n = (p.info.get("name") or "").lower()
            if n in ("friday-player", "friday-player.exe"):
                try:
                    p.kill()
                except Exception:
                    pass
    except Exception:
        pass


def _try_break_redis_tts_lock() -> None:
    """Release ambient's distributed lock so a priority speak can proceed."""
    url = os.environ.get("FRIDAY_AMBIENT_REDIS_URL", "").strip() or "redis://127.0.0.1:6379"
    try:
        import redis as _redis  # type: ignore

        r = _redis.Redis.from_url(url, decode_responses=True)
        r.delete("friday:tts:lock")
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
        raw = TTS_ACTIVE_FILE.read_text(encoding="utf-8").strip()
        if raw and int(raw) == os.getpid():
            TTS_ACTIVE_FILE.unlink(missing_ok=True)
    except Exception:
        pass


atexit.register(_release_own_tts_lock)
atexit.register(_release_thinking_singleton)


def _sigterm_handler(*_args) -> None:
    """Convert SIGTERM into a normal Python exit so atexit handlers fire."""
    sys.exit(0)


try:
    _signal.signal(_signal.SIGTERM, _sigterm_handler)
except (OSError, ValueError):
    # Can fail if not the main thread or on unsupported platforms — safe to ignore.
    pass


_THINKING_SINGLETON_TTL = 45.0  # seconds — auto-expire stale singleton


def _try_acquire_thinking_singleton() -> bool:
    """Atomic try-acquire for thinking narration. Returns True if this process won."""
    try:
        fd = os.open(str(THINKING_SINGLETON_FILE), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        try:
            os.write(fd, f"{os.getpid()}\n{time.time()}".encode())
        finally:
            os.close(fd)
        return True
    except FileExistsError:
        pass
    # Check if stale (holder dead or TTL expired)
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
                return True
            except FileExistsError:
                return False
    except Exception:
        pass
    return False


def _release_thinking_singleton() -> None:
    """Release the thinking singleton only if this process owns it."""
    try:
        raw = THINKING_SINGLETON_FILE.read_text(encoding="utf-8").strip()
        pid_str = raw.split("\n", 1)[0]
        if int(pid_str) == os.getpid():
            THINKING_SINGLETON_FILE.unlink(missing_ok=True)
    except Exception:
        pass


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


def _sapi_speak() -> None:
    try:
        safe = TEXT.replace("'", " ").replace('"', " ")[:400]
        win_voice = os.environ.get("FRIDAY_WIN_TTS_VOICE", "").strip()
        gend = os.environ.get("FRIDAY_WIN_TTS_GENDER", "").strip().lower() or "(default female hint)"
        who = win_voice if win_voice else gend
        print(f"[friday-speak] SAPI fallback (Edge offline): voice={who!r} text={safe[:60]!r}...", flush=True)
        voice_ps = _sapi_voice_setup_ps()
        subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "Add-Type -AssemblyName System.Speech; "
             "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
             + voice_ps
             + f"$s.Speak('{safe}')"],
            timeout=30,
        )
        _write_last_spoken_ts()
    except Exception as sapi_err:
        print(f"friday-speak: SAPI also failed — {sapi_err}", file=sys.stderr)


def _read_tts_lock_pid() -> int | None:
    try:
        raw = TTS_ACTIVE_FILE.read_text(encoding="utf-8").strip()
        if not raw:
            return None
        return int(raw)
    except (OSError, ValueError):
        return None


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
    global TEXT
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
    preempted_replay: str | None = None
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
            and platform.system() == "Windows"
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

        if _priority:
            # User-facing reply: cut over ambient / stuck TTS instead of waiting behind it.
            preempted_replay = _preempt_for_priority_tts()
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
            # Atomic try-acquire: only ONE process wins the O_CREAT|O_EXCL race.
            try:
                fd = os.open(str(TTS_ACTIVE_FILE), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                try:
                    os.write(fd, str(os.getpid()).encode())
                finally:
                    os.close(fd)
                # Orphan friday-player from a crashed holder would bypass the file lock
                # appearing "free" while still playing — clear before we speak.
                _kill_friday_player_processes()
                break  # lock acquired — proceed to speak
            except FileExistsError:
                pass  # another process holds the lock — fall through to wait

            # Stale lock: corrupt file or holder process exited without unlinking
            try:
                if TTS_ACTIVE_FILE.exists():
                    lp = _read_tts_lock_pid()
                    if lp is None or not _pid_alive(lp):
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
                    lp = _read_tts_lock_pid()
                    if lp is not None and _pid_alive(lp):
                        _wait_deadline = time.time() + 60.0
                    else:
                        _kill_friday_player_processes()
                        TTS_ACTIVE_FILE.unlink(missing_ok=True)
                except OSError:
                    pass
                await asyncio.sleep(0.05)
                continue

            await asyncio.sleep(0.25)

    try:
        await _speak_inner()
    finally:
        if is_playback:
            _release_own_tts_lock()
            if _is_thinking:
                _release_thinking_singleton()

    if is_playback and _priority and preempted_replay:
        _play_priority_followup(preempted_replay)


async def _speak_inner():
    # Kick off device-switch lookup in a background thread while we start the
    # TTS request — BT switch and stream overlap instead of running sequentially.
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

    # ── Playback mode ─────────────────────────────────────────────────────────
    cached = _load_cache()

    if cached:
        # Fast path: cache hit — wait for device, play from bytes
        print(f"[friday-speak] cache hit ({len(cached)} bytes)", flush=True)
        switch_done.wait(timeout=10)
        _fade_and_stop_music()
        _play_with_device(cached, device_result, use_device)
        return

    # Streaming path: cache miss — stream to ffplay while device switch runs
    _fade_and_stop_music()
    try:
        await _stream_and_play(switch_done)
        print(f"[friday-speak] streamed via {VOICE}", flush=True)
    except Exception as exc:
        print(f"[friday-speak] stream failed ({exc.__class__.__name__}) — retrying full download…", file=sys.stderr, flush=True)
        # 1 attempt only — fall through to SAPI immediately on failure
        try:
            mp3_data = await _fetch_mp3_network(retries=1)
            _save_cache(mp3_data)
            switch_done.wait(timeout=10)
            _play_with_device(mp3_data, device_result, use_device)
            print(f"[friday-speak] retry ok via {VOICE}", flush=True)
        except Exception as retry_exc:
            print(f"friday-speak: edge-tts retry failed — {retry_exc}", file=sys.stderr, flush=True)
            print(
                "[friday-speak] Cannot reach Microsoft Edge TTS (speech.platform.bing.com). "
                "Check network, VPN, firewall, or DNS — falling back to Windows SAPI. "
                "Set FRIDAY_WIN_TTS_VOICE (e.g. Microsoft Zira Desktop) or FRIDAY_WIN_TTS_GENDER.",
                file=sys.stderr,
                flush=True,
            )
            switch_done.wait(timeout=2)
            _restore_device(device_result)
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


def _play_with_device(mp3_data: bytes, device_result: list, use_device: bool) -> None:
    """Play mp3_data respecting the device switch that already happened."""
    info = device_result[0]

    if use_device and info is not False:
        if info is None:
            print(f"[friday-speak] device switch timed out — using default", file=sys.stderr, flush=True)
            _play_ffplay(mp3_data)
            return
        target_id, target_name, original_id = info
        try:
            _play_ffplay(mp3_data)
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
    _play_ffplay(mp3_data)


asyncio.run(speak())
