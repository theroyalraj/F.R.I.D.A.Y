"""
Distributed + local guard so friday-play music is not stopped by VAD or TTS,
unless the caller sets FRIDAY_TTS_INTERRUPT_MUSIC=ui (browser / UI server path).

Redis key: friday:music:active (TTL lease set by friday-play.py).
Falls back to friday-play.pid + process liveness and friday-play-session.start age.
"""

from __future__ import annotations

import os
import platform
import tempfile
import time
from pathlib import Path

REDIS_KEY = "friday:music:active"

PID_FILE = Path(tempfile.gettempdir()) / "friday-play.pid"
SESSION_START_FILE = Path(tempfile.gettempdir()) / "friday-play-session.start"


def _redis_url() -> str:
    return os.environ.get("FRIDAY_AMBIENT_REDIS_URL", "").strip() or "redis://127.0.0.1:6379"


def set_music_active_ttl(ttl_sec: int) -> None:
    """Mark local friday-play music as active in Redis (best-effort)."""
    try:
        import redis  # type: ignore

        r = redis.Redis.from_url(_redis_url(), decode_responses=True)
        r.setex(REDIS_KEY, max(30, int(ttl_sec)), "1")
    except Exception:
        pass


def clear_music_active() -> None:
    try:
        import redis  # type: ignore

        r = redis.Redis.from_url(_redis_url(), decode_responses=True)
        r.delete(REDIS_KEY)
    except Exception:
        pass


def redis_music_active() -> bool:
    try:
        import redis  # type: ignore

        r = redis.Redis.from_url(_redis_url(), decode_responses=True)
        v = r.get(REDIS_KEY)
        return (v or "") in ("1", "true", "yes")
    except Exception:
        return False


def _pid_alive_win(pid: int) -> bool:
    try:
        import ctypes

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        k = ctypes.windll.kernel32
        h = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not h:
            return False
        k.CloseHandle(h)
        return True
    except Exception:
        return True


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if platform.system() == "Windows":
        return _pid_alive_win(pid)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def friday_play_ffplay_pid() -> int | None:
    if not PID_FILE.exists():
        return None
    try:
        return int(PID_FILE.read_text(encoding="utf-8").strip())
    except Exception:
        return None


def local_friday_play_music_seems_active() -> bool:
    pid = friday_play_ffplay_pid()
    if pid is None:
        return False
    return pid_alive(pid)


def _listen_music_protect_sec() -> float:
    try:
        ps = int(os.environ.get("FRIDAY_PLAY_SECONDS", "45").split("#")[0].strip())
    except ValueError:
        ps = 45
    raw = os.environ.get("LISTEN_MUSIC_PROTECT_SEC", "").strip()
    if raw:
        try:
            return float(raw.split("#")[0].strip())
        except ValueError:
            pass
    return float(ps + 15)


def friday_play_music_hold_active() -> bool:
    """
    True while friday-play output should not be cut by listen VAD or non-UI TTS.
    """
    if redis_music_active():
        return True
    if local_friday_play_music_seems_active():
        return True
    if SESSION_START_FILE.exists():
        try:
            t0 = float(SESSION_START_FILE.read_text(encoding="ascii").strip())
            protect = _listen_music_protect_sec()
            if protect > 0 and (time.time() - t0) < protect:
                return True
        except (ValueError, OSError):
            pass
    return False


def may_interrupt_music_from_tts() -> bool:
    """Only these env values allow friday-speak to fade/kill friday-play music."""
    v = os.environ.get("FRIDAY_TTS_INTERRUPT_MUSIC", "").strip().lower()
    return v in ("ui", "1", "true", "yes", "on")


def music_redis_ttl_for_play_seconds(play_sec: float | None) -> int:
    """Upper bound TTL for Redis; actual key deleted when playback ends."""
    if play_sec is not None and play_sec > 0:
        return int(min(7200, play_sec + 180))
    return 7200
