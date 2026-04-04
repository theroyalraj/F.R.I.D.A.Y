#!/usr/bin/env python3
"""
friday-ambient.py — Jarvis-style ambient intelligence for OpenClaw.

- Tracks last TTS time via %TEMP%/friday-tts-ts (written by friday-speak.py).
- When silence exceeds FRIDAY_AMBIENT_SILENCE_SEC, speaks filler + a short line (Haiku / news / fallbacks).
- Logs now-playing (Windows + py-now-playing) to Redis + SQLite.
- Redis: hot cache, content queue, recent topics. SQLite: durable logs.

Set FRIDAY_AMBIENT=true to enable. Without it, exits 0 immediately (so start.mjs can always spawn this).
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import random
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

# ── Repo root + .env ───────────────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = ROOT / ".env"
if ENV_PATH.exists():
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        t = line.strip()
        if not t or t.startswith("#"):
            continue
        i = t.find("=")
        if i < 1:
            continue
        k, v = t[:i].strip(), t[i + 1 :].strip()
        if v.startswith('"') and v.endswith('"'):
            v = v[1:-1]
        elif v.startswith("'") and v.endswith("'"):
            v = v[1:-1]
        if k not in os.environ:
            os.environ[k] = v

# ── Early exit if disabled ────────────────────────────────────────────────────
def _env_bool(name: str, default: bool = False) -> bool:
    v = os.environ.get(name, "").strip().lower()
    if not v:
        return default
    return v in ("1", "true", "yes", "on")


if not _env_bool("FRIDAY_AMBIENT", False):
    print("friday-ambient: FRIDAY_AMBIENT not enabled — exiting.", flush=True)
    sys.exit(0)

# ── Config ────────────────────────────────────────────────────────────────────
SILENCE_SEC = float(os.environ.get("FRIDAY_AMBIENT_SILENCE_SEC", "10"))
MIN_AMBIENT_GAP = float(os.environ.get("FRIDAY_AMBIENT_MIN_SILENCE_SEC", "6"))
MAX_SILENCE_CAP = float(os.environ.get("FRIDAY_AMBIENT_MAX_SILENCE_SEC", "20"))
TONE = os.environ.get("FRIDAY_AMBIENT_TONE", "mixed").strip().lower()
FUNNY_RATIO = float(os.environ.get("FRIDAY_AMBIENT_FUNNY_RATIO", "0.6"))
TRACK_MEDIA = _env_bool("FRIDAY_AMBIENT_TRACK_MEDIA", True)
MUSIC_COMMENT_CHANCE = float(os.environ.get("FRIDAY_AMBIENT_MUSIC_COMMENT_CHANCE", "0.3"))
PREWARM = _env_bool("FRIDAY_AMBIENT_PREWARM_TTS", True)
QUEUE_TARGET = max(1, int(os.environ.get("FRIDAY_AMBIENT_CONTENT_QUEUE_SIZE", "3")))
REDIS_URL = os.environ.get("FRIDAY_AMBIENT_REDIS_URL", "redis://127.0.0.1:6379").strip()
NEWS_API_KEY = os.environ.get("NEWS_API_KEY", "").strip()
AI_MODEL = os.environ.get("FRIDAY_AMBIENT_AI_MODEL", "claude-haiku-4-5").strip()
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()

USER_NAME = os.environ.get("FRIDAY_USER_NAME", "sir").strip()
USER_AGE = os.environ.get("FRIDAY_USER_AGE", "").strip()
USER_CITY = os.environ.get("FRIDAY_USER_CITY", "").strip()
USER_INTERESTS = os.environ.get("FRIDAY_USER_INTERESTS", "technology, science, humour").strip()

_db_raw = os.environ.get("FRIDAY_AMBIENT_DB_PATH", "data/friday.db").strip()
DB_PATH = Path(_db_raw) if Path(_db_raw).is_absolute() else ROOT / _db_raw

TTS_TS_FILE = Path(tempfile.gettempdir()) / "friday-tts-ts"
SPEAK_SCRIPT = ROOT / "skill-gateway" / "scripts" / "friday-speak.py"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("friday-ambient")

# ── Fallback phrases (never silent) ───────────────────────────────────────────
FILLERS = [
    "One moment, sir.",
    "Right — thinking aloud for you.",
    "Interesting quiet — here's a thought.",
    "Still here, sir.",
    "Allow me a second.",
]

WITTY_FALLBACKS = [
    "If silence is golden, you're practically Fort Knox, sir.",
    "I've run a diagnostic on the quiet — it's suspiciously efficient.",
    "They say still waters run deep; you're giving me ocean vibes.",
    "No input detected — shall I assume you're compiling thoughts?",
    "The cricket scores won't refresh themselves, but I can pretend they did.",
]

# Pre-warm cache phrases (also used for edge-tts cache priming)
PREWARM_PHRASES = FILLERS + WITTY_FALLBACKS + [
    "Standing by, sir.",
    "Friday ambient online.",
    "Shall I fetch something amusing?",
    "Hyderabad traffic is still undefeated, I'd wager.",
    "Your stack is running; the universe, debatable.",
]


def _jitter_threshold() -> float:
    base = SILENCE_SEC + random.uniform(-2.0, 2.0)
    return max(MIN_AMBIENT_GAP, min(MAX_SILENCE_CAP, base))


# ── SQLite (shared across threads; serialize writes) ───────────────────────────
_db_lock = threading.Lock()


def db_connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL;")
    return conn


def db_init(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS spoken_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts REAL NOT NULL,
            text TEXT NOT NULL,
            source TEXT NOT NULL,
            duration_ms INTEGER
        );
        CREATE TABLE IF NOT EXISTS now_playing_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts REAL NOT NULL,
            title TEXT,
            artist TEXT,
            album TEXT,
            app TEXT,
            duration_ms INTEGER
        );
        CREATE TABLE IF NOT EXISTS ambient_content (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts REAL NOT NULL,
            topic TEXT,
            text TEXT NOT NULL,
            tone TEXT,
            rating INTEGER,
            was_spoken INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS user_interests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            interest TEXT NOT NULL UNIQUE,
            weight REAL DEFAULT 1.0,
            last_used_ts REAL
        );
        """
    )
    conn.commit()


def log_spoken(conn: sqlite3.Connection, text: str, source: str, duration_ms: int | None = None) -> None:
    with _db_lock:
        conn.execute(
            "INSERT INTO spoken_log (ts, text, source, duration_ms) VALUES (?,?,?,?)",
            (time.time(), text, source, duration_ms),
        )
        conn.commit()


def log_now_playing_row(
    conn: sqlite3.Connection,
    title: str,
    artist: str,
    album: str,
    app: str,
    duration_ms: int | None = None,
) -> None:
    with _db_lock:
        conn.execute(
            "INSERT INTO now_playing_log (ts, title, artist, album, app, duration_ms) VALUES (?,?,?,?,?,?)",
            (time.time(), title, artist, album, app, duration_ms),
        )
        conn.commit()


def log_ambient_content(conn: sqlite3.Connection, topic: str, text: str, tone: str, spoken: bool) -> None:
    with _db_lock:
        conn.execute(
            "INSERT INTO ambient_content (ts, topic, text, tone, was_spoken) VALUES (?,?,?,?,?)",
            (time.time(), topic, text, tone, 1 if spoken else 0),
        )
        conn.commit()


def fetch_stale_ambient_line(conn: sqlite3.Connection) -> str | None:
    with _db_lock:
        row = conn.execute(
            "SELECT text FROM ambient_content WHERE was_spoken=0 ORDER BY ts DESC LIMIT 1"
        ).fetchone()
        return row[0] if row else None


# ── Redis (optional) ────────────────────────────────────────────────────────────
class RedisLite:
    """In-process stand-in when Redis is down."""

    def __init__(self) -> None:
        self._kv: dict[str, Any] = {}
        self._lists: dict[str, list[str]] = {}
        self._hashes: dict[str, dict[str, str]] = {}
        self._ttl: dict[str, float] = {}

    def _purge_ttl(self) -> None:
        now = time.time()
        dead = [k for k, exp in self._ttl.items() if exp <= now]
        for k in dead:
            self._ttl.pop(k, None)
            self._kv.pop(k, None)

    def set(self, key: str, val: str, ex: int | None = None) -> bool:
        self._purge_ttl()
        self._kv[key] = val
        if ex:
            self._ttl[key] = time.time() + ex
        return True

    def get(self, key: str) -> str | None:
        self._purge_ttl()
        return self._kv.get(key)

    def setex(self, key: str, ttl: int, val: str) -> bool:
        return self.set(key, val, ex=ttl)

    def hset(self, name: str, mapping: dict | None = None, **kwargs: str) -> int:
        h = self._hashes.setdefault(name, {})
        m = dict(mapping or {})
        m.update(kwargs)
        for k, v in m.items():
            h[str(k)] = str(v)
        return len(m)

    def lpush(self, key: str, *vals: str) -> int:
        lst = self._lists.setdefault(key, [])
        for v in vals:
            lst.insert(0, v)
        return len(lst)

    def rpop(self, key: str) -> str | None:
        lst = self._lists.setdefault(key, [])
        if not lst:
            return None
        return lst.pop()

    def llen(self, key: str) -> int:
        return len(self._lists.get(key, []))

    def lrange(self, key: str, start: int, end: int) -> list:
        lst = self._lists.get(key, [])
        if end < 0:
            return lst[start:]
        return lst[start : end + 1]

    def ltrim(self, key: str, start: int, end: int) -> bool:
        lst = self._lists.get(key, [])
        self._lists[key] = lst[start : end + 1]
        return True


def connect_redis():
    try:
        import redis  # type: ignore

        r = redis.Redis.from_url(REDIS_URL, decode_responses=True)
        r.ping()
        log.info("Redis connected: %s", REDIS_URL)
        return r
    except Exception as e:
        log.warning("Redis unavailable (%s) — using in-memory cache.", e)
        return RedisLite()


def redis_push_recent_topic(r, topic: str) -> None:
    key = "friday:ambient:recent_topics"
    try:
        r.lpush(key, topic)
        r.ltrim(key, 0, 4)
    except Exception as e:
        log.debug("redis_push_recent_topic: %s", e)


def redis_recent_topics(r) -> list[str]:
    key = "friday:ambient:recent_topics"
    try:
        return list(r.lrange(key, 0, 4))
    except Exception:
        return getattr(r, "_lists", {}).get(key, [])


# ── News (stdlib HTTP) ─────────────────────────────────────────────────────────
def fetch_news_headline() -> str | None:
    if not NEWS_API_KEY:
        return None
    try:
        q = urllib.parse.urlencode({"country": "in", "apiKey": NEWS_API_KEY, "pageSize": 1})
        url = f"https://newsapi.org/v2/top-headlines?{q}"
        req = urllib.request.Request(url, headers={"User-Agent": "openclaw-friday-ambient/1.0"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode())
        arts = data.get("articles") or []
        if not arts:
            return None
        t = arts[0].get("title") or ""
        return t.strip()[:200] if t else None
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as e:
        log.debug("news fetch failed: %s", e)
        return None


# ── Anthropic ─────────────────────────────────────────────────────────────────
def generate_line_haiku(
    r,
    mode: str,
    news_hint: str | None,
    music_hint: str | None,
) -> tuple[str, str]:
    """Returns (topic_key, spoken_text)."""
    recent = set(redis_recent_topics(r))
    if mode == "music_comment":
        ctx = music_hint or "whatever is playing on the speakers"
        topic = f"music:{hashlib.md5(ctx.encode()).hexdigest()[:16]}"
        prompt = (
            "Briefly comment on this playing track in one witty British line (max 25 words). "
            f"Track context: {ctx}."
        )
    elif mode == "wisdom":
        topic = f"wisdom:{time.strftime('%Y-%m-%d-%H')}"
        prompt = "Give a short wise quote or observation, one sentence, max 25 words. British, dry humour allowed."
    elif mode == "informational":
        topic = f"info:{news_hint or 'general'}"
        base = news_hint or "Share one surprising but true tech or science fact."
        prompt = f"{base} One punchy sentence, max 25 words, spoken aloud."
    elif mode == "funny":
        topic = f"joke:{time.strftime('%Y-%m-%d-%H')}"
        prompt = (
            f"Tell a very short joke or quip tailored for someone who likes: {USER_INTERESTS}. "
            f"Name: {USER_NAME}. City: {USER_CITY or 'unknown'}. Max 25 words. British wit."
        )
    else:
        topic = f"mixed:{time.strftime('%Y-%m-%d-%H')}"
        prompt = (
            f"Either a tiny joke OR one interesting fact for {USER_NAME} "
            f"(interests: {USER_INTERESTS}). Max 25 words. Natural, not robotic."
        )

    # Skip repeated topics
    if topic in recent:
        topic = f"{topic}:alt{random.randint(1, 999)}"

    cache_key = "friday:ambient:content_cache:" + hashlib.sha256(
        f"{topic}|{mode}|{USER_INTERESTS}".encode()
    ).hexdigest()
    try:
        hit = r.get(cache_key)
        if hit:
            return topic, str(hit)
    except Exception:
        pass

    if not ANTHROPIC_KEY:
        line = random.choice(WITTY_FALLBACKS)
        return topic, line

    try:
        import anthropic

        client = anthropic.Anthropic(api_key=ANTHROPIC_KEY)
        system = (
            f"You are Friday, a witty British AI assistant (Jarvis tone). "
            f"User: {USER_NAME}"
            + (f", age {USER_AGE}" if USER_AGE else "")
            + (f", {USER_CITY}" if USER_CITY else "")
            + f". Interests: {USER_INTERESTS}. "
            "Keep output under 25 words. No quotes around the line. No stage directions."
        )
        msg = client.messages.create(
            model=AI_MODEL,
            max_tokens=120,
            system=system,
            messages=[{"role": "user", "content": prompt}],
        )
        line = (msg.content[0].text or "").strip().replace("\n", " ")
        if len(line) > 280:
            line = line[:277] + "..."
        if not line:
            line = random.choice(WITTY_FALLBACKS)
        try:
            r.setex(cache_key, 4 * 3600, line)
        except Exception:
            pass
        redis_push_recent_topic(r, topic)
        return topic, line
    except Exception as e:
        log.warning("Haiku generation failed: %s", e)
        line = random.choice(WITTY_FALLBACKS)
        return topic, line


def pick_mode() -> str:
    hour = time.localtime().tm_hour
    if TONE in ("funny", "informational", "wisdom", "music_comment"):
        return TONE
    # mixed + tone-of-day bias
    if 5 <= hour < 12:
        roll = random.random()
        return "informational" if roll < 0.35 else ("funny" if roll < 0.35 + FUNNY_RATIO else "wisdom")
    if 12 <= hour < 17:
        return "funny" if random.random() < FUNNY_RATIO else "informational"
    return "funny" if random.random() < FUNNY_RATIO * 0.8 else "wisdom"


# ── TTS ─────────────────────────────────────────────────────────────────────────
def _subprocess_kw_no_window() -> dict:
    if sys.platform == "win32":
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    return {}


def speak_blocking(text: str) -> float:
    """Run friday-speak.py; return wall time spent (approx)."""
    t0 = time.perf_counter()
    if not text.strip():
        return 0.0
    try:
        subprocess.run(
            [sys.executable, str(SPEAK_SCRIPT), text.strip()],
            env={**os.environ},
            capture_output=True,
            timeout=120,
            **_subprocess_kw_no_window(),
        )
    except Exception as e:
        log.warning("speak failed: %s", e)
    return time.perf_counter() - t0


def prewarm_tts() -> None:
    if not PREWARM or not SPEAK_SCRIPT.exists():
        return
    log.info("Pre-warming TTS cache (%d phrases)...", len(PREWARM_PHRASES))
    cache_dir = os.environ.get("FRIDAY_TTS_CACHE", "").strip()
    if not cache_dir:
        cache_dir = str(Path(tempfile.gettempdir()) / "friday-tts-cache")
    Path(cache_dir).mkdir(parents=True, exist_ok=True)

    for phrase in PREWARM_PHRASES:
        try:
            out = Path(cache_dir) / f"prewarm-{hashlib.md5(phrase.encode()).hexdigest()}.mp3"
            subprocess.run(
                [sys.executable, str(SPEAK_SCRIPT), "--output", str(out), phrase],
                env={**os.environ},
                capture_output=True,
                timeout=90,
                **_subprocess_kw_no_window(),
            )
        except Exception:
            pass
    log.info("Pre-warm pass done.")


# ── Now playing (async, Windows) ─────────────────────────────────────────────-
async def scan_now_playing_async() -> dict[str, str] | None:
    try:
        from py_now_playing import PyNowPlaying  # type: ignore
    except ImportError:
        return None

    try:
        apps = await PyNowPlaying.get_active_app_user_model_ids()
    except Exception as e:
        log.debug("get_active_app_user_model_ids: %s", e)
        return None

    if not apps:
        return None

    for app in apps:
        aid = app.get("AppID") or app.get("AppId")
        name = app.get("Name") or ""
        if not aid:
            continue
        try:
            pnp = await PyNowPlaying.create(aid)
            info = await pnp.get_media_info()
            if info and getattr(info, "title", None):
                return {
                    "title": str(info.title),
                    "artist": str(getattr(info, "artist", "") or ""),
                    "album": str(getattr(info, "album_title", "") or ""),
                    "app": name or aid,
                }
        except Exception:
            continue
    return None


def run_media_loop(
    stop: threading.Event,
    conn: sqlite3.Connection,
    r,
    state: dict[str, Any],
) -> None:
    async def loop() -> None:
        last_sig = ""
        while not stop.is_set():
            try:
                snap = await scan_now_playing_async()
                if snap:
                    sig = "|".join([snap["title"], snap["artist"], snap["app"]])
                    payload = json.dumps({**snap, "ts": time.time()})
                    try:
                        if hasattr(r, "setex"):
                            r.setex("friday:now_playing", 30, payload)
                        else:
                            r.set("friday:now_playing", payload, ex=30)
                    except Exception:
                        r.set("friday:now_playing", payload, ex=30)
                    if sig != last_sig:
                        last_sig = sig
                        log_now_playing_row(
                            conn,
                            snap["title"],
                            snap["artist"],
                            snap["album"],
                            snap["app"],
                            None,
                        )
                        state["last_track_sig"] = sig
                        state["last_track_pretty"] = f"{snap['title']} — {snap['artist']}".strip(" —")
                        if TRACK_MEDIA and random.random() < MUSIC_COMMENT_CHANCE:
                            state["want_music_comment"] = True
            except Exception as e:
                log.debug("media loop: %s", e)
            await asyncio.sleep(5)

    try:
        asyncio.run(loop())
    except RuntimeError:
        pass


# ── Content queue refill ───────────────────────────────────────────────────────
def refill_content_queue(conn: sqlite3.Connection, r) -> None:
    key = "friday:ambient:content_queue"
    try:
        n = r.llen(key)
    except Exception:
        n = len(getattr(r, "_lists", {}).get(key, []))
    need = max(0, QUEUE_TARGET - n)
    for _ in range(need):
        mode = pick_mode()
        news = fetch_news_headline() if mode in ("informational", "mixed") else None
        music = None
        topic, line = generate_line_haiku(r, mode, news, music)
        log_ambient_content(conn, topic, line, mode, spoken=False)
        try:
            r.lpush(key, line)
        except Exception as e:
            log.debug("content queue lpush: %s", e)


# ── Main brain ────────────────────────────────────────────────────────────────
def main() -> None:
    conn = db_connect()
    db_init(conn)
    r = connect_redis()

    # Sync user profile to Redis hash (for external tools)
    try:
        r.hset(
            "friday:ambient:user_profile",
            mapping={
                "name": USER_NAME,
                "age": USER_AGE,
                "city": USER_CITY,
                "interests": USER_INTERESTS,
            },
        )
    except Exception:
        pass

    try:
        r.set("friday:ambient:mode", TONE)
        r.set("friday:ambient:silence_threshold", str(SILENCE_SEC))
    except Exception:
        pass

    if PREWARM:
        threading.Thread(target=prewarm_tts, daemon=True).start()

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
    speak_lock = threading.Lock()
    log.info(
        "Ambient brain online — silence=%.1fs min_gap=%.1fs tone=%s",
        SILENCE_SEC,
        MIN_AMBIENT_GAP,
        TONE,
    )

    try:
        while True:
            time.sleep(2.0)
            # Last spoken timestamp
            ts = time.time()
            if TTS_TS_FILE.exists():
                try:
                    ts = float(TTS_TS_FILE.read_text(encoding="utf-8").strip())
                except (ValueError, OSError):
                    ts = time.time()
            try:
                r.set("friday:last_spoken_ts", str(ts))
            except Exception:
                pass

            gap = time.time() - ts
            threshold = _jitter_threshold()
            if gap < threshold:
                continue
            if time.time() - last_ambient < MIN_AMBIENT_GAP:
                continue

            with speak_lock:
                if time.time() - last_ambient < MIN_AMBIENT_GAP:
                    continue
                # Re-check file after acquiring lock
                if TTS_TS_FILE.exists():
                    try:
                        ts2 = float(TTS_TS_FILE.read_text(encoding="utf-8").strip())
                        if time.time() - ts2 < threshold:
                            continue
                    except (ValueError, OSError):
                        pass

                last_ambient = time.time()
                filler = random.choice(FILLERS)
                d0 = int(speak_blocking(filler) * 1000)
                log_spoken(conn, filler, "ambient_filler", d0)

                line = None
                try:
                    raw = r.rpop("friday:ambient:content_queue")
                    line = raw if isinstance(raw, str) else None
                except Exception:
                    line = None

                if not line:
                    line = fetch_stale_ambient_line(conn)

                mode = pick_mode()
                if media_state.get("want_music_comment"):
                    media_state["want_music_comment"] = False
                    mode = "music_comment"
                music_hint = media_state.get("last_track_pretty")

                if mode == "music_comment" or not line:
                    news = fetch_news_headline() if mode in ("informational", "mixed") else None
                    _topic, line = generate_line_haiku(r, mode, news, music_hint)

                d1 = int(speak_blocking(line) * 1000)
                log_spoken(conn, line, "ambient_main", d1)
                log_ambient_content(conn, mode, line, mode, spoken=True)

    except KeyboardInterrupt:
        log.info("Shutting down.")
    finally:
        stop_media.set()


if __name__ == "__main__":
    main()
