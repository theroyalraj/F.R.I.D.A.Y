#!/usr/bin/env python3
"""
friday-listen.py — always-on background voice daemon.

Continuously listens via microphone using sounddevice (no PyAudio needed),
routes commands to the Friday pc-agent, and speaks all responses back
through friday-speak.py (edge-tts neural voice).

Usage:
  python scripts/friday-listen.py

Requirements (all already installed for friday-speak.py):
  pip install SpeechRecognition sounddevice numpy requests edge-tts
  ffmpeg on PATH

Env vars (optional — reads .env automatically):
  FRIDAY_TTS_VOICE       edge-tts voice       (default: en-US-EmmaMultilingualNeural)
  FRIDAY_TTS_DEVICE      audio output device  (default: Echo Dot)
  FRIDAY_TTS_JARVIS_RANDOM — random greeting speed/pitch (default true; set false for fixed JARVIS_*)
  FRIDAY_USER_NAME       spoken address / prompts (default Raj)
  PC_AGENT_URL           pc-agent base URL    (default: http://127.0.0.1:3847)
  LISTEN_DEVICE_INDEX    mic device index     (default: system default)
  LISTEN_LANGUAGE        speech language      (default: en-US)
  LISTEN_PHRASE_LIMIT    max seconds/phrase   (default: 8)
  LISTEN_SILENCE_SEC     silence = phrase end (default: 1.2s)
  FRIDAY_LISTEN_WAKE     wake word filter     (default: disabled = always-on)
  FRIDAY_DEFER_WHEN_CURSOR  Windows: no mic capture while Cursor is focused (default: true)
  FRIDAY_DEFER_FOCUS_EXES   comma-separated exe name substrings (default: cursor)
"""

import io
import json
import logging
import os
import random
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
import wave
from pathlib import Path

# ── Load .env from repo root ───────────────────────────────────────────────────
root = Path(__file__).resolve().parent.parent
env_path = root / ".env"
if env_path.exists():
    for line in env_path.read_text(encoding="utf-8").splitlines():
        t = line.strip()
        if not t or t.startswith("#"):
            continue
        i = t.find("=")
        if i < 1:
            continue
        k, v = t[:i].strip(), t[i + 1:].strip()
        if v.startswith('"') and v.endswith('"'):   v = v[1:-1]
        elif v.startswith("'") and v.endswith("'"): v = v[1:-1]
        if k not in os.environ:
            os.environ[k] = v

_scripts_dir = Path(__file__).resolve().parent
if str(_scripts_dir) not in sys.path:
    sys.path.insert(0, str(_scripts_dir))
_sg_scripts = root / "skill-gateway" / "scripts"
if str(_sg_scripts) not in sys.path:
    sys.path.insert(0, str(_sg_scripts))
from friday_greeting_delivery import sample_greeting_rate_pitch  # noqa: E402
from friday_win_focus import should_defer_voice_for_cursor  # noqa: E402
from indic_tts_voice import edge_voice_override_for_text  # noqa: E402
from friday_music_lock import (
    SESSION_START_FILE,
    clear_music_active,
    friday_play_music_hold_active,
)  # noqa: E402

# ── Config ─────────────────────────────────────────────────────────────────────
VOICE        = os.environ.get("FRIDAY_TTS_VOICE",    "en-US-EmmaMultilingualNeural")
DEVICE_HINT  = os.environ.get("FRIDAY_TTS_DEVICE",   "Echo Dot")
USER_DISPLAY = (os.environ.get("FRIDAY_USER_NAME", "Raj") or "Raj").strip() or "Raj"
AGENT_URL    = os.environ.get("PC_AGENT_URL",         "http://127.0.0.1:3847").rstrip("/")
MIC_INDEX    = os.environ.get("LISTEN_DEVICE_INDEX")
LANGUAGE     = os.environ.get("LISTEN_LANGUAGE",     "en-US")
PHRASE_LIMIT     = float(os.environ.get("LISTEN_PHRASE_LIMIT",      "8"))
SILENCE_SEC      = float(os.environ.get("LISTEN_SILENCE_SEC",       "1.2"))
ENERGY_THRESHOLD = float(os.environ.get("LISTEN_ENERGY_THRESHOLD",  "300"))
WAKE_WORD    = os.environ.get("FRIDAY_LISTEN_WAKE",  "").strip().lower()
SPEAK_SCRIPT = root / "skill-gateway" / "scripts" / "friday-speak.py"
GATEWAY_URL  = os.environ.get("GATEWAY_URL", "http://127.0.0.1:3848").rstrip("/")
SAMPLE_RATE  = 16000   # Google STT works best at 16 kHz
CHANNELS     = 1
# Seconds after startup to ignore mic energy — lets the welcome song + greeting
# finish before the daemon can stop the music via voice activity detection.
DEAF_SEC     = float(os.environ.get("LISTEN_DEAF_SEC", "15"))
# Long window while friday-play holds music (Redis + PID + session file age). During hold,
# stop_music() is a no-op unless force=True (spoken "stop" after LISTEN_SONG_STOP_GRACE_SEC).
# Mic energy never stops music; only transcribed commands do. Override via LISTEN_MUSIC_PROTECT_SEC.
_play_sec    = int(os.environ.get("FRIDAY_PLAY_SECONDS", "45").split("#")[0].strip())
MUSIC_PROTECT_SEC = float(os.environ.get("LISTEN_MUSIC_PROTECT_SEC", str(_play_sec + 15)))
# Seconds after friday-play starts before spoken "stop" may cut the song (VAD never cuts music).
SONG_STOP_GRACE_SEC = float(os.environ.get("LISTEN_SONG_STOP_GRACE_SEC", "5"))

def _env_bool(name: str, default: bool = False) -> bool:
    v = os.environ.get(name, "").strip().lower()
    if not v:
        return default
    return v in ("1", "true", "yes", "on")


# Default false: spoken "On it…" + agent reply = two TTS playbacks (sounds like double).
# Monitor UI still shows PROCESSING. Set FRIDAY_LISTEN_SPEAK_ACK=true to hear the ack.
SPEAK_ACK = _env_bool("FRIDAY_LISTEN_SPEAK_ACK", False)

MIC_INDEX       = int(MIC_INDEX) if MIC_INDEX else None
PLAY_PID        = Path(tempfile.gettempdir()) / "friday-play.pid"
TTS_TS_FILE     = Path(tempfile.gettempdir()) / "friday-tts-ts"
TTS_ACTIVE_FILE = Path(tempfile.gettempdir()) / "friday-tts-active"


def _write_last_spoken_ts() -> None:
    """When SAPI fallback runs (no friday-speak subprocess), still reset ambient silence clock."""
    try:
        TTS_TS_FILE.write_text(str(time.time()), encoding="utf-8")
    except OSError:
        pass

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("friday-listen")

# ── Dependency checks ──────────────────────────────────────────────────────────
try:
    import numpy as np
except ImportError:
    print("ERROR: pip install numpy", file=sys.stderr); sys.exit(1)

try:
    import sounddevice as sd
except ImportError:
    print("ERROR: pip install sounddevice", file=sys.stderr); sys.exit(1)

try:
    import speech_recognition as sr
except ImportError:
    print("ERROR: pip install SpeechRecognition", file=sys.stderr); sys.exit(1)

try:
    import requests as req_lib
except ImportError:
    print("ERROR: pip install requests", file=sys.stderr); sys.exit(1)

# ── Live event bus (pushes to pc-agent /voice/event → SSE → listen.html) ──────
def post_event(event_type: str, text: str = ""):
    """Fire-and-forget POST to pc-agent so the web UI stays in sync."""
    def _send():
        try:
            req_lib.post(
                f"{AGENT_URL}/voice/event",
                json={"type": event_type, "text": text},
                timeout=2,
                headers={"ngrok-skip-browser-warning": "1"},
            )
        except Exception:
            pass   # never block the audio loop
    threading.Thread(target=_send, daemon=True).start()

# ── Music fade-out ─────────────────────────────────────────────────────────────
def stop_music(force: bool = False):
    """Stop Alexa music via gateway + kill any local ffplay PID file.
    When force=True, ignore friday-play hold (user said stop after LISTEN_SONG_STOP_GRACE_SEC)."""
    if not force and friday_play_music_hold_active():
        log.debug("stop_music skipped — friday-play music hold (Redis or local)")
        return
    # 1. Stop Alexa via gateway (non-blocking best-effort)
    try:
        import urllib.request
        stop_req = urllib.request.Request(
            f"{GATEWAY_URL}/internal/alexa-stop",
            method="POST",
            headers={"Content-Type": "application/json"},
            data=b"{}",
        )
        urllib.request.urlopen(stop_req, timeout=2)
        log.info("Alexa music stopped via gateway")
    except Exception as e:
        log.debug("alexa-stop: %s", e)

    # 2. Kill any local ffplay PID
    if not PLAY_PID.exists():
        return
    try:
        pid = int(PLAY_PID.read_text().strip())
        os.kill(pid, signal.SIGTERM)
        log.info("local music stopped (PID %d)", pid)
    except (ValueError, ProcessLookupError, PermissionError):
        pass
    except Exception as e:
        log.debug("stop_music local: %s", e)
    finally:
        PLAY_PID.unlink(missing_ok=True)
        SESSION_START_FILE.unlink(missing_ok=True)
        clear_music_active()


def _seconds_since_friday_play_start() -> float | None:
    """Wall-clock seconds since friday-play wrote the session file, or None."""
    if not SESSION_START_FILE.exists():
        return None
    try:
        t0 = float(SESSION_START_FILE.read_text(encoding="ascii").strip())
        return max(0.0, time.time() - t0)
    except (ValueError, OSError):
        return None


def _is_music_stop_phrase(lower: str) -> bool:
    return lower in (
        "stop",
        "stop music",
        "stop the music",
        "stop that song",
        "stop the song",
        "stop song",
        "stop playing",
    )


# ── Speech output (non-blocking) ───────────────────────────────────────────────
_speak_lock = threading.Lock()
_speaking   = threading.Event()     # True while TTS audio is playing — mutes VAD
_POST_SPEAK_COOLDOWN = 1.5          # seconds to keep mic muted after playback ends

def _speak_fallback(text: str):
    """Windows SAPI fallback when edge-tts is unavailable."""
    try:
        safe = text.replace("'", " ").replace('"', " ")[:300]
        subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             f"Add-Type -AssemblyName System.Speech; "
             f"$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
             f"$s.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::Male); "
             f"$s.Speak('{safe}')"],
            capture_output=True, timeout=30,
        )
        log.info("speak OK (SAPI fallback)")
    except Exception as e:
        log.warning("speak SAPI fallback failed: %s", e)

def _wait_for_tts_clear(timeout: float = 45.0) -> None:
    """Block until no other friday-speak.py instance is playing audio."""
    deadline = time.time() + timeout
    while TTS_ACTIVE_FILE.exists():
        try:
            age = time.time() - TTS_ACTIVE_FILE.stat().st_mtime
            if age > 120:          # stale file from crashed process
                TTS_ACTIVE_FILE.unlink(missing_ok=True)
                break
        except OSError:
            break
        if time.time() > deadline:
            break
        time.sleep(0.25)


def speak(text: str, *, jarvis: bool = False, priority: bool = True):
    from friday_speaker import speaker

    log.info("-> speak: %s", text[:80])
    def _run():
        _speaking.set()
        try:
            with _speak_lock:
                if not priority:
                    _wait_for_tts_clear()
                try:
                    override = edge_voice_override_for_text(text)
                    voice = override or VOICE
                    use_sticky = not bool(override)
                    rate = None
                    pitch = None
                    if jarvis:
                        rate, pitch = sample_greeting_rate_pitch()
                    speaker.speak_blocking(
                        text,
                        voice=voice,
                        priority=priority,
                        bypass_cursor_defer=True,
                        use_session_sticky=use_sticky,
                        rate=rate,
                        pitch=pitch,
                        timeout=90.0,
                    )
                    log.info("speak OK")
                except Exception as e:
                    log.warning("speak exception: %s — falling back to SAPI", e)
                    _speak_fallback(text)
                    _write_last_spoken_ts()
        finally:
            time.sleep(_POST_SPEAK_COOLDOWN)
            _speaking.clear()
    threading.Thread(target=_run, daemon=True).start()

# ── Ambient frequency control ─────────────────────────────────────────────────
_MORE_PATTERNS = re.compile(
    r"(speak|talk|chat|chime|comment).*(more|often|frequent|louder)|"
    r"(more|often|frequent).*(speak|talk|chat|ambient|updates?)|"
    r"(increase|crank up|bump up).*(frequency|interval|silence|gap)|"
    r"i (want|need).*(hear|more) (you|friday|updates?)",
    re.IGNORECASE,
)
_LESS_PATTERNS = re.compile(
    r"(speak|talk|chat|chime|comment).*(less|quieter|quiet|rarely|infrequent|seldom)|"
    r"(less|rarely|quiet|silence).*(speak|talk|chat|ambient|updates?)|"
    r"(reduce|decrease|lower).*(frequency|interval|silence|gap)|"
    r"(you talk|too much|too (often|frequent|loud|noisy|chatty))|"
    r"(shut up|be quiet|tone it down|dial.*(back|down)).*(a (bit|little))?",
    re.IGNORECASE,
)
_EVERY_N_PATTERN = re.compile(
    r"every\s+(\d+)\s*(second|sec|minute|min)",
    re.IGNORECASE,
)

def _restart_ambient() -> None:
    """Kill all running ambient processes and start a fresh one."""
    try:
        import subprocess as sp
        result = sp.run(
            ["powershell", "-NoProfile", "-Command",
             "Get-Process python* -ErrorAction SilentlyContinue | "
             "ForEach-Object { $cmd=(Get-CimInstance Win32_Process -Filter \"ProcessId=$($_.Id)\" "
             "-ErrorAction SilentlyContinue).CommandLine; "
             "if($cmd -like '*friday-ambient*'){Stop-Process -Id $_.Id -Force} }"],
            capture_output=True, timeout=10,
        )
        time.sleep(0.5)
        sp.Popen(
            [sys.executable, str(root / "scripts" / "friday-ambient.py")],
            cwd=str(root),
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        log.info("Ambient restarted.")
    except Exception as e:
        log.warning("Ambient restart failed: %s", e)


def _agent_bearer_headers() -> dict[str, str] | None:
    secret = (os.environ.get("PC_AGENT_SECRET") or "").strip()
    if not secret:
        return None
    return {
        "Authorization": f"Bearer {secret}",
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "1",
    }


def _get_ambient_settings_remote() -> dict | None:
    h = _agent_bearer_headers()
    if not h:
        return None
    try:
        r = req_lib.get(f"{AGENT_URL}/settings/ambient", headers=h, timeout=6)
        if r.status_code == 503:
            return None
        r.raise_for_status()
        return r.json()
    except Exception as e:
        log.debug("GET /settings/ambient failed: %s", e)
        return None


def _put_ambient_settings_remote(body: dict) -> tuple[bool, str]:
    h = _agent_bearer_headers()
    if not h:
        return False, "PC_AGENT_SECRET is not set in your environment."
    try:
        r = req_lib.put(f"{AGENT_URL}/settings/ambient", headers=h, json=body, timeout=12)
        if r.status_code == 503:
            return False, "OpenClaw Postgres is not configured on pc-agent. Set OPENCLAW_DATABASE_URL and create table openclaw_settings."
        if not r.ok:
            try:
                err = r.json().get("error")
            except Exception:
                err = None
            return False, str(err or r.text or r.reason)[:240]
        return True, ""
    except Exception as e:
        return False, str(e)[:200]


def try_handle_whatsapp_read(text: str) -> bool:
    """
    If the user says something like 'read my WhatsApp', 'summarize messages',
    'any WhatsApp messages', etc. — fetch recent messages via Evolution API,
    summarize with Claude via pc-agent, and speak it. Returns True if handled.
    """
    _WA_READ_PATTERN = re.compile(
        r"(read|check|any|show|summarize?).*(whatsapp|messages?|texts?|chats?)|"
        r"(whatsapp|messages?).*(read|check|summary|summarize?|what.*say)|"
        r"(anything|what).*(whatsapp|messages?|texts?)",
        re.IGNORECASE,
    )
    if not _WA_READ_PATTERN.search(text):
        return False

    speak(f"Checking your WhatsApp messages, {USER_DISPLAY}. One moment.")
    log.info("WhatsApp read requested — fetching via Evolution API...")

    def _fetch_and_speak():
        try:
            ev_key      = os.environ.get("EVOLUTION_API_KEY", "change-me").strip()
            ev_instance = os.environ.get("EVOLUTION_INSTANCE", "openclaw").strip()
            ev_port     = os.environ.get("EVOLUTION_PORT", "8181").strip()
            ev_base     = f"http://127.0.0.1:{ev_port}"

            headers = {"apikey": ev_key, "Content-Type": "application/json"}
            import json as _json
            # Fetch recent chats
            r_chats = req_lib.get(
                f"{ev_base}/chat/findChats/{ev_instance}",
                headers=headers, timeout=8,
            )
            r_chats.raise_for_status()
            chats = r_chats.json()
            if not isinstance(chats, list) or not chats:
                speak(f"No WhatsApp chats found right now, {USER_DISPLAY}.")
                return

            # Pull last message from each of the 5 most recent non-group chats
            snippets = []
            for chat in chats[:10]:
                jid = chat.get("id") or chat.get("remoteJid") or ""
                if "@g.us" in str(jid):
                    continue  # skip groups
                name = chat.get("name") or chat.get("pushName") or jid.split("@")[0]
                last = chat.get("lastMessage") or {}
                msg_obj = last.get("message") or {}
                body = (
                    msg_obj.get("conversation")
                    or (msg_obj.get("extendedTextMessage") or {}).get("text")
                    or ""
                ).strip()[:200]
                if body:
                    snippets.append(f"{name}: {body}")
                if len(snippets) >= 5:
                    break

            if not snippets:
                speak(f"I can see chats but couldn't pull message text right now, {USER_DISPLAY}.")
                return

            # Summarise via pc-agent (Claude)
            summary_prompt = (
                f"Summarise these WhatsApp messages for {USER_DISPLAY} in 2-3 natural spoken sentences. "
                "Be conversational — tell him who said what and whether anything needs a reply. "
                "Messages:\n" + "\n".join(snippets)
            )
            reply = send_command(summary_prompt)
            speak(reply)
        except req_lib.exceptions.ConnectionError:
            speak(f"Couldn't reach the Evolution API, {USER_DISPLAY}. Make sure Docker is running.")
        except Exception as e:
            log.warning("WhatsApp read failed: %s", e)
            speak(f"Hit an issue reading your messages, {USER_DISPLAY}: {str(e)[:100]}")

    threading.Thread(target=_fetch_and_speak, daemon=True).start()
    return True


def try_handle_ambient_frequency(text: str) -> bool:
    """
    If text means 'speak more/less often' or 'every N seconds', persist timing in Postgres
    via pc-agent /settings/ambient (never writes .env). Restarts ambient so it picks up immediately.
    """
    lower = text.lower()

    def _current_post_gap() -> float:
        j = _get_ambient_settings_remote()
        if j and j.get("postTtsGap") is not None:
            try:
                return float(j["postTtsGap"])
            except (TypeError, ValueError):
                pass
        raw = (os.environ.get("FRIDAY_AMBIENT_POST_TTS_GAP") or os.environ.get("FRIDAY_AMBIENT_SILENCE_SEC") or "12").split("#")[0].strip()
        try:
            return float(raw)
        except ValueError:
            return 12.0

    # Explicit "every N seconds/minutes"
    m = _EVERY_N_PATTERN.search(lower)
    if m:
        n = int(m.group(1))
        unit = m.group(2).lower()
        secs = n * 60 if "min" in unit else n
        secs = max(3, min(300, secs))
        ok, err = _put_ambient_settings_remote(
            {
                "postTtsGap": secs,
                "minSilenceSec": max(3, secs - 2),
            }
        )
        if not ok:
            speak(f"Couldn't save ambient timing, {USER_DISPLAY}. {err}")
            return True
        threading.Thread(target=_restart_ambient, daemon=True).start()
        speak(f"Done, {USER_DISPLAY}. I'll chime in roughly every {secs} seconds from now on.")
        log.info("Ambient post_tts_gap set to %ds in Postgres by voice command.", secs)
        return True

    if _MORE_PATTERNS.search(lower):
        current = _current_post_gap()
        new_val = max(3, int(current * 0.55))
        ok, err = _put_ambient_settings_remote(
            {"postTtsGap": new_val, "minSilenceSec": max(3, new_val - 2)}
        )
        if not ok:
            speak(f"Couldn't save ambient timing, {USER_DISPLAY}. {err}")
            return True
        threading.Thread(target=_restart_ambient, daemon=True).start()
        speak(f"Got it, {USER_DISPLAY}. Increasing my frequency — I'll speak roughly every {new_val} seconds.")
        log.info("Ambient post_tts_gap increased to %ds in Postgres by voice command.", new_val)
        return True

    if _LESS_PATTERNS.search(lower):
        current = _current_post_gap()
        new_val = min(180, int(current * 2.0))
        ok, err = _put_ambient_settings_remote(
            {"postTtsGap": new_val, "minSilenceSec": max(3, new_val - 5)}
        )
        if not ok:
            speak(f"Couldn't save ambient timing, {USER_DISPLAY}. {err}")
            return True
        threading.Thread(target=_restart_ambient, daemon=True).start()
        speak(f"Understood, {USER_DISPLAY}. Dialling it back — I'll speak roughly every {new_val} seconds.")
        log.info("Ambient post_tts_gap reduced to %ds in Postgres by voice command.", new_val)
        return True

    return False


# ── PC-agent command ───────────────────────────────────────────────────────────
def send_command(text: str) -> str:
    try:
        r = req_lib.post(
            f"{AGENT_URL}/voice/command",
            json={"text": text, "userId": "friday-mic-daemon", "source": "voice"},
            timeout=120,
            headers={"ngrok-skip-browser-warning": "1"},
        )
        r.raise_for_status()
        j = r.json()
        return str(j.get("summary") or j.get("error") or "Done.")
    except req_lib.exceptions.ConnectionError:
        return "Cannot reach the Friday agent. Is pc-agent running on port 3847?"
    except Exception as e:
        return f"Request failed: {e}"

# ── Audio helpers ──────────────────────────────────────────────────────────────
def numpy_to_audio_data(audio_int16: np.ndarray) -> sr.AudioData:
    """Convert int16 numpy array → SpeechRecognition AudioData without PyAudio."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(2)          # int16 = 2 bytes
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(audio_int16.tobytes())
    raw = buf.getvalue()
    return sr.AudioData(raw[44:], SAMPLE_RATE, 2)  # skip 44-byte WAV header

def find_input_device(hint: str | None) -> int | None:
    if hint is None:
        return None
    devs = sd.query_devices()
    for i, d in enumerate(devs):
        if d["max_input_channels"] > 0 and hint.lower() in d["name"].lower():
            return i
    return None

# ── Voice activity detection (simple energy-based) ────────────────────────────
_daemon_start: float = 0.0   # set in main() after greeting fires

def record_phrase(mic_idx: int | None) -> np.ndarray | None:
    """
    Record audio until silence is detected or PHRASE_LIMIT is reached.
    Returns int16 mono numpy array, or None if silence throughout.
    """
    BLOCK      = int(SAMPLE_RATE * 0.1)   # 100 ms chunks
    THRESHOLD  = ENERGY_THRESHOLD
    MAX_CHUNKS = int(PHRASE_LIMIT / 0.1)
    SILENCE_CHUNKS = max(1, int(SILENCE_SEC / 0.1))

    chunks    = []
    silent    = 0
    speaking  = False

    kwargs = {"device": mic_idx} if mic_idx is not None else {}

    with sd.InputStream(samplerate=SAMPLE_RATE, channels=CHANNELS,
                        dtype="int16", blocksize=BLOCK, **kwargs) as stream:
        for _ in range(MAX_CHUNKS):
            if should_defer_voice_for_cursor():
                return None
            block, _ = stream.read(BLOCK)
            block = block.flatten()

            # Anti-feedback: Friday is speaking — drain mic, reset any partial phrase
            if _speaking.is_set():
                chunks.clear()
                speaking = False
                silent   = 0
                continue

            rms = np.sqrt(np.mean(block.astype(np.float32) ** 2))

            if rms > THRESHOLD:
                if not speaking:
                    # Do not stop music from mic energy — only from spoken stop (after grace) or other commands.
                    pass
                speaking = True
                silent   = 0
                chunks.append(block)
            elif speaking:
                chunks.append(block)
                silent += 1
                if silent >= SILENCE_CHUNKS:
                    break
            # If not yet speaking, don't accumulate noise chunks

    if not chunks:
        return None
    return np.concatenate(chunks)

# ── Startup banner ─────────────────────────────────────────────────────────────
def print_banner():
    lines = [
        "",
        "  +---------------------------------------------------------+",
        "  |   F R I D A Y  --  Voice Daemon  --  Always Listening  |",
        f"  |   Voice: {VOICE:<22}  Agent: {AGENT_URL:<16} |",
        "  +---------------------------------------------------------+",
        "",
    ]
    sys.stdout.buffer.write("\n".join(lines).encode("utf-8") + b"\n")
    sys.stdout.buffer.flush()

# ── Main ───────────────────────────────────────────────────────────────────────
def main():
    print_banner()

    recognizer = sr.Recognizer()
    mic_idx    = MIC_INDEX or find_input_device(None)

    mode = f"wake-word '{WAKE_WORD}'" if WAKE_WORD else "always-on"
    log.info("Voice daemon starting (%s) | language=%s | phrase_limit=%.1fs | silence=%.1fs",
             mode, LANGUAGE, PHRASE_LIMIT, SILENCE_SEC)

    # Print available input devices
    devs = sd.query_devices()
    log.info("Available microphones:")
    for i, d in enumerate(devs):
        if d["max_input_channels"] > 0:
            log.info("  [%d] %s", i, d["name"])

    _mic_errors = 0
    post_event("daemon_start", f"Voice daemon online. {mode.capitalize()} mode.")
    # Startup greeting suppressed — gateway already speaks on boot to avoid double TTS.
    # speak(
    #     f"Friday voice daemon online, {USER_DISPLAY}. {mode.capitalize()} mode. Ready.",
    #     jarvis=True,
    #     priority=False,
    # )
    post_event("listening", f"Ready for your command, {USER_DISPLAY}.")
    global _daemon_start
    _daemon_start = time.monotonic()
    log.info("Listening — speak to Friday any time. Ctrl+C to stop.\n")
    if DEAF_SEC > 0 or MUSIC_PROTECT_SEC > 0:
        log.info(
            "Startup windows — deaf (commands): %.0fs | music hold (VAD ignored): %.0fs | song stop grace: %.0fs",
            DEAF_SEC, MUSIC_PROTECT_SEC, SONG_STOP_GRACE_SEC,
        )

    while True:
        if should_defer_voice_for_cursor():
            time.sleep(0.25)
            continue
        try:
            audio = record_phrase(mic_idx)
            _mic_errors = 0   # reset backoff on success
        except KeyboardInterrupt:
            break
        except Exception as e:
            _mic_errors += 1
            wait = min(2 ** min(_mic_errors, 5), 30)  # 1, 2, 4, 8, 16, 30 s cap
            log.warning("Mic error (attempt %d, retry in %ds): %s", _mic_errors, wait, e)
            if _mic_errors == 3:
                log.warning("Persistent mic errors — falling back to system default mic (device None)")
                mic_idx = None   # try system default
            time.sleep(wait)
            continue

        if audio is None:
            continue   # silence — keep waiting

        # Transcribe
        try:
            audio_data = numpy_to_audio_data(audio)
            text = recognizer.recognize_google(audio_data, language=LANGUAGE)
        except sr.UnknownValueError:
            continue
        except sr.RequestError as e:
            log.warning("Google STT error: %s", e)
            post_event("error", f"Google STT error: {e}")
            speak(f"Speech recognition error, {USER_DISPLAY}. Check your internet connection.")
            time.sleep(2)
            continue
        except Exception as e:
            log.warning("Recognition failed: %s", e)
            continue

        text = text.strip()
        if not text:
            continue

        # Wake-word filter
        if WAKE_WORD and not text.lower().startswith(WAKE_WORD):
            log.debug("Heard (no wake word): %s", text)
            continue
        if WAKE_WORD:
            text = text[len(WAKE_WORD):].strip(" ,.")

        log.info("► %s", text)

        lower = text.lower().strip()

        # Stop background music by voice only after grace; does not shut down the daemon.
        if _is_music_stop_phrase(lower) and friday_play_music_hold_active():
            age = _seconds_since_friday_play_start()
            if age is not None and age < SONG_STOP_GRACE_SEC:
                log.info(
                    "Music stop ignored — within first %.0fs of playback (heard at %.1fs)",
                    SONG_STOP_GRACE_SEC,
                    age,
                )
                continue
            stop_music(force=True)
            post_event("heard", text)
            continue

        # Other commands: stop music when hold allows (so replies are audible over Alexa/local clip)
        stop_music()
        post_event("heard", text)

        # Built-in stop commands (plain "stop" only reaches here when no music hold)
        if lower in ("stop", "exit", "quit", "goodbye", "shut down", "go offline"):
            bye = random.choice([
                f"Going offline, {USER_DISPLAY}. Goodbye.",
                f"Shutting down. Take care, {USER_DISPLAY}.",
                "Signing off. Till next time.",
                f"Offline. Catch you later, {USER_DISPLAY}.",
                f"Done for now. Goodbye, {USER_DISPLAY}.",
            ])
            post_event("speak", bye)
            speak(bye)
            log.info("Shutdown requested.")
            break

        # Status ping
        ping_reply = random.choice([
            f"Right here, {USER_DISPLAY}. Ready for your command.",
            "Online and listening.",
            f"Always here, {USER_DISPLAY}.",
            "Standing by. What do you need?",
            "Alive and well. Go ahead.",
            f"Ready when you are, {USER_DISPLAY}.",
            "At your service.",
            f"Here, {USER_DISPLAY}. What's the play?",
            "Fully operational. Talk to me.",
        ])
        if lower in ("status", "are you there", "hello", "hey friday", "friday"):
            post_event("speak", ping_reply)
            speak(ping_reply)
            post_event("listening", f"Ready for your command, {USER_DISPLAY}.")
            continue

        # Ambient frequency control (semantic intercept before routing to agent)
        if try_handle_ambient_frequency(text):
            post_event("listening", f"Ready for your command, {USER_DISPLAY}.")
            continue

        # WhatsApp read/summarize intercept
        if try_handle_whatsapp_read(text):
            post_event("listening", f"Ready for your command, {USER_DISPLAY}.")
            continue

        # Send to Friday pc-agent
        ack = random.choice([
            "On it.",
            f"Already on it, {USER_DISPLAY}.",
            "Consider it done.",
            "Right away.",
            "Copy that. Working on it.",
            "Sure, give me a moment.",
            "Locked in. Stand by.",
            "Running it now.",
            "On it — won't be long.",
            "Leave it with me.",
            "Got it. Let me pull that together.",
            "Understood. Give me a second.",
            "Yep, on it.",
            "Roger that.",
            f"Diving in now, {USER_DISPLAY}.",
            "Absolutely. One moment.",
            "I'm on it — back in a moment.",
            "All over it.",
        ])
        post_event("thinking", "Routing to Friday agent…")
        post_event("speak", ack)
        if SPEAK_ACK:
            speak(ack)
        log.info("Sending to agent…")
        reply = send_command(text)
        log.info("◄ %s", reply[:120])

        spoken = reply if len(reply) <= 1000 else reply[:997] + "…"
        post_event("reply", spoken)
        post_event("speak", spoken)
        speak(spoken)
        post_event("listening", f"Ready for your command, {USER_DISPLAY}.")

    log.info("Voice daemon stopped.")


if __name__ == "__main__":
    if "--list-mics" in sys.argv:
        print("\nAvailable microphone input devices:\n")
        for i, d in enumerate(sd.query_devices()):
            if d["max_input_channels"] > 0:
                default = " (default)" if i == sd.default.device[0] else ""
                print(f"  [{i:2d}] {d['name']}{default}")
        print(f"\nSet LISTEN_DEVICE_INDEX=<number> in .env to choose one.\n")
        sys.exit(0)
    try:
        main()
    except KeyboardInterrupt:
        speak(
            random.choice([
                f"Going offline, {USER_DISPLAY}.",
                f"Shutting down. Later, {USER_DISPLAY}.",
                "Offline. See you next time.",
            ]),
            priority=False,
        )
        print("\nStopped.")
