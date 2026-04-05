#!/usr/bin/env python3
"""
Clear Friday runtime locks after a hard kill (restart:force, stuck TTS, wedged music guard).

Redis (same resolution as friday-speak.py: OPENCLAW_REDIS_URL, else FRIDAY_AMBIENT_REDIS_URL, else default):
  friday:music:active            — friday-play session lease
  friday:tts:lock              — distributed TTS lock
  friday:tts:generation        — speak supersession counter
  friday:tts:thinking_singleton — thinking narration singleton
  friday:tts:last_call         — last TTS call hint (optional flush)
  friday:tts:last_activity     — last spoken wall time for ECHO silence watcher (optional flush)
  openclaw:silence_watch:last_nudge — ECHO re-arm debounce (optional flush)
  friday:tts:thinking_pool_idx — friday-speak thinking pool rotation counter
  friday:now_playing           — short-lived ambient hint

Temp files (%TEMP%):
  friday-tts-active, friday-thinking-singleton, friday-tts-generation,
  friday-play.pid, friday-play-session.start, friday-ambient-speaking.txt

  --music-only   only friday-play / music Redis keys + play pid files (does not clear TTS locks)

Exit 0 always; prints what it did. Redis errors are non-fatal (stderr one line).
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent.parent
_ENV = _ROOT / ".env"

if _ENV.exists():
    for line in _ENV.read_text(encoding="utf-8").splitlines():
        t = line.strip()
        if not t or t.startswith("#") or "=" not in t:
            continue
        k, _, rest = t.partition("=")
        k = k.strip()
        v = rest.split("#", 1)[0].strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v

REDIS_KEYS_FULL = (
    "friday:music:active",
    "friday:tts:lock",
    "friday:tts:generation",
    "friday:tts:thinking_singleton",
    "friday:tts:thinking_pool_idx",
    "friday:tts:last_call",
    "friday:tts:last_activity",
    "openclaw:silence_watch:last_nudge",
    "friday:now_playing",
)

REDIS_KEYS_MUSIC_ONLY = (
    "friday:music:active",
    "friday:now_playing",
)

TEMP_FILES_FULL = (
    "friday-tts-active",
    "friday-thinking-singleton",
    "friday-tts-generation",
    "friday-play.pid",
    "friday-play-session.start",
    "friday-ambient-speaking.txt",
)

TEMP_FILES_MUSIC_ONLY = (
    "friday-play.pid",
    "friday-play-session.start",
)


def _redis_url() -> str:
    return (
        os.environ.get("OPENCLAW_REDIS_URL", "").strip()
        or os.environ.get("FRIDAY_AMBIENT_REDIS_URL", "").strip()
        or "redis://127.0.0.1:6379"
    )


def main() -> int:
    music_only = "--music-only" in sys.argv
    redis_keys = REDIS_KEYS_MUSIC_ONLY if music_only else REDIS_KEYS_FULL
    temp_names = TEMP_FILES_MUSIC_ONLY if music_only else TEMP_FILES_FULL
    if music_only:
        print("[clear-friday-locks] mode=music-only (TTS locks left intact)", flush=True)

    td = Path(tempfile.gettempdir())
    for name in temp_names:
        p = td / name
        try:
            if p.exists():
                p.unlink()
                print(f"[clear-friday-locks] removed {p.name}", flush=True)
        except OSError as e:
            print(f"[clear-friday-locks] temp {name}: {e}", file=sys.stderr, flush=True)

    url = _redis_url()
    try:
        import redis  # type: ignore

        r = redis.Redis.from_url(url, decode_responses=True)
        r.ping()
        for k in redis_keys:
            n = r.delete(k)
            if n:
                print(f"[clear-friday-locks] Redis DEL {k}", flush=True)
        print("[clear-friday-locks] Redis ping OK", flush=True)
    except Exception as e:
        print(
            f"[clear-friday-locks] Redis unavailable — locks not cleared ({e.__class__.__name__})",
            file=sys.stderr,
            flush=True,
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
