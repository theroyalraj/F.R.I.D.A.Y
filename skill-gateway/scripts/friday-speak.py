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
  FRIDAY_TTS_CACHE   MP3 cache dir       (default: %TEMP%/friday-tts-cache)
                     set to "" to disable cache

Good voices:
  en-GB-RyanNeural              British male    ← default (Jarvis feel)
  en-GB-ThomasNeural            British male, deeper
  en-US-GuyNeural               US male neural
  en-IN-NeerjaExpressiveNeural  Indian English / Hinglish
  hi-IN-SwaraNeural             Hindi female
"""
import asyncio
import hashlib
import io
import os
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
VOICE  = os.environ.get("FRIDAY_TTS_VOICE",  "en-GB-RyanNeural")
RATE   = os.environ.get("FRIDAY_TTS_RATE",   "+0%")
PITCH  = os.environ.get("FRIDAY_TTS_PITCH",  "+0Hz")
VOLUME = os.environ.get("FRIDAY_TTS_VOLUME", "+0%")
DEVICE = os.environ.get("FRIDAY_TTS_DEVICE", "Echo Dot").strip()

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


# ── MP3 cache ─────────────────────────────────────────────────────────────────
def _cache_key() -> str:
    key = f"{TEXT}|{VOICE}|{RATE}|{PITCH}|{VOLUME}"
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


# ── Edge-TTS with retry ───────────────────────────────────────────────────────
async def _fetch_mp3_network(retries: int = 3) -> bytes:
    """3 quick retries (2s, 4s gaps = ~6s total) then raise — caller falls back to SAPI."""
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
                wait = attempt * 2.0   # 2s, 4s — short budget before SAPI kicks in
                print(f"[friday-speak] attempt {attempt} failed ({exc.__class__.__name__}), retry in {wait}s", file=sys.stderr, flush=True)
                await asyncio.sleep(wait)
    raise last_err

async def _fetch_mp3() -> bytes:
    """Return MP3 bytes — from cache if available, else download and cache."""
    cached = _load_cache()
    if cached:
        print(f"[friday-speak] cache hit ({len(cached)} bytes)", flush=True)
        return cached
    data = await _fetch_mp3_network()
    _save_cache(data)
    return data


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
    The device switch happens CONCURRENTLY with the MP3 fetch (caller passes pre-fetched data).
    Returns True on success, False to fall back to default device.
    """
    try:
        result = _find_device_id(device_name_sub)
        if not result:
            print(f"[friday-speak] device '{device_name_sub}' not found — using default", file=sys.stderr, flush=True)
            return False

        target_id, target_name = result
        original_id = _get_default_output_id()

        # Already the right device — no switch needed, no BT wake delay
        if original_id and original_id == target_id:
            print(f"[friday-speak] playing to default device: {target_name}", flush=True)
            _play_ffplay(mp3_data)
            return True

        print(f"[friday-speak] switching default to: {target_name}", flush=True)
        _set_default_endpoint(target_id)
        # Brief pause: Bluetooth needs a moment to (re)connect before audio starts
        time.sleep(0.3)

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


def _fade_and_stop_music(fade_sec: float = 1.5, steps: int = 20) -> None:
    """
    Fade out any running music (ffplay audio sessions) to silence, then kill
    the friday-play process via its PID file.  Called automatically before
    every TTS playback so speech is never buried under music.
    """
    try:
        from pycaw.utils import AudioUtilities

        sessions = AudioUtilities.GetAllSessions()
        music_sessions = [
            s for s in sessions
            if s.Process and "ffplay" in s.Process.name().lower() and s.SimpleAudioVolume
        ]
        if not music_sessions:
            return  # nothing playing — nothing to do

        step_time = fade_sec / steps
        for i in range(steps + 1):
            vol = 1.0 - (i / steps)   # 1.0 → 0.0 linear fade
            for s in music_sessions:
                try:
                    s.SimpleAudioVolume.SetMasterVolume(vol, None)
                except Exception:
                    pass
            if i < steps:
                time.sleep(step_time)

        # Kill the friday-play ffplay process so it doesn't linger silently at volume 0
        pid_file = Path(tempfile.gettempdir()) / "friday-play.pid"
        if pid_file.exists():
            try:
                pid = int(pid_file.read_text().strip())
                os.kill(pid, _signal.SIGTERM)
                pid_file.unlink(missing_ok=True)
            except Exception:
                pass

        print(f"[friday-speak] faded out {len(music_sessions)} music session(s)", flush=True)
    except Exception as exc:
        print(f"[friday-speak] fade-out skipped ({exc.__class__.__name__}: {exc})", file=sys.stderr, flush=True)


async def speak():
    if not TEXT:
        print("friday-speak: no text provided", file=sys.stderr)
        sys.exit(1)

    # Kick off device-switch lookup in a background thread while we fetch the MP3 —
    # so the BT switch and TTS download overlap instead of running sequentially.
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
                # Already correct — nothing to switch
                device_result[0] = (target_id, target_name, None)
                switch_done.set()
                return
            # Switch now (while MP3 is still downloading)
            _set_default_endpoint(target_id)
            time.sleep(0.3)   # BT wake-up
            device_result[0] = (target_id, target_name, original_id)
        except Exception as exc:
            print(f"[friday-speak] device prep failed: {exc}", file=sys.stderr, flush=True)
            device_result[0] = False
        finally:
            switch_done.set()

    # Start device prep immediately (non-blocking thread)
    threading.Thread(target=_prepare_device, daemon=True).start()

    try:
        mp3_data = await _fetch_mp3()
    except Exception as exc:
        print(f"friday-speak: edge-tts failed — {exc}", file=sys.stderr, flush=True)
        switch_done.wait(timeout=2)
        # Restore device if we already switched
        if device_result[0] and device_result[0] is not False:
            _tid, _tname, orig = device_result[0]
            if orig:
                try: _set_default_endpoint(orig)
                except Exception: pass
        # SAPI fallback — instant, no network needed
        if not OUTPUT and not STDOUT:
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
            except Exception as sapi_err:
                print(f"friday-speak: SAPI also failed — {sapi_err}", file=sys.stderr)
        sys.exit(1)

    # --output: write MP3 to file
    if OUTPUT:
        switch_done.wait(timeout=5)
        if device_result[0] and device_result[0] is not False:
            _tid, _tname, orig = device_result[0]
            if orig:
                try: _set_default_endpoint(orig)
                except Exception: pass
        with open(OUTPUT, "wb") as f:
            f.write(mp3_data)
        print(f"[friday-speak] wrote {len(mp3_data)} bytes -> {OUTPUT}", flush=True)
        return

    # --stdout
    if STDOUT:
        switch_done.wait(timeout=5)
        if device_result[0] and device_result[0] is not False:
            _tid, _tname, orig = device_result[0]
            if orig:
                try: _set_default_endpoint(orig)
                except Exception: pass
        sys.stdout.buffer.write(mp3_data)
        sys.stdout.buffer.flush()
        return

    # Wait for device switch to complete (it probably already finished while we were fetching)
    switch_done.wait(timeout=10)

    # Fade out any running music before speaking — always, for every TTS call
    _fade_and_stop_music()

    if use_device and device_result[0] is not False:
        info = device_result[0]
        if info is None:
            # Thread didn't finish in time — fall through to ffplay default
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
                except Exception: pass
        return

    # Fallback / no device specified
    print(f"[friday-speak] playing via {VOICE} on default audio device", flush=True)
    _play_ffplay(mp3_data)


asyncio.run(speak())
