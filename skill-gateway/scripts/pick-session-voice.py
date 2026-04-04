#!/usr/bin/env python3
"""
pick-session-voice.py — assign one random TTS voice per Cursor chat session.

How it works:
  1. Finds the most-recently-modified chat UUID from the Cursor agent-transcripts folder.
  2. Compares it to the stored chat ID in .session-voice.json (repo root).
  3. If it's a NEW chat → pick a random voice from VOICE_POOL, persist it,
     then speak a welcome greeting in that new voice.
  4. If it's the SAME chat → reuse the existing voice silently.
  5. Prints the chosen voice name to stdout.

Usage:
  python pick-session-voice.py          # prints voice name, e.g. en-AU-WilliamNeural
"""

import json
import os
import random
import re
import subprocess
import sys
from pathlib import Path

# ── Voice pool ─────────────────────────────────────────────────────────────────
# Curated set of high-quality Edge TTS voices: male + female, various accents.
VOICE_POOL = [
    # British
    "en-GB-RyanNeural",        # British male — default Jarvis feel
    "en-GB-ThomasNeural",      # British male, deeper
    "en-GB-SoniaNeural",       # British female
    "en-GB-LibbyNeural",       # British female, warm
    # American
    "en-US-GuyNeural",         # US male
    "en-US-EricNeural",        # US male, calm
    "en-US-JennyNeural",       # US female, professional
    "en-US-AriaNeural",        # US female, expressive
    # Australian
    "en-AU-WilliamNeural",     # Australian male
    "en-AU-NatashaNeural",     # Australian female
    # Irish / Scottish
    "en-IE-ConnorNeural",      # Irish male
    "en-GB-MaisieNeural",      # Scottish-adjacent, young female
    # Canadian
    "en-CA-LiamNeural",        # Canadian male
    "en-CA-ClaraNeural",       # Canadian female
    # Indian English
    "en-IN-PrabhatNeural",     # Indian English male
    "en-IN-NeerjaExpressiveNeural",  # Indian English female, expressive
]

# ── Paths ──────────────────────────────────────────────────────────────────────
_REPO_ROOT        = Path(__file__).resolve().parent.parent.parent
_STATE_FILE       = _REPO_ROOT / ".session-voice.json"
_SPEAK_SCRIPT     = Path(__file__).resolve().parent / "friday-speak.py"
_TRANSCRIPTS_ROOT = Path(os.environ.get(
    "CURSOR_TRANSCRIPTS_DIR",
    r"C:\Users\rajut\.cursor\projects\d-code-openclaw\agent-transcripts"
))

# ── Human-readable voice labels ────────────────────────────────────────────────
_LOCALE_LABELS = {
    "en-GB": "British",
    "en-US": "American",
    "en-AU": "Australian",
    "en-IE": "Irish",
    "en-CA": "Canadian",
    "en-IN": "Indian English",
}

def _friendly_voice_name(voice: str) -> str:
    """'en-AU-WilliamNeural' → 'William, Australian Neural voice'"""
    parts  = voice.split("-", 2)            # ['en', 'AU', 'WilliamNeural']
    locale = "-".join(parts[:2])            # 'en-AU'
    label  = _LOCALE_LABELS.get(locale, locale)
    name   = parts[2] if len(parts) > 2 else voice
    name   = name.replace("Neural", "").strip()
    # Insert space before each capital that follows a lowercase letter
    name   = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", name)
    return f"{name}, {label}"


def _latest_chat_uuid() -> str | None:
    """Return the UUID of the most recently modified chat folder."""
    try:
        folders = [p for p in _TRANSCRIPTS_ROOT.iterdir() if p.is_dir()]
        if not folders:
            return None
        latest = max(folders, key=lambda p: p.stat().st_mtime)
        return latest.name
    except Exception:
        return None


def _load_state() -> dict:
    try:
        return json.loads(_STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_state(state: dict) -> None:
    try:
        _STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")
    except Exception:
        pass


def _speak_welcome(voice: str) -> None:
    """Fire-and-forget: speak the session-start greeting in the new voice."""
    friendly = _friendly_voice_name(voice)
    greeting = (
        f"Friday online, sir. Your session voice today is {friendly}. "
        f"All responses this chat will use this voice."
    )
    try:
        subprocess.Popen(
            [sys.executable, str(_SPEAK_SCRIPT), greeting],
            cwd=str(_REPO_ROOT),
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception:
        pass


def pick_voice() -> str:
    chat_id   = _latest_chat_uuid()
    state     = _load_state()
    is_new    = not (chat_id and state.get("chat_id") == chat_id and state.get("voice"))

    if not is_new:
        # Same chat — return sticky voice silently
        return state["voice"]

    # New chat (or no state yet) — pick a fresh random voice, avoid repeating last
    last_voice = state.get("voice", "")
    pool       = [v for v in VOICE_POOL if v != last_voice] or VOICE_POOL
    new_voice  = random.choice(pool)

    # Persist BEFORE spawning the welcome (friday-speak.py reads .session-voice.json at startup)
    _save_state({"chat_id": chat_id, "voice": new_voice})
    _speak_welcome(new_voice)
    return new_voice


if __name__ == "__main__":
    print(pick_voice(), flush=True)
