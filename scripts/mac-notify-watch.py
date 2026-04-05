#!/usr/bin/env python3
"""
mac-notify-watch.py — show macOS banners for OpenClaw SSE events (win_notify).

Uses the same pc-agent /voice/stream stream as the Listen UI. Much narrower than
Windows WPN scraping: only forwards structured win_notify payloads to osascript.

Env (.env):
  FRIDAY_MAC_NOTIFY_WATCH   master switch (default false)
  PC_AGENT_URL              base URL (default http://127.0.0.1:3847)
  PC_AGENT_SECRET           Bearer for /voice/stream
"""

from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
_ENV = _REPO / ".env"
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

if platform.system() != "Darwin":
    print("[mac-notify] not macOS — exiting.")
    sys.exit(0)

_MASTER = os.environ.get("FRIDAY_MAC_NOTIFY_WATCH", "false").strip().lower()
if _MASTER in ("0", "false", "no", "off", ""):
    print("[mac-notify] FRIDAY_MAC_NOTIFY_WATCH is off — exiting.")
    sys.exit(0)

BASE = os.environ.get("PC_AGENT_URL", "http://127.0.0.1:3847").rstrip("/")
SECRET = os.environ.get("PC_AGENT_SECRET", "").strip()
if not SECRET:
    print("[mac-notify] PC_AGENT_SECRET missing — exiting.", file=sys.stderr)
    sys.exit(1)

RECONNECT_SEC = float(os.environ.get("FRIDAY_MAC_NOTIFY_RECONNECT_SEC", "4").strip() or "4")


def _banner(title: str, body: str) -> None:
    t = (title or "OpenClaw").replace('"', "'").replace("\n", " ")[:120]
    b = (body or "").replace('"', "'").replace("\n", " ")[:500]
    script = f'display notification "{b}" with title "{t}"'
    try:
        subprocess.run(
            ["osascript", "-e", script],
            capture_output=True,
            text=True,
            timeout=20,
        )
    except Exception as exc:
        print(f"[mac-notify] osascript failed: {exc}", file=sys.stderr)


def _handle_payload(obj: object) -> None:
    if not isinstance(obj, dict):
        return
    if obj.get("type") != "win_notify":
        return
    title = str(obj.get("title") or obj.get("app") or "OpenClaw")
    body = str(obj.get("body") or "")
    if not body.strip():
        return
    _banner(title, body)


def _loop() -> None:
    url = f"{BASE}/voice/stream"
    headers = {
        "Authorization": f"Bearer {SECRET}",
        "Accept": "text/event-stream",
        "ngrok-skip-browser-warning": "true",
    }
    buf = b""
    while True:
        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                while True:
                    chunk = resp.read(2048)
                    if not chunk:
                        break
                    buf += chunk
                    while b"\n" in buf:
                        line, buf = buf.split(b"\n", 1)
                        try:
                            s = line.decode("utf-8", errors="replace").strip()
                        except Exception:
                            continue
                        if not s.startswith("data:"):
                            continue
                        raw = s[5:].strip()
                        if not raw or raw == "[DONE]":
                            continue
                        try:
                            _handle_payload(json.loads(raw))
                        except json.JSONDecodeError:
                            pass
        except urllib.error.HTTPError as e:
            print(f"[mac-notify] HTTP {e.code} — retry in {RECONNECT_SEC}s", file=sys.stderr)
        except Exception as exc:
            print(f"[mac-notify] stream error: {exc!r} — retry in {RECONNECT_SEC}s", file=sys.stderr)
        time.sleep(RECONNECT_SEC)


if __name__ == "__main__":
    print(f"[mac-notify] SSE → Notification Center | {BASE}", flush=True)
    _loop()
