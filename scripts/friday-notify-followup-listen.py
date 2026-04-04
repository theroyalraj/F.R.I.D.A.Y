#!/usr/bin/env python3
"""
One-shot listen after a PC-spoken notification (task done, /internal/speak, etc.).

Speaks a short prompt, waits up to FRIDAY_NOTIFY_LISTEN_SEC wall seconds for the user to
start talking, records until silence, then POSTs the transcript to pc-agent /voice/command
and speaks the reply.

Spawned by skill-gateway after notification TTS completes. If the always-on friday-listen
daemon holds the mic exclusively, capture may fail — check logs.

Env (after loading .env from repo root):
  FRIDAY_NOTIFY_LISTEN_SEC   default 10
  FRIDAY_NOTIFY_LISTEN_PROMPT optional override (else built-in phrase)
  FRIDAY_USER_NAME, PC_AGENT_URL, LISTEN_LANGUAGE, LISTEN_DEVICE_INDEX,
  LISTEN_ENERGY_THRESHOLD, LISTEN_SILENCE_SEC, LISTEN_PHRASE_LIMIT — same as friday-listen
"""

from __future__ import annotations

import io
import logging
import os
import sys
import tempfile
import time
import wave
from pathlib import Path

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
        k, v = t[:i].strip(), t[i + 1 :].strip()
        if v.startswith('"') and v.endswith('"'):
            v = v[1:-1]
        elif v.startswith("'") and v.endswith("'"):
            v = v[1:-1]
        if k not in os.environ:
            os.environ[k] = v

# This pass must hear the user even when Cursor is focused (notification path).
os.environ["FRIDAY_DEFER_WHEN_CURSOR"] = "false"

_scripts_dir = Path(__file__).resolve().parent
if str(_scripts_dir) not in sys.path:
    sys.path.insert(0, str(_scripts_dir))
_sg_scripts = root / "skill-gateway" / "scripts"
if str(_sg_scripts) not in sys.path:
    sys.path.insert(0, str(_sg_scripts))

from friday_speaker import speaker  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("friday-notify-followup")

USER_DISPLAY = (os.environ.get("FRIDAY_USER_NAME", "Raj") or "Raj").strip() or "Raj"
AGENT_URL = os.environ.get("PC_AGENT_URL", "http://127.0.0.1:3847").rstrip("/")
LANGUAGE = os.environ.get("LISTEN_LANGUAGE", "en-US")
LISTEN_SEC = float(os.environ.get("FRIDAY_NOTIFY_LISTEN_SEC", "10").split("#")[0].strip() or "10")
MIC_INDEX_RAW = os.environ.get("LISTEN_DEVICE_INDEX")
SAMPLE_RATE = 16000
CHANNELS = 1
ENERGY_THRESHOLD = float(os.environ.get("LISTEN_ENERGY_THRESHOLD", "300"))
SILENCE_SEC = float(os.environ.get("LISTEN_SILENCE_SEC", "1.2"))
PHRASE_LIMIT = float(os.environ.get("LISTEN_PHRASE_LIMIT", "8"))
TTS_ACTIVE_FILE = Path(tempfile.gettempdir()) / "friday-tts-active"

try:
    import numpy as np
except ImportError:
    print("ERROR: pip install numpy", file=sys.stderr)
    sys.exit(1)

try:
    import sounddevice as sd
except ImportError:
    print("ERROR: pip install sounddevice", file=sys.stderr)
    sys.exit(1)

try:
    import speech_recognition as sr
except ImportError:
    print("ERROR: pip install SpeechRecognition", file=sys.stderr)
    sys.exit(1)

try:
    import requests as req_lib
except ImportError:
    print("ERROR: pip install requests", file=sys.stderr)
    sys.exit(1)


def _mic_index() -> int | None:
    if not MIC_INDEX_RAW:
        return None
    try:
        return int(MIC_INDEX_RAW)
    except ValueError:
        return None


def _wait_for_tts_clear(timeout: float = 30.0) -> None:
    deadline = time.time() + timeout
    while TTS_ACTIVE_FILE.exists():
        try:
            age = time.time() - TTS_ACTIVE_FILE.stat().st_mtime
            if age > 120:
                TTS_ACTIVE_FILE.unlink(missing_ok=True)
                break
        except OSError:
            break
        if time.time() > deadline:
            break
        time.sleep(0.2)


def _default_prompt() -> str:
    custom = (os.environ.get("FRIDAY_NOTIFY_LISTEN_PROMPT") or "").strip()
    if custom:
        return custom
    n = int(round(LISTEN_SEC))
    return (
        f"If you want to add anything, {USER_DISPLAY}, go ahead — "
        f"I will listen for {n} seconds."
    )


def numpy_to_audio_data(audio_int16: np.ndarray) -> sr.AudioData:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(audio_int16.tobytes())
    raw = buf.getvalue()
    return sr.AudioData(raw[44:], SAMPLE_RATE, 2)


def record_after_prompt(mic_idx: int | None) -> np.ndarray | None:
    """
    For up to LISTEN_SEC seconds, wait for speech to start; then record until silence
    or PHRASE_LIMIT (post-start), same chunking as friday-listen record_phrase.
    """
    BLOCK = int(SAMPLE_RATE * 0.1)
    THRESHOLD = ENERGY_THRESHOLD
    MAX_CHUNKS_AFTER_SPEECH = int(PHRASE_LIMIT / 0.1)
    SILENCE_CHUNKS = max(1, int(SILENCE_SEC / 0.1))
    kwargs = {"device": mic_idx} if mic_idx is not None else {}

    listen_deadline = time.monotonic() + max(1.0, LISTEN_SEC)

    try:
        stream_ctx = sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=CHANNELS,
            dtype="int16",
            blocksize=BLOCK,
            **kwargs,
        )
    except Exception as e:
        log.warning("Mic open failed (is friday-listen using the mic?): %s", e)
        return None

    chunks: list[np.ndarray] = []
    silent = 0
    speaking = False
    chunks_since_speech = 0

    with stream_ctx as stream:
        # Phase 1: wait for voice start within listen window
        while time.monotonic() < listen_deadline:
            block, _ = stream.read(BLOCK)
            block = block.flatten()
            rms = float(np.sqrt(np.mean(block.astype(np.float32) ** 2)))
            if rms > THRESHOLD:
                speaking = True
                silent = 0
                chunks = [block]
                chunks_since_speech = 1
                break
        else:
            log.info("No speech started within %.1fs — done.", LISTEN_SEC)
            return None

        # Phase 2: record until silence or phrase cap
        while chunks_since_speech < MAX_CHUNKS_AFTER_SPEECH:
            block, _ = stream.read(BLOCK)
            block = block.flatten()
            rms = float(np.sqrt(np.mean(block.astype(np.float32) ** 2)))

            if rms > THRESHOLD:
                silent = 0
                chunks.append(block)
                chunks_since_speech += 1
            else:
                chunks.append(block)
                chunks_since_speech += 1
                silent += 1
                if silent >= SILENCE_CHUNKS:
                    break

    if not chunks:
        return None
    return np.concatenate(chunks)


def send_command(text: str) -> str:
    try:
        r = req_lib.post(
            f"{AGENT_URL}/voice/command",
            json={"text": text, "userId": "friday-notify-followup", "source": "voice"},
            timeout=120,
            headers={"ngrok-skip-browser-warning": "1"},
        )
        r.raise_for_status()
        j = r.json()
        return str(j.get("summary") or j.get("error") or "Done.")
    except req_lib.exceptions.ConnectionError:
        return "Cannot reach the Friday agent. Is pc-agent running?"
    except Exception as e:
        return f"Request failed: {e}"


def main() -> None:
    _wait_for_tts_clear(45.0)
    prompt = _default_prompt()
    log.info("Follow-up prompt: %s", prompt[:80])
    speaker.speak_blocking(
        prompt,
        priority=True,
        bypass_cursor_defer=True,
        interrupt_music=True,
        use_session_sticky=True,
        timeout=90.0,
    )
    time.sleep(0.35)
    _wait_for_tts_clear(15.0)

    mic_idx = _mic_index()
    audio = record_after_prompt(mic_idx)
    if audio is None:
        return

    recognizer = sr.Recognizer()
    try:
        audio_data = numpy_to_audio_data(audio)
        text = recognizer.recognize_google(audio_data, language=LANGUAGE)
    except sr.UnknownValueError:
        log.info("Could not understand reply — done.")
        return
    except sr.RequestError as e:
        log.warning("STT error: %s", e)
        return

    text = (text or "").strip()
    if not text:
        return
    log.info("Heard: %s", text[:120])
    reply = send_command(text)
    spoken = reply if len(reply) <= 1000 else reply[:997] + "…"
    speaker.speak_blocking(
        spoken,
        priority=True,
        bypass_cursor_defer=True,
        interrupt_music=True,
        use_session_sticky=True,
        timeout=120.0,
    )


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
