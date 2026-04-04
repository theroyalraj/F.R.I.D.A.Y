"""
Rate/pitch for first-contact TTS only (session welcome, pc-agent boot, listen daemon start).

Default: random within env bounds — biased slightly quick/brighter (≈1.075× tier).
Set FRIDAY_TTS_JARVIS_RANDOM=false to use fixed FRIDAY_TTS_JARVIS_RATE / FRIDAY_TTS_JARVIS_PITCH.
"""

from __future__ import annotations

import os
import random


def _env_bool(name: str, default: bool) -> bool:
    v = os.environ.get(name, "").strip().lower()
    if not v:
        return default
    return v not in ("0", "false", "no", "off")


def _parse_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)).strip().split("#")[0])
    except ValueError:
        return default


def sample_greeting_rate_pitch() -> tuple[str, str]:
    if not _env_bool("FRIDAY_TTS_JARVIS_RANDOM", True):
        return (
            os.environ.get("FRIDAY_TTS_JARVIS_RATE", "+7.5%"),
            os.environ.get("FRIDAY_TTS_JARVIS_PITCH", "+2Hz"),
        )
    r_lo = _parse_int("FRIDAY_TTS_JARVIS_RATE_MIN_PCT", 3)
    r_hi = _parse_int("FRIDAY_TTS_JARVIS_RATE_MAX_PCT", 12)
    p_lo = _parse_int("FRIDAY_TTS_JARVIS_PITCH_MIN_HZ", 0)
    p_hi = _parse_int("FRIDAY_TTS_JARVIS_PITCH_MAX_HZ", 10)
    r_lo, r_hi = min(r_lo, r_hi), max(r_lo, r_hi)
    p_lo, p_hi = min(p_lo, p_hi), max(p_lo, p_hi)
    rp = random.randint(r_lo, r_hi)
    ph = random.randint(p_lo, p_hi)
    return f"{rp:+d}%", f"{ph:+d}Hz"
