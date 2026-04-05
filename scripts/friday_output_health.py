"""
Default Windows playback health for Sentinel (cursor-reply-watch): mute + audio-disabled.

Publishes JSON to Redis key friday:voice:watcher:output_health (same shape as pc-agent /voice/ping).
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

_SG = Path(__file__).resolve().parent.parent / "skill-gateway" / "scripts"
if str(_SG) not in sys.path:
    sys.path.insert(0, str(_SG))

from friday_platform_audio import get_default_output_health  # noqa: E402

WATCHER_OUTPUT_HEALTH_KEY = "friday:voice:watcher:output_health"

_HEALTH_CACHE_SEC = 1.5
_health_cache: tuple[float, dict] | None = None


def _env_bool(name: str, default: bool) -> bool:
    v = os.environ.get(name, "").strip().lower()
    if not v:
        return default
    if v in ("0", "false", "no", "off"):
        return False
    if v in ("1", "true", "yes", "on"):
        return True
    return default


def snapshot_watcher_output_health() -> dict:
    h = get_default_output_health()
    h["checkedAtMs"] = int(__import__("time").time() * 1000)
    return h


def _fresh_health_for_watcher() -> dict:
    """Sample MMDevice at most every ~1.5s — thinking TTS can call this many times per second."""
    global _health_cache
    import time as _t

    now = _t.time()
    if _health_cache is not None and now - _health_cache[0] < _HEALTH_CACHE_SEC:
        return _health_cache[1]
    h = snapshot_watcher_output_health()
    publish_watcher_output_health_redis(h)
    _health_cache = (now, h)
    return h


def publish_watcher_output_health_redis(payload: dict) -> None:
    try:
        url = (
            os.environ.get("OPENCLAW_REDIS_URL", "").strip()
            or os.environ.get("FRIDAY_AMBIENT_REDIS_URL", "").strip()
            or "redis://127.0.0.1:6379"
        )
        import redis as _redis  # type: ignore

        r = _redis.Redis.from_url(url, decode_responses=True)
        body = json.dumps(payload, separators=(",", ":"))
        r.set(WATCHER_OUTPUT_HEALTH_KEY, body, ex=600)
    except Exception:
        pass


def watcher_should_skip_tts() -> tuple[bool, str]:
    """
    Returns (skip, reason). Pushes latest health to Redis for UI / other consumers.
    """
    h = _fresh_health_for_watcher()

    if _env_bool("FRIDAY_CURSOR_WATCHER_SKIP_IF_OUTPUT_DISABLED", True) and h.get("audioDisabled"):
        return True, "default output disabled or unavailable"

    if _env_bool("FRIDAY_CURSOR_WATCHER_SKIP_IF_MUTED", False) and h.get("muted"):
        return True, "default output is muted"

    return False, ""
