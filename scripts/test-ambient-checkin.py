#!/usr/bin/env python3
"""
Smoke-test the ambient sub-agent check-in voice path.

Calls exactly the same code that _ambient_checkin_loop uses:
  speak_subagent_blocking  (blocking; sub-agent rate/pitch; FRIDAY_AMBIENT_SUB_TTS_VOICE if set)
  _format_local_time_spoken
  _pick_checkin_line

Options:
  --all          Cycle through all 5 check-in templates (default: pick one random)
  --dry-run      Print lines without speaking
  --pause N      Seconds between lines when --all is used (default: 3)

Usage:
  python scripts/test-ambient-checkin.py
  python scripts/test-ambient-checkin.py --all --pause 4
  python scripts/test-ambient-checkin.py --dry-run
"""
from __future__ import annotations

import argparse
import datetime
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEAK = ROOT / "skill-gateway" / "scripts" / "friday-speak.py"

_SCRIPTS = Path(__file__).resolve().parent
_SG_SCRIPTS = ROOT / "skill-gateway" / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))


def _load_dotenv() -> None:
    env_path = ROOT / ".env"
    if not env_path.is_file():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        t = line.strip()
        if not t or t.startswith("#"):
            continue
        i = t.find("=")
        if i < 1:
            continue
        k = t[:i].strip()
        v = t[i + 1:].split("#")[0].strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


def _no_window() -> dict:
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}


def _get_user_tz():
    tz_name = os.environ.get("FRIDAY_USER_TZ", "").strip()
    if not tz_name:
        return None
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(tz_name)
    except Exception:
        pass
    try:
        import pytz  # type: ignore
        return pytz.timezone(tz_name)
    except Exception:
        pass
    return None


def _user_now() -> datetime.datetime:
    tz = _get_user_tz()
    if tz is not None:
        return datetime.datetime.now(tz=tz)
    return datetime.datetime.now().astimezone()


def _format_local_time_spoken() -> str:
    now = _user_now()
    h12 = now.hour % 12 or 12
    suf = "AM" if now.hour < 12 else "PM"
    return f"{h12}:{now.minute:02d} {suf}"


_CHECKIN_TEMPLATES = [
    # ── Physical / wellness ───────────────────────────────────────────────────
    "Hey {user}, quick pulse check. It's {time}. How are you holding up? Maybe water, a stretch, or a short break?",
    "Time check for {user}: {time}. You've been at this a while — want to pause, snack, or just breathe for a minute?",
    "{user}, {time}. Sub-agent check-in: posture okay? Eyes need a break? I'm not going anywhere.",
    "It's {time}, {user}. Gentle nudge — hydrate if you can, and don't forget to unclench your jaw.",
    "{user}, shoulders. Right now. Drop them. It's {time} and you've been tensed up for a while.",
    "Blink check, {user} — it's {time}. Seriously, look away from the screen for twenty seconds. I'll wait.",
    # ── Humorous ─────────────────────────────────────────────────────────────
    "{user}, it is {time} and I am legally required to ask if you've eaten anything that wasn't coffee.",
    "Sub-agent reporting in at {time}. {user}, the chair is not a throne — stand up for sixty seconds.",
    "{time}, {user}. Just checking you haven't been sucked into a rabbit hole. How's the surface world?",
    "It's {time}. {user}, if you've been in flow state this whole time, impressive — but your back disagrees.",
    # ── Motivational / curious ────────────────────────────────────────────────
    "{time}, {user}. Quick check-in — how's the problem you were working on? Any breakthrough yet?",
    "{user}, it's {time}. You've put in solid time. Take sixty seconds to step back and look at the big picture before diving back in.",
    "Clock says {time}, {user}. Sometimes the best debugging tool is a short walk and fresh eyes.",
    # ── Late-night / early-morning aware ─────────────────────────────────────
    "{time} and you're still at it, {user}. Respect — but brain fog is real after midnight. A short break now saves an hour of confusion later.",
    "Hey {user}, {time}. The screen has been winning for a while. Give your eyes a rest — even two minutes helps.",
    "{user}, {time}. Sub-agent wellness ping: water, posture, one deep breath. Go.",
]


def speak_line(label: str, text: str, *, dry_run: bool) -> int:
    sub_rate  = os.environ.get("FRIDAY_AMBIENT_SUB_VOICE_RATE",  "+9%")
    sub_pitch = os.environ.get("FRIDAY_AMBIENT_SUB_VOICE_PITCH", "+3Hz")
    subv      = os.environ.get("FRIDAY_AMBIENT_SUB_TTS_VOICE",   "").strip()
    main_v    = os.environ.get("FRIDAY_TTS_VOICE", "en-US-EmmaMultilingualNeural").strip() or "en-US-EmmaMultilingualNeural"
    voice_used = subv or main_v

    print(f"\n[{label}]")
    print(f"  voice : {voice_used}")
    print(f"  rate  : {sub_rate}  pitch: {sub_pitch}")
    print(f"  text  : {text[:120]}{'...' if len(text) > 120 else ''}")

    if dry_run:
        print("  (dry-run — not speaking)")
        return 0

    if not SPEAK.is_file():
        print(f"  ERROR: {SPEAK} not found", file=sys.stderr)
        return 1

    env = {
        **os.environ,
        "FRIDAY_TTS_USE_SESSION_STICKY_VOICE": "false",
        "FRIDAY_TTS_RATE":  sub_rate,
        "FRIDAY_TTS_PITCH": sub_pitch,
        "FRIDAY_TTS_BYPASS_CURSOR_DEFER": "true",
    }
    env.pop("FRIDAY_TTS_PRIORITY", None)   # check-in does NOT use priority
    if subv:
        env["FRIDAY_TTS_VOICE"] = subv

    result = subprocess.run(
        [sys.executable, str(SPEAK), text],
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        **_no_window(),
    )
    if result.returncode != 0:
        err = (result.stderr or result.stdout or "").strip()[:500]
        print(f"  FAILED (exit {result.returncode}): {err}")
    else:
        out = (result.stdout or "").strip().splitlines()
        for o in out:
            print(f"  {o}")
        print("  ok")
    return result.returncode


def main() -> None:
    _load_dotenv()

    ap = argparse.ArgumentParser(description="Test ambient sub-agent check-in TTS")
    ap.add_argument("--all",      action="store_true", help="Cycle all 5 templates")
    ap.add_argument("--dry-run",  action="store_true", help="Print without speaking")
    ap.add_argument("--pause",    type=float, default=3.0, metavar="SEC",
                    help="Seconds between lines when --all is used (default 3)")
    args = ap.parse_args()

    name = (os.environ.get("FRIDAY_USER_NAME", "Raj").strip() or "Raj")
    tz_name = os.environ.get("FRIDAY_USER_TZ", "(system local)").strip() or "(system local)"
    now = _format_local_time_spoken()
    print(f"\nCheck-in test  |  user={name}  time={now}")
    print(f"  FRIDAY_USER_TZ                = {tz_name} ({_user_now().strftime('%Z %z')})")
    print(f"  UTC epoch                     = {int(_user_now().timestamp())}")
    print(f"  FRIDAY_AMBIENT_SUB_TTS_VOICE  = {os.environ.get('FRIDAY_AMBIENT_SUB_TTS_VOICE', '(not set)')}")
    print(f"  FRIDAY_AMBIENT_SUB_VOICE_RATE = {os.environ.get('FRIDAY_AMBIENT_SUB_VOICE_RATE', '+9%')}")
    print(f"  FRIDAY_AMBIENT_MAIN_VOICE_ONLY = {os.environ.get('FRIDAY_AMBIENT_MAIN_VOICE_ONLY', 'false')}")
    print()

    if args.all:
        lines = [t.format(user=name, time=now) for t in _CHECKIN_TEMPLATES]
        codes = []
        for i, line in enumerate(lines):
            code = speak_line(f"checkin template {i + 1}/{len(lines)}", line, dry_run=args.dry_run)
            codes.append(code)
            if i < len(lines) - 1 and not args.dry_run:
                time.sleep(args.pause)
        failed = sum(1 for c in codes if c != 0)
        print(f"\n{'All' if not failed else str(len(codes) - failed) + '/' + str(len(codes))} lines {'ok' if not failed else 'completed — ' + str(failed) + ' failed'}")
    else:
        import random
        tmpl = random.choice(_CHECKIN_TEMPLATES)
        line = tmpl.format(user=name, time=now)
        code = speak_line("checkin (random template)", line, dry_run=args.dry_run)
        sys.exit(code)


if __name__ == "__main__":
    main()
