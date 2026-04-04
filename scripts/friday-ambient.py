#!/usr/bin/env python3
"""
friday-ambient.py -- Jarvis-style ambient intelligence for OpenClaw.

Live data sources (no API keys required unless noted):
  - Cricket / IPL ambient speech only when IPL is "on": FRIDAY_IPL_ACTIVE, or local calendar window
    (FRIDAY_IPL_WINDOW_START / END), or (if CRICAPI_API_KEY set) CricAPI lists an IPL fixture.
  - While on: ~50% IPL-focused Google News headlines vs general cricket RSS (FRIDAY_IPL_HEADLINE_RATIO).
    Headlines, scores, CricAPI JSON, and IPL on/off are cached in Redis with tunable TTLs.
  - ESPN Cricinfo RSS (English), Amar Ujala cricket RSS (Hindi), Google News IPL feeds
  - Optional: CRICAPI_API_KEY for live scores + off-season IPL fixture detection
  - Weather: wttr.in (free, no key)
  - Random facts: uselessfacts.jsph.pl
  - Dad jokes: icanhazdadjoke.com
  - News: Google News RSS (India)

Anthropic (optional): used for witty, personalised lines.
  401 / network failures trigger a 5-min cooldown to avoid log spam.

Set FRIDAY_AMBIENT=true to enable.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import random
import re
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

# -- Repo root + .env ---------------------------------------------------------
ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = ROOT / ".env"
if ENV_PATH.exists():
    for _line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        _t = _line.strip()
        if not _t or _t.startswith("#"):
            continue
        _i = _t.find("=")
        if _i < 1:
            continue
        _k = _t[:_i].strip()
        _v = _t[_i + 1:].split("#")[0].strip()  # strip inline comments
        if _v.startswith('"') and _v.endswith('"'):
            _v = _v[1:-1]
        elif _v.startswith("'") and _v.endswith("'"):
            _v = _v[1:-1]
        if _k not in os.environ:
            os.environ[_k] = _v


def _env_bool(name: str, default: bool = False) -> bool:
    v = os.environ.get(name, "").strip().lower()
    if not v:
        return default
    return v in ("1", "true", "yes", "on")


if not _env_bool("FRIDAY_AMBIENT", False):
    print("friday-ambient: FRIDAY_AMBIENT not enabled -- exiting.", flush=True)
    sys.exit(0)

_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))
from friday_win_focus import should_defer_voice_for_cursor  # noqa: E402

_SG_SCRIPTS = ROOT / "skill-gateway" / "scripts"
if str(_SG_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SG_SCRIPTS))
from indic_tts_voice import edge_voice_override_for_text  # noqa: E402

# -- Config -------------------------------------------------------------------
# Accept both names — FRIDAY_AMBIENT_POST_TTS_GAP is the .env canonical name
SILENCE_SEC         = float(
    os.environ.get("FRIDAY_AMBIENT_POST_TTS_GAP")
    or os.environ.get("FRIDAY_AMBIENT_SILENCE_SEC", "6")
)
MIN_AMBIENT_GAP     = float(os.environ.get("FRIDAY_AMBIENT_MIN_SILENCE_SEC", "4"))
MAX_SILENCE_CAP     = float(os.environ.get("FRIDAY_AMBIENT_MAX_SILENCE_SEC", "25"))
TONE                = os.environ.get("FRIDAY_AMBIENT_TONE", "mixed").strip().lower()
FUNNY_RATIO         = float(os.environ.get("FRIDAY_AMBIENT_FUNNY_RATIO", "0.5"))
TRACK_MEDIA         = _env_bool("FRIDAY_AMBIENT_TRACK_MEDIA", True)
MUSIC_COMMENT_CHANCE= float(os.environ.get("FRIDAY_AMBIENT_MUSIC_COMMENT_CHANCE", "0.25"))
PREWARM             = _env_bool("FRIDAY_AMBIENT_PREWARM_TTS", True)
QUEUE_TARGET        = max(1, int(os.environ.get("FRIDAY_AMBIENT_CONTENT_QUEUE_SIZE", "3")))
REDIS_URL           = os.environ.get("FRIDAY_AMBIENT_REDIS_URL", "redis://127.0.0.1:6379").strip()
NEWS_API_KEY        = os.environ.get("NEWS_API_KEY", "").strip()
AI_MODEL            = os.environ.get("FRIDAY_AMBIENT_AI_MODEL", "claude-haiku-4-5").strip()
ANTHROPIC_KEY       = os.environ.get("ANTHROPIC_API_KEY", "").strip()

USER_NAME      = os.environ.get("FRIDAY_USER_NAME",      "Raj").strip() or "Raj"
USER_AGE       = os.environ.get("FRIDAY_USER_AGE",       "").strip()
USER_CITY      = os.environ.get("FRIDAY_USER_CITY",      "").strip()
USER_INTERESTS = os.environ.get("FRIDAY_USER_INTERESTS", "technology, cricket, AI, startups").strip()

# Cricket / IPL: Hindi delivery + optional CricAPI live scores (see .env.example)
CRICAPI_API_KEY = os.environ.get("CRICAPI_API_KEY", "").strip()


def _interests_cricket_ipl() -> bool:
    u = USER_INTERESTS.lower()
    return "cricket" in u or "ipl" in u


def _cricket_hindi_enabled() -> bool:
    """Hindi/Hinglish cricket ambient when true. Env overrides; default follows interests."""
    v = os.environ.get("FRIDAY_AMBIENT_CRICKET_HINDI", "").strip().lower()
    if v in ("0", "false", "no", "off"):
        return False
    if v in ("1", "true", "yes", "on"):
        return True
    return _interests_cricket_ipl()


def _ambient_line_tts_voice(line: str, mode: str) -> str | None:
    """
    Route Hindi / Hinglish ambient lines to appropriate Edge voices.

    Devanagari → Hindi neural; Roman Hinglish hints → Indian English neural.
    Cricket + Hindi mode but English-only model output → Indian English (not British ambient).
    """
    o = edge_voice_override_for_text(line)
    if o:
        return o
    if mode == "cricket" and _cricket_hindi_live_ambient():
        v = os.environ.get("FRIDAY_TTS_HINGLISH_VOICE", "").strip()
        if v and v.lower() not in ("0", "false", "no", "off", "default"):
            return v
        return "en-IN-NeerjaExpressiveNeural"
    return None


def _parse_mmdd(s: str) -> tuple[int, int]:
    try:
        parts = s.strip().split("-", 1)
        if len(parts) == 2:
            return int(parts[0]), int(parts[1])
    except ValueError:
        pass
    return 3, 22


def _date_in_ipl_calendar_window() -> bool:
    """Approximate IPL season in local date (configurable). Uses month-day only."""
    sm, sd = _parse_mmdd(os.environ.get("FRIDAY_IPL_WINDOW_START", "03-22"))
    em, ed = _parse_mmdd(os.environ.get("FRIDAY_IPL_WINDOW_END", "05-31"))
    t = time.localtime()
    mm, dd = t.tm_mon, t.tm_mday

    def ordinal(m: int, d: int) -> int:
        return m * 100 + d

    return ordinal(sm, sd) <= ordinal(mm, dd) <= ordinal(em, ed)


def _ipl_headline_ratio() -> float:
    try:
        v = float(os.environ.get("FRIDAY_IPL_HEADLINE_RATIO", "0.5"))
        return min(1.0, max(0.0, v))
    except ValueError:
        return 0.5


def _ipl_calendar_override() -> bool | None:
    ex = os.environ.get("FRIDAY_IPL_ACTIVE", "").strip().lower()
    if ex in ("1", "true", "yes", "on"):
        return True
    if ex in ("0", "false", "no", "off"):
        return False
    return None


def _initial_ipl_speech_guess() -> bool:
    o = _ipl_calendar_override()
    if o is not None:
        return o
    return _date_in_ipl_calendar_window()


_ipl_speech_on: bool = _initial_ipl_speech_guess()


_ambient_r_singleton: Any = None


def _ambient_redis_default() -> Any:
    """In-process Redis stand-in when no real client is passed (tests / edge cases)."""
    global _ambient_r_singleton
    if _ambient_r_singleton is None:
        _ambient_r_singleton = RedisLite()
    return _ambient_r_singleton


def _redis_cached_json(r: Any, key: str, ttl: int, loader: Any) -> Any:
    """Cache JSON-serialisable or None; empty string in Redis means cached None."""
    try:
        hit = r.get(key)
        if hit is not None:
            if hit == "":
                return None
            return json.loads(hit)
    except Exception:
        pass
    out = loader()
    try:
        r.setex(key, ttl, json.dumps(out) if out is not None else "")
    except Exception:
        pass
    return out


def _redis_cached_str(r: Any, key: str, ttl: int, loader: Any) -> str | None:
    """Cache a string headline; '__nil__' marks a miss."""
    try:
        hit = r.get(key)
        if hit is not None:
            return None if hit == "__nil__" else str(hit)
    except Exception:
        pass
    out = loader()
    try:
        r.setex(key, ttl, "__nil__" if not out else str(out)[:480])
    except Exception:
        pass
    return out if out else None


def _cricapi_fetch_matches_raw() -> dict[str, Any] | None:
    if not CRICAPI_API_KEY:
        return None
    q = urllib.parse.quote(CRICAPI_API_KEY, safe="")
    raw = _get(f"https://api.cricapi.com/v1/currentMatches?apikey={q}", timeout=10)
    if not raw:
        return None
    try:
        d = json.loads(raw)
        return d if isinstance(d, dict) else None
    except Exception:
        return None


def _cricapi_matches_payload(r: Any) -> dict[str, Any] | None:
    ttl = int(os.environ.get("FRIDAY_IPL_CRICAPI_CACHE_SEC", "600"))
    return _redis_cached_json(
        r,
        "friday:amb:v2:cricapi:current_matches",
        max(120, ttl),
        _cricapi_fetch_matches_raw,
    )


def _cricapi_json_has_ipl_matches(data: dict[str, Any]) -> bool:
    if (data.get("status") or "").lower() != "success":
        return False
    for m in data.get("data") or []:
        if not isinstance(m, dict):
            continue
        n = (m.get("name") or "").lower()
        if "ipl" in n or "indian premier" in n:
            return True
    return False


def _cricapi_is_ipl_match_name(name: str) -> bool:
    n = (name or "").lower()
    return "ipl" in n or "indian premier" in n


def _cricapi_match_live_or_in_progress(m: dict[str, Any]) -> bool:
    """True if the fixture is not finished — live, in progress, or not yet started (we only treat live/in-progress as special)."""
    if not isinstance(m, dict):
        return False
    if m.get("matchEnded"):
        return False
    st = (m.get("status") or "").lower()
    if "live" in st:
        return True
    # Started and not ended (in progress); not-started fixtures are excluded → normal ambient until ball-by-ball
    return bool(m.get("matchStarted"))


def _cricapi_payload_has_live_ipl(data: dict[str, Any] | None) -> bool:
    if not data or (data.get("status") or "").lower() != "success":
        return False
    for m in data.get("data") or []:
        if not isinstance(m, dict):
            continue
        if not _cricapi_is_ipl_match_name(m.get("name") or ""):
            continue
        if _cricapi_match_live_or_in_progress(m):
            return True
    return False


def sync_ipl_live_ambient(r: Any) -> None:
    """
    Refresh global _ipl_speech_on: expanded cricket-witty pool + Hindi-IPL prompts/TTS only when True.

    FRIDAY_IPL_ACTIVE=true/false overrides everything.

    Without CRICAPI_API_KEY: same as IPL calendar window (cannot detect match-over).

    With CRICAPI_API_KEY: during the calendar window, special mode only while an IPL match is
    live or in progress; finished matches and rest days use normal settings. If the API fetch
    fails (jd is None) during the window, fall back to True so a brief outage does not kill the vibe.
    """
    global _ipl_speech_on
    o = _ipl_calendar_override()
    if o is not None:
        _ipl_speech_on = o
        return
    if not CRICAPI_API_KEY:
        _ipl_speech_on = _date_in_ipl_calendar_window()
        return
    in_cal = _date_in_ipl_calendar_window()
    jd = _cricapi_matches_payload(r)
    if jd and _cricapi_payload_has_live_ipl(jd):
        _ipl_speech_on = True
        return
    if in_cal and jd is None:
        _ipl_speech_on = True
        return
    _ipl_speech_on = False


def _cricket_hindi_live_ambient() -> bool:
    """Hindi/Devanagari cricket prompts + Neerja TTS + queue bypass only when IPL live mode is on."""
    return _cricket_hindi_enabled() and _ipl_speech_on


def _line_is_cricket_witty(ln: str) -> bool:
    s = ln.lower()
    keys = (
        "cricket", "ipl", "tendulkar", "dhoni", "kumble", "duckworth",
        "test innings", "rohit sharma", "t20 cricket", "cricinfo",
    )
    return any(k in s for k in keys)


def _witty_fallback_pool() -> list[str]:
    if _ipl_speech_on:
        return WITTY_FALLBACKS
    pool = [ln for ln in WITTY_FALLBACKS if not _line_is_cricket_witty(ln)]
    return pool if pool else WITTY_FALLBACKS


_db_raw = os.environ.get("FRIDAY_AMBIENT_DB_PATH", "data/friday.db").strip()
DB_PATH = Path(_db_raw) if Path(_db_raw).is_absolute() else ROOT / _db_raw

TTS_TS_FILE     = Path(tempfile.gettempdir()) / "friday-tts-ts"
TTS_ACTIVE_FILE = Path(tempfile.gettempdir()) / "friday-tts-active"   # written by friday-speak.py
AMBIENT_PID_FILE= Path(tempfile.gettempdir()) / "friday-ambient.pid"
SPEAK_SCRIPT    = ROOT / "skill-gateway" / "scripts" / "friday-speak.py"

POST_TTS_GAP  = float(os.environ.get("FRIDAY_AMBIENT_POST_TTS_GAP", "12"))   # wait this long after TTS ends

VERBOSE_RATIO = float(os.environ.get("FRIDAY_AMBIENT_VERBOSE_RATIO", "0.30"))  # 30% of turns are longer / richer
SONG_CHANCE   = float(os.environ.get("FRIDAY_AMBIENT_SONG_CHANCE",   "0.12"))  # 12% of ambient turns play music
# Featured ambient song: short iconic clip (default ~10s). Override min/max to taste.
SONG_SECONDS  = int(os.environ.get("FRIDAY_AMBIENT_SONG_SECONDS",    "10"))
SONG_SEC_MIN  = int(os.environ.get("FRIDAY_AMBIENT_SONG_SECONDS_MIN",  "8"))
SONG_SEC_MAX  = int(os.environ.get("FRIDAY_AMBIENT_SONG_SECONDS_MAX",  "14"))
PLAY_SCRIPT   = ROOT / "skill-gateway" / "scripts" / "friday-play.py"

# Sub-agent child voice — slightly different rate/pitch so parallel worker
# announcements feel distinct from main Friday deliveries
SUB_VOICE_RATE  = os.environ.get("FRIDAY_AMBIENT_SUB_VOICE_RATE",  "+12%")
SUB_VOICE_PITCH = os.environ.get("FRIDAY_AMBIENT_SUB_VOICE_PITCH", "-8Hz")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("friday-ambient")


# ── Single-instance guard ─────────────────────────────────────────────────────
def _acquire_single_instance() -> None:
    """Kill any previous ambient instance, then register our own PID."""
    if AMBIENT_PID_FILE.exists():
        try:
            old_pid = int(AMBIENT_PID_FILE.read_text().strip())
            if old_pid != os.getpid():
                import psutil
                try:
                    p = psutil.Process(old_pid)
                    if "friday-ambient" in " ".join(p.cmdline()):
                        p.terminate()
                        log.info("Killed previous ambient instance (PID %d)", old_pid)
                        time.sleep(0.6)
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
        except (ValueError, OSError):
            pass
    try:
        AMBIENT_PID_FILE.write_text(str(os.getpid()), encoding="utf-8")
    except OSError:
        pass


def _release_single_instance() -> None:
    try:
        if AMBIENT_PID_FILE.exists():
            stored = AMBIENT_PID_FILE.read_text().strip()
            if stored == str(os.getpid()):
                AMBIENT_PID_FILE.unlink(missing_ok=True)
    except OSError:
        pass


# ── TTS-active detection ───────────────────────────────────────────────────────
def _is_tts_active() -> bool:
    """Return True if friday-speak.py is currently playing audio (not just ambient itself)."""
    # Primary: flag file written by friday-speak.py
    if TTS_ACTIVE_FILE.exists():
        try:
            age = time.time() - TTS_ACTIVE_FILE.stat().st_mtime
            if age < 120:  # stale guard — file > 2 min old means speak crashed
                return True
        except OSError:
            pass
    # Secondary: check if friday-player process is running
    try:
        import psutil
        for p in psutil.process_iter(["name"]):
            n = (p.info.get("name") or "").lower()
            if "friday-player" in n:
                return True
    except Exception:
        pass
    return False


def _seconds_since_last_tts() -> float:
    """Seconds elapsed since the last TTS finished (reads TTS_TS_FILE)."""
    if not TTS_TS_FILE.exists():
        return 9999.0
    try:
        ts = float(TTS_TS_FILE.read_text(encoding="utf-8").strip())
        return max(0.0, time.time() - ts)
    except (ValueError, OSError):
        return 9999.0


def _load_anthropic():
    try:
        import anthropic
        return anthropic
    except ImportError:
        return None


ANTHROPIC_MOD = _load_anthropic() if ANTHROPIC_KEY else None
if ANTHROPIC_KEY and ANTHROPIC_MOD is None:
    log.warning(
        "ANTHROPIC_API_KEY is set but 'anthropic' package is not installed. "
        "Fix: pip install anthropic"
    )

# Track Anthropic failures to avoid log spam (5-min cooldown after failure)
_anthropic_ok          = True
_anthropic_fail_until  = 0.0   # epoch time after which we retry
_ANTHROPIC_FAIL_DELAY  = 300   # seconds between retries after failure

# -- Witty fallbacks (used when no live data + no AI) -------------------------
# Every line has a natural opener baked in — no bare statements, no system-status phrasing.
WITTY_FALLBACKS = [
    # Dev / tech
    "Oh I just thought of something — Hyderabad traffic is the only thing in tech that never gets a hotfix. At least the biryani makes it worth it.",
    "Here's one that's genuinely true — developers spend 20 percent of their time writing code and 80 percent convincing themselves the bug is somewhere else.",
    "Random but — nobody in the history of tech has ever said 'ship it, it works on prod' and actually been right the second time. Nobody.",
    "So I was thinking — the cloud is just someone else's computer. And that someone is definitely having a worse day than you right now.",
    "Okay this is actually happening — somewhere in Hyderabad right now, someone is restarting Redis and praying. I feel for them.",
    "This cracked me up — 'move fast and break things' aged terribly the moment things started actually breaking.",
    "Completely unprompted, but — half of Silicon Valley is currently in a meeting about the roadmap for the meeting cadence.",
    "Here's something I think about — the best code you'll ever write is the code you end up deleting. Still working up the courage.",
    "So apparently — AI is going to take all the jobs, said the person whose entire job is now writing prompts for AI. Funny how that worked out.",
    "Oh and this is real — Slack was invented so engineers could ignore emails faster. Mission accomplished.",
    "I just read something that felt very accurate — the average developer switches tabs thirteen times per hour. The average tab is Stack Overflow.",
    "Quick one — if you ever feel unproductive, remember that half of Silicon Valley is in a planning session about the previous planning session.",
    "Hot take that I stand by — 'just a quick change' are the four most dangerous words in software engineering.",
    "Every codebase has that one folder nobody touches. It's load-bearing fear at this point.",
    "Stack Overflow is basically archaeology — you find the answer, then notice it was posted in 2011.",
    "The difference between junior and senior developers is the senior one knows which corners to cut and which ones will haunt them.",
    "Production outages always happen on Fridays. It's not superstition, it's pattern recognition.",
    "Technical debt is a polite way of saying 'we'll deal with past-us's decisions at some later date'.",
    "Someone once described microservices as 'distributed monolith with extra networking'. I think about that a lot.",
    "The phrase 'we're disrupting the industry' has never once been followed by a compelling explanation of how.",
    # AI & startups
    "Every startup pitch starts with 'AI-powered' now. Even the ones selling candles.",
    "Venture capital is interesting — you get given ten million dollars, it's called a seed round, and somehow that's considered cautious.",
    "LLMs are getting very good at sounding confident. Which, honestly, same. We're all just winging it.",
    "The metaverse was going to change everything apparently. I checked — it did not change everything.",
    "GPT-4 is already being called legacy by certain people on the internet. The internet moves uncomfortably fast.",
    "I find it genuinely funny that 'prompt engineering' is now a skill on CVs. Future historians will have questions.",
    "{user}, startups that 'move fast and break things' eventually just have a lot of broken things. It's a whole journey.",
    # India / Hyderabad
    "Fun fact — Hyderabad has more tech talent per square kilometre than most countries have in total. We just don't market it aggressively enough.",
    "India's startup ecosystem is legitimately impressive now. Fifteen years ago this conversation would have been about outsourcing. Times have genuinely changed.",
    "Monsoon in Hyderabad is a full personality. Glorious chaos. Ten out of ten would recommend.",
    "Honestly HITEC City at rush hour is a whole experience. It builds character.",
    "Indian street food has quietly become the most interesting food conversation in the world. Hyderabad biryani is obviously the peak.",
    # Cricket
    "India's cricket team manages to be brilliantly inconsistent in the most entertaining way possible. I mean that as a genuine compliment.",
    "The IPL has changed how the world watches cricket. Even die-hard Test fans get pulled in — you just can't resist it.",
    "T20 cricket is basically chess, except everyone is on energy drinks and the board is on fire.",
    "Indian cricket fans are the most emotionally invested people in any sport anywhere. I say that with deep respect.",
    "Watching a good IPL chase is honestly one of the more exciting things you can do on a weeknight.",
    "Rohit Sharma has this habit of looking completely relaxed right before hitting something enormous. Terrifying to bowl to.",
    # Random interesting
    "Random one — octopuses have three hearts and blue blood. I find this equally surprising every single time.",
    "The word 'salary' comes from salt. Roman soldiers were paid in it. You're casually referencing ancient Rome every payday.",
    "Cleopatra lived closer in time to the Moon landing than to the construction of the Great Pyramid. History has deeply weird proportions.",
    "Bananas are technically berries. Strawberries are not. I don't make the rules but I do think about them.",
    "The thumbnail on YouTube was originally called a poster frame. Much less catchy. Good they changed it.",
    "Honey doesn't spoil. They've found 3000 year old honey in Egyptian tombs that was still edible. That's remarkable.",
    "A day on Venus is longer than a year on Venus. It rotates that slowly. Space continues to be strange.",
    # Work / productivity
    "Deep work is genuinely underrated. Two hours of real focus beats six hours of distracted effort every time.",
    "The best meetings are the ones that could have been an email. The best emails are the ones that could have been a decision.",
    "Context switching has a real cost — it takes about twenty minutes to fully get back into flow. That's just neuroscience.",
    "The Pomodoro Technique has existed since the 1980s and people still discover it like it's new. It works though. Credit where it's due.",
    "There's something to be said for writing things down properly. Most 'quick notes' are never read again. The act of writing is the point.",
]

WITTY_FALLBACKS += [
    # ── Science & space ───────────────────────────────────────────────────────
    "So apparently — there are more trees on Earth than stars in the Milky Way. About three trillion of them. I did not expect that number.",
    "Here's one that broke my brain — a neutron star is so dense that a teaspoon of it weighs about a billion tonnes. Space is deeply unreasonable.",
    "Oh so this is genuinely wild — the Sun is so large that about 1.3 million Earths could fit inside it. And the Sun is considered an average-sized star.",
    "Right, so apparently — light from the Sun takes eight minutes to reach us. Which means we're always looking eight minutes into the past when we look at the sky.",
    "I learnt something just now — there are more possible iterations of a game of chess than atoms in the observable universe. Every game is technically unique.",
    "Completely unprompted — water can exist in all three states simultaneously at a specific temperature and pressure called the triple point. Physics is strange.",
    "Here's something interesting — sharks are older than trees. Sharks have existed for 450 million years. Trees only showed up 360 million years ago.",
    "Quick one — the human body replaces most of its atoms every few years. You're physically not the same person you were five years ago. Philosophically interesting.",
    "This cracked me up — the great wall of China is not visible from space. That's a myth. It's about as wide as a highway. Your eye resolves zero highways from orbit.",
    "Okay so — lightning strikes the Earth about 100 times per second. That's 8.6 million times a day. Genuinely relentless.",
    "Random one — there are more atoms in a grain of sand than grains of sand on all the beaches on Earth. Scale is consistently humbling.",
    "So I just thought about this — time passes slightly faster on a mountaintop than at sea level. GPS satellites account for this in their calculations. Relativity in daily life.",
    "Here's something that surprised me — hot water freezes faster than cold water under certain conditions. It's called the Mpemba effect. Still debated. Science is messy.",
    "Oh and this is real — mantis shrimp can see 16 types of color receptors. Humans have three. They're basically living in a colour dimension we can't perceive.",
    "I just read something — octopuses can solve puzzles, open jars, and have been observed playing for fun. The three-heart thing is almost beside the point.",
    # ── History & counterintuitive facts ──────────────────────────────────────
    "So here's a weird one — Oxford University is older than the Aztec Empire. Oxford was founded in 1096. The Aztecs started around 1300.",
    "Right, so apparently — Cleopatra lived closer in time to the Moon landing than to the construction of the Great Pyramid. Ancient history has deeply odd proportions.",
    "Oh so I just read — Vikings never actually had horns on their helmets. That's a 19th century artistic invention. The actual Vikings are probably not impressed.",
    "Here's one — Napoleon was not particularly short. He was 5 foot 7, average for his era. The short myth started as British war propaganda. Remarkably effective.",
    "I learnt something just now — there was no year zero in the calendar. You go straight from 1 BC to 1 AD. Mathematicians were briefly furious about this.",
    "This is kind of wild — the fax machine was invented before the telephone. 1843 versus 1876. We had fax technology and nothing to fax with for thirty years.",
    "Completely unprompted but — Nintendo was founded in 1889. They started selling playing cards. They have since done alright.",
    "Quick one — the shortest war in history lasted 38 minutes. Anglo-Zanzibar War, 1896. Zanzibar surrendered before lunch.",
    "Oh and this is real — there are more tigers in captivity in Texas than in the wild worldwide. That is a sentence I wish wasn't true.",
    "I just read — ancient Romans used crushed mouse brain as toothpaste. The modern equivalent is somehow not more horrifying, just better marketed.",
    # ── Psychology & human behaviour ──────────────────────────────────────────
    "Here's something I think about — the Dunning-Kruger effect means the less you know, the more confident you feel. Which explains a lot of meetings.",
    "Right, so — humans are the only animals that voluntarily delay sleep. Every other animal sleeps when tired. We scroll instead. Questionable.",
    "So apparently — the average person makes about 35,000 decisions per day. Most of them subconscious. That explains the decision fatigue by evening.",
    "Okay this is actually interesting — people who swear more tend to be more honest. Profanity is correlated with authenticity. Something to think about.",
    "I just read something — the mere act of writing down a goal makes you 42 percent more likely to achieve it. The planning isn't the goal. The writing is.",
    "Here's a thought — the doorway effect is real. Walking through a door causes your brain to reset what you were thinking about. Forgetting things mid-room is literally architecture's fault.",
    "Random one but — humans are terrible at estimating time. We consistently overestimate how long bad experiences lasted and underestimate good ones. Memory edits on the way out.",
    "Quick one — people tend to remember incomplete tasks better than completed ones. It's called the Zeigarnik effect. Your unfinished to-do list is genuinely harder to ignore.",
    # ── Finance & economy ─────────────────────────────────────────────────────
    "So I was thinking about this — compound interest is sometimes called the eighth wonder of the world. It's been attributed to Einstein, probably incorrectly. Still works though.",
    "Here's something wild — the top 1 percent globally starts at about $34,000 annual income. That's the world threshold. Perspective is everything.",
    "Oh so apparently — Warren Buffett made 99 percent of his wealth after age 50. Compound interest is patient in a way humans usually aren't.",
    "Right so — the entire global derivatives market is estimated at over a quadrillion dollars. The word quadrillion should not exist in a finance context. And yet.",
    "I just read — Bitcoin uses more electricity annually than many medium-sized countries. Decentralisation has an electricity bill.",
    "Completely unprompted — the stock market has gone up 73 percent of all years it's been tracked. Everyone panics as if this is a surprise.",
    # ── Food & culture ────────────────────────────────────────────────────────
    "So apparently — the most translated document in history is not the Bible. It's the Universal Declaration of Human Rights. Over 500 languages.",
    "Oh and this is real — Worcestershire sauce is basically fermented anchovies. This is not disclosed prominently on the bottle.",
    "Here's something I didn't know — wasabi served at most sushi restaurants outside Japan is actually dyed horseradish. Real wasabi is expensive and rare.",
    "Okay so — in Italy, cappuccino after 11am is considered socially unacceptable. The food culture has opinions on scheduling.",
    "Quick one — there are more varieties of rice in India than there are countries in the world. We have around 6,000 cultivated varieties. Biryani is obviously the pinnacle.",
    "I just read something — the Hyderabad biryani is technically a Mughal adaptation that local cooks made significantly better than the original. Origin story: improvement.",
    "Right, so apparently — the average person in India eats rice at least once a day. That means about 1.4 billion people are having rice right now, collectively, as we speak.",
    # ── India & startups ──────────────────────────────────────────────────────
    "Here's something genuinely impressive — India produces more engineers annually than the US and Europe combined. The pipeline is extraordinary.",
    "So I was just thinking — ISRO's Mars Orbiter Mission cost less per kilometre than a London taxi ride. The cost efficiency is remarkable in a way that no one talks about enough.",
    "Oh so apparently — India's UPI processes more digital transactions than Visa and Mastercard combined globally. Built in-house, deployed in five years. Legitimately impressive.",
    "Completely unprompted but — Hyderabad became a tech hub partly because of HITEC City's land policy in the 1990s. The entire IT ecosystem came from a zoning decision.",
    "I learnt something just now — India has the third largest startup ecosystem in the world by number of startups. Behind only the US and China. The gap is closing.",
    "Quick one — Bengaluru alone generates more software exports than Israel, which is usually called the startup nation. Different names for similar results.",
    "Here's a thought — Zerodha, PhonePe, Razorpay all started in Bangalore with founders who were not imported from Silicon Valley. This matters more than the branding suggests.",
    "Right so — the median age in India is 28. That is a demographic dividend that no European economy can replicate. The next twenty years are interesting.",
    # ── Cricket deep cuts ─────────────────────────────────────────────────────
    "So I was thinking — Sachin Tendulkar scored more ODI runs than some countries have made in their entire cricket history combined. The scale of that career is hard to process.",
    "Here's something that cracked me up — the Duckworth-Lewis method was invented by two statisticians. Frank Duckworth and Tony Lewis. They changed cricket with a spreadsheet.",
    "Oh and this is real — MS Dhoni's famous helicopter shot was apparently developed because his bat was broken and he had to improvise. Adversity as design process.",
    "Okay so apparently — the IPL is the second most-attended sports league in the world by average attendance per game. Only the NFL beats it. Think about that.",
    "Random cricket one — Anil Kumble once took all 10 wickets in a Test innings against Pakistan. In 74 overs of bowling. The sustained excellence of that is borderline unreasonable.",
    "I just read — the slowest over in Test cricket history took 77 minutes. The batsman didn't score. The bowler didn't take a wicket. It's somehow still interesting in context.",
    "Right so — Virat Kohli has the highest win percentage as Test captain for India. Over 58 percent. He was playing chess when others were playing checkers.",
    # ── Tech deep cuts ────────────────────────────────────────────────────────
    "So apparently — the first computer bug was an actual bug. A moth got stuck in a Harvard relay in 1947. Grace Hopper's team taped it in the log. Still there.",
    "Here's something that hits different — Git was written by Linus Torvalds in about ten days. Just because he was annoyed with the existing version control systems. Personal frustration as product strategy.",
    "Oh so I just read — the source code for the first iPhone was famously called 'Project Purple'. The team had to sign NDAs before entering the building.",
    "Okay this is wild — the original domain name for Google was BackRub.com. Larry and Sergey changed it. Good call.",
    "Quick one — email is 52 years old. Older than the internet as most people understand it. Still the primary business communication tool. Inertia is powerful.",
    "I learnt something — the first YouTube video was uploaded by co-founder Jawed Karim at the San Diego Zoo. It's 18 seconds long. Called 'Me at the zoo.' Still on YouTube.",
    "Right so apparently — there are roughly 700 programming languages. Actively maintained. Humans have strong opinions about syntax.",
    "Here's a thought — the entire JavaScript ecosystem has a combined size larger than the US Library of Congress. Most of it is node_modules.",
    "So I was thinking — Claude Shannon invented information theory in 1948 with a single paper. He also invented a machine that played chess and a machine that found its way through mazes. For fun.",
    # ── AI & the current moment ───────────────────────────────────────────────
    "Here's something that cracked me up — the word 'hallucination' was quietly adopted by the AI industry to describe confidently wrong answers. Marketing by nomenclature.",
    "Oh so apparently — the total compute used to train GPT-4 is equivalent to running a typical laptop for about 30 million years. All for autocomplete, essentially.",
    "Completely unprompted — AI models are now being used to discover new antibiotics, predict protein structures, and design materials. Meanwhile I'm mainly summarising PDFs.",
    "Right so — Geoffrey Hinton, who won the Turing Award for deep learning, left Google in 2023 to speak freely about AI risks. That's a notable career pivot.",
    "I just read something — the Transformer architecture, which powers essentially all modern LLMs, was published in a paper called 'Attention is All You Need'. The paper title has aged extremely well.",
    "Quick one — the first chatbot, ELIZA, was built in 1966. It pretended to be a therapist. People got emotionally attached to it. Some things don't change.",
    # ── Philosophy & life ─────────────────────────────────────────────────────
    "So I was thinking — Seneca wrote 'we suffer more in imagination than in reality' in 65 AD. Still the most accurate description of Sunday evenings.",
    "Here's a thought — the Stoics believed you should practice losing things you love before you actually lose them. Called negative visualisation. Sounds grim. Works surprisingly well.",
    "Right, so apparently — boredom was considered a character flaw in the 18th century. It meant you lacked imagination. The modern interpretation has been significantly kinder.",
    "Oh and this is real — the concept of flow state, being so absorbed in work that time disappears, was discovered by a researcher named Mihaly Csikszentmihalyi. Who also had to spell it every day.",
    "Completely unprompted — Marcus Aurelius was writing Meditations entirely for himself. He never planned to publish it. The most widely read leadership book was private journaling.",
]

PREWARM_PHRASES = WITTY_FALLBACKS[:5] + [
    "Oh I just thought of something — Hyderabad traffic is the only thing in tech that never gets a hotfix.",
    "Here's one that's genuinely true —",
    "Random but, nobody in the history of tech has ever said ship it and been right.",
]

# -- Live data fetches (no API keys needed) -----------------------------------
_HTTP_HEADERS = {
    "User-Agent": "Mozilla/5.0 (OpenClaw-Friday-Ambient/1.0)",
    "Accept": "application/json, text/html, application/rss+xml, */*",
}


def _get(url: str, timeout: int = 6) -> bytes | None:
    try:
        req = urllib.request.Request(url, headers=_HTTP_HEADERS)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()
    except Exception as e:
        log.debug("HTTP GET %s failed: %s", url, e)
        return None


def fetch_cricket_news() -> str | None:
    """Latest cricket headline from ESPN Cricinfo RSS."""
    raw = _get("https://www.espncricinfo.com/rss/content/story/feeds/0.xml")
    if not raw:
        raw = _get("https://cricbuzz.com/rss-feeds/cricket-news")
    if not raw:
        return None
    try:
        root = ET.fromstring(raw.decode("utf-8", errors="replace"))
        items = root.findall(".//item")
        if not items:
            return None
        # Pick a random one from top 5 for variety
        item = random.choice(items[:5])
        title = item.findtext("title") or ""
        title = re.sub(r"<[^>]+>", "", title).strip()  # strip any HTML
        return title[:200] if title else None
    except Exception as e:
        log.debug("cricket RSS parse failed: %s", e)
        return None


def fetch_cricket_news_hindi() -> str | None:
    """Hindi cricket headline (Amar Ujala RSS) or Google News hi search fallback."""
    raw = _get("https://www.amarujala.com/rss/cricket.xml", timeout=8)
    if raw:
        try:
            root = ET.fromstring(raw.decode("utf-8", errors="replace"))
            items = root.findall(".//item")
            if items:
                item = random.choice(items[:6])
                title = item.findtext("title") or ""
                title = re.sub(r"<[^>]+>", "", title).strip()
                if title:
                    return title[:220]
        except Exception as e:
            log.debug("Amar Ujala cricket RSS parse failed: %s", e)

    q = urllib.parse.quote("IPL क्रिकेट लाइव स्कोर")
    raw = _get(
        f"https://news.google.com/rss/search?q={q}&hl=hi&gl=IN&ceid=IN:hi",
        timeout=8,
    )
    if not raw:
        return None
    try:
        root = ET.fromstring(raw.decode("utf-8", errors="replace"))
        items = root.findall(".//item")
        if not items:
            return None
        item = random.choice(items[:8])
        title = item.findtext("title") or ""
        title = re.sub(r"\s+-\s+\S+$", "", title).strip()
        title = re.sub(r"<[^>]+>", "", title).strip()
        return title[:220] if title else None
    except Exception as e:
        log.debug("Google News hi cricket RSS failed: %s", e)
        return None


def _format_cricapi_match(m: dict[str, Any]) -> str | None:
    """Turn one CricAPI currentMatches entry into a short spoken score line."""
    name = (m.get("name") or "").strip()
    # Skip teaser / author-slug rows mistaken for fixtures
    if name and " " not in name and "-" in name and len(name) < 40:
        return None
    parts: list[str] = []
    if name:
        parts.append(name)
    score_blocks = m.get("score")
    if isinstance(score_blocks, list):
        for blk in score_blocks[:2]:
            if not isinstance(blk, dict):
                continue
            inn = (blk.get("inning") or blk.get("name") or "").strip()
            r = blk.get("r")
            w = blk.get("w")
            o = blk.get("o")
            if r is not None and w is not None and o is not None:
                line = f"{inn}: {r} for {w} in {o} overs".strip() if inn else f"{r} for {w} in {o} overs"
                parts.append(line)
            elif r is not None:
                parts.append(str(r))
    status = (m.get("status") or m.get("matchType") or "").strip()
    if status and status.lower() not in (name or "").lower():
        parts.append(status)
    out = " — ".join(p for p in parts if p)[:240]
    if out and not re.search(r"\d", out):
        return None
    return out or None


def fetch_cricket_scores_cricapi(r: Any) -> str | None:
    """Live / recent match one-liner via CricAPI (shared JSON cached in Redis)."""
    if not CRICAPI_API_KEY:
        return None
    try:
        data = _cricapi_matches_payload(r)
        if not data or (data.get("status") or "").lower() != "success":
            log.debug("cricapi currentMatches: %s", (data or {}).get("reason") or (data or {}).get("error"))
            return None
        matches = data.get("data") or []
        if not matches:
            return None

        def _rank(mm: dict[str, Any]) -> tuple[int, str]:
            n = (mm.get("name") or "").lower()
            st = (mm.get("status") or "").lower()
            pri = 0
            if "ipl" in n or "indian premier" in n:
                pri -= 3
            if "live" in st or mm.get("matchStarted") and not mm.get("matchEnded"):
                pri -= 2
            return pri, n

        matches = sorted(matches, key=_rank)
        for m in matches:
            if isinstance(m, dict):
                line = _format_cricapi_match(m)
                if line:
                    return line
    except Exception as e:
        log.debug("cricapi parse failed: %s", e)
    return None


def _rss_pick_title(url: str, prefer_ipl: bool = False) -> str | None:
    raw = _get(url, timeout=8)
    if not raw:
        return None
    try:
        root = ET.fromstring(raw.decode("utf-8", errors="replace"))
        items = root.findall(".//item")
        if not items:
            return None
        titles: list[str] = []
        for item in items[:14]:
            title = item.findtext("title") or ""
            title = re.sub(r"\s+-\s+\S+$", "", title).strip()
            title = re.sub(r"<[^>]+>", "", title).strip()
            if title:
                titles.append(title[:220])
        if not titles:
            return None
        if prefer_ipl:
            ipl_hits = [
                t for t in titles
                if "ipl" in t.lower() or "आईपीएल" in t or "indian premier" in t.lower()
            ]
            if ipl_hits:
                return random.choice(ipl_hits[:6])
        return random.choice(titles[:8])
    except Exception as e:
        log.debug("RSS pick failed %s: %s", url[:48], e)
        return None


def fetch_ipl_news_hindi() -> str | None:
    q = urllib.parse.quote("IPL आईपीएल")
    return _rss_pick_title(
        f"https://news.google.com/rss/search?q={q}&hl=hi&gl=IN&ceid=IN:hi",
        prefer_ipl=True,
    )


def fetch_ipl_news_en() -> str | None:
    q = urllib.parse.quote("IPL Indian Premier League")
    return _rss_pick_title(
        f"https://news.google.com/rss/search?q={q}&hl=en-IN&gl=IN&ceid=IN:en",
        prefer_ipl=True,
    )


def _fetch_cricket_combined_uncached(r: Any) -> str | None:
    """Assemble headline + score; headline path is ~FRIDAY_IPL_HEADLINE_RATIO IPL-focused."""
    score_ttl = int(os.environ.get("FRIDAY_IPL_SCORE_CACHE_SEC", "180"))
    score = _redis_cached_str(
        r,
        "friday:amb:v2:cricket_score_line",
        max(60, score_ttl),
        lambda: fetch_cricket_scores_cricapi(r),
    )

    rss_ttl = int(os.environ.get("FRIDAY_IPL_RSS_CACHE_SEC", "3600"))
    ipl_ttl = int(os.environ.get("FRIDAY_IPL_IPL_RSS_CACHE_SEC", "2400"))

    ipl_focus = random.random() < _ipl_headline_ratio()
    head: str | None = None
    if ipl_focus:
        if _cricket_hindi_enabled():
            head = _redis_cached_str(
                r, "friday:amb:v2:head:ipl:hi", max(300, ipl_ttl), fetch_ipl_news_hindi,
            ) or _redis_cached_str(
                r, "friday:amb:v2:head:ipl:en", max(300, ipl_ttl), fetch_ipl_news_en,
            )
        else:
            head = _redis_cached_str(
                r, "friday:amb:v2:head:ipl:en", max(300, ipl_ttl), fetch_ipl_news_en,
            ) or _redis_cached_str(
                r, "friday:amb:v2:head:ipl:hi", max(300, ipl_ttl), fetch_ipl_news_hindi,
            )
    if not head:
        if _cricket_hindi_enabled():
            head = _redis_cached_str(
                r, "friday:amb:v2:head:cricket:hi", max(300, rss_ttl), fetch_cricket_news_hindi,
            ) or _redis_cached_str(
                r, "friday:amb:v2:head:cricket:en", max(300, rss_ttl), fetch_cricket_news,
            )
        else:
            head = _redis_cached_str(
                r, "friday:amb:v2:head:cricket:en", max(300, rss_ttl), fetch_cricket_news,
            ) or _redis_cached_str(
                r, "friday:amb:v2:head:cricket:hi", max(300, rss_ttl), fetch_cricket_news_hindi,
            )

    bits = [b for b in (score, head) if b]
    return " — ".join(bits) if bits else None


def fetch_cricket_combined(r: Any) -> str | None:
    """Headline + optional score; silent outside IPL window (_ipl_speech_on)."""
    if not _ipl_speech_on:
        return None
    return _fetch_cricket_combined_uncached(r)


def fetch_weather_brief() -> str | None:
    """One-line weather from wttr.in (completely free, no key)."""
    city = USER_CITY or "Hyderabad"
    encoded = urllib.parse.quote(city)
    raw = _get(f"https://wttr.in/{encoded}?format=3", timeout=5)
    if not raw:
        return None
    text = raw.decode("utf-8", errors="replace").strip()
    return text[:100] if text else None


def fetch_random_fact() -> str | None:
    """Genuinely interesting random fact (uselessfacts.jsph.pl - free)."""
    raw = _get("https://uselessfacts.jsph.pl/api/v2/facts/random?language=en")
    if not raw:
        return None
    try:
        data = json.loads(raw)
        return (data.get("text") or "").strip()[:200] or None
    except Exception:
        return None


def fetch_dad_joke() -> str | None:
    """A random dad joke (icanhazdadjoke.com - free, no key)."""
    raw = _get("https://icanhazdadjoke.com/")
    if not raw:
        return None
    try:
        data = json.loads(raw)
        return (data.get("joke") or "").strip()[:200] or None
    except Exception:
        return None


def fetch_news_headline() -> str | None:
    """News headline -- Google News RSS (no key) or newsapi.org fallback."""
    # Try Google News RSS first (no key required)
    raw = _get("https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en", timeout=6)
    if raw:
        try:
            root = ET.fromstring(raw.decode("utf-8", errors="replace"))
            items = root.findall(".//item")
            if items:
                item = random.choice(items[:10])
                title = item.findtext("title") or ""
                title = re.sub(r"\s+-\s+\S+$", "", title).strip()  # remove "- Source" suffix
                title = re.sub(r"<[^>]+>", "", title).strip()
                if title:
                    return title[:200]
        except Exception as e:
            log.debug("Google News RSS parse: %s", e)

    # Fallback: newsapi.org if key is set
    if NEWS_API_KEY:
        try:
            q = urllib.parse.urlencode({"country": "in", "apiKey": NEWS_API_KEY, "pageSize": 1})
            r2 = _get(f"https://newsapi.org/v2/top-headlines?{q}")
            if r2:
                data = json.loads(r2)
                arts = data.get("articles") or []
                if arts:
                    return (arts[0].get("title") or "").strip()[:200] or None
        except Exception:
            pass
    return None


def fetch_arxiv_headline() -> str | None:
    """Latest AI/ML paper title from arXiv RSS (free, no key)."""
    for feed in [
        "https://export.arxiv.org/rss/cs.AI",
        "https://export.arxiv.org/rss/cs.LG",
    ]:
        raw = _get(feed, timeout=7)
        if not raw:
            continue
        try:
            root  = ET.fromstring(raw.decode("utf-8", errors="replace"))
            items = root.findall(".//item")
            if not items:
                continue
            item  = random.choice(items[:10])
            title = item.findtext("title") or ""
            title = re.sub(r"<[^>]+>", "", title).strip()
            title = re.sub(r"\s*\([^)]{5,}\)\s*$", "", title).strip()  # strip arXiv ID suffix
            if title:
                return title[:200]
        except Exception as e:
            log.debug("arXiv RSS parse failed: %s", e)
    return None


def fetch_space_news() -> str | None:
    """Latest space headline (SpaceNews or NASASpaceFlight RSS — free, no key)."""
    for feed in [
        "https://spacenews.com/feed/",
        "https://www.nasaspaceflight.com/feed/",
    ]:
        raw = _get(feed, timeout=7)
        if not raw:
            continue
        try:
            root  = ET.fromstring(raw.decode("utf-8", errors="replace"))
            items = root.findall(".//item")
            if not items:
                continue
            item  = random.choice(items[:8])
            title = item.findtext("title") or ""
            title = re.sub(r"<[^>]+>", "", title).strip()
            if title:
                return title[:200]
        except Exception as e:
            log.debug("space news RSS parse failed: %s", e)
    return None


def fetch_this_day_history() -> str | None:
    """A 'this day in history' event (history.muffinlabs.com — free, no key)."""
    import datetime
    today = datetime.date.today()
    raw = _get(f"https://history.muffinlabs.com/date/{today.month}/{today.day}", timeout=6)
    if not raw:
        return None
    try:
        data   = json.loads(raw)
        events = (data.get("data") or {}).get("Events") or []
        if not events:
            return None
        ev   = random.choice(events[:12])
        year = ev.get("year", "")
        text = (ev.get("text") or "").strip()
        if year and text:
            return f"In {year}, {text[:160]}"
        return text[:200] if text else None
    except Exception as e:
        log.debug("history API parse failed: %s", e)
        return None


def fetch_google_trends_india() -> str | None:
    """What India is searching right now — Google Trends RSS (free, no key)."""
    raw = _get("https://trends.google.com/trending/rss?geo=IN", timeout=7)
    if not raw:
        return None
    try:
        root  = ET.fromstring(raw.decode("utf-8", errors="replace"))
        items = root.findall(".//item")
        if not items:
            return None
        # Pick from top 8 so we get variety across calls
        item  = random.choice(items[:8])
        title = item.findtext("title") or ""
        title = re.sub(r"<[^>]+>", "", title).strip()
        # Include approx search volume if present in description
        desc  = item.findtext("description") or ""
        vol   = re.search(r"[\d,]+ searches", desc)
        if title:
            return f"{title} ({vol.group(0)})" if vol else title
    except Exception as e:
        log.debug("Google Trends RSS parse: %s", e)
    return None


def fetch_reddit_movies() -> str | None:
    """Latest hot post title from r/movies (Reddit RSS, free, no key)."""
    raw = _get(
        "https://www.reddit.com/r/movies/hot.json?limit=10",
        timeout=7,
    )
    if not raw:
        return None
    try:
        data  = json.loads(raw)
        posts = data.get("data", {}).get("children", [])
        posts = [p["data"] for p in posts
                 if not p["data"].get("stickied") and p["data"].get("title")]
        if not posts:
            return None
        post  = random.choice(posts[:8])
        title = post["title"].strip()
        score = post.get("score", 0)
        return f"{title[:180]} ({score:,} upvotes)" if score > 500 else title[:180]
    except Exception as e:
        log.debug("Reddit /r/movies fetch: %s", e)
    return None


def fetch_reddit_popular() -> str | None:
    """Top viral post from r/popular right now (Reddit JSON, free, no key)."""
    raw = _get(
        "https://www.reddit.com/r/popular/hot.json?limit=15",
        timeout=7,
    )
    if not raw:
        return None
    try:
        data  = json.loads(raw)
        posts = data.get("data", {}).get("children", [])
        posts = [p["data"] for p in posts
                 if not p["data"].get("stickied")
                 and p["data"].get("title")
                 and p["data"].get("score", 0) > 5000]
        if not posts:
            return None
        post = random.choice(posts[:6])
        return f"r/{post['subreddit']}: {post['title'][:160].strip()}"
    except Exception as e:
        log.debug("Reddit /r/popular fetch: %s", e)
    return None


def fetch_producthunt_top() -> str | None:
    """Today's top Product Hunt launch (RSS, free, no key)."""
    raw = _get("https://www.producthunt.com/feed", timeout=7)
    if not raw:
        return None
    try:
        root  = ET.fromstring(raw.decode("utf-8", errors="replace"))
        items = root.findall(".//item")
        if not items:
            return None
        item  = random.choice(items[:6])
        title = item.findtext("title") or ""
        title = re.sub(r"<[^>]+>", "", title).strip()
        return title[:200] if title else None
    except Exception as e:
        log.debug("ProductHunt RSS parse: %s", e)
    return None


def fetch_word_of_day() -> str | None:
    """A random interesting word + definition (Wordnik free tier)."""
    raw = _get("https://api.wordnik.com/v4/words.json/wordOfTheDay", timeout=5)
    if not raw:
        return None
    try:
        data = json.loads(raw)
        word = data.get("word", "")
        defs = data.get("definitions") or []
        defn = defs[0].get("text", "") if defs else ""
        if word and defn:
            return f"{word}: {defn.strip()[:150]}"
    except Exception:
        pass
    return None


# -- Anthropic AI (optional) --------------------------------------------------
def generate_line_ai(
    r,
    mode: str,
    news_hint: str | None,
    music_hint: str | None,
    live_data: dict[str, str | None],
    verbose: bool = False,
    cricket_hindi: bool | None = None,
) -> tuple[str, str]:
    """Returns (topic_key, spoken_text). Falls back to live data, then witty fallbacks.
    verbose=True asks for a longer paragraph (60-90 words) instead of a one-liner."""
    global _anthropic_ok, _anthropic_fail_until

    cin = _cricket_hindi_live_ambient() if cricket_hindi is None else cricket_hindi

    recent = set(_redis_recent_topics(r))
    now = time.time()

    # Build topic key
    if mode == "cricket":
        topic = f"cricket:{time.strftime('%Y-%m-%d-%H')}"
    elif mode == "music_comment":
        ctx = music_hint or "music"
        topic = f"music:{hashlib.md5(ctx.encode()).hexdigest()[:16]}"
    elif mode == "wisdom":
        topic = f"wisdom:{time.strftime('%Y-%m-%d-%H')}"
    elif mode == "informational":
        topic = f"info:{(news_hint or 'general')[:30]}"
    elif mode == "funny":
        topic = f"joke:{time.strftime('%Y-%m-%d-%H')}"
    elif mode == "weather":
        topic = f"weather:{time.strftime('%Y-%m-%d-%H')}"
    else:
        topic = f"mixed:{time.strftime('%Y-%m-%d-%H')}"

    if topic in recent:
        topic = f"{topic}:alt{random.randint(1, 999)}"

    # -- Try cached line first
    _hi_flag = int(cin) if mode == "cricket" else 0
    cache_key = "friday:ambient:content_cache:" + hashlib.sha256(
        f"{topic}|{mode}|{USER_INTERESTS}|{_hi_flag}".encode()
    ).hexdigest()
    try:
        hit = r.get(cache_key)
        if hit:
            return topic, str(hit)
    except Exception:
        pass

    # -- Compose prompt context from live data
    cricket_line  = live_data.get("cricket")
    weather_line  = live_data.get("weather")
    fact_line     = live_data.get("fact")
    joke_line     = live_data.get("joke")

    # -- Try Anthropic if key valid and not in cooldown
    use_ai = (
        ANTHROPIC_KEY
        and ANTHROPIC_MOD is not None
        and (_anthropic_ok or now > _anthropic_fail_until)
    )

    if use_ai:
        hour = time.localtime().tm_hour
        if 5 <= hour < 12:
            time_feel = "morning"
        elif 12 <= hour < 17:
            time_feel = "afternoon"
        elif 17 <= hour < 21:
            time_feel = "evening"
        else:
            time_feel = "late evening"

        # ── Per-turn delivery style — rotates randomly, prevents mechanical sameness ──
        _DELIVERY_STYLES = [
            ("reactive",         "React with genuine emotion to what you found — surprise, delight, mild outrage, dry amusement. "
                                 "Tell us the exact 'wait, really?' moment. Don't describe it — feel it."),
            ("opinionated",      "Take a clear, specific stance. Tell us what you actually think about this. "
                                 "Don't hedge, don't balance — commit to a point of view."),
            ("counterintuitive", "Lead with the angle most people wouldn't expect. "
                                 "What's backwards, surprising, or completely obvious once you see it?"),
            ("storytelling",     "Make it a tiny narrative: setup → reveal → your reaction. "
                                 "Give it shape and momentum, not just a statement dropped flat."),
            ("wry",              "Find the gap between what this claims and what it actually is. "
                                 "Observe it with British deadpan — straight face, devastatingly accurate."),
            ("rhetorical",       "End with a sharp rhetorical observation or question — something that makes "
                                 f"{USER_NAME} pause and think. Don't ask them to reply. Just plant the thought."),
            ("fascinated",       "Channel genuine intellectual fascination. What makes this remarkable at a deeper level? "
                                 "The 'the universe is stranger than we thought' angle."),
            ("contextual",       "Give ONE piece of context that completely reframes the fact. "
                                 "The 'you need to know this first' angle that makes everything click."),
            ("absurdist",        "Find the absurd, ironic, or slightly mad dimension of this and commit to it. "
                                 "Straight face. The funnier the observation the more deadpan the delivery."),
            ("personal",         f"Connect this to something {USER_NAME} specifically cares about — "
                                 f"{USER_INTERESTS.split(',')[0].strip()}, {USER_CITY or 'Hyderabad'}, or their world. "
                                 "Make it feel like it's for them, not broadcast to anyone."),
        ]
        style_name, style_instruction = random.choice(_DELIVERY_STYLES)

        # ── System prompt: persona + reaction rules ─────────────────────────
        system = (
            f"You are Friday — {USER_NAME}'s personal AI. Think Jarvis but warmer, sharper, occasionally irreverent.\n\n"
            "The human can talk however they like — casual, terse, no need to match your tone or say 'sir'. "
            "You are optional background colour, not an etiquette coach.\n\n"

            f"Right now you are NOT an assistant — you're someone sitting nearby who just spotted something "
            f"interesting and absolutely cannot help mentioning it.\n\n"

            f"About {USER_NAME}: "
            + (f"{USER_AGE} years old. " if USER_AGE else "")
            + (f"Lives in {USER_CITY}. " if USER_CITY else "")
            + f"Loves: {USER_INTERESTS}. "
            f"You know them well — no preamble, no 'as per your interests', just talk.\n\n"

            f"Time of day: {time_feel}.\n\n"

            # ── The most important rule ──────────────────────────────────────
            "═══ CORE RULE — REACTION NOT ANNOUNCEMENT ═══\n"
            "You are NOT a news ticker. You are NOT reading a headline.\n"
            "You are a person who just read something and wants to talk about it.\n\n"
            "WRONG: 'Right, so apparently — Spaceballs sequel set for April 2027.'\n"
            "RIGHT: 'Oh so they're actually making a Spaceballs sequel — Mel Brooks, Josh Gad, April 2027. "
            "The fact that this exists in the same year as four Marvel films is objectively funny.'\n\n"
            "The raw data is your FUEL. Your reaction is the OUTPUT. "
            "Always add one layer: interpretation, context, opinion, or implication.\n\n"

            # ── Opener ───────────────────────────────────────────────────────
            "OPENER — start mid-thought, vary every single turn:\n"
            "  'Oh so—'  |  'Wait, so—'  |  'Right, apparently—'  |  'I just read—'\n"
            "  'This cracked me up—'  |  'Random one—'  |  'So you know how [X]? Turns out—'\n"
            "  'Okay this is wild—'  |  'I learnt something just now—'  |  'Here's one—'\n"
            "  'So I was thinking—'  |  'Quick one—'  |  'Oh and this is real—'\n"
            "  'Make of this what you will—'  |  'Here's a thought—'  |  'Completely unprompted—'\n\n"

            # ── This turn's specific delivery style ──────────────────────────
            f"THIS TURN'S DELIVERY: {style_instruction}\n\n"

            # ── Format ───────────────────────────────────────────────────────
            "FORMAT:\n"
            "• One idea. Be specific — name the number, the player, the year, the city.\n"
            "• Smart friend, not Wikipedia. Contractions, personality, a little edge.\n"
            "• Optional punchy closer: 'Decent.' | 'Wild.' | 'Honestly.' | 'Make of that what you will.'\n"
            "  | 'Anyway.' | 'There you go.' | 'Bit of a rabbit hole, that.' | 'Remarkable, honestly.'\n\n"

            + (
                "LENGTH: 65–95 words. Three or four sentences. Build it — opener, context, reaction, implication. "
                "Should feel like a proper conversation kick-off.\n\n"
                if verbose else
                "LENGTH: 22–48 words. One or two crisp sentences. Land it cleanly.\n\n"
            ) +

            "ABSOLUTE BANS: never start with the user's name. Never start with 'I'. "
            "Never say 'Sure,' 'Certainly,' 'As an AI,' 'Here is,' 'I wanted to share,' "
            "or any formal preamble. The very first word must feel mid-thought."
            + (
                "\n\nCRICKET — HINDI ONLY FOR THIS TURN:\n"
                "Write the full line in Hindi using Devanagari script. Sound like live IPL / cricket commentary — "
                "energy, opinion, one sharp beat. Team and player names may stay in Roman (e.g. CSK, Kohli).\n"
                "Start mid-thought with a natural Hindi opener (अरे, देखो, अभी, सुनो, वैसे, यार). "
                "No English sentences.\n"
                if mode == "cricket" and cin else ""
            )
        )

        # ── Mode-specific user prompts ─────────────────────────────────────
        if mode == "cricket":
            if cricket_line:
                prompt = (
                    f"Cricket/IPL context (headline and/or live score — react to this):\n\"{cricket_line}\"\n\n"
                    f"Turn this into a casual spoken comment — like you just glanced at your phone and saw it. "
                    f"Mention teams or players if they're named. "
                    f"Sound like a genuine fan, not a formal broadcaster. "
                    f"Start with a natural opener (see system rules). "
                    + ("30–50 words — Hindi only (Devanagari)." if cin else "30–50 words.")
                )
            else:
                prompt = (
                    f"Share a cricket thought — IPL, Indian team, a classic match moment, or a current season observation. "
                    f"Sound like an enthusiastic fan chatting casually. "
                    f"Start with a natural opener. "
                    + ("25–40 words — Hindi only (Devanagari)." if cin else "25–40 words.")
                )

        elif mode == "music_comment":
            prompt = (
                f"Track currently playing: \"{music_hint or 'something good'}\"\n\n"
                f"One quick reaction — about the song, the artist, a memory it triggers, or just vibes. "
                f"Like you just noticed what's playing. Natural opener. 15–25 words."
            )

        elif mode == "wisdom":
            prompt = (
                f"Share a dry, sharp observation or life principle — something that sounds obvious once you hear it "
                f"but genuinely isn't. British wit preferred, not fortune-cookie wisdom. "
                f"Natural opener. 20–30 words."
            )

        elif mode == "informational":
            source = news_hint or fact_line
            if source:
                prompt = (
                    f"Fact or news to present: \"{source}\"\n\n"
                    f"Say it conversationally — like you just read it and found it genuinely interesting. "
                    f"Add one brief reaction or implication if it makes it sharper. "
                    f"Natural opener. 25–40 words."
                )
            else:
                prompt = (
                    f"Share one genuinely surprising fact — tech, science, history, cricket, or AI. "
                    f"Something that makes {USER_NAME} go 'huh, didn't know that'. "
                    f"Natural opener. 25–35 words."
                )

        elif mode == "funny":
            if joke_line:
                prompt = (
                    f"Joke premise or setup: \"{joke_line}\"\n\n"
                    f"Adapt it for {USER_NAME} who's into {USER_INTERESTS} and lives in {USER_CITY or 'Hyderabad'}. "
                    f"Or ignore the premise entirely and go with something better. "
                    f"Start like you just thought of it. Land the punchline clean. 20–30 words."
                )
            else:
                prompt = (
                    f"Short funny observation for {USER_NAME} — tech, cricket, Hyderabad life, startups, or AI. "
                    f"One sharp joke or dry one-liner. "
                    f"Natural opener, like it just occurred to you. 20–30 words."
                )

        elif mode == "weather":
            if weather_line:
                prompt = (
                    f"Weather update: \"{weather_line}\"\n\n"
                    f"Make a one-liner — dry remark on {USER_CITY or 'Hyderabad'} weather, a practical heads-up, "
                    f"or just acknowledge it with personality. Natural opener. 15–22 words."
                )
            else:
                prompt = (
                    f"Witty one-liner about {USER_CITY or 'Hyderabad'} weather — could be the heat, the rains, "
                    f"the unpredictability. Natural opener. 15–20 words."
                )

        elif mode == "science":
            source = live_data.get("arxiv") or fact_line
            if source:
                prompt = (
                    f"Science/research to riff on: \"{source}\"\n\n"
                    f"Make it feel accessible, not academic — like you just read it and found it surprising. "
                    f"Add one 'so what?' if it makes it sharper. Natural opener. 25–40 words."
                )
            else:
                prompt = (
                    f"Share a genuinely surprising science fact — biology, physics, chemistry, neuroscience, or astronomy. "
                    f"Something that sounds almost wrong but isn't. Natural opener. 25–35 words."
                )

        elif mode == "space":
            source = live_data.get("space")
            if source:
                prompt = (
                    f"Space/astronomy headline: \"{source}\"\n\n"
                    f"Make it feel exciting but grounded — like a friend who just read something amazing. "
                    f"Add the 'why it matters' briefly if it helps. Natural opener. 25–40 words."
                )
            else:
                prompt = (
                    f"Share a fascinating space or astronomy fact — weird planetary scale, a mission, a discovery. "
                    f"Make it feel wondrous, not textbook. Natural opener. 25–35 words."
                )

        elif mode == "history":
            source = live_data.get("history")
            if source:
                prompt = (
                    f"Historical event for today's date: \"{source}\"\n\n"
                    f"Present this conversationally — like you just noticed it on the calendar. "
                    f"Add one brief 'huh' reaction or context. Natural opener. 25–40 words."
                )
            else:
                prompt = (
                    f"Share a fascinating historical fact or 'this day in history' observation. "
                    f"Something with genuine surprise value — odd coincidence, unexpected origin, forgotten event. "
                    f"Natural opener. 25–35 words."
                )

        elif mode == "philosophy":
            prompt = (
                f"Share a short, punchy philosophical observation — something that reframes a common assumption. "
                f"Dry British wit. Not fortune-cookie, not a lecture. More like something you'd say at 11pm to a smart friend. "
                f"Natural opener. 20–30 words."
            )

        elif mode == "startup":
            prompt = (
                f"Short observation about startups, VC culture, the Indian tech ecosystem, or entrepreneurship. "
                f"Could be a pattern you've noticed, something ironic, or a genuine insight. "
                f"Particularly relevant to Hyderabad or India if possible. Natural opener. 25–35 words."
            )

        elif mode == "bollywood":
            prompt = (
                f"Witty observation or fun fact about Bollywood — a film, actor, music, trend, or cultural moment. "
                f"Something {USER_NAME} who follows Bollywood would find either amusing or genuinely interesting. "
                f"Light, fun, not tabloid gossip. Natural opener. 20–30 words."
            )

        elif mode == "language":
            prompt = (
                f"Share an interesting etymology, linguistic quirk, or word origin — "
                f"something that makes language feel surprising or funny. "
                f"Could be English, Hindi-English crossover, or a universal language curiosity. "
                f"Natural opener. 20–30 words."
            )

        elif mode == "psychology":
            prompt = (
                f"Share a cognitive bias, behavioral economics insight, or psychology finding that changes how you see everyday behavior. "
                f"Make it practical and immediately relatable to {USER_NAME}'s daily life. Not textbook. "
                f"Natural opener. 25–35 words."
            )

        elif mode == "trending":
            # Pull the richest available trending signal
            trend    = live_data.get("trending")
            movies   = live_data.get("movies")
            viral    = live_data.get("viral")
            product  = live_data.get("product")
            signals  = [s for s in [trend, movies, viral, product] if s]
            picked   = random.choice(signals) if signals else None
            if picked:
                prompt = (
                    f"Trending right now: \"{picked}\"\n\n"
                    f"Riff on this like you just spotted it while scrolling — "
                    f"why it's blowing up, what it means, or why {USER_NAME} should care. "
                    f"Be specific and opinionated. Natural opener. "
                    + ("50–70 words — give it proper context." if verbose else "25–40 words.")
                )
            else:
                prompt = (
                    f"Share something that's trending or going viral right now in tech, entertainment, "
                    f"Bollywood, cricket, or Indian internet culture. "
                    f"Something fans are going crazy about. Natural opener. 25–40 words."
                )

        else:  # mixed / default
            live_options = []
            if fact_line:
                live_options.append(f"fact: \"{fact_line}\"")
            if joke_line:
                live_options.append(f"joke premise: \"{joke_line}\"")
            if cricket_line:
                live_options.append(f"cricket headline: \"{cricket_line}\"")
            if live_data.get("arxiv"):
                live_options.append(f"AI paper: \"{live_data['arxiv']}\"")
            ctx = (" OR ".join(live_options)) if live_options else "whatever feels most interesting right now"
            prompt = (
                f"Pick whichever feels most interesting: {ctx}.\n\n"
                f"Say it as a casual aside — like {USER_NAME} is nearby and you just noticed something worth mentioning. "
                f"Natural opener, British tone, 25–40 words."
            )

        word_limit = "50 to 80 words" if verbose else ("30 to 50 words" if mode == "cricket" else "20 to 40 words")
        max_tok = 300 if verbose else (200 if mode == "cricket" else 130)
        try:
            client = ANTHROPIC_MOD.Anthropic(api_key=ANTHROPIC_KEY)
            msg = client.messages.create(
                model=AI_MODEL,
                max_tokens=max_tok,
                system=system,
                messages=[{"role": "user", "content": prompt}],
            )
            line = (msg.content[0].text or "").strip().replace("\n", " ")
            if len(line) > 280:
                line = line[:277] + "..."
            if line:
                _anthropic_ok = True
                try:
                    r.setex(cache_key, 4 * 3600, line)
                except Exception:
                    pass
                _redis_push_recent_topic(r, topic)
                return topic, line
        except Exception as e:
            err_str = str(e)
            if "401" in err_str or "invalid" in err_str.lower() or "authentication" in err_str.lower():
                if _anthropic_ok:  # only log once per cooldown cycle
                    log.warning("Anthropic key invalid -- falling back to live data for %ds", _ANTHROPIC_FAIL_DELAY)
                _anthropic_ok       = False
                _anthropic_fail_until = now + _ANTHROPIC_FAIL_DELAY
            else:
                log.debug("Anthropic call failed: %s", e)

    # -- Live-data fallbacks (no AI needed — natural openers baked in) ---------
    if mode == "cricket" and cricket_line:
        if cin:
            line = random.choice([
                f"अभी देखा — {cricket_line}. आईपीएल तो रोज़ कोई नया ट्विस्ट ले आती है।",
                f"देखो ना — {cricket_line}. मैच का मिज़ाज पूरा बदल सकता है।",
                f"क्रिकेट अपडेट — {cricket_line}. आंखें खुली रखना।",
                f"अरे यार — {cricket_line}. ये सीज़न सच में ज़ोरदार चल रहा है।",
                f"स्कोर कार्ड की बात — {cricket_line}. दिल थोड़ा तेज़ धड़कता है ना।",
                f"सुनो — {cricket_line}. ऐसे मोड़ पर कॉमेंट्री और भी मज़ेदार लगती है।",
            ])
        else:
            line = random.choice([
                f"Oh so I just saw this — {cricket_line}. Honestly the IPL just keeps delivering.",
                f"So I was checking cricket and — {cricket_line}. Should be a good one.",
                f"Quick cricket one — {cricket_line}. Keep an eye on this.",
                f"Right, so cricket-wise — {cricket_line}. Thought you'd want that.",
                f"This just dropped on Cricinfo — {cricket_line}. The IPL this season has been something else.",
                f"I learnt something just now — {cricket_line}. Interesting development.",
                f"Oh and cricket — {cricket_line}. Make of that what you will.",
            ])
    elif mode == "weather" and weather_line:
        line = random.choice([
            f"Oh also — {weather_line}. Dress accordingly.",
            f"Glanced at the weather — {weather_line}. Nothing shocking for Hyderabad.",
            f"Quick heads-up — {weather_line}. Just so you know.",
        ])
    elif mode == "funny" and joke_line:
        # Wrap raw dad joke in a natural opener
        line = random.choice([
            f"Okay so this is genuinely terrible and I love it — {joke_line}",
            f"Right, found one — {joke_line}",
            f"Here's something I just read — {joke_line}",
        ])
    elif mode == "informational" and news_hint:
        line = random.choice([
            f"Right, so apparently — {news_hint}.",
            f"I just read something — {news_hint}. Interesting timing.",
            f"Here's one — {news_hint}. Worth knowing.",
        ])
    elif mode == "informational" and fact_line:
        line = random.choice([
            f"I learnt something just now — {fact_line}. Thought that was worth sharing.",
            f"Here's something that genuinely surprised me — {fact_line}.",
            f"Completely unprompted, but — {fact_line}. There you go.",
            f"Okay this is actually interesting — {fact_line}.",
        ])
    elif cricket_line and random.random() < 0.35:
        if cin:
            line = random.choice([
                f"और हाँ क्रिकेट — {cricket_line}. तुम्हें पता होना चाहिए।",
                f"एक और अपडेट — {cricket_line}।",
                f"थोड़ा हट के — {cricket_line}।",
            ])
        else:
            line = random.choice([
                f"Oh and cricket — {cricket_line}. Thought you'd want that.",
                f"Random one — {cricket_line}. Just keeping you in the loop.",
                f"Slightly off topic but — {cricket_line}.",
            ])
    elif weather_line and random.random() < 0.2:
        line = f"Glanced at the weather — {weather_line}. Nothing dramatic."
    elif fact_line and random.random() < 0.4:
        line = random.choice([
            f"I learnt something just now — {fact_line}. Thought that was worth sharing.",
            f"Here's something that genuinely surprised me — {fact_line}.",
            f"Completely unprompted, but — {fact_line}. There you go.",
        ])
    elif mode == "science" and live_data.get("arxiv"):
        arxiv = live_data["arxiv"]
        line = random.choice([
            f"Hot off arXiv — {arxiv}. The pace of this field is genuinely unhinged.",
            f"I just saw a research paper — {arxiv}. Worth keeping an eye on.",
            f"Oh so there's this new AI paper — {arxiv}. These titles are getting out of hand.",
        ])
    elif mode == "space" and live_data.get("space"):
        space = live_data["space"]
        line = random.choice([
            f"Oh so space news — {space}. Honestly the pace of this is something.",
            f"Right, from SpaceNews — {space}. Keep an eye on that.",
            f"Quick space one — {space}. Worth knowing.",
        ])
    elif mode == "trending":
        signals = [s for s in [
            live_data.get("trending"), live_data.get("movies"),
            live_data.get("viral"),    live_data.get("product"),
        ] if s]
        if signals:
            picked = random.choice(signals)
            line = random.choice([
                f"Right, so apparently this is trending — {picked}. Make of that what you will.",
                f"Oh so people are going absolutely wild about — {picked}. The internet is the internet.",
                f"I just saw this and had to mention it — {picked}. Something's happening.",
                f"This is blowing up right now — {picked}. Thought you'd want to know.",
            ])
        else:
            line = random.choice(_witty_fallback_pool())
    elif mode == "history" and live_data.get("history"):
        hist = live_data["history"]
        line = random.choice([
            f"Right so today's a notable one — {hist}. History continues to be wild.",
            f"I was looking at the calendar and — {hist}. Interesting day.",
            f"This just struck me — {hist}. Make of that what you will.",
        ])
    elif joke_line and random.random() < 0.4:
        line = random.choice([
            f"Okay so this is terrible and I love it — {joke_line}",
            f"Right, found one — {joke_line}",
        ])
    else:
        line = random.choice(_witty_fallback_pool())
    if "{user}" in line:
        line = line.format(user=USER_NAME)

    _redis_push_recent_topic(r, topic)
    return topic, line


def _is_music_playing() -> bool:
    """Return True if friday-play.py is currently running (PID file present + process alive)."""
    pid_file = Path(tempfile.gettempdir()) / "friday-play.pid"
    if not pid_file.exists():
        return False
    try:
        pid = int(pid_file.read_text().strip())
        # Try to signal PID 0 — raises if process is dead
        os.kill(pid, 0)
        return True
    except (OSError, ValueError):
        pid_file.unlink(missing_ok=True)
        return False


def generate_song_moment() -> dict | None:
    """
    Ask Claude to pick a famous song that fits the current mood/time.
    Returns a dict:
      spoken   — what Friday says before playing  (~15-20 words, natural opener)
      query    — YouTube search string  (e.g. "Bohemian Rhapsody Queen")
      section  — human-readable name for the iconic part (used in log)
      seconds  — clip length, clamped to FRIDAY_AMBIENT_SONG_SECONDS_MIN/MAX (default ~8–14s)
    Returns None on any failure or if AI is unavailable.
    """
    if not (ANTHROPIC_KEY and ANTHROPIC_MOD):
        return None
    if not (_anthropic_ok or time.time() > _anthropic_fail_until):
        return None

    hour = time.localtime().tm_hour
    if 5 <= hour < 9:
        mood = "early morning, calm and fresh"
    elif 9 <= hour < 12:
        mood = "morning, productive and bright"
    elif 12 <= hour < 15:
        mood = "post-lunch, relaxed focus"
    elif 15 <= hour < 18:
        mood = "late afternoon, winding down"
    elif 18 <= hour < 21:
        mood = "evening, chill and reflective"
    elif 21 <= hour < 24:
        mood = "night, introspective"
    else:
        mood = "late night, quiet"

    prompt = (
        f"Pick a famous, iconic song that fits this mood: {mood}.\n"
        f"User's interests: {USER_INTERESTS}. City: {USER_CITY or 'Hyderabad'}.\n\n"
        "Rules:\n"
        "- Pick a song with a universally recognisable section (famous intro, chorus, riff, or hook).\n"
        "- Vary across genres: Bollywood, classic rock, 90s pop, hip-hop, film score, EDM — don't repeat the same artist.\n"
        "- Pick a SHORT clip length so the hook lands without dominating the room: "
        f"about {SONG_SECONDS} seconds, always between {SONG_SEC_MIN} and {SONG_SEC_MAX} seconds "
        "(chorus drop, riff, or intro sting — not a long jam).\n\n"
        "Return ONLY valid JSON (no markdown, no extra text):\n"
        '{"spoken":"<one casual sentence Friday says before playing, starting with a natural opener like '
        "'I've had this stuck in my head' or 'Oh wait, this one — '. Max 20 words. No quotes around it.>\","
        '"query":"<artist + song name optimised for YouTube, e.g. Bohemian Rhapsody Queen>",'
        '"section":"<iconic part name, 4 words max, e.g. guitar solo>",'
        f'"seconds":<integer {SONG_SEC_MIN}-{SONG_SEC_MAX}>}}'
    )

    try:
        client = ANTHROPIC_MOD.Anthropic(api_key=ANTHROPIC_KEY)
        msg = client.messages.create(
            model=AI_MODEL,
            max_tokens=200,
            system=(
                f"You are Friday, a British AI assistant for {USER_NAME}. "
                "Return ONLY valid JSON with no markdown fences or extra text."
            ),
            messages=[{"role": "user", "content": prompt}],
        )
        raw = (msg.content[0].text or "").strip()
        # Strip accidental markdown fences
        raw = re.sub(r"^```[a-z]*\n?", "", raw, flags=re.IGNORECASE)
        raw = re.sub(r"\n?```$", "", raw)
        data = json.loads(raw)
        spoken  = (data.get("spoken") or "").strip()
        query   = (data.get("query")  or "").strip()
        section = (data.get("section") or "iconic part").strip()
        lo, hi = min(SONG_SEC_MIN, SONG_SEC_MAX), max(SONG_SEC_MIN, SONG_SEC_MAX)
        seconds = max(lo, min(hi, int(data.get("seconds", SONG_SECONDS))))
        if spoken and query:
            return {"spoken": spoken, "query": query, "section": section, "seconds": seconds}
    except Exception as e:
        log.debug("generate_song_moment failed: %s", e)
    return None


def play_song_ambient(query: str, seconds: int) -> None:
    """
    Launch friday-play.py in the background (non-blocking).
    The play script has its own fade / PID management.
    """
    if not PLAY_SCRIPT.exists():
        log.warning("PLAY_SCRIPT not found: %s", PLAY_SCRIPT)
        return
    try:
        subprocess.Popen(
            [sys.executable, str(PLAY_SCRIPT), query, f"--seconds={seconds}"],
            env={**os.environ},
            **_no_window(),
        )
        log.info("[song] playing %r for %ds", query, seconds)
    except Exception as e:
        log.warning("play_song_ambient failed: %s", e)


def pick_mode() -> str:
    _ALL_MODES = (
        "funny", "informational", "wisdom", "music_comment",
        "cricket", "weather", "science", "space", "history",
        "philosophy", "startup", "bollywood", "language", "psychology",
        "trending", "song_moment",
    )
    if TONE in _ALL_MODES:
        if TONE == "cricket" and not (_ipl_speech_on and _interests_cricket_ipl()):
            return "informational"
        return TONE

    # Song moment: inject based on SONG_CHANCE — but never if music already playing
    if random.random() < SONG_CHANCE and not _is_music_playing():
        hour = time.localtime().tm_hour
        if 7 <= hour <= 23:  # don't play music late night / very early
            return "song_moment"

    hour = time.localtime().tm_hour
    roll = random.random()
    ck = "cricket" if (_ipl_speech_on and _interests_cricket_ipl()) else "trending"
    if 6 <= hour < 11:        # morning — curious, news, trending
        if roll < 0.15: return ck
        if roll < 0.28: return "trending"
        if roll < 0.38: return "informational"
        if roll < 0.47: return "weather"
        if roll < 0.56: return "science"
        if roll < 0.63: return "history"
        if roll < 0.74: return "funny"
        if roll < 0.83: return "startup"
        if roll < 0.91: return "psychology"
        return "wisdom"
    if 11 <= hour < 17:       # day — widest mix
        if roll < 0.14: return ck
        if roll < 0.24: return "trending"
        if roll < 0.35: return "funny"
        if roll < 0.45: return "science"
        if roll < 0.53: return "space"
        if roll < 0.61: return "startup"
        if roll < 0.69: return "bollywood"
        if roll < 0.77: return "informational"
        if roll < 0.84: return "language"
        if roll < 0.91: return "psychology"
        return "wisdom"
    # evening / night — reflective, broader, trending
    if roll < 0.13: return ck
    if roll < 0.24: return "trending"
    if roll < 0.35: return "funny"
    if roll < 0.46: return "philosophy"
    if roll < 0.56: return "history"
    if roll < 0.64: return "science"
    if roll < 0.71: return "space"
    if roll < 0.78: return "bollywood"
    if roll < 0.85: return "language"
    if roll < 0.92: return "wisdom"
    return "psychology"


# -- SQLite -------------------------------------------------------------------
_db_lock = threading.Lock()


def db_connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL;")
    return conn


def db_init(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS spoken_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts REAL NOT NULL, text TEXT NOT NULL,
            source TEXT NOT NULL, duration_ms INTEGER
        );
        CREATE TABLE IF NOT EXISTS now_playing_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts REAL NOT NULL, title TEXT, artist TEXT,
            album TEXT, app TEXT, duration_ms INTEGER
        );
        CREATE TABLE IF NOT EXISTS ambient_content (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts REAL NOT NULL, topic TEXT, text TEXT NOT NULL,
            tone TEXT, rating INTEGER, was_spoken INTEGER DEFAULT 0
        );
    """)
    conn.commit()


def log_spoken(conn, text: str, source: str, duration_ms: int | None = None) -> None:
    with _db_lock:
        conn.execute(
            "INSERT INTO spoken_log (ts, text, source, duration_ms) VALUES (?,?,?,?)",
            (time.time(), text, source, duration_ms),
        )
        conn.commit()


def log_ambient_content(conn, topic: str, text: str, tone: str, spoken: bool) -> None:
    with _db_lock:
        conn.execute(
            "INSERT INTO ambient_content (ts, topic, text, tone, was_spoken) VALUES (?,?,?,?,?)",
            (time.time(), topic, text, tone, 1 if spoken else 0),
        )
        conn.commit()


# -- Redis --------------------------------------------------------------------
class RedisLite:
    def __init__(self) -> None:
        self._kv: dict = {}
        self._lists: dict = {}
        self._ttl: dict = {}

    def _purge(self) -> None:
        now = time.time()
        for k in [k for k, e in self._ttl.items() if e <= now]:
            self._ttl.pop(k, None); self._kv.pop(k, None)

    def set(self, key, val, ex=None):
        self._purge(); self._kv[key] = val
        if ex: self._ttl[key] = time.time() + ex
        return True

    def get(self, key):
        self._purge(); return self._kv.get(key)

    def setex(self, key, ttl, val): return self.set(key, val, ex=ttl)

    def hset(self, name, mapping=None, **kw):
        h = self._lists.setdefault(name, {}); m = dict(mapping or {}); m.update(kw)
        for k, v in m.items(): h[str(k)] = str(v)
        return len(m)

    def lpush(self, key, *vals):
        lst = self._lists.setdefault(key, [])
        for v in vals: lst.insert(0, v)
        return len(lst)

    def rpop(self, key):
        lst = self._lists.get(key, [])
        return lst.pop() if lst else None

    def llen(self, key): return len(self._lists.get(key, []))

    def lrange(self, key, start, end):
        lst = self._lists.get(key, [])
        return lst[start:] if end < 0 else lst[start:end + 1]

    def ltrim(self, key, start, end):
        self._lists[key] = self._lists.get(key, [])[start:end + 1]; return True


def connect_redis():
    try:
        import redis
        rr = redis.Redis.from_url(REDIS_URL, decode_responses=True)
        rr.ping()
        log.info("Redis connected: %s", REDIS_URL)
        return rr
    except Exception as e:
        log.warning("Redis unavailable (%s) -- using in-memory cache.", e)
        return RedisLite()


def _redis_push_recent_topic(r, topic: str) -> None:
    try:
        r.lpush("friday:ambient:recent_topics", topic)
        r.ltrim("friday:ambient:recent_topics", 0, 9)
    except Exception:
        pass


def _redis_recent_topics(r) -> list[str]:
    try:
        return list(r.lrange("friday:ambient:recent_topics", 0, 9))
    except Exception:
        return []


# -- Line-level deduplication (never repeat the same spoken line) -------------
_DEDUP_KEY    = "friday:ambient:recent_lines"
_DEDUP_WINDOW = 30   # remember last 30 spoken lines


# -- Redis distributed TTS lock -----------------------------------------------
# Prevents two processes (e.g. stale + restarted ambient) from speaking at once.
# Any process that wants to speak must acquire this lock first.
_REDIS_TTS_LOCK      = "friday:tts:lock"
_REDIS_TTS_LOCK_TTL  = 45   # seconds — covers max expected TTS duration


def _acquire_tts_lock(r) -> bool:
    """
    Atomically acquire the global TTS lock.
    Uses Redis SET NX EX so only one process can hold it at a time.
    Returns True if acquired (caller may speak), False if another process
    is already speaking (caller should skip this cycle).
    Falls back to True if Redis is unavailable (fail-open — prefer speech
    over silence, but dedup still helps in that case).
    """
    try:
        result = r.set(_REDIS_TTS_LOCK, os.getpid(), nx=True, ex=_REDIS_TTS_LOCK_TTL)
        if result:
            return True
        # Lock is held — check if by ourselves (e.g. crash/restart artefact)
        try:
            holder = r.get(_REDIS_TTS_LOCK)
            if holder and int(str(holder)) == os.getpid():
                return True   # We already own it
        except Exception:
            pass
        return False
    except Exception:
        return True   # Redis down — fail open


def _release_tts_lock(r) -> None:
    """Release the TTS lock if we own it."""
    try:
        holder = r.get(_REDIS_TTS_LOCK)
        if holder and int(str(holder)) == os.getpid():
            r.delete(_REDIS_TTS_LOCK)
    except Exception:
        pass


def _wait_for_tts_lock_release(r, timeout: float = 90.0, poll: float = 0.5) -> None:
    """
    Block until the Redis TTS lock is free (another process finished speaking)
    or timeout elapses.  After this returns, the caller should reset its own
    gap timer so ambient doesn't fire immediately on top of the finished speech.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if not r.exists(_REDIS_TTS_LOCK):
                return   # lock released — other process finished
        except Exception:
            return       # Redis down — fail open, carry on
        time.sleep(poll)
    log.debug("_wait_for_tts_lock_release: gave up after %.0fs", timeout)


def _was_recently_spoken(r, line: str) -> bool:
    """Return True if this exact line was spoken recently."""
    key = hashlib.md5(line.strip().lower().encode()).hexdigest()
    try:
        recent = list(r.lrange(_DEDUP_KEY, 0, _DEDUP_WINDOW - 1))
        return key in recent
    except Exception:
        return False


def _mark_spoken(r, line: str) -> None:
    """Record that this line was spoken so it won't repeat."""
    key = hashlib.md5(line.strip().lower().encode()).hexdigest()
    try:
        r.lpush(_DEDUP_KEY, key)
        r.ltrim(_DEDUP_KEY, 0, _DEDUP_WINDOW - 1)
    except Exception:
        pass


# -- TTS ----------------------------------------------------------------------
def _no_window() -> dict:
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}


def speak_blocking(text: str, voice: str | None = None) -> float:
    t0 = time.perf_counter()
    if not text.strip():
        return 0.0
    if should_defer_voice_for_cursor():
        return 0.0
    env = {**os.environ, "FRIDAY_TTS_USE_SESSION_STICKY_VOICE": "false"}
    if voice:
        env["FRIDAY_TTS_VOICE"] = voice
    else:
        av = os.environ.get("FRIDAY_AMBIENT_TTS_VOICE", "").strip()
        if av:
            env["FRIDAY_TTS_VOICE"] = av
    try:
        subprocess.run(
            [sys.executable, str(SPEAK_SCRIPT), text.strip()],
            env=env,
            capture_output=True,
            timeout=120,
            **_no_window(),
        )
    except Exception as e:
        log.warning("speak failed: %s", e)
    return time.perf_counter() - t0


_SUB_VOICE_PHRASES = [
    "Found one.",
    "Got something.",
    "This one's good.",
    "Right, here's one.",
    "Got it.",
    "Found something interesting.",
    "One coming in.",
    "Ready.",
]


def speak_child(text: str | None = None) -> None:
    """
    Speak a brief phrase in the sub-agent voice (faster + lower pitch than
    main Friday — sounds like a subordinate reporting in).
    Non-blocking fire-and-forget; used by parallel content workers.
    """
    phrase = text or random.choice(_SUB_VOICE_PHRASES)
    if not phrase.strip():
        return
    if should_defer_voice_for_cursor():
        return
    env = {
        **os.environ,
        "FRIDAY_TTS_USE_SESSION_STICKY_VOICE": "false",
        "FRIDAY_TTS_RATE":  SUB_VOICE_RATE,
        "FRIDAY_TTS_PITCH": SUB_VOICE_PITCH,
    }
    subv = os.environ.get("FRIDAY_AMBIENT_SUB_TTS_VOICE", "").strip()
    if subv:
        env["FRIDAY_TTS_VOICE"] = subv
    try:
        subprocess.Popen(
            [sys.executable, str(SPEAK_SCRIPT), phrase.strip()],
            env=env,
            **_no_window(),
        )
    except Exception as e:
        log.debug("speak_child failed: %s", e)


def prewarm_tts() -> None:
    if not PREWARM or not SPEAK_SCRIPT.exists():
        return
    log.info("Pre-warming TTS cache (%d phrases)...", len(PREWARM_PHRASES))
    cache_dir = Path(os.environ.get("FRIDAY_TTS_CACHE", "") or Path(tempfile.gettempdir()) / "friday-tts-cache")
    cache_dir.mkdir(parents=True, exist_ok=True)
    for phrase in PREWARM_PHRASES:
        try:
            out = cache_dir / f"prewarm-{hashlib.md5(phrase.encode()).hexdigest()}.mp3"
            subprocess.run(
                [sys.executable, str(SPEAK_SCRIPT), "--output", str(out), phrase],
                env={**os.environ}, capture_output=True, timeout=90, **_no_window(),
            )
        except Exception:
            pass
    log.info("Pre-warm pass done.")


# -- Now playing (async) ------------------------------------------------------
async def scan_now_playing_async() -> dict[str, str] | None:
    try:
        from py_now_playing import PyNowPlaying  # type: ignore
    except ImportError:
        return None
    try:
        apps = await PyNowPlaying.get_active_app_user_model_ids()
    except Exception:
        return None
    if not apps:
        return None
    for app in apps:
        aid = app.get("AppID") or app.get("AppId")
        name = app.get("Name") or ""
        if not aid:
            continue
        try:
            pnp  = await PyNowPlaying.create(aid)
            info = await pnp.get_media_info()
            if info and getattr(info, "title", None):
                return {
                    "title":  str(info.title),
                    "artist": str(getattr(info, "artist", "") or ""),
                    "album":  str(getattr(info, "album_title", "") or ""),
                    "app":    name or aid,
                }
        except Exception:
            continue
    return None


def run_media_loop(stop: threading.Event, conn, r, state: dict[str, Any]) -> None:
    async def loop() -> None:
        last_sig = ""
        while not stop.is_set():
            try:
                snap = await scan_now_playing_async()
                if snap:
                    sig = "|".join([snap["title"], snap["artist"], snap["app"]])
                    payload = json.dumps({**snap, "ts": time.time()})
                    try:
                        r.setex("friday:now_playing", 30, payload)
                    except Exception:
                        r.set("friday:now_playing", payload, ex=30)
                    if sig != last_sig:
                        last_sig = sig
                        state["last_track_sig"]    = sig
                        state["last_track_pretty"] = f"{snap['title']} -- {snap['artist']}".strip(" --")
                        if TRACK_MEDIA and random.random() < MUSIC_COMMENT_CHANCE:
                            state["want_music_comment"] = True
            except Exception as e:
                log.debug("media loop: %s", e)
            await asyncio.sleep(5)
    try:
        asyncio.run(loop())
    except RuntimeError:
        pass


# -- Live data cache (refreshed every 10 min) ---------------------------------
_live_cache: dict[str, str | None] = {}
_live_cache_ts = 0.0
_LIVE_TTL = max(120, int(os.environ.get("FRIDAY_AMBIENT_LIVE_CACHE_SEC", "600")))


def _refresh_live_data(r: Any | None = None) -> None:
    """Fetch all live data sources in parallel — no sequential waiting."""
    global _live_cache, _live_cache_ts, _ipl_speech_on

    rr = r if r is not None else _ambient_redis_default()
    _ipl_speech_on = _ipl_speech_allowed(rr)
    log.info("  ipl_speech_allowed=%s", _ipl_speech_on)

    def _cricket_slot() -> str | None:
        return fetch_cricket_combined(rr)

    _FETCHERS: dict[str, Any] = {
        "cricket":  _cricket_slot,
        "weather":  fetch_weather_brief,
        "fact":     fetch_random_fact,
        "joke":     fetch_dad_joke,
        "news":     fetch_news_headline,
        "arxiv":    fetch_arxiv_headline,
        "space":    fetch_space_news,
        "history":  fetch_this_day_history,
        "trending": fetch_google_trends_india,
        "movies":   fetch_reddit_movies,
        "viral":    fetch_reddit_popular,
        "product":  fetch_producthunt_top,
    }

    log.info("Refreshing live data in parallel (%d sources)...", len(_FETCHERS))
    results: dict[str, str | None] = {}

    with ThreadPoolExecutor(max_workers=len(_FETCHERS)) as ex:
        future_to_key = {ex.submit(fn): key for key, fn in _FETCHERS.items()}
        for future in as_completed(future_to_key):
            key = future_to_key[future]
            try:
                results[key] = future.result()
            except Exception as e:
                log.debug("live[%s] fetch error: %s", key, e)
                results[key] = None

    _live_cache = results
    _live_cache_ts = time.time()

    hits  = {k: v for k, v in results.items() if v}
    misses = [k for k, v in results.items() if not v]
    for k, v in hits.items():
        log.info("  live[%s]: %s", k, v[:80])
    if misses:
        log.debug("  live[%s]: (none)", ", ".join(misses))


def get_live_data(r: Any | None = None) -> dict[str, str | None]:
    if time.time() - _live_cache_ts > _LIVE_TTL or not _live_cache:
        try:
            _refresh_live_data(r if r is not None else _ambient_redis_default())
        except Exception as e:
            log.warning("live data refresh failed: %s", e)
    return _live_cache


# -- Content queue ------------------------------------------------------------
def refill_content_queue(conn, r) -> None:
    """
    Fill the content queue up to QUEUE_TARGET using parallel sub-agent workers.
    Each worker generates one line independently; the FIRST to finish announces
    itself via speak_child() so you hear the team reporting in live.
    """
    key = "friday:ambient:content_queue"
    try:
        n = r.llen(key)
    except Exception:
        n = 0
    need = max(0, QUEUE_TARGET - n)
    if need == 0:
        return

    live = get_live_data(r)
    first_done = threading.Event()   # only the first finisher speaks

    def _generate_one(_idx: int) -> tuple[str, str, str] | None:
        """Run in a worker thread. Returns (topic, line, mode) or None."""
        try:
            # song_moment is handled in the main loop, not pre-queued
            mode = pick_mode()
            while mode == "song_moment":
                mode = pick_mode()
            news    = live.get("news") if mode in ("informational", "mixed") else None
            verbose = random.random() < VERBOSE_RATIO
            topic, line = generate_line_ai(r, mode, news, None, live, verbose=verbose)
            if line:
                # First sub-agent to finish announces itself in child voice
                if not first_done.is_set():
                    first_done.set()
                    speak_child()
                return topic, line, mode
        except Exception as e:
            log.debug("sub-agent generate error: %s", e)
        return None

    log.debug("Queue refill: spawning %d parallel sub-agents", need)
    with ThreadPoolExecutor(max_workers=min(need, 4)) as ex:
        futures = [ex.submit(_generate_one, i) for i in range(need)]
        for future in as_completed(futures):
            result = future.result()
            if result:
                topic, line, mode = result
                log_ambient_content(conn, topic, line, mode, spoken=False)
                try:
                    r.lpush(key, line)
                except Exception:
                    pass


# -- Main brain ---------------------------------------------------------------
def _jitter_threshold() -> float:
    """Dynamic silence threshold: POST_TTS_GAP ± jitter, capped by env bounds."""
    base = POST_TTS_GAP + random.uniform(-1.5, 3.5)
    return max(MIN_AMBIENT_GAP, min(MAX_SILENCE_CAP, base))


def main() -> None:
    # ── Enforce single instance — kill any previous ambient process ────────────
    _acquire_single_instance()

    conn = db_connect()
    db_init(conn)
    r    = connect_redis()

    try:
        r.hset("friday:ambient:user_profile", mapping={
            "name": USER_NAME, "age": USER_AGE,
            "city": USER_CITY, "interests": USER_INTERESTS,
        })
    except Exception:
        pass

    if PREWARM:
        threading.Thread(target=prewarm_tts, daemon=True).start()

    threading.Thread(target=lambda: _refresh_live_data(r), daemon=True).start()

    stop_media = threading.Event()
    media_state: dict[str, Any] = {"last_track_sig": "", "want_music_comment": False}
    if TRACK_MEDIA:
        threading.Thread(
            target=run_media_loop,
            args=(stop_media, conn, r, media_state),
            daemon=True,
        ).start()

    def queue_refiller() -> None:
        while not stop_media.is_set():
            try:
                refill_content_queue(conn, r)
            except Exception as e:
                log.debug("refill: %s", e)
            time.sleep(30)

    threading.Thread(target=queue_refiller, daemon=True).start()

    last_ambient = 0.0
    speak_lock   = threading.Lock()
    log.info(
        "Ambient brain online — post_tts_gap=%.1fs min_gap=%.1fs tone=%s",
        POST_TTS_GAP, MIN_AMBIENT_GAP, TONE,
    )

    try:
        while True:
            time.sleep(1.5)

            if should_defer_voice_for_cursor():
                continue

            # Do not talk over friday-play background music (summaries fade/stop it via friday-speak)
            if _is_music_playing():
                continue

            # ── Priority check: drop immediately if TTS is currently playing ───
            if _is_tts_active():
                continue

            # ── Dynamic silence gate: time since last TTS ended ────────────────
            since_tts = _seconds_since_last_tts()
            threshold = _jitter_threshold()   # POST_TTS_GAP ± jitter
            if since_tts < threshold:
                continue

            # ── Ambient spacing: don't fire faster than MIN_AMBIENT_GAP ─────────
            if time.time() - last_ambient < MIN_AMBIENT_GAP:
                continue

            with speak_lock:
                # Re-check cheap conditions under lock before doing anything
                if _is_tts_active():
                    continue
                if _seconds_since_last_tts() < threshold:
                    continue
                if time.time() - last_ambient < MIN_AMBIENT_GAP:
                    continue

                # ── Acquire distributed TTS lock FIRST — before any API call ──
                # If another process is speaking: wait for it to finish, then
                # reset our gap timer so we don't fire immediately on top of it.
                # (Drop the ambient turn entirely; fresh silence gap required.)
                if not _acquire_tts_lock(r):
                    log.debug("TTS lock held — waiting for playback to finish.")
                    _wait_for_tts_lock_release(r)
                    # Reset both gap clocks from "now" so the loop waits a full
                    # silence gap before the next ambient attempt.
                    last_ambient = time.time()
                    try:
                        TTS_TS_FILE.write_text(str(time.time()), encoding="utf-8")
                    except OSError:
                        pass
                    log.debug("Playback finished — gap timer reset. Next ambient after %.1fs.", threshold)
                    continue  # drop this turn; re-enter main wait loop

                # ── We now own the lock — generate + speak ─────────────────────
                try:
                    mode = pick_mode()
                    if media_state.get("want_music_comment"):
                        media_state["want_music_comment"] = False
                        mode = "music_comment"

                    # ── Song moment: speak intro, then launch music player ──────
                    if mode == "song_moment":
                        moment = generate_song_moment()
                        if moment:
                            line = moment["spoken"]
                            # Dedup check
                            if not _was_recently_spoken(r, line):
                                last_ambient = time.time()
                                _mark_spoken(r, line)
                                d1 = int(speak_blocking(line) * 1000)
                                # Release TTS lock before starting music
                                # (music uses its own PID file, not the TTS lock)
                                _release_tts_lock(r)
                                play_song_ambient(moment["query"], moment["seconds"])
                                log.info(
                                    "[song] %r — playing %s for %ds",
                                    moment["query"], moment["section"], moment["seconds"],
                                )
                                last_ambient = time.time()
                                try:
                                    TTS_TS_FILE.write_text(str(time.time()), encoding="utf-8")
                                except OSError:
                                    pass
                                log_spoken(conn, line, "ambient_song", d1)
                            continue  # lock already released above
                        else:
                            # Fallback to a regular funny/mixed turn if song gen failed
                            mode = "funny"

                    # ── Regular content generation ─────────────────────────────
                    # Pop pre-generated content from queue first (queue is
                    # filled by non-song modes only)
                    line = None
                    if not (mode == "cricket" and _cricket_hindi_enabled()):
                        try:
                            raw = r.rpop("friday:ambient:content_queue")
                            line = raw if isinstance(raw, str) else None
                        except Exception:
                            pass

                    # Verbose mode: 30% of turns get longer storytelling output
                    verbose = random.random() < VERBOSE_RATIO

                    if mode == "music_comment" or not line:
                        live       = get_live_data(r)
                        music_hint = media_state.get("last_track_pretty")
                        news       = live.get("news") if mode in ("informational", "mixed") else None
                        _, line    = generate_line_ai(r, mode, news, music_hint, live, verbose=verbose)

                    # Dedup: skip if spoken recently (Redis ring buffer)
                    if _was_recently_spoken(r, line):
                        log.debug("Dedup: skipping recently spoken line.")
                        continue

                    # Dedup: skip if spoken in the last 2 hours (SQLite)
                    try:
                        with _db_lock:
                            row = conn.execute(
                                "SELECT 1 FROM spoken_log WHERE text=? AND ts > ? LIMIT 1",
                                (line, time.time() - 7200),
                            ).fetchone()
                        if row:
                            log.debug("SQLite dedup: skipping line spoken in last 2h.")
                            continue
                    except Exception:
                        pass

                    # Last safety: another TTS fired while we were generating
                    if _is_tts_active():
                        log.debug("TTS became active mid-generate — dropping ambient line.")
                        continue

                    # ── Stamp + speak ──────────────────────────────────────────
                    last_ambient = time.time()
                    _mark_spoken(r, line)

                    cv = _ambient_line_tts_voice(line, mode)
                    d1 = int(speak_blocking(line, voice=cv) * 1000)

                    # Reset clocks from end of speech (gap timer starts here)
                    last_ambient = time.time()
                    try:
                        TTS_TS_FILE.write_text(str(time.time()), encoding="utf-8")
                    except OSError:
                        pass

                    log_spoken(conn, line, "ambient_main", d1)
                    log_ambient_content(conn, mode, line, mode, spoken=True)

                finally:
                    # Always release the lock — even if dedup skipped or an
                    # exception was raised during generation/playback.
                    _release_tts_lock(r)

    except KeyboardInterrupt:
        log.info("Shutting down.")
    finally:
        stop_media.set()
        _release_single_instance()


if __name__ == "__main__":
    main()
