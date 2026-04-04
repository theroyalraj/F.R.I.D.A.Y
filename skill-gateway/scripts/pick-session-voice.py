#!/usr/bin/env python3
"""
pick-session-voice.py — sticky Edge-TTS voice for Cursor chat / Task subagents.

How it works:
  1. Finds the most-recently-modified chat UUID from the Cursor agent-transcripts folder.
  2. Compares it to the stored chat ID in .session-voice.json (repo root).
  3. If it's a NEW chat → pick a voice, persist it, then speak a short welcome (main only).
  4. If it's the SAME chat → reuse the existing voice silently.
  5. Prints the chosen voice name to stdout.

Voice policy (main Cursor chat — default):
  • Uses FRIDAY_TTS_VOICE from the environment (Jarvis / Ryan by default). Same voice every time.

Optional party mode:
  • Set FRIDAY_TTS_MAIN_RANDOM_VOICES=true to restore random adult voices + rare Ana roll.

Subagents (Task tool):
  Run:  FRIDAY_TTS_SESSION=subagent  python pick-session-voice.py --subagent
  Uses a separate sticky subagent_voice from a teen / young-adult pool — never Ana.

Usage:
  python pick-session-voice.py              # main Cursor chat
  python pick-session-voice.py --subagent   # Task subagent (set FRIDAY_TTS_SESSION too)
"""

import argparse
import json
import os
import random
import re
import subprocess
import sys
from pathlib import Path

from friday_greeting_delivery import sample_greeting_rate_pitch

# ── Voice pools ────────────────────────────────────────────────────────────────
# Child: Edge Ana — toddler / small-child timbre (rare in main chat only).
CHILD_VOICE = "en-US-AnaNeural"
CHILD_ROLL_MAX = 25

# Teen / young-adult — for subagents only (sounds older than Ana).
TEEN_POOL = [
    "en-GB-MaisieNeural",   # young female, Scottish-adjacent
    "en-US-AvaNeural",
    "en-IE-EmilyNeural",
    "en-US-MichelleNeural",
    "en-NZ-MollyNeural",
    "en-US-SteffanNeural",
    "en-NZ-MitchellNeural",  # young male, balances pool vs Ana-tier child
]

# Main chat adults — balanced Jarvis / FRIDAY style; excludes Ana and teen-only voices.
ADULT_POOL = [
    "en-GB-RyanNeural",
    "en-GB-ThomasNeural",
    "en-GB-SoniaNeural",
    "en-GB-LibbyNeural",
    "en-US-GuyNeural",
    "en-US-EricNeural",
    "en-US-JennyNeural",
    "en-US-AriaNeural",
    "en-AU-WilliamNeural",
    "en-AU-NatashaNeural",
    "en-IE-ConnorNeural",
    "en-CA-LiamNeural",
    "en-CA-ClaraNeural",
    "en-IN-PrabhatNeural",
    "en-IN-NeerjaExpressiveNeural",
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
    "en-NZ": "New Zealand",
}


def _friendly_voice_name(voice: str) -> str:
    """'en-AU-WilliamNeural' → 'William, Australian Neural voice'"""
    parts  = voice.split("-", 2)
    locale = "-".join(parts[:2])
    label  = _LOCALE_LABELS.get(locale, locale)
    name   = parts[2] if len(parts) > 2 else voice
    name   = name.replace("Neural", "").strip()
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


def _user_display_name() -> str:
    return (os.environ.get("FRIDAY_USER_NAME", "Raj") or "Raj").strip() or "Raj"


def _main_random_voices_enabled() -> bool:
    v = os.environ.get("FRIDAY_TTS_MAIN_RANDOM_VOICES", "").strip().lower()
    return v in ("1", "true", "yes", "on")


def _pick_main_chat_voice(state: dict) -> str:
    if _main_random_voices_enabled():
        last_voice = state.get("voice", "")
        if random.randint(1, CHILD_ROLL_MAX) == 1:
            return CHILD_VOICE
        pool = [v for v in ADULT_POOL if v != last_voice] or ADULT_POOL
        return random.choice(pool)
    return os.environ.get("FRIDAY_TTS_VOICE", "en-GB-RyanNeural").strip() or "en-GB-RyanNeural"


def _jarvis_greeting_env(voice: str) -> dict:
    """First-contact line only: random or fixed rate/pitch (see friday_greeting_delivery)."""
    rate, pitch = sample_greeting_rate_pitch()
    return {
        **os.environ,
        "FRIDAY_TTS_VOICE": voice,
        "FRIDAY_TTS_RATE": rate,
        "FRIDAY_TTS_PITCH": pitch,
    }


def _speak_welcome(voice: str) -> None:
    """Fire-and-forget: speak the session-start greeting in the new voice."""
    who = _user_display_name()
    if _main_random_voices_enabled():
        friendly = _friendly_voice_name(voice)
        greeting = (
            f"Friday online, {who}. Your session voice today is {friendly}. "
            f"All responses this chat will use this voice."
        )
    else:
        greeting = (
            f"Friday online, {who}. Main assistant voice is active for this chat. "
            "Ambient and subagents may use other voices."
        )
    try:
        subprocess.Popen(
            [sys.executable, str(_SPEAK_SCRIPT), greeting],
            cwd=str(_REPO_ROOT),
            env=_jarvis_greeting_env(voice),
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception:
        pass


def pick_voice(*, subagent: bool = False) -> str:
    chat_id = _latest_chat_uuid()
    state   = _load_state()

    if subagent:
        is_new = not (
            chat_id
            and state.get("subagent_chat_id") == chat_id
            and state.get("subagent_voice")
        )
        if not is_new:
            return state["subagent_voice"]

        last_voice = state.get("subagent_voice", "")
        pool       = [v for v in TEEN_POOL if v != last_voice] or TEEN_POOL
        new_voice  = random.choice(pool)
        state["subagent_chat_id"] = chat_id
        state["subagent_voice"]   = new_voice
        _save_state(state)
        return new_voice

    # ── Main chat ─────────────────────────────────────────────────────────────
    is_new = not (chat_id and state.get("chat_id") == chat_id and state.get("voice"))
    if not is_new:
        return state["voice"]

    new_voice = _pick_main_chat_voice(state)

    state["chat_id"] = chat_id
    state["voice"]   = new_voice
    _save_state(state)
    _speak_welcome(new_voice)
    return new_voice


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Pick sticky Edge-TTS voice for Cursor session.")
    ap.add_argument(
        "--subagent",
        action="store_true",
        help="Use teen / young-adult pool only; sticky per subagent transcript id.",
    )
    args = ap.parse_args()
    print(pick_voice(subagent=args.subagent), flush=True)
