"""Shared FRIDAY_TTS_LOCK_TTL_SEC for friday-speak Redis/file lock and waiter stale thresholds."""
from __future__ import annotations

import os


def tts_lock_ttl_sec() -> int:
    """Bounds: one minute to one hour. Default ten minutes — long briefings exceed two minutes."""
    raw = os.environ.get("FRIDAY_TTS_LOCK_TTL_SEC", "600")
    try:
        v = int(str(raw).split("#", 1)[0].strip() or "600")
    except ValueError:
        v = 600
    return max(60, min(3600, v))
