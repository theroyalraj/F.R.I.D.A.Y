#!/usr/bin/env python3
"""
Friday TTS — edge-tts neural voice, plays to a named Windows audio device.

Usage:
  python friday-speak.py "Task complete, sir."
  python friday-speak.py --output path/to/out.mp3 "Text"   # write MP3, no playback
  python friday-speak.py --stdout "Text"                    # pipe MP3 bytes to stdout

Env vars (all optional):
  FRIDAY_TTS_VOICE   edge-tts voice name  (default: en-GB-RyanNeural)
  FRIDAY_TTS_DEVICE  audio device substring (default: "" = Windows default device)
                     set to "Echo Dot", "WH-1000XM3", etc. to lock a specific output
  FRIDAY_TTS_RATE    speed               (default: +0%)
  FRIDAY_TTS_PITCH   pitch               (default: +0Hz)
  FRIDAY_TTS_VOLUME  volume              (default: +0%)
  FRIDAY_TTS_CACHE   MP3 cache dir       (default: %TEMP%/friday-tts-cache)
                     set to "" to disable cache

Good voices:
  en-GB-RyanNeural              British male    ← default (Jarvis feel)
  en-GB-ThomasNeural            British male, deeper
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
import asyncio
import hashlib
import io
import os
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
VOICE  = os.environ.get("FRIDAY_TTS_VOICE",  "en-GB-RyanNeural")

# Session-sticky voice: if .session-voice.json exists in the repo root and has a
# voice set for the current Cursor chat, it overrides FRIDAY_TTS_VOICE.
_SESSION_VOICE_FILE = Path(__file__).resolve().parent.parent.parent / ".session-voice.json"
try:
    import json as _json
    _sv = _json.loads(_SESSION_VOICE_FILE.read_text(encoding="utf-8"))
    if _sv.get("voice"):
        VOICE = _sv["voice"]
except Exception:
    pass

RATE   = os.environ.get("FRIDAY_TTS_RATE",   "+0%")
PITCH  = os.environ.get("FRIDAY_TTS_PITCH",  "+0Hz")
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


def normalize_for_speech(text: str) -> str:
    """
    Convert any text to clean, speakable English before handing it to edge-tts.

    Strips markdown, code, URLs, symbols, and converts technical patterns
    (env var names, units, percentages, paths) to natural words.
    """
    if not text:
        return text
    t = text

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

    return t or "Done."


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
async def _fetch_mp3_network(retries: int = 3) -> bytes:
    """3 quick retries then raise — caller falls back to SAPI."""
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


# ── Windows audio device routing via IPolicyConfig (pycaw + comtypes) ─────────
def _find_device_id(name_sub: str):
    """Return (device_id, friendly_name) for the first output device matching name_sub, or None."""
    try:
        from pycaw.utils import AudioUtilities
        devs = AudioUtilities.GetAllDevices()
        sub = name_sub.lower()
        match = next((d for d in devs if sub in d.FriendlyName.lower()), None)
        return (match.id, match.FriendlyName) if match else None
    except Exception:
        return None


def _set_default_endpoint(device_id: str):
    """Set device_id as default for all three audio roles (console/multimedia/comms). Raises on failure."""
    from pycaw.api.policyconfig import IPolicyConfig
    from comtypes.client import CreateObject
    from comtypes import GUID
    CLSID_PolicyConfigClient = GUID("{870AF99C-171D-4F9E-AF0D-E63DF40C2BC9}")
    policy = CreateObject(CLSID_PolicyConfigClient, interface=IPolicyConfig)
    for role in range(3):
        policy.SetDefaultEndpoint(device_id, role)


def _get_default_output_id() -> str | None:
    """Return the current default output device ID."""
    try:
        from pycaw.utils import AudioUtilities
        dev = AudioUtilities.GetSpeakers()
        return dev.id
    except Exception:
        return None


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
    """
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


# ── SAPI fallback ──────────────────────────────────────────────────────────────
def _sapi_speak() -> None:
    try:
        safe = TEXT.replace("'", " ").replace('"', " ")[:400]
        print(f"[friday-speak] SAPI fallback: {safe[:60]}", flush=True)
        subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             f"Add-Type -AssemblyName System.Speech; "
             f"$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
             f"$s.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::Male); "
             f"$s.Speak('{safe}')"],
            timeout=30,
        )
        _write_last_spoken_ts()
    except Exception as sapi_err:
        print(f"friday-speak: SAPI also failed — {sapi_err}", file=sys.stderr)


# ── Main ───────────────────────────────────────────────────────────────────────
async def speak():
    global TEXT
    TEXT = normalize_for_speech(_RAW_TEXT)
    if not TEXT:
        print("friday-speak: no text provided", file=sys.stderr)
        sys.exit(1)

    # For playback (not --output/--stdout) signal to ambient that TTS is active.
    is_playback = not (OUTPUT or STDOUT)
    if is_playback:
        # ── Global serialisation: wait for any other speak instance to finish ──
        # Uses O_CREAT|O_EXCL for atomic lock acquisition on NTFS — eliminates
        # the TOCTOU race where two processes both see the file absent and both
        # proceed to speak simultaneously.  Max wait = 60 s; stale files (> 120 s)
        # from crashed processes are cleaned up automatically.
        _wait_deadline = time.time() + 60.0
        while True:
            # Atomic try-acquire: only ONE process wins the O_CREAT|O_EXCL race.
            try:
                fd = os.open(str(TTS_ACTIVE_FILE), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                try:
                    os.write(fd, str(os.getpid()).encode())
                finally:
                    os.close(fd)
                break  # lock acquired — proceed to speak
            except FileExistsError:
                pass  # another process holds the lock — fall through to wait

            # Lock is held — check for stale file (crashed process)
            try:
                age = time.time() - TTS_ACTIVE_FILE.stat().st_mtime
                if age > 120:
                    TTS_ACTIVE_FILE.unlink(missing_ok=True)
                    continue  # retry atomic acquire immediately
            except OSError:
                pass  # file vanished between our check and stat — loop retries

            if time.time() > _wait_deadline:
                # 60 s timeout — force-write to avoid permanent silence
                try:
                    TTS_ACTIVE_FILE.write_text(str(os.getpid()), encoding="utf-8")
                except OSError:
                    pass
                break

            await asyncio.sleep(0.25)

    try:
        await _speak_inner()
    finally:
        if is_playback:
            try:
                TTS_ACTIVE_FILE.unlink(missing_ok=True)
            except OSError:
                pass


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
        # Retry: full download with 3 retries (2 s, 4 s backoff) before SAPI
        try:
            mp3_data = await _fetch_mp3_network(retries=3)
            _save_cache(mp3_data)
            switch_done.wait(timeout=10)
            _play_with_device(mp3_data, device_result, use_device)
            print(f"[friday-speak] retry ok via {VOICE}", flush=True)
        except Exception as retry_exc:
            print(f"friday-speak: edge-tts retry failed — {retry_exc}", file=sys.stderr, flush=True)
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
