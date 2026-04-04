#!/usr/bin/env python3
"""
Clear Friday runtime locks after a hard kill (restart-local, stuck TTS, wedged music guard).

Redis (same URL as ambient — FRIDAY_AMBIENT_REDIS_URL, default redis://127.0.0.1:6379):
  friday:music:active   — friday-play session lease
  friday:tts:lock       — ambient distributed TTS lock (string value)
  friday:now_playing    — short-lived ambient hint

Temp files (%TEMP%):
  friday-tts-active, friday-play.pid, friday-play-session.start, friday-ambient-speaking.txt

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

REDIS_KEYS = (
    "friday:music:active",
    "friday:tts:lock",
    "friday:now_playing",
)

TEMP_FILES = (
    "friday-tts-active",
    "friday-play.pid",
    "friday-play-session.start",
    "friday-ambient-speaking.txt",
)


def main() -> int:
    td = Path(tempfile.gettempdir())
    for name in TEMP_FILES:
        p = td / name
        try:
            if p.exists():
                p.unlink()
                print(f"[clear-friday-locks] removed {p.name}", flush=True)
        except OSError as e:
            print(f"[clear-friday-locks] temp {name}: {e}", file=sys.stderr, flush=True)

    url = os.environ.get("FRIDAY_AMBIENT_REDIS_URL", "").strip() or "redis://127.0.0.1:6379"
    try:
        import redis  # type: ignore

        r = redis.Redis.from_url(url, decode_responses=True)
        r.ping()
        for k in REDIS_KEYS:
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
