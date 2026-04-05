#!/usr/bin/env python3
"""
friday-reminder-watch.py — Polls the pc-agent /todos/reminders endpoint every minute
and speaks any reminders that are due, at highest TTS priority.

Env:
  PC_AGENT_URL          pc-agent base URL (default http://127.0.0.1:3847)
  FRIDAY_REMINDER_POLL_SEC  polling interval (default 60)
  FRIDAY_REMINDER_WINDOW_SEC how far ahead to fire (default 120 — fires 2 min early)

Run:
  python scripts/friday-reminder-watch.py
"""
from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

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

_SPEAK_SCRIPT = _REPO_ROOT / "skill-gateway" / "scripts" / "friday-speak.py"

PC_AGENT_URL = os.environ.get("PC_AGENT_URL", "http://127.0.0.1:3847").rstrip("/")
POLL_SEC = max(15, int(os.environ.get("FRIDAY_REMINDER_POLL_SEC", "60")))
WINDOW_SEC = max(30, int(os.environ.get("FRIDAY_REMINDER_WINDOW_SEC", "120")))


def _speak(text: str) -> None:
    if not _SPEAK_SCRIPT.exists():
        print(f"[harper] would speak: {text}", flush=True)
        return
    try:
        from openclaw_company import friday_speak_env_for_persona

        env = {**os.environ, **friday_speak_env_for_persona("harper", priority=True)}
    except Exception:
        env = {
            **os.environ,
            "FRIDAY_TTS_PRIORITY": "1",
            "FRIDAY_TTS_BYPASS_CURSOR_DEFER": "true",
        }
    kwargs: dict = {}
    if platform.system() == "Windows":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        subprocess.Popen(
            [sys.executable, str(_SPEAK_SCRIPT), text],
            cwd=str(_REPO_ROOT),
            env=env,
            **kwargs,
        )
        print(f"[harper] spoke: {text[:120]}", flush=True)
    except Exception as exc:
        print(f"[harper] speak failed: {exc}", file=sys.stderr)


def _get_reminders() -> list[dict]:
    url = f"{PC_AGENT_URL}/todos/reminders"
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("reminders", [])
    except Exception as exc:
        print(f"[reminder-watch] GET reminders failed: {exc}", file=sys.stderr)
        return []


def _fire_reminder(reminder_id: str) -> None:
    url = f"{PC_AGENT_URL}/todos/reminders/{reminder_id}/fire"
    req = urllib.request.Request(url, data=b"{}", headers={"Content-Type": "application/json"}, method="PATCH")
    try:
        urllib.request.urlopen(req, timeout=5)
    except Exception as exc:
        print(f"[reminder-watch] fire PATCH failed: {exc}", file=sys.stderr)


def _check_due_reminders() -> None:
    import datetime

    reminders = _get_reminders()
    now = datetime.datetime.now(tz=datetime.timezone.utc)
    horizon = now + datetime.timedelta(seconds=WINDOW_SEC)

    for r in reminders:
        if r.get("fired"):
            continue
        due_iso = r.get("dueIso")
        if not due_iso:
            continue
        try:
            due = datetime.datetime.fromisoformat(due_iso.replace("Z", "+00:00"))
            if due.tzinfo is None:
                due = due.replace(tzinfo=datetime.timezone.utc)
        except ValueError:
            continue
        if due <= horizon:
            title = r.get("title", "Reminder")
            due_nat = r.get("dueNatural", "")
            text = f"Harper here, your executive assistant. Reminder: {title}."
            if due_nat:
                text += f" This was due {due_nat}."
            _speak(text)
            _fire_reminder(r["id"])
            print(f"[harper] fired reminder: {title}", flush=True)


def main() -> None:
    print(f"[harper] Harper (Executive Assistant) starting — poll every {POLL_SEC}s | {PC_AGENT_URL}", flush=True)
    while True:
        try:
            _check_due_reminders()
        except KeyboardInterrupt:
            print("[harper] stopped.", flush=True)
            sys.exit(0)
        except Exception as exc:
            print(f"[reminder-watch] error: {exc}", file=sys.stderr)
        time.sleep(POLL_SEC)


if __name__ == "__main__":
    main()
