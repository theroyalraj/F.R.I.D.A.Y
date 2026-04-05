#!/usr/bin/env python3
"""Print persona registry + key TTS env vars (daemon alignment check). Run from repo root."""
from __future__ import annotations

import os
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
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

_scripts = Path(__file__).resolve().parent
if str(_scripts) not in sys.path:
    sys.path.insert(0, str(_scripts))

from openclaw_company import PERSONAS, get_persona  # noqa: E402

KEYS = (
    "FRIDAY_TTS_VOICE",
    "FRIDAY_TTS_THINKING_VOICE",
    "FRIDAY_CURSOR_REPLY_VOICE",
    "FRIDAY_EMAIL_NOTIFY_VOICE",
    "FRIDAY_ARGUS_VOICE",
)


def main() -> None:
    print("OpenClaw persona -> Edge voice (after OPENCLAW_* / legacy env)\n")
    for role in sorted(PERSONAS.keys()):
        p = get_persona(role)
        v = (p.get("voice") or "").strip() or "(none)"
        r = (p.get("rate") or "").strip()
        extra = f"  {r}" if r else ""
        print(f"  {role:10}  {v}{extra}")
    print("\nSticky / override env\n")
    for k in KEYS:
        val = os.environ.get(k, "").strip()
        print(f"  {k:32} {val or '(unset)'}")
    sv = _ROOT / ".session-voice.json"
    if sv.exists():
        print(f"\n.session-voice.json ({sv.name})")
        try:
            import json

            d = json.loads(sv.read_text(encoding="utf-8"))
            for k in ("voice", "subagent_voice", "cursor_reply_voice", "thinking_voice"):
                if k in d:
                    print(f"  {k:20} {d.get(k) or '(none)'}")
        except Exception as e:
            print(f"  (read error: {e})")
    else:
        print("\n(no .session-voice.json)")
    print(
        "Postgres roster (merged defaults + patch): GET http://127.0.0.1:3847/settings/personas "
        "(Bearer JWT or PC_AGENT_SECRET). Python daemons read Redis key openclaw:voice_agent_personas_patch.\n"
    )


if __name__ == "__main__":
    main()
