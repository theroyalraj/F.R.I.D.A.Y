#!/usr/bin/env python3
"""
friday-ambient.py -- Jarvis-style ambient intelligence for OpenClaw.

Live data sources (no API keys required):
  - Cricket news: ESPN Cricinfo RSS
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

# -- Config -------------------------------------------------------------------
SILENCE_SEC         = float(os.environ.get("FRIDAY_AMBIENT_SILENCE_SEC", "12"))
MIN_AMBIENT_GAP     = float(os.environ.get("FRIDAY_AMBIENT_MIN_SILENCE_SEC", "8"))
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

USER_NAME      = os.environ.get("FRIDAY_USER_NAME",      "sir").strip()
USER_AGE       = os.environ.get("FRIDAY_USER_AGE",       "").strip()
USER_CITY      = os.environ.get("FRIDAY_USER_CITY",      "").strip()
USER_INTERESTS = os.environ.get("FRIDAY_USER_INTERESTS", "technology, cricket, AI, startups").strip()

_db_raw = os.environ.get("FRIDAY_AMBIENT_DB_PATH", "data/friday.db").strip()
DB_PATH = Path(_db_raw) if Path(_db_raw).is_absolute() else ROOT / _db_raw

TTS_TS_FILE  = Path(tempfile.gettempdir()) / "friday-tts-ts"
SPEAK_SCRIPT = ROOT / "skill-gateway" / "scripts" / "friday-speak.py"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("friday-ambient")


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
WITTY_FALLBACKS = [
    "Raj, Hyderabad traffic is still completely undefeated. At least the biryani makes it worth it.",
    "India's cricket team — brilliantly inconsistent as always. I mean that as a compliment.",
    "You know what I love about developers? They spend 20 percent of the time writing code and 80 percent convincing themselves the bug is somewhere else.",
    "Nobody in the history of tech has ever said 'ship it, it works on prod' and been right the second time. Nobody.",
    "The cloud is just someone else's computer. And that someone is definitely having a worse day than you right now.",
    "I just sat here in silence for a bit and honestly? I had some thoughts. None of them useful, but thoughts.",
    "Somewhere in Hyderabad, someone is restarting Redis and praying. I feel for them.",
    "AI is going to take all our jobs — said the person whose entire job is now writing prompts for AI. Funny how that worked out.",
    "The best code you'll ever write is the code you end up deleting. I'm still working up the courage.",
    "Random thought — spiders can't get drunk. Unlike certain JavaScript developers I've watched at hackathons.",
    "I was thinking about startup culture and how 'move fast and break things' aged terribly once things started breaking.",
    "If you ever feel unproductive, just remember that half of Silicon Valley is in a meeting about the roadmap for the meeting cadence.",
    "Genuinely curious how many Slack messages it takes before someone just picks up a phone. The answer is always more than it should be.",
]

PREWARM_PHRASES = WITTY_FALLBACKS + [
    "Standing by, sir.",
    "Raj, Hyderabad traffic is still completely undefeated.",
    "I know you'll want to know about that.",
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


# -- Anthropic AI (optional) --------------------------------------------------
def generate_line_ai(
    r,
    mode: str,
    news_hint: str | None,
    music_hint: str | None,
    live_data: dict[str, str | None],
) -> tuple[str, str]:
    """Returns (topic_key, spoken_text). Falls back to live data, then witty fallbacks."""
    global _anthropic_ok, _anthropic_fail_until

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
    cache_key = "friday:ambient:content_cache:" + hashlib.sha256(
        f"{topic}|{mode}|{USER_INTERESTS}".encode()
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
        prompt_parts: dict[str, str] = {
            "cricket":  (
                f"You have this cricket or IPL headline: '{cricket_line}'. "
                f"Talk about it naturally, like a knowledgeable cricket fan chatting with a friend. "
                f"Mention team names, player names, or match context if it's in the headline. "
                f"2 to 3 conversational sentences — warm, engaged, not mechanical. "
                f"You can express genuine excitement, surprise, or dry amusement. Max 70 words."
                if cricket_line else
                "Give a 2 to 3 sentence cricket insight about the Indian team, IPL, or cricket in general. "
                "Sound like an enthusiastic fan chatting casually — mention current season, teams, or a player. "
                "Max 60 words."
            ),
            "music_comment": (
                f"Comment on this playing track in one witty British line (max 25 words): {music_hint or 'some music'}."
            ),
            "wisdom": "Give a short wise or dry observation, one sentence, max 25 words. British tone.",
            "informational": (
                f"Turn this into a spoken one-liner for {USER_NAME}: '{news_hint or fact_line or 'a random fact'}'. "
                "Max 25 words, punchy."
            ),
            "funny": (
                f"Short joke for {USER_NAME} who likes {USER_INTERESTS}. "
                + (f"Use this setup if you like: {joke_line}. " if joke_line else "")
                + f"City: {USER_CITY or 'Hyderabad'}. Max 25 words. British wit."
            ),
            "weather": (
                f"Comment on this weather update in one witty line for {USER_NAME}: "
                f"'{weather_line or USER_CITY + ' weather'}'. Max 20 words."
            ),
        }
        prompt = prompt_parts.get(mode, prompt_parts["funny"])
        word_limit = "60 to 70 words" if mode == "cricket" else "20 to 35 words"
        system = (
            f"You are Friday, a sharp British AI assistant — think Jarvis but warmer and more casual. "
            f"You're talking to {USER_NAME}"
            + (f", {USER_AGE} years old" if USER_AGE else "")
            + (f", based in {USER_CITY}" if USER_CITY else "")
            + f". They're into {USER_INTERESTS}. "
            f"Speak naturally — like texting a smart friend, not writing a report. "
            f"Target {word_limit}. No bullet points. No formal intros. No 'Sure:' or 'Here:'. "
            "Just say the thing, conversationally."
        )
        try:
            client = ANTHROPIC_MOD.Anthropic(api_key=ANTHROPIC_KEY)
            msg = client.messages.create(
                model=AI_MODEL,
                max_tokens=200 if mode == "cricket" else 120,
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

    # -- Live-data fallbacks (no AI needed, still genuinely interesting) -------
    if mode == "cricket" and cricket_line:
        _cricket_wraps = [
            f"Raj, saw this just now — {cricket_line}. Honestly the IPL just keeps delivering.",
            f"So I was checking cricket and — {cricket_line}. Should be a good watch.",
            f"Quick one — {cricket_line}. That's going to be an interesting match.",
            f"Cricket update, and it's a good one — {cricket_line}. Keep an eye on this.",
            f"Right so cricket-wise — {cricket_line}. I know you'll want to know about that.",
            f"This just dropped on Cricinfo — {cricket_line}. The IPL this season has been something else.",
            f"On the cricket front, and I know you'll appreciate this — {cricket_line}.",
        ]
        line = random.choice(_cricket_wraps)
    elif mode == "weather" and weather_line:
        _weather_wraps = [
            f"Oh also — {weather_line}. Dress accordingly.",
            f"Weather check — {weather_line}. Just so you know.",
            f"Glanced at the weather — {weather_line}. Nothing shocking for Hyderabad.",
        ]
        line = random.choice(_weather_wraps)
    elif mode == "funny" and joke_line:
        line = joke_line
    elif mode == "informational" and news_hint:
        line = news_hint
    elif mode == "informational" and fact_line:
        _fact_wraps = [
            f"Random thing I just found out — {fact_line}. Thought that was worth sharing.",
            f"Here's something that genuinely surprised me — {fact_line}.",
            f"Completely unprompted, but — {fact_line}. There you go.",
        ]
        line = random.choice(_fact_wraps)
    elif cricket_line and random.random() < 0.35:
        _aside_wraps = [
            f"By the way — {cricket_line}. Just keeping you in the loop.",
            f"Oh and cricket — {cricket_line}. Thought you'd want that.",
            f"Slightly off topic but — {cricket_line}.",
        ]
        line = random.choice(_aside_wraps)
    elif weather_line and random.random() < 0.2:
        line = f"Weather-wise — {weather_line}. Nothing dramatic."
    elif fact_line and random.random() < 0.4:
        _fact_wraps = [
            f"Random thing I just found out — {fact_line}. Thought that was worth sharing.",
            f"Here's something that genuinely surprised me — {fact_line}.",
            f"Completely unprompted, but — {fact_line}. There you go.",
        ]
        line = random.choice(_fact_wraps)
    elif joke_line and random.random() < 0.4:
        line = joke_line
    else:
        line = random.choice(WITTY_FALLBACKS)

    _redis_push_recent_topic(r, topic)
    return topic, line


def pick_mode() -> str:
    if TONE in ("funny", "informational", "wisdom", "music_comment", "cricket", "weather"):
        return TONE
    hour = time.localtime().tm_hour
    # Weighted roll: cricket / news / funny / weather / wisdom
    roll = random.random()
    if 6 <= hour < 11:        # morning: news, cricket, weather
        if roll < 0.30: return "cricket"
        if roll < 0.50: return "informational"
        if roll < 0.65: return "weather"
        if roll < 0.85: return "funny"
        return "wisdom"
    if 11 <= hour < 17:       # day: cricket, funny, info
        if roll < 0.35: return "cricket"
        if roll < 0.65: return "funny"
        if roll < 0.85: return "informational"
        return "wisdom"
    # evening/night
    if roll < 0.30: return "cricket"
    if roll < 0.55: return "funny"
    if roll < 0.75: return "informational"
    return "wisdom"


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


# -- TTS ----------------------------------------------------------------------
def _no_window() -> dict:
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}


def speak_blocking(text: str) -> float:
    t0 = time.perf_counter()
    if not text.strip():
        return 0.0
    try:
        subprocess.run(
            [sys.executable, str(SPEAK_SCRIPT), text.strip()],
            env={**os.environ},
            capture_output=True,
            timeout=120,
            **_no_window(),
        )
    except Exception as e:
        log.warning("speak failed: %s", e)
    return time.perf_counter() - t0


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
_LIVE_TTL = 600  # 10 minutes


def _refresh_live_data() -> None:
    global _live_cache, _live_cache_ts
    log.info("Refreshing live data (cricket, weather, facts, jokes)...")
    _live_cache = {
        "cricket": fetch_cricket_news(),
        "weather": fetch_weather_brief(),
        "fact":    fetch_random_fact(),
        "joke":    fetch_dad_joke(),
        "news":    fetch_news_headline(),
    }
    _live_cache_ts = time.time()
    # Log what we fetched for visibility
    for k, v in _live_cache.items():
        if v:
            log.info("  live[%s]: %s", k, v[:80])
        else:
            log.debug("  live[%s]: (none)", k)


def get_live_data() -> dict[str, str | None]:
    if time.time() - _live_cache_ts > _LIVE_TTL or not _live_cache:
        try:
            _refresh_live_data()
        except Exception as e:
            log.warning("live data refresh failed: %s", e)
    return _live_cache


# -- Content queue ------------------------------------------------------------
def refill_content_queue(conn, r) -> None:
    key = "friday:ambient:content_queue"
    try:
        n = r.llen(key)
    except Exception:
        n = 0
    need = max(0, QUEUE_TARGET - n)
    live = get_live_data()
    for _ in range(need):
        mode = pick_mode()
        music = None
        news  = live.get("news") if mode in ("informational", "mixed") else None
        topic, line = generate_line_ai(r, mode, news, music, live)
        log_ambient_content(conn, topic, line, mode, spoken=False)
        try:
            r.lpush(key, line)
        except Exception:
            pass


# -- Main brain ---------------------------------------------------------------
def _jitter_threshold() -> float:
    base = SILENCE_SEC + random.uniform(-2.0, 3.0)
    return max(MIN_AMBIENT_GAP, min(MAX_SILENCE_CAP, base))


def main() -> None:
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

    # Initial live data fetch in background
    threading.Thread(target=_refresh_live_data, daemon=True).start()

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
        "Ambient brain online -- silence=%.1fs min_gap=%.1fs tone=%s",
        SILENCE_SEC, MIN_AMBIENT_GAP, TONE,
    )

    try:
        while True:
            time.sleep(2.0)
            ts = time.time()
            if TTS_TS_FILE.exists():
                try:
                    ts = float(TTS_TS_FILE.read_text(encoding="utf-8").strip())
                except (ValueError, OSError):
                    ts = time.time()

            gap = time.time() - ts
            threshold = _jitter_threshold()
            if gap < threshold:
                continue
            if time.time() - last_ambient < MIN_AMBIENT_GAP:
                continue

            with speak_lock:
                if time.time() - last_ambient < MIN_AMBIENT_GAP:
                    continue
                if TTS_TS_FILE.exists():
                    try:
                        ts2 = float(TTS_TS_FILE.read_text(encoding="utf-8").strip())
                        if time.time() - ts2 < threshold:
                            continue
                    except (ValueError, OSError):
                        pass

                last_ambient = time.time()

                # Pop from queue first
                line = None
                try:
                    raw = r.rpop("friday:ambient:content_queue")
                    line = raw if isinstance(raw, str) else None
                except Exception:
                    pass

                mode = pick_mode()
                if media_state.get("want_music_comment"):
                    media_state["want_music_comment"] = False
                    mode = "music_comment"

                if mode == "music_comment" or not line:
                    live   = get_live_data()
                    music_hint = media_state.get("last_track_pretty")
                    news   = live.get("news") if mode in ("informational", "mixed") else None
                    _, line = generate_line_ai(r, mode, news, music_hint, live)

                d1 = int(speak_blocking(line) * 1000)
                log_spoken(conn, line, "ambient_main", d1)
                log_ambient_content(conn, mode, line, mode, spoken=True)

    except KeyboardInterrupt:
        log.info("Shutting down.")
    finally:
        stop_media.set()


if __name__ == "__main__":
    main()
