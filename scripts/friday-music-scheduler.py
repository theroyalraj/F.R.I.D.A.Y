#!/usr/bin/env python3
"""
friday-music-scheduler.py — background daemon that plays a song at a fixed interval.

Picks a random song from FRIDAY_MUSIC_PLAYLIST (comma-separated) and plays it via
friday-play.py every FRIDAY_MUSIC_INTERVAL_MIN minutes (default: 30).

Skips if TTS is currently active (friday-tts-active lock exists) or if friday-play
is already running. Respects FRIDAY_MUSIC_SCHEDULER=false to disable.

Usage:
  python scripts/friday-music-scheduler.py

Env vars (all optional — reads .env):
  FRIDAY_MUSIC_SCHEDULER       true/false to enable/disable (default: true if script is run)
  FRIDAY_MUSIC_INTERVAL_MIN    minutes between songs (default: 30)
  FRIDAY_MUSIC_PLAYLIST        comma-separated search phrases (default: FRIDAY_STARTUP_SONG)
  FRIDAY_PLAY_SECONDS          per-song play duration (default: 28)
  FRIDAY_PLAY_VOLUME           ffplay volume 0-100 (default: 70)
"""

import logging
import os
import random
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = ROOT / ".env"
if ENV_PATH.exists():
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        t = line.strip()
        if not t or t.startswith("#") or "=" not in t:
            continue
        k, _, rest = t.partition("=")
        k = k.strip()
        v = rest.split("#", 1)[0].strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v

PLAY_SCRIPT = ROOT / "skill-gateway" / "scripts" / "friday-play.py"
TTS_ACTIVE_FILE = Path(tempfile.gettempdir()) / "friday-tts-active"
PLAY_PID_FILE = Path(tempfile.gettempdir()) / "friday-play.pid"


def _python_for_friday_play() -> str:
    if sys.platform != "win32":
        return sys.executable
    override = os.environ.get("FRIDAY_PYTHON_CHILD", "").strip()
    if override:
        return override
    base = Path(sys.executable)
    w = base.parent / "pythonw.exe"
    if w.is_file():
        return str(w)
    return sys.executable


_autoplay_raw = os.environ.get("FRIDAY_AUTOPLAY", "true").lower()
AUTOPLAY_ENABLED = _autoplay_raw not in ("false", "0", "off", "no")

INTERVAL_MIN = float(os.environ.get("FRIDAY_MUSIC_INTERVAL_MIN", "30"))
DEFAULT_SONG = os.environ.get("FRIDAY_STARTUP_SONG", "Back in Black AC DC")
PLAYLIST_RAW = os.environ.get("FRIDAY_MUSIC_PLAYLIST", "").strip()
PLAYLIST = [s.strip() for s in PLAYLIST_RAW.split(",") if s.strip()] if PLAYLIST_RAW else [DEFAULT_SONG]

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("friday-music")

if not AUTOPLAY_ENABLED:
    log.info("FRIDAY_AUTOPLAY=false — music scheduler disabled, exiting")
    sys.exit(0)


def _tts_active() -> bool:
    if not TTS_ACTIVE_FILE.exists():
        return False
    try:
        age = time.time() - TTS_ACTIVE_FILE.stat().st_mtime
        return age < 120
    except OSError:
        return False


def _play_running() -> bool:
    if not PLAY_PID_FILE.exists():
        return False
    try:
        pid = int(PLAY_PID_FILE.read_text().strip())
        if sys.platform == "win32":
            import ctypes
            k32 = ctypes.windll.kernel32
            h = k32.OpenProcess(0x1000, False, pid)
            if not h:
                return False
            k32.CloseHandle(h)
            return True
        os.kill(pid, 0)
        return True
    except (ValueError, OSError, ProcessLookupError):
        return False


def play_song():
    song = random.choice(PLAYLIST)
    log.info("Playing: %s", song)

    env = {**os.environ}
    kw = {
        "cwd": str(ROOT),
        "env": env,
        "timeout": 300,
    }
    if sys.platform == "win32":
        kw["creationflags"] = subprocess.CREATE_NO_WINDOW

    try:
        r = subprocess.run(
            [_python_for_friday_play(), str(PLAY_SCRIPT), song],
            **kw,
        )
        if r.returncode == 0:
            log.info("Finished: %s", song)
        else:
            log.warning("friday-play exited %d for %s", r.returncode, song)
    except subprocess.TimeoutExpired:
        log.warning("friday-play timed out for %s", song)
    except Exception as e:
        log.warning("friday-play error: %s", e)


def main():
    interval_sec = INTERVAL_MIN * 60
    log.info(
        "Music scheduler online — every %.0f min, %d song(s) in playlist",
        INTERVAL_MIN,
        len(PLAYLIST),
    )
    log.info("Playlist: %s", PLAYLIST)

    while True:
        time.sleep(interval_sec)

        if _tts_active():
            log.info("TTS active — skipping this cycle")
            continue

        if _play_running():
            log.info("friday-play already running — skipping")
            continue

        try:
            play_song()
        except KeyboardInterrupt:
            break
        except Exception as e:
            log.warning("Unhandled error: %s", e)

    log.info("Music scheduler stopped.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log.info("Stopped.")
