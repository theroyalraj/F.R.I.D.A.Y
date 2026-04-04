#!/usr/bin/env python3
"""
narrate-screen.py — take a screenshot and describe it via Claude vision (+ optional TTS).

The friday-listen voice daemon does not invoke this script (no hot-mic screen narration).
Use the CLI when you want a capture; use --store to persist to Postgres only (--silent for no TTS).

Usage:
  python scripts/narrate-screen.py              # narrate full screen
  python scripts/narrate-screen.py --silent     # print description only, no TTS
  python scripts/narrate-screen.py --store      # save description to Postgres via pc-agent /perception/capture
  python scripts/narrate-screen.py --store --store-image   # also store JPEG (large payloads)
  python scripts/narrate-screen.py --focus      # narrate focused window only (future)

Env vars (from .env):
  ANTHROPIC_API_KEY   — required for vision
  FRIDAY_USER_NAME    — spoken name (default: Raj)
  FRIDAY_NARRATE_MODEL — claude model for vision (default: claude-haiku-4-5)
  PC_AGENT_SECRET     — Bearer for POST /perception/capture when using --store
  PC_AGENT_BASE_URL   — default http://127.0.0.1:3847
  OPENCLAW_DATABASE_URL — must be set in .env for pc-agent (see .env.example)
"""

import argparse
import base64
import io
import json
import os
import subprocess
import sys
import time
from pathlib import Path

# ── Load .env ─────────────────────────────────────────────────────────────────
root = Path(__file__).resolve().parent.parent
env_path = root / ".env"
if env_path.exists():
    for line in env_path.read_text(encoding="utf-8").splitlines():
        t = line.strip()
        if not t or t.startswith("#"):
            continue
        i = t.find("=")
        if i < 1:
            continue
        k, v = t[:i].strip(), t[i + 1:].strip()
        if v.startswith('"') and v.endswith('"'): v = v[1:-1]
        elif v.startswith("'") and v.endswith("'"): v = v[1:-1]
        if k not in os.environ:
            os.environ[k] = v

def _read_env_key(key: str) -> str:
    """Always read from .env file directly — bypasses stale os.environ."""
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            t = line.strip()
            if t.startswith("#") or "=" not in t:
                continue
            k, _, v = t.partition("=")
            if k.strip() == key:
                v = v.split("#")[0].strip().strip('"').strip("'")
                return v
    return os.environ.get(key, "")

API_KEY    = _read_env_key("ANTHROPIC_API_KEY").strip()
USER_NAME  = (os.environ.get("FRIDAY_USER_NAME", "Raj") or "Raj").strip()
MODEL      = os.environ.get("FRIDAY_NARRATE_MODEL", "claude-haiku-4-5").strip()
SPEAK_SCRIPT = root / "skill-gateway" / "scripts" / "friday-speak.py"


def capture_screen() -> bytes:
    """Capture full screen as JPEG bytes using mss."""
    import mss
    import mss.tools
    from PIL import Image

    with mss.mss() as sct:
        monitor = sct.monitors[0]  # all monitors combined
        shot = sct.grab(monitor)
        img = Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")

    # Downscale to max 1280px wide to keep API payload small
    max_w = 1280
    if img.width > max_w:
        ratio = max_w / img.width
        img = img.resize((max_w, int(img.height * ratio)), Image.LANCZOS)

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=75)
    return buf.getvalue()


def narrate_image(jpeg_bytes: bytes, prompt: str | None = None) -> str:
    """Send screenshot to Claude vision API and get narration."""
    import urllib.request

    if not API_KEY:
        return "No Anthropic API key found. Please set ANTHROPIC_API_KEY in dot env."

    b64 = base64.standard_b64encode(jpeg_bytes).decode()

    system = (
        f"You are Friday — {USER_NAME}'s personal AI. You are looking at their screen right now.\n"
        "Narrate what you see in 2-4 spoken sentences. Be specific and useful — name the app, "
        "the content, what's happening. Sound like a sharp friend describing it, not a machine reading UI labels.\n"
        "Plain English only. No markdown, no bullet points. Write for TTS — it will be spoken aloud."
    )

    user_text = prompt or "What's on my screen right now? Narrate it for me."

    body = json.dumps({
        "model": MODEL,
        "max_tokens": 300,
        "system": system,
        "messages": [{
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/jpeg",
                        "data": b64,
                    }
                },
                {
                    "type": "text",
                    "text": user_text,
                }
            ]
        }]
    }).encode()

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        headers={
            "Content-Type": "application/json",
            "x-api-key": API_KEY,
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read())
        return data["content"][0]["text"].strip()
    except Exception as e:
        return f"Vision API error: {e}"


def store_perception(jpeg_bytes: bytes | None, description: str, include_image: bool) -> None:
    """POST vision result to pc-agent perception store (Postgres + optional Redis pointer)."""
    import urllib.request

    base = (_read_env_key("PC_AGENT_BASE_URL") or "http://127.0.0.1:3847").strip().rstrip("/")
    secret = _read_env_key("PC_AGENT_SECRET").strip()
    if not secret:
        print("[narrate-screen] --store skipped: set PC_AGENT_SECRET in .env", file=sys.stderr)
        return
    body: dict = {
        "sourceType": "screen_vision",
        "descriptionText": description,
        "metadata": {"origin": "narrate-screen.py"},
    }
    if include_image and jpeg_bytes:
        body["imageBase64"] = base64.standard_b64encode(jpeg_bytes).decode()
        body["imageMime"] = "image/jpeg"
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        f"{base}/perception/capture",
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {secret}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            out = json.loads(resp.read().decode())
        print(f"[narrate-screen] stored id={out.get('id')}", file=sys.stderr)
    except Exception as e:
        print(f"[narrate-screen] store failed: {e}", file=sys.stderr)


def speak(text: str) -> None:
    """TTS via friday-speak; blocks until playback finishes (caller may rely on process exit)."""
    if not SPEAK_SCRIPT.exists():
        print(text)
        return
    env = {**os.environ, "FRIDAY_TTS_BYPASS_CURSOR_DEFER": "true", "FRIDAY_TTS_PRIORITY": "1"}
    run_kw: dict = {
        "cwd": str(root),
        "env": env,
        "timeout": 180,
    }
    if sys.platform == "win32":
        run_kw["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        subprocess.run([sys.executable, str(SPEAK_SCRIPT), text], **run_kw)
    except subprocess.TimeoutExpired:
        print("[narrate-screen] TTS timed out", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser(description="Narrate screen via Claude vision + TTS")
    ap.add_argument("--silent", action="store_true", help="Print description, don't speak it")
    ap.add_argument(
        "--store",
        action="store_true",
        help="Save description to OpenClaw perception DB via pc-agent (needs OPENCLAW_DATABASE_URL on agent + PC_AGENT_SECRET)",
    )
    ap.add_argument(
        "--store-image",
        action="store_true",
        help="With --store, include JPEG as base64 (large request bodies)",
    )
    ap.add_argument("--prompt", default=None, help="Custom question about the screen")
    args = ap.parse_args()

    t0 = time.time()
    print("[narrate-screen] capturing screen…", file=sys.stderr)
    jpeg = capture_screen()
    print(f"[narrate-screen] captured {len(jpeg)//1024}KB in {time.time()-t0:.1f}s", file=sys.stderr)

    print("[narrate-screen] sending to Claude vision…", file=sys.stderr)
    description = narrate_image(jpeg, prompt=args.prompt)
    print(f"[narrate-screen] got response in {time.time()-t0:.1f}s", file=sys.stderr)

    print(description)

    if args.store:
        store_perception(jpeg, description, include_image=args.store_image)

    if not args.silent:
        speak(description)


if __name__ == "__main__":
    main()
