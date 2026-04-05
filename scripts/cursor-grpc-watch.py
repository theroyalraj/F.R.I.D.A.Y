#!/usr/bin/env python3
"""
cursor-grpc-watch — optional daemon: on new main-Composer user turns in JSONL, run ConnectRPC
stream to api2.cursor.sh and log timing (compare with JSONL assistant path).

Requires: httpx + h2 (see scripts/requirements-cursor-reply-watch.txt).

Env:
  FRIDAY_CURSOR_GRPC=true
  FRIDAY_CURSOR_GRPC_LOG=true
  FRIDAY_CURSOR_GRPC_TTS=false  — speak truncated gRPC result via Sentinel session
  FRIDAY_CURSOR_GRPC_POLL_SEC=2
  FRIDAY_CURSOR_GRPC_MODEL=default
  CURSOR_TRANSCRIPTS_DIR — same as cursor-reply-watch
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import threading
import time
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _SCRIPTS_DIR.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

_ENV_FILE = _REPO_ROOT / ".env"
if _ENV_FILE.exists():
    for line in _ENV_FILE.read_text(encoding="utf-8").splitlines():
        t = line.strip()
        if not t or t.startswith("#") or "=" not in t:
            continue
        k, _, rest = t.partition("=")
        k = k.strip()
        v = rest.split("#", 1)[0].strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v

_SESSION_VOICE = _REPO_ROOT / ".session-voice.json"
_TRANSCRIPTS_ROOT = Path(os.environ.get(
    "CURSOR_TRANSCRIPTS_DIR",
    r"C:\Users\rajut\.cursor\projects\d-code-openclaw\agent-transcripts",
)).resolve()


def _main_chat_jsonl() -> Path | None:
    try:
        data = json.loads(_SESSION_VOICE.read_text(encoding="utf-8"))
        cid = str(data.get("chat_id") or "").strip()
        if not cid:
            return None
        folder = _TRANSCRIPTS_ROOT / cid
        if not folder.is_dir():
            return None
        jsonls = sorted(folder.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
        return jsonls[0] if jsonls else None
    except Exception:
        return None


def _user_text_from_line(line: str) -> str:
    try:
        obj = json.loads(line)
    except Exception:
        return ""
    if obj.get("role") != "user":
        return ""
    for block in obj.get("content") or []:
        if isinstance(block, dict) and block.get("type") == "text":
            t = str(block.get("text") or "").strip()
            if t:
                return t
    return ""


def _tail_new_lines(path: Path, offset: int) -> tuple[str, int]:
    try:
        sz = path.stat().st_size
    except OSError:
        return "", offset
    if sz < offset:
        offset = 0
    if sz == offset:
        return "", offset
    with path.open("r", encoding="utf-8", errors="replace") as f:
        f.seek(offset)
        data = f.read()
    return data, sz


def _run_grpc(user_text: str) -> None:
    from cursor_grpc.stream_client import GrpcTimingLog, stream_unified_chat

    model = os.environ.get("FRIDAY_CURSOR_GRPC_MODEL", "default").strip() or "default"
    slog = GrpcTimingLog()
    slog.emit("t0_user")
    out = stream_unified_chat(user_text, model=model, timing=slog)
    if os.environ.get("FRIDAY_CURSOR_GRPC_TTS", "").strip().lower() in ("1", "true", "yes") and out:
        try:
            from friday_speaker import speaker

            dt = (time.perf_counter() - slog.t0) * 1000.0
            log_on = os.environ.get("FRIDAY_CURSOR_GRPC_LOG", "true").strip().lower()
            if log_on not in ("0", "false", "no", "off"):
                print(f"[gRPC:t4_tts_fire] +{dt:.1f}ms", flush=True)
            speaker.speak(out[:1200], session="cursor-reply", priority=False, bypass_cursor_defer=True)
        except Exception as e:
            print(f"[gRPC] TTS skip: {e}", flush=True)


def main() -> None:
    if os.environ.get("FRIDAY_CURSOR_GRPC", "").strip().lower() not in (
        "1", "true", "yes", "on",
    ):
        print("cursor-grpc-watch: FRIDAY_CURSOR_GRPC not enabled — exiting.", flush=True)
        return
    path = _main_chat_jsonl()
    if not path:
        print("cursor-grpc-watch: no main chat jsonl (check .session-voice.json chat_id).", flush=True)
        return
    poll = float(os.environ.get("FRIDAY_CURSOR_GRPC_POLL_SEC", "2") or "2")
    print(f"cursor-grpc-watch: tailing {path} poll={poll}s", flush=True)
    offset = path.stat().st_size
    seen_user: set[str] = set()

    try:
        while True:
            time.sleep(poll)
            p = _main_chat_jsonl()
            if p and p != path:
                path = p
                offset = path.stat().st_size
                seen_user.clear()
                print(f"cursor-grpc-watch: switched to {path}", flush=True)
            chunk, offset = _tail_new_lines(path, offset)
            if not chunk:
                continue
            for line in chunk.split("\n"):
                ut = _user_text_from_line(line)
                if not ut or len(ut) < 3:
                    continue
                h = hashlib.sha256(ut.encode("utf-8", errors="replace")).hexdigest()
                if h in seen_user:
                    continue
                seen_user.add(h)
                if len(seen_user) > 200:
                    seen_user = set(list(seen_user)[-100:])
                threading.Thread(target=_run_grpc, args=(ut,), daemon=True).start()
    except KeyboardInterrupt:
        print("cursor-grpc-watch: stop.", flush=True)


if __name__ == "__main__":
    main()
