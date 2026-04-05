"""Shared music playback volume 0–100: Redis openclaw:music:play_volume + temp file fallback."""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

REDIS_KEY = "openclaw:music:play_volume"
VOL_FILE = Path(tempfile.gettempdir()) / "openclaw-music-play-volume.txt"


def _redis_client():
    try:
        import redis

        url = (
            os.environ.get("OPENCLAW_REDIS_URL", "").strip()
            or os.environ.get("FRIDAY_AMBIENT_REDIS_URL", "").strip()
            or "redis://127.0.0.1:6379"
        )
        r = redis.Redis.from_url(url, decode_responses=True, socket_timeout=2)
        r.ping()
        return r
    except Exception:
        return None


def _clamp_pct(v: object, default: int) -> int:
    try:
        n = int(float(str(v).split("#", 1)[0].strip()))
    except (TypeError, ValueError):
        n = default
    return max(0, min(100, n))


def read_music_play_volume_percent() -> int:
    """Prefer Redis, then temp file, then FRIDAY_PLAY_VOLUME (default 20)."""
    raw_env = os.environ.get("FRIDAY_PLAY_VOLUME", "20")
    base = _clamp_pct(raw_env, 20)
    r = _redis_client()
    if r:
        try:
            got = r.get(REDIS_KEY)
            if got is not None and str(got).strip() != "":
                return _clamp_pct(got, base)
        except Exception:
            pass
    try:
        if VOL_FILE.exists():
            t = VOL_FILE.read_text(encoding="ascii", errors="replace").strip()
            if t:
                return _clamp_pct(t, base)
    except OSError:
        pass
    return base


def write_music_play_volume_percent(pct: int) -> bool:
    """Persist volume; returns True if at least one backend succeeded."""
    pct = _clamp_pct(pct, 20)
    ok = False
    try:
        VOL_FILE.write_text(str(pct), encoding="ascii")
        ok = True
    except OSError:
        pass
    r = _redis_client()
    if r:
        try:
            r.set(REDIS_KEY, str(pct))
            ok = True
        except Exception:
            pass
    return ok
