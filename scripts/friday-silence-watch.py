#!/usr/bin/env python3
"""
friday-silence-watch.py — ECHO (Director of Presence): speaks a light check-in when nothing
has been spoken for FRIDAY_SILENCE_IDLE_SEC (default 600s / ten minutes).

Uses Redis key friday:tts:last_activity (stamped by friday-speak.py on every speak, seven-day TTL).
If Redis has no activity yet, idle is measured from this process start so we do not fire immediately.

Skips while: global TTS lock held, friday-tts-active file fresh, friday-play running,
FRIDAY_CURSOR_NARRATION off (silent like Argus), or FRIDAY_SILENCE_DEFER_WHEN_CURSOR and Cursor
has focus (same helper as ambient).

Env (optional, reads .env):
  FRIDAY_SILENCE_WATCH          default true — set false to disable
  FRIDAY_SILENCE_IDLE_SEC       default 600
  FRIDAY_SILENCE_REARM_SEC      default 600 — min gap between nudges (Redis EX on last_nudge key)
  FRIDAY_SILENCE_POLL_SEC       default 15
  FRIDAY_SILENCE_DEFER_WHEN_CURSOR  default true
  FRIDAY_SILENCE_REQUIRES_NARRATION   default false — when true, skip nudges if FRIDAY_CURSOR_NARRATION is off
"""
from __future__ import annotations

import logging
import os
import random
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

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

from friday_win_focus import should_defer_ambient_for_cursor  # noqa: E402
from openclaw_company import friday_speak_env_for_persona  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("friday-silence-watch")

SPEAK_SCRIPT = ROOT / "skill-gateway" / "scripts" / "friday-speak.py"
TTS_ACTIVE_FILE = Path(tempfile.gettempdir()) / "friday-tts-active"
PLAY_PID_FILE = Path(tempfile.gettempdir()) / "friday-play.pid"

_REDIS_ACTIVITY = "friday:tts:last_activity"
_REDIS_TTS_LOCK = "friday:tts:lock"
_REDIS_REARM = "openclaw:silence_watch:last_nudge"


def _env_bool(name: str, default: bool = False) -> bool:
    v = os.environ.get(name, "").strip().lower()
    if not v:
        return default
    return v in ("1", "true", "yes", "on")


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip().split("#")[0].strip()
    if not raw:
        return default
    try:
        return int(raw, 10)
    except ValueError:
        return default


def _redis_url() -> str:
    return (
        os.environ.get("OPENCLAW_REDIS_URL", "").strip()
        or os.environ.get("FRIDAY_AMBIENT_REDIS_URL", "").strip()
        or "redis://127.0.0.1:6379"
    )


_r_client = None


def _redis():
    global _r_client
    if _r_client is not None:
        return _r_client
    try:
        import redis as redis_mod

        _r_client = redis_mod.Redis.from_url(
            _redis_url(),
            decode_responses=True,
            socket_connect_timeout=1.5,
            socket_timeout=1.5,
        )
        _r_client.ping()
    except Exception as e:
        log.warning("Redis unavailable (%s) — idle timing uses local watch start only", e)
        _r_client = False
    return _r_client


def _tts_active_file() -> bool:
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


def _redis_tts_lock_held() -> bool:
    r = _redis()
    if not r or r is False:
        return False
    try:
        return bool(r.exists(_REDIS_TTS_LOCK))
    except Exception:
        return False


def _last_activity_ts(r, watch_started: float) -> float:
    if not r or r is False:
        return watch_started
    try:
        raw = r.get(_REDIS_ACTIVITY)
        if raw:
            return float(raw)
    except Exception:
        pass
    return watch_started


def _pick_line() -> str:
    name = os.environ.get("FRIDAY_USER_NAME", "").strip() or "there"
    pool = [
        f"{name}, it has been quiet a while — want a quick briefing, a joke, or should I leave you to it?",
        "Nothing from either of us for a bit. Say the word if you want headlines, reminders, or just a chat.",
        "Still here. I can summarise what is open, check mail tone, or play something light — your call.",
        "Long stretch without speech. If you are heads-down, ignore me; if you want company, just ask.",
        "Ten minutes of silence on my side. Want me to surface anything from the tracker or calendar?",
        "Quiet desk. I am around if you want a one-line status, a cricket snippet, or music.",
        "No TTS for a while — either you are focused or the mic path is idle. Ping me if you need anything.",
        f"{name}, gentle check-in: need a nudge on pending reviews or shall I stay quiet?",
    ]
    return random.choice(pool)


def main() -> None:
    if not _env_bool("FRIDAY_SILENCE_WATCH", True):
        log.info("FRIDAY_SILENCE_WATCH off — exiting")
        sys.exit(0)

    idle_sec = max(60, _env_int("FRIDAY_SILENCE_IDLE_SEC", 600))
    rearm_sec = max(60, _env_int("FRIDAY_SILENCE_REARM_SEC", 600))
    poll_sec = max(5, _env_int("FRIDAY_SILENCE_POLL_SEC", 15))
    defer_cursor = _env_bool("FRIDAY_SILENCE_DEFER_WHEN_CURSOR", True)
    narration_on = _env_bool("FRIDAY_CURSOR_NARRATION", True)
    silence_requires_narration = _env_bool("FRIDAY_SILENCE_REQUIRES_NARRATION", False)

    if not SPEAK_SCRIPT.is_file():
        log.error("friday-speak.py missing at %s", SPEAK_SCRIPT)
        sys.exit(1)

    watch_started = time.time()
    last_nudge_local = 0.0
    log.info(
        "ECHO (Director of Presence) online — idle=%ds rearm=%ds poll=%ds cursor_narration=%s "
        "silence_requires_narration=%s",
        idle_sec,
        rearm_sec,
        poll_sec,
        narration_on,
        silence_requires_narration,
    )

    if silence_requires_narration and not narration_on:
        log.info("FRIDAY_SILENCE_REQUIRES_NARRATION on and FRIDAY_CURSOR_NARRATION off — no idle nudges")

    while True:
        time.sleep(poll_sec)

        if silence_requires_narration and not narration_on:
            continue

        if defer_cursor and should_defer_ambient_for_cursor():
            continue

        if _tts_active_file() or _play_running() or _redis_tts_lock_held():
            continue

        r = _redis()
        rearm_active = False
        if r and r is not False:
            try:
                rearm_active = bool(r.exists(_REDIS_REARM))
            except Exception:
                rearm_active = False
        if not rearm_active and (time.time() - last_nudge_local) < rearm_sec:
            rearm_active = True
        if rearm_active:
            continue

        base = _last_activity_ts(r, watch_started)
        idle = time.time() - base
        if idle < idle_sec:
            continue

        line = _pick_line()
        env = os.environ.copy()
        env.update(friday_speak_env_for_persona("echo", priority=True))
        try:
            proc = subprocess.Popen(
                [sys.executable, str(SPEAK_SCRIPT), line],
                cwd=str(ROOT),
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except OSError as e:
            log.warning("Could not spawn friday-speak: %s", e)
            continue

        last_nudge_local = time.time()
        if proc.pid and r and r is not False:
            try:
                r.set(_REDIS_REARM, "1", ex=rearm_sec)
            except Exception:
                pass
        log.info("Idle %.0fs — nudge spoken (pid=%s)", idle, proc.pid)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log.info("Stopped.")
