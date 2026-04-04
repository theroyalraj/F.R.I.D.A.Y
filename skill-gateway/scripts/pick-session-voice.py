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
  • Set FRIDAY_TTS_SESSION_USE_ENV_VOICE_ONLY=true to skip Hindi/Hinglish and pools — always
    FRIDAY_TTS_VOICE from .env (fallback if blocked).

Subagents (Task tool):
  Run:  FRIDAY_TTS_SESSION=subagent  python pick-session-voice.py --subagent
  Uses a GLOBAL sticky subagent_voice from the adult pool — same voice across ALL chats, never Ana.

Cursor-reply TTS (cursor-reply-watch.py — distinct from main + subagent):
  python pick-session-voice.py --cursor-reply
  Pick stores cursor_reply_voice + cursor_reply_chat_id; speak with FRIDAY_TTS_SESSION=cursor-reply.

Usage:
  python pick-session-voice.py                 # main Cursor chat
  python pick-session-voice.py --subagent     # Task subagent (set FRIDAY_TTS_SESSION too)
  python pick-session-voice.py --cursor-reply # third voice for transcript narration

Automation (e.g. cursor-reply-watch) can set FRIDAY_PICK_SESSION_NO_WELCOME=true when invoking this script
so a new main session updates chat_id and voice without the spoken welcome.
"""

import argparse
import datetime
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

# Subagent pool — adult voices only; distinct enough from the main pool to be recognisable
SUBAGENT_POOL = [v for v in [
    "en-US-ChristopherNeural",          # deep, confident American male
    "en-US-GuyNeural",                  # clear American male anchor-style
    "en-US-EricNeural",                 # calm, natural American male
    "en-GB-SoniaNeural",                # polished British female
    "en-IE-ConnorNeural",               # warm Irish male
    "en-US-AndrewMultilingualNeural",   # warm American male
    "en-US-BrianMultilingualNeural",    # smooth American male
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


def _redis_touch_voice_context(context: str, voice: str) -> None:
    """Write/update a voice context entry in Redis (fire-and-forget, never raises)."""
    try:
        url = (
            os.environ.get("OPENCLAW_REDIS_URL", "").strip()
            or os.environ.get("FRIDAY_AMBIENT_REDIS_URL", "").strip()
            or "redis://127.0.0.1:6379"
        )
        import redis as _redis  # type: ignore
        r = _redis.Redis.from_url(url, decode_responses=True)
        now = datetime.datetime.utcnow().isoformat() + "Z"
        key = f"friday:voice:context:{context}"
        existing = r.hget(key, "voice")
        if existing != voice:
            # Voice changed (or first write) — reset set_at too
            r.hset(key, mapping={"voice": voice, "set_at": now, "last_used": now, "status": "active"})
        else:
            # Same voice — just update last_used
            r.hset(key, mapping={"last_used": now, "status": "active"})
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


def _session_use_env_voice_only() -> bool:
    """When true, new Cursor chats use only FRIDAY_TTS_VOICE (no random Hindi/Hinglish or adult pool)."""
    v = os.environ.get("FRIDAY_TTS_SESSION_USE_ENV_VOICE_ONLY", "").strip().lower()
    return v in ("1", "true", "yes", "on")


def _pick_main_chat_voice(state: dict) -> str:
    last_voice = state.get("voice", "")
    if _session_use_env_voice_only():
        preferred = _env_main_voice_raw()
        if preferred not in _BLOCKED_VOICES:
            return preferred
        if ADULT_POOL:
            return _pick_from_pool_excluding(ADULT_POOL, last_voice)
        return "en-US-EmmaMultilingualNeural"

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
    if os.environ.get("FRIDAY_PICK_SESSION_NO_WELCOME", "").strip().lower() in (
        "1", "true", "yes", "on",
    ):
        return
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


def _env_cursor_reply_voice_override() -> str:
    return os.environ.get("FRIDAY_CURSOR_REPLY_VOICE", "").strip()


def pick_voice(*, subagent: bool = False, cursor_reply: bool = False) -> str:
    chat_id = _latest_chat_uuid()
    state   = _load_state()

    if cursor_reply:
        # Anchor to main Composer chat id (authoritative); fall back to latest folder if unset.
        anchor = state.get("chat_id") or chat_id
        override = _env_cursor_reply_voice_override()
        if override:
            if override in _BLOCKED_VOICES:
                override = ""
        if override:
            cur = state.get("cursor_reply_voice", "")
            if state.get("cursor_reply_chat_id") == anchor and cur == override and cur not in _BLOCKED_VOICES:
                _redis_touch_voice_context("cursor:reply", cur)
                return cur
            state["cursor_reply_chat_id"] = anchor
            state["cursor_reply_voice"] = override
            _save_state(state)
            _redis_touch_voice_context("cursor:reply", override)
            return override

        main_v = state.get("voice", "")
        sub_v = state.get("subagent_voice", "")
        pool = [v for v in ADULT_POOL if v not in _BLOCKED_VOICES and v != main_v and v != sub_v]
        if not pool:
            pool = [v for v in ADULT_POOL if v not in _BLOCKED_VOICES] or ["en-US-EmmaMultilingualNeural"]

        last = state.get("cursor_reply_voice", "")
        if (
            anchor
            and state.get("cursor_reply_chat_id") == anchor
            and last
            and last not in _BLOCKED_VOICES
        ):
            _redis_touch_voice_context("cursor:reply", last)
            return last

        choices = [v for v in pool if v != last] or pool
        new_voice = random.choice(choices)
        state["cursor_reply_chat_id"] = anchor
        state["cursor_reply_voice"] = new_voice
        _save_state(state)
        _redis_touch_voice_context("cursor:reply", new_voice)
        return new_voice

    if subagent:
        # Subagent voice is GLOBAL — same adult voice across all chats until blocked or reset.
        cur = state.get("subagent_voice", "")
        if cur and cur not in _BLOCKED_VOICES:
            _redis_touch_voice_context("cursor:subagent", cur)
            return cur
        # Not set yet, or blocked — pick a fresh adult voice.
        last_voice = cur
        pool       = [v for v in SUBAGENT_POOL if v not in _BLOCKED_VOICES and v != last_voice] or SUBAGENT_POOL
        new_voice  = random.choice(pool)
        state["subagent_voice"] = new_voice
        _save_state(state)
        _redis_touch_voice_context("cursor:subagent", new_voice)
        return new_voice

    # ── Main chat ─────────────────────────────────────────────────────────────
    is_new = not (chat_id and state.get("chat_id") == chat_id and state.get("voice"))
    if not is_new:
        cur = state.get("voice", "")
        if cur in _BLOCKED_VOICES:
            new_voice = _pick_main_chat_voice(state)
            state["voice"] = new_voice
            _save_state(state)
            _redis_touch_voice_context("cursor:main", new_voice)
            return new_voice
        _redis_touch_voice_context("cursor:main", cur)
        return cur

    new_voice = _pick_main_chat_voice(state)

    state["chat_id"] = chat_id
    state["voice"]   = new_voice
    _save_state(state)
    _redis_touch_voice_context("cursor:main", new_voice)
    _speak_welcome(new_voice)
    return new_voice


def check_voices() -> None:
    """Print current session voice assignments as a human-readable summary."""
    state = _load_state()
    chat_id = state.get("chat_id", "")
    lines = [
        "Session voice assignments:",
        f"  main       : {state.get('voice', '(not set)'):<42} chat: {chat_id[:12] + '...' if len(chat_id) > 12 else chat_id or '(none)'}",
        f"  subagent   : {state.get('subagent_voice', '(not set)'):<42} (global sticky)",
        f"  cursor-reply: {state.get('cursor_reply_voice', '(not set)'):<42} chat: {(state.get('cursor_reply_chat_id') or '(none)')[:12]}...",
    ]
    # Redis voice context (if available)
    try:
        url = (
            os.environ.get("OPENCLAW_REDIS_URL", "").strip()
            or os.environ.get("FRIDAY_AMBIENT_REDIS_URL", "").strip()
            or "redis://127.0.0.1:6379"
        )
        import redis as _redis
        r = _redis.Redis.from_url(url, decode_responses=True)
        for ctx in ("cursor:main", "cursor:subagent", "cursor:reply"):
            data = r.hgetall(f"friday:voice:context:{ctx}")
            if data:
                lines.append(f"  redis {ctx}: voice={data.get('voice','?')} last_used={data.get('last_used','?')} status={data.get('status','?')}")
    except Exception:
        lines.append("  (redis not available for context lookup)")
    # Blocked voices
    blocked = sorted(_BLOCKED_VOICES)
    if blocked:
        lines.append(f"  blocked    : {', '.join(blocked)}")
    print("\n".join(lines), flush=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Pick sticky Edge-TTS voice for Cursor session.")
    ap.add_argument(
        "--subagent",
        action="store_true",
        help="Use adult voice pool; global sticky subagent voice.",
    )
    ap.add_argument(
        "--cursor-reply",
        action="store_true",
        help="Pick third voice for cursor-reply-watch TTS (distinct from main and subagent when possible).",
    )
    ap.add_argument(
        "--check",
        action="store_true",
        help="Display current session voice assignments per session type (no pick).",
    )
    args = ap.parse_args()
    if args.check:
        check_voices()
        sys.exit(0)
    if args.subagent and args.cursor_reply:
        print("pick-session-voice: use only one of --subagent or --cursor-reply", file=sys.stderr)
        sys.exit(2)
    print(pick_voice(subagent=args.subagent, cursor_reply=args.cursor_reply), flush=True)
