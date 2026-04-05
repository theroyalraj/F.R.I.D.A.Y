#!/usr/bin/env python3
"""
openclaw-terminal-pc-agent.py — talk to OpenClaw pc-agent from the terminal the same way
the Friday *chat* page does: authenticated POST /task, no voice fast-path source tag, so you
get the full Claude Code path (shell, workspace tools) instead of the Haiku-only API used
when source is \"voice\".

Also prints the JSON summary and optionally narrates it via friday-speak.py (same Edge TTS
as the rest of OpenClaw).

Usage:
  python scripts/openclaw-terminal-pc-agent.py open notepad
  python scripts/openclaw-terminal-pc-agent.py -i
  python scripts/openclaw-terminal-pc-agent.py --no-speak \"list files in the workspace\"

Env (optional — loads repo .env like friday-listen):
  PC_AGENT_URL      default http://127.0.0.1:3847
  PC_AGENT_SECRET   required for /task (same as N8N → pc-agent Bearer token)

There is no separate server-side \"priority queue\" today; this script uses /task so your
request is handled like Alexa/N8N jobs (authenticated, full runner). Run it while the voice
daemon is active — each request is independent.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

try:
    import requests
except ImportError:
    print("Install requests: pip install requests", file=sys.stderr)
    raise SystemExit(1)


def _load_dotenv() -> None:
    root = Path(__file__).resolve().parent.parent
    env_path = root / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        t = line.strip()
        if not t or t.startswith("#"):
            continue
        i = t.find("=")
        if i < 1:
            continue
        k, v = t[:i].strip(), t[i + 1 :].strip()
        if v.startswith('"') and v.endswith('"'):
            v = v[1:-1]
        elif v.startswith("'") and v.endswith("'"):
            v = v[1:-1]
        if k not in os.environ:
            os.environ[k] = v


def _speak(text: str) -> None:
    root = Path(__file__).resolve().parent.parent
    speak_py = root / "skill-gateway" / "scripts" / "friday-speak.py"
    if not speak_py.exists():
        print("(friday-speak.py not found; skipping TTS)", file=sys.stderr)
        return
    try:
        subprocess.run(
            [sys.executable, str(speak_py), text],
            cwd=str(root),
            check=False,
            timeout=120,
        )
    except Exception as e:
        print(f"(TTS failed: {e})", file=sys.stderr)


def _run_one(
    text: str,
    *,
    base: str,
    secret: str,
    user_id: str,
    no_speak: bool,
    priority_header: bool,
) -> int:
    text = (text or "").strip()
    if not text:
        print("Empty command.", file=sys.stderr)
        return 1
    url = f"{base.rstrip('/')}/task"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {secret}",
        "ngrok-skip-browser-warning": "1",
    }
    if priority_header:
        headers["X-Openclaw-Priority"] = "high"
    body = {
        "text": text,
        "userId": user_id,
        "correlationId": str(uuid.uuid4()),
        # Omit \"source\" so runTask does NOT use the voice fast API (matches voice.html chat).
    }
    try:
        r = requests.post(url, headers=headers, json=body, timeout=600)
    except requests.exceptions.ConnectionError:
        print(
            f"Cannot reach pc-agent at {base}. Is it running? Try npm run restart:local (safe) or npm run restart:force if ports are stuck.",
            file=sys.stderr,
        )
        return 1
    try:
        j = r.json()
    except json.JSONDecodeError:
        print(r.text[:2000] or f"HTTP {r.status_code}", file=sys.stderr)
        return 1

    summary = j.get("summary") or j.get("error") or json.dumps(j)
    mode = j.get("mode", "")
    ok = j.get("ok", r.ok)
    print(summary)
    if mode:
        print(f"(mode={mode} ok={ok})", file=sys.stderr)

    if not no_speak and summary:
        _speak(str(summary))

    return 0 if r.ok and ok is not False else 1


def main() -> int:
    _load_dotenv()
    p = argparse.ArgumentParser(description="Send a command to OpenClaw pc-agent (/task, full path).")
    p.add_argument("text", nargs="*", help="Command text (or use -i)")
    p.add_argument("-i", "--interactive", action="store_true", help="Read lines from stdin until EOF")
    p.add_argument("--no-speak", action="store_true", help="Do not call friday-speak.py")
    p.add_argument(
        "--user-id",
        default="openclaw-terminal",
        help="userId field (default: openclaw-terminal)",
    )
    p.add_argument(
        "--priority-header",
        action="store_true",
        help='Send X-Openclaw-Priority: high (reserved for future queue use; harmless today)',
    )
    args = p.parse_args()

    base = os.environ.get("PC_AGENT_URL", "http://127.0.0.1:3847").rstrip("/")
    secret = (os.environ.get("PC_AGENT_SECRET") or "").strip()
    if not secret:
        print("PC_AGENT_SECRET is not set (.env or environment). Required for POST /task.", file=sys.stderr)
        return 1

    if args.interactive:
        print("OpenClaw terminal (full /task path). Enter lines, Ctrl-Z then Enter (Windows) or Ctrl-D (Unix) to finish.", file=sys.stderr)
        lines = sys.stdin.read().splitlines()
        code = 0
        for line in lines:
            line = line.strip()
            if not line:
                continue
            c = _run_one(
                line,
                base=base,
                secret=secret,
                user_id=args.user_id,
                no_speak=args.no_speak,
                priority_header=args.priority_header,
            )
            code = max(code, c)
        return code

    cmd = " ".join(args.text).strip()
    if not cmd:
        p.print_help()
        return 1
    return _run_one(
        cmd,
        base=base,
        secret=secret,
        user_id=args.user_id,
        no_speak=args.no_speak,
        priority_header=args.priority_header,
    )


if __name__ == "__main__":
    raise SystemExit(main())
