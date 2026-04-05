"""
friday_vocal_asides.py — one-liners for TTS after yes/no flows (music, tracker check-in).

Keep lines speakable: no markdown, minimal symbols, Friday-ish wit.
"""

from __future__ import annotations

import os
import random


def _name() -> str:
    n = (os.environ.get("FRIDAY_USER_NAME", "") or "").strip()
    return n if n else "mate"


def pick_music_yes_ack() -> str:
    return random.choice(_MUSIC_YES)


def pick_music_no_ack() -> str:
    return random.choice(_MUSIC_NO)


def pick_music_scheduler_timeout() -> str:
    """When nobody answered the music offer in time — scheduler speaks this."""
    return random.choice(_MUSIC_TIMEOUT).format(name=_name())


def pick_tracker_user_said_no() -> str:
    return random.choice(_TRACKER_DECLINE).format(name=_name())


def pick_tracker_silent_default_no() -> str:
    """Heard nothing / STT failed and policy is default no — still say something human."""
    return random.choice(_TRACKER_SILENT_NO).format(name=_name())


# ── Pools ───────────────────────────────────────────────────────────────────────

_MUSIC_YES = (
    "On it.",
    "You got it — cue the noise.",
    "Playing now. Try not to chair-dance too hard.",
    "Done. Volume is your problem, not mine.",
    "Alright, let's make the neighbours wonder.",
)

_MUSIC_NO = (
    "Fine, I'll keep my impeccable taste to myself.",
    "Respect. Silence is underrated.",
    "Skipped. Your loss — that track slaps.",
    "Noted. I'll pretend you're being productive.",
    "Okay, no concert. The algorithm will remember this.",
    "Fair. I'll go touch grass on your behalf.",
    "Roger — saving your ears and my bandwidth.",
)

_MUSIC_TIMEOUT = (
    "No reply — I'll assume you're in the zone. Not playing anything.",
    "Radio silence from you means no gig. I'll leave the room quiet.",
    "You said nothing, so I'm calling that a no. Music stays in the vault.",
    "{name}, I asked nicely and got crickets — skipping the song.",
    "Timed out. If you were typing a thesis, fair enough — no music.",
    "That's a no by absence. I'm not offended. Much.",
)

_TRACKER_DECLINE = (
    "Cool, I'll keep the clipboard to myself. Go crush something.",
    "Okay, no pep talk. Your backlog sends its regards.",
    "Roger — briefing cancelled. Try not to forget you exist.",
    "Fine, I won't read the list. The guilt is organic and free-range.",
    "Skipped. I'll assume you've got this under control. Bold.",
)

_TRACKER_SILENT_NO = (
    "Didn't catch that — counting it as a no. I'll let you focus.",
    "Mic went shy, so I'm not reading the plan. Ping me when you want it.",
    "Silence means no briefing. I'm choosing peace over productivity.",
    "No clear answer — I'll assume you're heads-down. Good luck in there.",
    "Couldn't hear you, so I'm not running the checklist. Your brain, your rules.",
    "Either you're mute or the mic is — either way, no rundown from me.",
    "I'm half exhausted just waiting — take a break if you need one, {name}.",
    "If you're grinding this hard you can't speak, that's a sign to stretch and hydrate.",
    "Fun fact: the word deadline originally meant a literal line prisoners couldn't cross. Yours are softer.",
    "Thought for the day: done beats perfect. Ship the thing.",
    "Micro-meme energy: this meeting could have been silence. Enjoy it.",
    "I'm running on vibes and caffeine logic — you're off the hook this round.",
)
