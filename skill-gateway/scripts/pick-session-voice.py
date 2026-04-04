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
  • Uses FRIDAY_TTS_VOICE from the environment (Emma multilingual by default), except each new chat
    has a 50% chance to pick a Hindi or Hinglish-suited Edge voice instead (hi-IN or en-IN neural).

Optional party mode:
  • Set FRIDAY_TTS_MAIN_RANDOM_VOICES=true to restore random adult voices + rare Ana roll.
    The same 50% Hindi / Hinglish branch applies first; otherwise Ana roll + adult pool as before.

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

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_ENV_FILE = _REPO_ROOT / ".env"
if _ENV_FILE.exists():
    for line in _ENV_FILE.read_text(encoding="utf-8").splitlines():
        t = line.strip()
        if not t or t.startswith("#") or "=" not in t:
            continue
        k, _, rest = t.partition("=")
        k = k.strip()
        v = rest.split("#", 1)[0].strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v

# ── Voice pools ────────────────────────────────────────────────────────────────
# Child: Edge Ana — toddler / small-child timbre (rare in main chat only).
CHILD_VOICE = "en-US-AnaNeural"
CHILD_ROLL_MAX = 25

# Hindi + Indian English — good for Hindi or Roman Hinglish session TTS (matches indic_tts defaults).
HINDI_HINGLISH_POOL = [
    "hi-IN-SwaraNeural",
    "hi-IN-MadhurNeural",
    "en-IN-NeerjaExpressiveNeural",
    "en-IN-PrabhatNeural",
]

# Voices Raj never wants to hear — checked against all pools at pick time.
_BLOCKED_VOICES = {v.strip() for v in os.environ.get("FRIDAY_TTS_VOICE_BLOCK", "").split(",") if v.strip()}
_BLOCKED_VOICES |= {
    "en-AU-WilliamNeural",
    "en-AU-WilliamMultilingualNeural",
    "en-GB-RyanNeural",
    "en-GB-ThomasNeural",
}

# ── Curated whitelist — only the best-quality voices ─────────────────────────
# Tier 1: Multilingual Neural (newest, most natural, lowest robotic artefacts)
# Tier 2: Expressive/high-quality single-locale picks
# Excluded: older standard neural, flat-sounding, or user-blocked voices.
ADULT_POOL = [v for v in [
    # Tier 1 — Multilingual Neural (top quality)
    "en-US-AndrewMultilingualNeural",   # warm American male
    "en-US-BrianMultilingualNeural",    # smooth American male
    "en-US-EmmaMultilingualNeural",     # expressive American female
    "en-US-AvaMultilingualNeural",      # bright American female
    # Tier 2 — Expressive single-locale (consistently good)
    "en-US-ChristopherNeural",          # deep, confident American male
    "en-US-GuyNeural",                  # clear American male anchor-style
    "en-US-EricNeural",                 # calm, natural American male
    "en-GB-SoniaNeural",                # polished British female
    "en-IE-ConnorNeural",               # warm Irish male
] if v not in _BLOCKED_VOICES]

# Teen / subagent pool — also trimmed to best quality only
TEEN_POOL = [v for v in [
    "en-US-SteffanNeural",     # crisp young male
    "en-US-AvaNeural",         # bright young female
    "en-US-MichelleNeural",    # clear young female
    "en-GB-MaisieNeural",      # Scottish-adjacent young female
    "en-IE-EmilyNeural",       # warm Irish young female
] if v not in _BLOCKED_VOICES]

# ── Paths ──────────────────────────────────────────────────────────────────────
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
    "hi-IN": "Hindi",
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


def _pick_from_pool_excluding(pool: list[str], last_voice: str) -> str:
    choices = [v for v in pool if v != last_voice] or pool
    return random.choice(choices)


def _hindi_hinglish_candidates() -> list[str]:
    return [v for v in HINDI_HINGLISH_POOL if v not in _BLOCKED_VOICES]


def _env_main_voice_raw() -> str:
    return os.environ.get("FRIDAY_TTS_VOICE", "en-US-EmmaMultilingualNeural").strip() or "en-US-EmmaMultilingualNeural"


def _pick_main_chat_voice(state: dict) -> str:
    last_voice = state.get("voice", "")
    use_hindi_hinglish = random.random() < 0.5

    if use_hindi_hinglish:
        hh = _hindi_hinglish_candidates()
        if hh:
            return _pick_from_pool_excluding(hh, last_voice)
        # Blocked or empty — fall through to English paths

    if _main_random_voices_enabled():
        if CHILD_VOICE not in _BLOCKED_VOICES and random.randint(1, CHILD_ROLL_MAX) == 1:
            return CHILD_VOICE
        if ADULT_POOL:
            return _pick_from_pool_excluding(ADULT_POOL, last_voice)
        return _env_main_voice_raw()

    preferred = _env_main_voice_raw()
    if preferred not in _BLOCKED_VOICES:
        return preferred
    if ADULT_POOL:
        return _pick_from_pool_excluding(ADULT_POOL, last_voice)
    return "en-US-EmmaMultilingualNeural"


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
    elif voice in HINDI_HINGLISH_POOL:
        friendly = _friendly_voice_name(voice)
        greeting = (
            f"Friday online, {who}. Your session voice is {friendly}, "
            "suited to Hindi or Hinglish. All responses this chat will use this voice."
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
            cur = state.get("subagent_voice", "")
            if cur in _BLOCKED_VOICES:
                last_voice = state.get("subagent_voice", "")
                pool = [v for v in TEEN_POOL if v not in _BLOCKED_VOICES]
                pool = [v for v in pool if v != last_voice] or pool or TEEN_POOL
                new_voice = random.choice(pool)
                state["subagent_voice"] = new_voice
                _save_state(state)
                return new_voice
            return cur

        last_voice = state.get("subagent_voice", "")
        pool       = [v for v in TEEN_POOL if v != last_voice and v not in _BLOCKED_VOICES] or TEEN_POOL
        new_voice  = random.choice(pool)
        state["subagent_chat_id"] = chat_id
        state["subagent_voice"]   = new_voice
        _save_state(state)
        return new_voice

    # ── Main chat ─────────────────────────────────────────────────────────────
    is_new = not (chat_id and state.get("chat_id") == chat_id and state.get("voice"))
    if not is_new:
        cur = state.get("voice", "")
        if cur in _BLOCKED_VOICES:
            new_voice = _pick_main_chat_voice(state)
            state["voice"] = new_voice
            _save_state(state)
            return new_voice
        return cur

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
