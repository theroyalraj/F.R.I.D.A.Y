"""
Pick Edge TTS voice for Hindi / Hinglish content so British or US voices do not butcher it.

- Devanagari script → Hindi neural (default hi-IN-SwaraNeural).
- Roman Hinglish (conservative keyword hints) → Indian English neural (default en-IN-NeerjaExpressiveNeural).

Used by friday-ambient, friday-listen, and any caller that sets FRIDAY_TTS_USE_SESSION_STICKY_VOICE=false
when applying the override.
"""

from __future__ import annotations

import os
import re

# Devanagari block (Hindi, Marathi, etc.)
_DEVANAGARI_RE = re.compile(r"[\u0900-\u097F]")

# Roman Hinglish — high-specificity phrases / words (avoid common English like "the", "are")
_HINGLISH_ROMAN_RE = re.compile(
    r"\b(?:"
    r"yaar|bhai|accha|acha|nahin|nahi|kyun|kyon|matlab|arre|arey|dekho|sunno|"
    r"doston|bilkul|zaroor|theek\s+hai|ho\s+gaya|kar\s+diya|kya\s+baat|bahut\s+hi|"
    r"abhi\s+ke|phir\s+se|aisa\s+hi|kitna\s+zabardast|mere\s+bhai|bas\s+yaar|"
    r"hum\s+to|aap\s+ko|yeh\s+to|kya\s+hai|mat\s+karo|mat\s+kar|"
    r"chal\s+na|ho\s+raha|kar\s+rahe|hai\s+na|nahi\s+na"
    r")\b",
    re.IGNORECASE,
)

_OFF = frozenset({"", "0", "false", "no", "off", "default"})


def _env_or(name: str, default: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v or v.lower() in _OFF:
        return default
    return v


def edge_voice_override_for_text(text: str) -> str | None:
    """
    Return an Edge short voice name when text is clearly Indic / Hinglish.
    None means caller should use FRIDAY_TTS_VOICE / ambient default / session voice.
    """
    if not text or not str(text).strip():
        return None
    s = str(text)

    if _DEVANAGARI_RE.search(s):
        v = os.environ.get("FRIDAY_TTS_DEVANAGARI_VOICE", "").strip()
        if v and v.lower() not in _OFF:
            return v
        # Legacy: ambient cricket env used to mean "Hindi TTS"
        leg = os.environ.get("FRIDAY_AMBIENT_CRICKET_VOICE", "").strip()
        if leg and leg.lower() not in _OFF:
            return leg
        return "hi-IN-SwaraNeural"

    if _HINGLISH_ROMAN_RE.search(s):
        return _env_or("FRIDAY_TTS_HINGLISH_VOICE", "en-IN-NeerjaExpressiveNeural")

    return None
