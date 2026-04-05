#!/usr/bin/env python3
"""
create-calendar-event.py — Create a .ics calendar event and open it in
the default Windows calendar application.

Usage:
  python scripts/create-calendar-event.py --title "Team Standup" \
      --date 2026-04-10 --time 10:00 --duration 30 --location "Zoom"

Args:
  --title       Event title (required)
  --date        ISO date YYYY-MM-DD (optional; defaults to today)
  --time        Start time HH:MM 24-hour (optional; defaults to 09:00)
  --duration    Duration in minutes (optional; default 60)
  --location    Location/URL (optional)
  --description Event description/notes (optional)
  --open        Whether to open the .ics file (default true)

Output: writes <data/calendar/YYYYMMDD-<slug>.ics> and opens it.
"""
from __future__ import annotations

import os
import platform
import re
import subprocess
import sys
import textwrap
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_ENV_FILE = _REPO_ROOT / ".env"
if _ENV_FILE.exists():
    for _line in _ENV_FILE.read_text(encoding="utf-8").splitlines():
        _t = _line.strip()
        if not _t or _t.startswith("#") or "=" not in _t:
            continue
        _k, _, _rest = _t.partition("=")
        _k = _k.strip()
        _v = _rest.split("#", 1)[0].strip().strip('"').strip("'")
        if _k and _k not in os.environ:
            os.environ[_k] = _v

_CALENDAR_DIR = _REPO_ROOT / "data" / "calendar"


def _arg(args: list[str], flag: str, default: str = "") -> str:
    for i, a in enumerate(args):
        if a == flag and i + 1 < len(args):
            return args[i + 1]
    return default


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower())[:40].strip("-")


def _format_dt(dt: datetime) -> str:
    """Format datetime as iCal DTSTART/DTEND — local floating time."""
    return dt.strftime("%Y%m%dT%H%M%S")


def create_ics(
    title: str,
    date_str: str = "",
    time_str: str = "",
    duration_min: int = 60,
    location: str = "",
    description: str = "",
) -> Path:
    today = datetime.now()
    if date_str:
        try:
            d = datetime.strptime(date_str, "%Y-%m-%d").date()
        except ValueError:
            d = today.date()
    else:
        d = today.date()

    if time_str:
        try:
            t = datetime.strptime(time_str, "%H:%M").time()
        except ValueError:
            t = datetime.strptime("09:00", "%H:%M").time()
    else:
        t = datetime.strptime("09:00", "%H:%M").time()

    start = datetime.combine(d, t)
    end = start + timedelta(minutes=max(1, duration_min))
    now_utc = datetime.now(tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")

    uid = str(uuid.uuid4())
    slug = _slug(title)
    date_label = d.strftime("%Y%m%d")

    _CALENDAR_DIR.mkdir(parents=True, exist_ok=True)
    ics_path = _CALENDAR_DIR / f"{date_label}-{slug}.ics"

    desc_lines = textwrap.wrap(description.strip() or title, 60)
    desc_folded = "\\n".join(desc_lines) if desc_lines else title

    ics_content = "\r\n".join([
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//OpenClaw//Friday//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:REQUEST",
        "BEGIN:VEVENT",
        f"UID:{uid}@openclaw.friday",
        f"DTSTAMP:{now_utc}",
        f"DTSTART:{_format_dt(start)}",
        f"DTEND:{_format_dt(end)}",
        f"SUMMARY:{title}",
        f"DESCRIPTION:{desc_folded}",
        f"LOCATION:{location}" if location else "LOCATION:",
        "STATUS:TENTATIVE",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
    ])

    ics_path.write_text(ics_content, encoding="utf-8")
    print(f"[create-calendar-event] wrote: {ics_path}", flush=True)
    return ics_path


def open_ics(ics_path: Path) -> None:
    if platform.system() == "Windows":
        try:
            os.startfile(str(ics_path))
            print(f"[create-calendar-event] opened in Windows Calendar: {ics_path.name}", flush=True)
            return
        except Exception as exc:
            print(f"[create-calendar-event] os.startfile failed: {exc}", file=sys.stderr)
        try:
            subprocess.Popen(["cmd", "/c", "start", "", str(ics_path)], shell=False)
        except Exception as exc:
            print(f"[create-calendar-event] start failed: {exc}", file=sys.stderr)
    elif platform.system() == "Darwin":
        subprocess.Popen(["open", str(ics_path)])
    else:
        subprocess.Popen(["xdg-open", str(ics_path)])


def main() -> None:
    argv = sys.argv[1:]
    title = _arg(argv, "--title") or "Meeting"
    date_str = _arg(argv, "--date")
    time_str = _arg(argv, "--time")
    duration = int(_arg(argv, "--duration", "60") or "60")
    location = _arg(argv, "--location")
    description = _arg(argv, "--description")
    do_open = _arg(argv, "--open", "true").lower() not in ("false", "0", "no")

    ics_path = create_ics(
        title=title,
        date_str=date_str,
        time_str=time_str,
        duration_min=duration,
        location=location,
        description=description,
    )
    if do_open:
        open_ics(ics_path)
    print(ics_path)


if __name__ == "__main__":
    main()
