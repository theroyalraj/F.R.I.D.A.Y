#!/usr/bin/env python3
"""
Friday TTS — edge-tts neural voice, plays to a named Windows audio device.

Usage:
  python friday-speak.py "Task complete, sir."
  python friday-speak.py --output path/to/out.mp3 "Text"   # write MP3, no playback
  python friday-speak.py --stdout "Text"                    # pipe MP3 bytes to stdout

Env vars (all optional):
  FRIDAY_TTS_VOICE   edge-tts voice name  (default: en-GB-RyanNeural)
  FRIDAY_TTS_DEVICE  audio device substring (default: Echo Dot)
                     set to "" or "default" to use system default device
  FRIDAY_TTS_RATE    speed               (default: +0%)
  FRIDAY_TTS_PITCH   pitch               (default: +0Hz)
  FRIDAY_TTS_VOLUME  volume              (default: +0%)

Good voices:
  en-GB-RyanNeural              British male    ← default (Jarvis feel)
  en-GB-ThomasNeural            British male, deeper
  en-US-GuyNeural               US male neural
  en-IN-NeerjaExpressiveNeural  Indian English / Hinglish
  hi-IN-SwaraNeural             Hindi female
"""
import asyncio
import io
import os
import subprocess
import sys
import tempfile
import time
import platform

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
VOICE  = os.environ.get("FRIDAY_TTS_VOICE",  "en-GB-RyanNeural")
RATE   = os.environ.get("FRIDAY_TTS_RATE",   "+0%")
PITCH  = os.environ.get("FRIDAY_TTS_PITCH",  "+0Hz")
VOLUME = os.environ.get("FRIDAY_TTS_VOLUME", "+0%")
DEVICE = os.environ.get("FRIDAY_TTS_DEVICE", "Echo Dot").strip()

# ── Edge-TTS with retry ───────────────────────────────────────────────────────
async def _fetch_mp3(retries: int = 8) -> bytes:
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
                wait = min(attempt * 1.5, 8.0)   # cap at 8s so total wait stays under ~50s
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


# ── ffplay fallback (default Windows audio device) ────────────────────────────
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
        subprocess.run(
            ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", tmp],
            check=True,
            **kwargs,
        )
    except subprocess.CalledProcessError as e:
        print(f"friday-speak: ffplay error {e.returncode}", file=sys.stderr)
        sys.exit(1)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def _play_to_device(mp3_data: bytes, device_name_sub: str) -> bool:
    """
    Switch Windows default audio output to the named device, play via ffplay, then restore.
    Returns True if the device was found and audio played to it, False to fall back to default.
    """
    try:
        result = _find_device_id(device_name_sub)
        if not result:
            print(f"[friday-speak] device '{device_name_sub}' not found — using default", file=sys.stderr, flush=True)
            return False

        target_id, target_name = result
        original_id = _get_default_output_id()

        # Already the right device — skip the switch overhead
        if original_id and original_id == target_id:
            print(f"[friday-speak] playing to default device: {target_name}", flush=True)
            _play_ffplay(mp3_data)
            return True

        print(f"[friday-speak] switching default to: {target_name}", flush=True)
        _set_default_endpoint(target_id)
        # Brief pause: Bluetooth needs a moment to (re)connect before audio starts
        time.sleep(0.4)

        try:
            _play_ffplay(mp3_data)
        finally:
            if original_id:
                _set_default_endpoint(original_id)
                print(f"[friday-speak] restored default output", flush=True)

        print(f"[friday-speak] played via {VOICE} on {target_name}", flush=True)
        return True

    except Exception as exc:
        print(f"[friday-speak] device routing failed ({exc.__class__.__name__}: {exc}) — using default", file=sys.stderr, flush=True)
        return False


async def speak():
    if not TEXT:
        print("friday-speak: no text provided", file=sys.stderr)
        sys.exit(1)

    try:
        mp3_data = await _fetch_mp3()
    except Exception as exc:
        print(f"friday-speak: edge-tts failed — {exc}", file=sys.stderr)
        sys.exit(1)

    # --output: write MP3 to file (used by HTTP /voice/tts endpoint)
    if OUTPUT:
        with open(OUTPUT, "wb") as f:
            f.write(mp3_data)
        print(f"[friday-speak] wrote {len(mp3_data)} bytes -> {OUTPUT}", flush=True)
        return

    # --stdout: pipe raw MP3 bytes (for streaming)
    if STDOUT:
        sys.stdout.buffer.write(mp3_data)
        sys.stdout.buffer.flush()
        return

    # Playback — route to named device if set, else ffplay on default device
    use_device = DEVICE and DEVICE.lower() not in ("", "default", "none")
    if use_device:
        if _play_to_device(mp3_data, DEVICE):
            return

    # Fallback / no device specified
    print(f"[friday-speak] playing via {VOICE} on default audio device", flush=True)
    _play_ffplay(mp3_data)


asyncio.run(speak())
