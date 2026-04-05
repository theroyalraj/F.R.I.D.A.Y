"""Music autoplay: openclaw:music:autoplay in Redis + temp file + FRIDAY_AUTOPLAY (matches lib/musicAutoplayPrefs.js)."""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

REDIS_KEY = "openclaw:music:autoplay"
AUTOPLAY_FILE = Path(tempfile.gettempdir()) / "openclaw-music-autoplay.txt"


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


def _env_default() -> bool:
    v = os.environ.get("FRIDAY_AUTOPLAY", "true").lower().split("#")[0].strip()
    return v not in ("false", "0", "off", "no")


def _parse(raw: object) -> bool | None:
    if raw is None:
        return None
    t = str(raw).strip().lower()
    if t in ("1", "true", "yes", "on"):
        return True
    if t in ("0", "false", "no", "off"):
        return False
    return None


def read_music_autoplay_enabled() -> bool:
    base = _env_default()
    r = _redis_client()
    if r:
        try:
            got = r.get(REDIS_KEY)
            if got is not None and str(got).strip() != "":
                p = _parse(got)
                if p is not None:
                    return p
        except Exception:
            pass
    try:
        if AUTOPLAY_FILE.exists():
            p = _parse(AUTOPLAY_FILE.read_text(encoding="ascii", errors="replace").strip())
            if p is not None:
                return p
    except OSError:
        pass
    return base


def write_music_autoplay_enabled(on: bool) -> bool:
    val = "1" if on else "0"
    ok = False
    try:
        AUTOPLAY_FILE.write_text(val, encoding="ascii")
        ok = True
    except OSError:
        pass
    r = _redis_client()
    if r:
        try:
            r.set(REDIS_KEY, val)
            ok = True
        except Exception:
            pass
    return ok
