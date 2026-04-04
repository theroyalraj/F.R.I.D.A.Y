"""
friday_speaker.py — common TTS singleton used by every Python script in this repo.

All scripts (friday-listen, friday-ambient, cursor-reply-watch, etc.) import
FridaySpeaker instead of manually spawning friday-speak.py via subprocess.

Serialisation:
  1. A local threading.Lock prevents two threads in the same process from
     speaking simultaneously.
  2. A Redis distributed lock (friday:tts:lock) prevents two PROCESSES from
     speaking simultaneously (ambient, listen, cursor-reply, Cursor agent).
  Priority calls break the Redis lock first so urgent speech is never queued.
  If Redis is down both locks are skipped (fail-open).

Usage:
    from friday_speaker import speaker   # singleton, ready to use

    speaker.speak("Hello")                         # fire-and-forget (queued behind lock)
    duration = speaker.speak_blocking("Hello")     # waits for playback, returns seconds
    speaker.speak_blocking("Hello", voice="en-GB-SoniaNeural")
    speaker.speak("Urgent", priority=True, bypass_cursor_defer=True)
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import threading
import time
import unicodedata
import uuid
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_SPEAK_SCRIPT = _REPO_ROOT / "skill-gateway" / "scripts" / "friday-speak.py"

_REDIS_URL = os.environ.get("OPENCLAW_REDIS_URL", "").strip() or "redis://127.0.0.1:6379"
_REDIS_TTS_LOCK = "friday:tts:lock"
_REDIS_TTS_LOCK_TTL = 90

# Local threading lock — serialises speak calls within the same Python process
_local_lock = threading.Lock()


# ── Redis helpers (lazy import — no hard dependency) ──────────────────────────

_redis_client = None
_redis_init_done = False
_redis_init_lock = threading.Lock()


def _get_redis():
    global _redis_client, _redis_init_done
    if _redis_init_done:
        return _redis_client
    with _redis_init_lock:
        if _redis_init_done:
            return _redis_client
        try:
            import redis as _redis_mod
            _redis_client = _redis_mod.Redis.from_url(_REDIS_URL, decode_responses=True, socket_timeout=2)
            _redis_client.ping()
        except Exception:
            _redis_client = None
        _redis_init_done = True
        return _redis_client


def _acquire_redis_lock(token: str, priority: bool = False, timeout: float = 60.0) -> bool:
    """Acquire the global TTS Redis lock with a unique token.  Returns True when safe to speak."""
    r = _get_redis()
    if r is None:
        return True  # fail-open

    if priority:
        try:
            r.delete(_REDIS_TTS_LOCK)
        except Exception:
            pass
        time.sleep(0.05)

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if r.set(_REDIS_TTS_LOCK, token, nx=True, ex=_REDIS_TTS_LOCK_TTL):
                return True
            holder = r.get(_REDIS_TTS_LOCK)
            if holder == token:
                return True
        except Exception:
            return True  # fail-open
        time.sleep(0.15)
    return False


def _release_redis_lock(token: str) -> None:
    r = _get_redis()
    if r is None:
        return
    try:
        holder = r.get(_REDIS_TTS_LOCK)
        if holder == token:
            r.delete(_REDIS_TTS_LOCK)
    except Exception:
        pass


# ── Text sanitisation (runs before every TTS call) ────────────────────────────

def _strip_redacted(text: str) -> str:
    """Remove privacy / tool-result tokens so Edge never speaks the word 'redacted'."""
    if not text:
        return text
    t = text
    try:
        t = unicodedata.normalize("NFKC", t)
    except Exception:
        pass
    pats = (
        r"(?i)\*+\s*redacted\s*\*+",
        r"(?i)`\s*redacted\s*`",
        r"(?i)<\s*redacted[^>]*>",
        r"(?i)\[\s*redacted\s*\]",
        r"(?i)\{\s*redacted\s*\}",
        r"(?i)\(\s*redacted\s*\)",
        r"(?i)\bredacted\s*[:;.,!?…]+\s*",
        r"(?i)\bredacted\b",
        r"(?i)\bREDACTED\b",
    )
    for pat in pats:
        t = re.sub(pat, " ", t)
    return re.sub(r"\s{2,}", " ", t).strip()


def sanitise(text: str) -> str:
    """Public helper — strip redacted tokens + collapse whitespace."""
    return _strip_redacted(text)


# ── Singleton speaker ─────────────────────────────────────────────────────────

class FridaySpeaker:
    """Process-wide singleton that wraps friday-speak.py subprocess calls."""

    _instance: FridaySpeaker | None = None
    _cls_lock = threading.Lock()

    def __new__(cls) -> FridaySpeaker:
        with cls._cls_lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._initialised = False
            return cls._instance

    def __init__(self) -> None:
        if self._initialised:
            return
        self._initialised = True
        self._script = str(_SPEAK_SCRIPT)
        self._python = sys.executable

    # ── Public API ─────────────────────────────────────────────────────────

    def speak(
        self,
        text: str,
        *,
        voice: str | None = None,
        priority: bool = False,
        bypass_cursor_defer: bool = False,
        session: str | None = None,
        use_session_sticky: bool = True,
        rate: str | None = None,
        pitch: str | None = None,
        interrupt_music: bool = False,
        extra_env: dict[str, str] | None = None,
    ) -> None:
        """Fire-and-forget TTS — returns immediately, audio queued behind lock."""
        clean = _strip_redacted(text)
        if not clean or len(re.sub(r"[^a-zA-Z0-9\u0900-\u097F]", "", clean)) < 2:
            return
        env = self._build_env(
            voice=voice,
            priority=priority,
            bypass_cursor_defer=bypass_cursor_defer,
            session=session,
            use_session_sticky=use_session_sticky,
            rate=rate,
            pitch=pitch,
            interrupt_music=interrupt_music,
            extra_env=extra_env,
        )
        threading.Thread(
            target=self._run_locked,
            args=(clean, env, priority),
            daemon=True,
        ).start()

    def speak_blocking(
        self,
        text: str,
        *,
        voice: str | None = None,
        priority: bool = False,
        bypass_cursor_defer: bool = False,
        session: str | None = None,
        use_session_sticky: bool = True,
        rate: str | None = None,
        pitch: str | None = None,
        interrupt_music: bool = False,
        extra_env: dict[str, str] | None = None,
        timeout: float = 120.0,
    ) -> float:
        """Blocking TTS — acquires both locks, waits for playback, returns duration."""
        clean = _strip_redacted(text)
        if not clean or len(re.sub(r"[^a-zA-Z0-9\u0900-\u097F]", "", clean)) < 2:
            return 0.0
        env = self._build_env(
            voice=voice,
            priority=priority,
            bypass_cursor_defer=bypass_cursor_defer,
            session=session,
            use_session_sticky=use_session_sticky,
            rate=rate,
            pitch=pitch,
            interrupt_music=interrupt_music,
            extra_env=extra_env,
        )
        t0 = time.perf_counter()
        self._run_locked(clean, env, priority, timeout=timeout)
        return time.perf_counter() - t0

    # ── Internal ───────────────────────────────────────────────────────────

    def _run_locked(
        self,
        clean: str,
        env: dict[str, str],
        priority: bool,
        timeout: float = 120.0,
    ) -> None:
        """Local lock → Redis lock → run friday-speak.py → release both."""
        token = f"{os.getpid()}:{uuid.uuid4().hex[:8]}"

        with _local_lock:
            if not _acquire_redis_lock(token, priority=priority):
                return
            try:
                subprocess.run(
                    [self._python, self._script, clean],
                    env=env,
                    capture_output=True,
                    timeout=timeout,
                    **self._no_window(),
                )
            except Exception:
                pass
            finally:
                _release_redis_lock(token)

    def _build_env(
        self,
        *,
        voice: str | None,
        priority: bool,
        bypass_cursor_defer: bool,
        session: str | None,
        use_session_sticky: bool,
        rate: str | None,
        pitch: str | None,
        interrupt_music: bool,
        extra_env: dict[str, str] | None,
    ) -> dict[str, str]:
        env = {**os.environ}
        if voice:
            env["FRIDAY_TTS_VOICE"] = voice
        if rate:
            env["FRIDAY_TTS_RATE"] = rate
        if pitch:
            env["FRIDAY_TTS_PITCH"] = pitch
        if priority:
            env["FRIDAY_TTS_PRIORITY"] = "1"
        else:
            env.pop("FRIDAY_TTS_PRIORITY", None)
        if bypass_cursor_defer:
            env["FRIDAY_TTS_BYPASS_CURSOR_DEFER"] = "true"
        if session:
            env["FRIDAY_TTS_SESSION"] = session
        if not use_session_sticky:
            env["FRIDAY_TTS_USE_SESSION_STICKY_VOICE"] = "false"
        if interrupt_music:
            env["FRIDAY_TTS_INTERRUPT_MUSIC"] = "ui"
        if extra_env:
            env.update(extra_env)
        return env

    @staticmethod
    def _no_window() -> dict:
        if sys.platform == "win32":
            return {"creationflags": subprocess.CREATE_NO_WINDOW}
        return {}


# Module-level singleton — import this
speaker = FridaySpeaker()
