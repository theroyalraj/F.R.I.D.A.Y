#!/usr/bin/env python3
"""
Probe Chrome DevTools Protocol on Cursor (or any Chromium).

Cursor does NOT open remote debugging by default — add this to your Cursor shortcut
Target (after the closing quote of the .exe path):

  --remote-debugging-port=9222

Full example:
  "C:\\Users\\YOU\\AppData\\Local\\Programs\\cursor\\Cursor.exe" --remote-debugging-port=9222

Then restart Cursor and run:
  python scripts/cursor-cdp-probe.py

Env: FRIDAY_CURSOR_CDP_PORT (default 9222)
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

_HOST = "127.0.0.1"
_PORT = int(os.environ.get("FRIDAY_CURSOR_CDP_PORT", "9222").strip() or "9222")


def main() -> None:
    url = f"http://{_HOST}:{_PORT}/json/list"
    try:
        with urllib.request.urlopen(url, timeout=2) as r:
            data = json.loads(r.read().decode())
    except urllib.error.URLError as e:
        print(f"CDP not reachable at {_PORT}: {e}", file=sys.stderr)
        print("\nEnable: add to Cursor shortcut Target:", file=sys.stderr)
        print('  --remote-debugging-port=9222', file=sys.stderr)
        print("Then restart Cursor and run this script again.", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"CDP OK on port {_PORT} — {len(data)} target(s)\n")
    for t in data:
        tid = t.get("id", "")
        typ = t.get("type", "")
        title = t.get("title", "")[:80]
        wurl = t.get("url", "")[:100]
        ws = t.get("webSocketDebuggerUrl", "")
        print(f"  [{typ}] {title!r}")
        print(f"       url: {wurl}")
        if ws:
            print(f"       ws:  {ws[:72]}...")
        print()


if __name__ == "__main__":
    main()
