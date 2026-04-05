#!/usr/bin/env python3
"""
friday-music-scheduler.py — background daemon that plays a song at a fixed interval.

Picks a random song from FRIDAY_MUSIC_PLAYLIST (comma-separated) and plays it via
friday-play.py every FRIDAY_MUSIC_INTERVAL_MIN minutes (default: 30).

Skips if TTS is currently active (friday-tts-active lock exists) or if friday-play
is already running. Respects FRIDAY_MUSIC_SCHEDULER=false to disable.

Optional “ask first” (default off): speak a short prompt and wait for voice yes/no from
friday-listen.py (same machine). Set FRIDAY_MUSIC_ASK_BEFORE_PLAY=true.

Usage:
  python scripts/friday-music-scheduler.py

Env vars (all optional — reads .env):
  FRIDAY_MUSIC_SCHEDULER       true/false to enable/disable (default: true if script is run)
  FRIDAY_MUSIC_INTERVAL_MIN    minutes between songs (default: 30)
  FRIDAY_MUSIC_PLAYLIST        comma-separated search phrases (default: FRIDAY_STARTUP_SONG)
  FRIDAY_MUSIC_FIRST_WAIT_SEC  seconds before first song (optional; default min(120, interval))
  FRIDAY_MUSIC_ASK_BEFORE_PLAY true = speak a prompt and wait for mic yes/no before playing
                                 (default: false — behaviour unchanged)
  FRIDAY_MUSIC_ASK_WAIT_SEC    seconds to wait for an answer (default: 90)
  FRIDAY_PLAY_SECONDS          per-song play duration (default: 28)
  FRIDAY_PLAY_VOLUME           ffplay volume 0-100 (default: 70)
"""

import json
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
SPEAK_SCRIPT = ROOT / "skill-gateway" / "scripts" / "friday-speak.py"
TTS_ACTIVE_FILE = Path(tempfile.gettempdir()) / "friday-tts-active"
PLAY_PID_FILE = Path(tempfile.gettempdir()) / "friday-play.pid"
MUSIC_OFFER_FILE = Path(tempfile.gettempdir()) / "friday-music-offer.json"
MUSIC_OFFER_RESPONSE_FILE = Path(tempfile.gettempdir()) / "friday-music-offer-response.txt"


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


def _ask_before_play_enabled() -> bool:
    v = os.environ.get("FRIDAY_MUSIC_ASK_BEFORE_PLAY", "").strip().lower()
    return v in ("1", "true", "yes", "on")


def _ask_wait_sec() -> float:
    raw = os.environ.get("FRIDAY_MUSIC_ASK_WAIT_SEC", "").strip().split("#")[0].strip()
    if raw:
        try:
            return max(15.0, min(float(raw), 600.0))
        except ValueError:
            pass
    return 90.0


_MUSIC_ASK_PROMPTS = (
    "Fancy a bit of noise? I had {song} lined up — say yes if you want it, or no if you're heads-down.",
    "Vibe check — mind if I put on {song}? Yes or no, your call.",
    "It's gone quiet. Want {song}, or shall I leave the silence alone? Just say yes or no.",
    "I could spin {song} — interested, or would you rather skip? Yes or no works.",
    "Quick one — {song} sounds good about now. Play it, or nah?",
    "{name}, permission to drop {song}? Yes means go, no means I'll park it.",
)


def _offer_prompt(song: str) -> str:
    name = (os.environ.get("FRIDAY_USER_NAME", "") or "").strip() or "mate"
    tmpl = random.choice(_MUSIC_ASK_PROMPTS)
    return tmpl.format(song=song, name=name)


def _speak_ask(prompt: str) -> None:
    env = {
        **os.environ,
        "FRIDAY_TTS_PRIORITY": "1",
        "FRIDAY_TTS_BYPASS_CURSOR_DEFER": "true",
    }
    kw: dict = {"cwd": str(ROOT), "env": env, "timeout": 120}
    if sys.platform == "win32":
        kw["creationflags"] = subprocess.CREATE_NO_WINDOW
    try:
        subprocess.run([sys.executable, str(SPEAK_SCRIPT), prompt], **kw)
    except Exception as e:
        log.warning("Ask prompt speak failed: %s", e)


def _wait_for_music_offer_yes(deadline: float) -> bool:
    """Poll response file written by friday-listen (yes/no)."""
    MUSIC_OFFER_RESPONSE_FILE.unlink(missing_ok=True)
    while time.time() < deadline:
        if MUSIC_OFFER_RESPONSE_FILE.is_file():
            try:
                raw = MUSIC_OFFER_RESPONSE_FILE.read_text(encoding="utf-8").strip().lower()
                MUSIC_OFFER_RESPONSE_FILE.unlink(missing_ok=True)
                if raw in (
                    "yes",
                    "y",
                    "1",
                    "true",
                    "yeah",
                    "yep",
                    "yup",
                    "sure",
                    "ok",
                    "okay",
                    "please",
                ):
                    return True
                if raw in ("no", "n", "0", "false", "nope", "nah", "skip", "pass"):
                    return False
            except OSError:
                pass
        time.sleep(0.35)
    return False


def _run_ask_then_maybe_play() -> None:
    song = random.choice(PLAYLIST)
    wait_sec = _ask_wait_sec()
    deadline = time.time() + wait_sec
    try:
        MUSIC_OFFER_FILE.write_text(
            json.dumps(
                {"deadline": deadline, "song": song, "wait_sec": wait_sec},
                indent=None,
            ),
            encoding="utf-8",
        )
    except OSError as e:
        log.warning("Could not write music offer file: %s", e)
        play_song(song)
        return

    prompt = _offer_prompt(song)
    log.info("Music ask — waiting up to %.0fs for yes/no (friday-listen): %s", wait_sec, song)
    _speak_ask(prompt)

    if _wait_for_music_offer_yes(deadline):
        log.info("Music ask — yes, playing: %s", song)
        play_song(song)
    else:
        log.info("Music ask — skipped or timed out (no affirmative)")

    MUSIC_OFFER_FILE.unlink(missing_ok=True)
    MUSIC_OFFER_RESPONSE_FILE.unlink(missing_ok=True)


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


def play_song(song: str | None = None):
    if not song:
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


def _first_sleep_sec(interval_sec: float) -> float:
    """
    Legacy loop slept a full interval before the first song — up to 30+ minutes of silence.
    Default: wait at most two minutes (or one full interval if shorter), unless overridden.
    """
    raw = os.environ.get("FRIDAY_MUSIC_FIRST_WAIT_SEC", "").strip().split("#")[0].strip()
    if raw:
        try:
            return max(5.0, float(raw))
        except ValueError:
            pass
    return min(120.0, interval_sec)


def main():
    interval_sec = INTERVAL_MIN * 60
    log.info(
        "Music scheduler online — every %.0f min, %d song(s) in playlist",
        INTERVAL_MIN,
        len(PLAYLIST),
    )
    log.info("Playlist: %s", PLAYLIST)

    first = True
    while True:
        time.sleep(_first_sleep_sec(interval_sec) if first else interval_sec)
        first = False

        if _tts_active():
            log.info("TTS active — skipping this cycle")
            continue

        if _play_running():
            log.info("friday-play already running — skipping")
            continue

        try:
            if _ask_before_play_enabled():
                _run_ask_then_maybe_play()
            else:
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
