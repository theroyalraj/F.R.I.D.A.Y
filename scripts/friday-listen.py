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
  FRIDAY_TTS_VOICE       edge-tts voice       (default: en-GB-RyanNeural)
  FRIDAY_TTS_DEVICE      audio output device  (default: Echo Dot)
  PC_AGENT_URL           pc-agent base URL    (default: http://127.0.0.1:3847)
  LISTEN_DEVICE_INDEX    mic device index     (default: system default)
  LISTEN_LANGUAGE        speech language      (default: en-US)
  LISTEN_PHRASE_LIMIT    max seconds/phrase   (default: 8)
  LISTEN_SILENCE_SEC     silence = phrase end (default: 1.2s)
  FRIDAY_LISTEN_WAKE     wake word filter     (default: disabled = always-on)
"""

import io
import json
import logging
import os
import random
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

# ── Config ─────────────────────────────────────────────────────────────────────
VOICE        = os.environ.get("FRIDAY_TTS_VOICE",    "en-GB-RyanNeural")
DEVICE_HINT  = os.environ.get("FRIDAY_TTS_DEVICE",   "Echo Dot")
AGENT_URL    = os.environ.get("PC_AGENT_URL",         "http://127.0.0.1:3847").rstrip("/")
MIC_INDEX    = os.environ.get("LISTEN_DEVICE_INDEX")
LANGUAGE     = os.environ.get("LISTEN_LANGUAGE",     "en-US")
PHRASE_LIMIT = float(os.environ.get("LISTEN_PHRASE_LIMIT", "8"))
SILENCE_SEC  = float(os.environ.get("LISTEN_SILENCE_SEC",  "1.2"))
WAKE_WORD    = os.environ.get("FRIDAY_LISTEN_WAKE",  "").strip().lower()
SPEAK_SCRIPT = root / "skill-gateway" / "scripts" / "friday-speak.py"
GATEWAY_URL  = os.environ.get("GATEWAY_URL", "http://127.0.0.1:3848").rstrip("/")
SAMPLE_RATE  = 16000   # Google STT works best at 16 kHz
CHANNELS     = 1
# Seconds after startup to ignore mic energy — lets the welcome song + greeting
# finish before the daemon can stop the music via voice activity detection.
DEAF_SEC     = float(os.environ.get("LISTEN_DEAF_SEC", "60"))

MIC_INDEX  = int(MIC_INDEX) if MIC_INDEX else None
PLAY_PID   = Path(tempfile.gettempdir()) / "friday-play.pid"
TTS_TS_FILE = Path(tempfile.gettempdir()) / "friday-tts-ts"


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
def stop_music():
    """Stop Alexa music via gateway + kill any local ffplay PID file."""
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

def speak(text: str):
    log.info("-> speak: %s", text[:80])
    def _run():
        _speaking.set()
        try:
            with _speak_lock:
                try:
                    result = subprocess.run(
                        [sys.executable, str(SPEAK_SCRIPT), text],
                        env={**os.environ, "FRIDAY_TTS_VOICE": VOICE},
                        capture_output=True, timeout=90,   # edge-tts may retry up to ~60s
                    )
                    if result.returncode != 0:
                        err = (result.stderr or b"").decode(errors="replace").strip()
                        log.warning("speak FAILED (exit %d) — falling back to SAPI. stderr=%s",
                                    result.returncode, err[:200])
                        _speak_fallback(text)
                        _write_last_spoken_ts()
                    else:
                        out = (result.stdout or b"").decode(errors="replace").strip()
                        log.info("speak OK: %s", out)
                except subprocess.TimeoutExpired:
                    log.warning("speak timed out — falling back to SAPI")
                    _speak_fallback(text)
                    _write_last_spoken_ts()
                except Exception as e:
                    log.warning("speak exception: %s — falling back to SAPI", e)
                    _speak_fallback(text)
                    _write_last_spoken_ts()
        finally:
            time.sleep(_POST_SPEAK_COOLDOWN)   # keep mic deaf briefly after audio ends
            _speaking.clear()
    threading.Thread(target=_run, daemon=True).start()

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
    THRESHOLD  = 300                        # RMS energy threshold for speech
    MAX_CHUNKS = int(PHRASE_LIMIT / 0.1)
    SILENCE_CHUNKS = max(1, int(SILENCE_SEC / 0.1))

    chunks    = []
    silent    = 0
    speaking  = False

    kwargs = {"device": mic_idx} if mic_idx is not None else {}

    with sd.InputStream(samplerate=SAMPLE_RATE, channels=CHANNELS,
                        dtype="int16", blocksize=BLOCK, **kwargs) as stream:
        for _ in range(MAX_CHUNKS):
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
                    # Only kill music after the startup deaf window has elapsed
                    if DEAF_SEC <= 0 or (time.monotonic() - _daemon_start) >= DEAF_SEC:
                        stop_music()
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
    speak(f"Friday voice daemon online, sir. {mode.capitalize()} mode. Ready.")
    post_event("listening", "Ready for your command, sir.")
    global _daemon_start
    _daemon_start = time.monotonic()
    log.info("Listening — speak to Friday any time. Ctrl+C to stop.\n")
    if DEAF_SEC > 0:
        log.info("Startup deaf period: %.0fs (mic energy ignored until startup music finishes)", DEAF_SEC)

    while True:
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
            speak("Speech recognition error, sir. Check your internet connection.")
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

        # Cut the music the moment a command is recognised (deaf window already elapsed by now)
        stop_music()
        post_event("heard", text)

        lower = text.lower()

        # Built-in stop commands
        if lower in ("stop", "exit", "quit", "goodbye", "shut down", "go offline"):
            bye = random.choice([
                "Going offline, sir. Goodbye.",
                "Shutting down. Take care, sir.",
                "Signing off. Till next time.",
                "Offline. Catch you later, sir.",
                "Done for now. Goodbye, sir.",
            ])
            post_event("speak", bye)
            speak(bye)
            log.info("Shutdown requested.")
            break

        # Status ping
        ping_reply = random.choice([
            "Right here, sir. Ready for your command.",
            "Online and listening.",
            "Always here, sir.",
            "Standing by. What do you need?",
            "Alive and well. Go ahead.",
            "Ready when you are, sir.",
            "At your service.",
            "Here, sir. What's the play?",
            "Fully operational. Talk to me.",
        ])
        if lower in ("status", "are you there", "hello", "hey friday", "friday"):
            post_event("speak", ping_reply)
            speak(ping_reply)
            post_event("listening", "Ready for your command, sir.")
            continue

        # Send to Friday pc-agent
        ack = random.choice([
            "On it.",
            "Already on it, sir.",
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
            "Diving in now, sir.",
            "Absolutely. One moment.",
            "I'm on it — back in a moment.",
            "All over it.",
        ])
        post_event("thinking", "Routing to Friday agent…")
        post_event("speak", ack)
        speak(ack)
        log.info("Sending to agent…")
        reply = send_command(text)
        log.info("◄ %s", reply[:120])

        spoken = reply if len(reply) <= 250 else reply[:247] + "…"
        post_event("reply", spoken)
        post_event("speak", spoken)
        speak(spoken)
        post_event("listening", "Ready for your command, sir.")

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
        speak(random.choice([
            "Going offline, sir.",
            "Shutting down. Later, sir.",
            "Offline. See you next time.",
        ]))
        print("\nStopped.")
