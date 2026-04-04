#!/usr/bin/env python3
"""
pick-session-voice.py — assign one random TTS voice per Cursor chat session.

How it works:
  1. Finds the most-recently-modified chat UUID from the Cursor agent-transcripts folder.
  2. Compares it to the stored chat ID in .session-voice.json (repo root).
  3. If it's a NEW chat → pick a random voice from VOICE_POOL, persist it.
  4. If it's the SAME chat → reuse the existing voice.
  5. Prints the chosen voice name to stdout (so callers can read it).

Usage:
  python pick-session-voice.py          # prints voice name, e.g. en-AU-WilliamNeural
"""

import json
import os
import random
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
_TRANSCRIPTS_ROOT = Path(os.environ.get(
    "CURSOR_TRANSCRIPTS_DIR",
    r"C:\Users\rajut\.cursor\projects\d-code-openclaw\agent-transcripts"
))


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


def pick_voice() -> str:
    chat_id = _latest_chat_uuid()
    state   = _load_state()

    if chat_id and state.get("chat_id") == chat_id and state.get("voice"):
        # Same chat — return the sticky voice without changing anything
        return state["voice"]

    # New chat (or no state yet) — pick a fresh random voice
    # Avoid repeating the last voice if there's a pool big enough
    last_voice = state.get("voice", "")
    pool = [v for v in VOICE_POOL if v != last_voice] or VOICE_POOL
    new_voice = random.choice(pool)

    _save_state({"chat_id": chat_id, "voice": new_voice})
    return new_voice


if __name__ == "__main__":
    print(pick_voice(), flush=True)
