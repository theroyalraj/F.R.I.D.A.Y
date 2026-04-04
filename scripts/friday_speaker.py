"""
friday_speaker.py — common TTS singleton used by every Python script in this repo.

All scripts (friday-listen, friday-ambient, cursor-reply-watch, etc.) import
FridaySpeaker instead of manually spawning friday-speak.py via subprocess.

Serialisation lives inside friday-speak.py itself (Redis distributed lock +
file lock), so this module does NOT double-lock.  It provides:
  • Text sanitisation (strip redacted tokens)
  • Consistent env-var building
  • A local threading.Lock so two in-process threads don't spawn two
    friday-speak.py subprocesses at the same instant (the child will
    still serialise via Redis, but avoiding the spawn storm is cheaper).

Usage:
    from friday_speaker import speaker   # singleton, ready to use

    speaker.speak("Hello")                         # fire-and-forget (background thread)
    duration = speaker.speak_blocking("Hello")     # waits for playback, returns seconds
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
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_SPEAK_SCRIPT = _REPO_ROOT / "skill-gateway" / "scripts" / "friday-speak.py"

# Local lock — avoids spawning two friday-speak.py at the exact same instant.
# The child process does its own Redis + file lock, but this prevents the
# burst of process spawns that overloads Edge TTS before the first child
# can even acquire its lock.
_local_lock = threading.Lock()


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
        """Fire-and-forget TTS — returns immediately, audio queued via local lock."""
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
            args=(clean, env),
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
        timeout: float | None = None,
    ) -> float:
        """Blocking TTS — waits for playback, returns duration in seconds."""
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
        self._run_locked(clean, env, timeout=timeout)
        return time.perf_counter() - t0

    # ── Internal ───────────────────────────────────────────────────────────

    def _run_locked(self, clean: str, env: dict[str, str], timeout: float | None = None) -> None:
        """Local lock → spawn friday-speak.py (it handles Redis lock internally).

        timeout=None waits for playback to finish (no cap). friday-speak.py enforces its
        own playback budget when configured; killing the child here at thirty seconds
        used to truncate long TTS and looked like a broken voice.
        """
        with _local_lock:
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
