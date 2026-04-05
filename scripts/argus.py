#!/usr/bin/env python3
"""
argus.py — ARGUS, the all-seeing watcher. Speaks up when Claude has pending changes.

Named after the hundred-eyed giant of Greek myth who never slept. ARGUS monitors
the active Cursor agent JSONL transcript. When Claude completes a turn that included
file edits (Write, StrReplace, EditNotebook, Delete), he speaks a priority reminder
in his own male voice if the user has not responded within FRIDAY_ARGUS_TIMEOUT seconds.
He repeats at FRIDAY_ARGUS_REPEAT intervals until the user interacts.

State resets the moment a user message appears in the transcript.

Env:
  FRIDAY_ARGUS_ENABLED  master switch (default: true)
  FRIDAY_ARGUS_VOICE    Edge TTS voice id for ARGUS (default: en-US-GuyNeural)
  FRIDAY_ARGUS_TIMEOUT  seconds before first reminder (default: 25)
  FRIDAY_ARGUS_REPEAT   seconds between repeat reminders (default: 90)
  FRIDAY_ARGUS_IDLE     JSONL idle seconds = agent turn done (default: 8)
  CURSOR_TRANSCRIPTS_DIR  override path to agent-transcripts folder

Run:
  python scripts/argus.py
  npm run start:argus
"""
from __future__ import annotations

import json
import os
import platform
import random
import subprocess
import sys
import time
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

# ── Config ────────────────────────────────────────────────────────────────────

def _env_bool(key: str, default: bool) -> bool:
    v = os.environ.get(key, "").strip().lower()
    if not v:
        return default
    return v not in ("0", "false", "no", "off")

ARGUS_ENABLED  = _env_bool("FRIDAY_ARGUS_ENABLED", True)
NARRATION_ON   = _env_bool("FRIDAY_CURSOR_NARRATION", True)
try:
    from openclaw_company import get_persona as _get_argus_persona
    _arg = _get_argus_persona("argus")
    ARGUS_VOICE = (_arg.get("voice") or "en-US-GuyNeural").strip()
    ARGUS_RATE = (_arg.get("rate") or "").strip()
except Exception:
    ARGUS_VOICE = os.environ.get("FRIDAY_ARGUS_VOICE", "en-US-GuyNeural").strip()
    ARGUS_RATE = os.environ.get("OPENCLAW_ARGUS_RATE", "+5%").strip()

ARGUS_TIMEOUT  = max(10, int(os.environ.get("FRIDAY_ARGUS_TIMEOUT", "25")))
ARGUS_REPEAT   = max(30, int(os.environ.get("FRIDAY_ARGUS_REPEAT", "90")))
IDLE_SEC       = max(4,  int(os.environ.get("FRIDAY_ARGUS_IDLE", "8")))
POLL_SEC       = 2.0

_TRANSCRIPTS_ROOT = Path(os.environ.get(
    "CURSOR_TRANSCRIPTS_DIR",
    r"C:\Users\rajut\.cursor\projects\d-code-openclaw\agent-transcripts",
))
_SESSION_FILE = _REPO_ROOT / ".session-voice.json"
_SPEAK_SCRIPT = _REPO_ROOT / "skill-gateway" / "scripts" / "friday-speak.py"

# Tools that produce pending diffs in the Cursor editor
FILE_EDIT_TOOLS = {"Write", "StrReplace", "EditNotebook", "Delete"}

# ── TTS — always in ARGUS's own voice ────────────────────────────────────────

def _speak(text: str) -> None:
    """Fire friday-speak.py with ARGUS's voice at priority 1 — fire-and-forget."""
    if not _SPEAK_SCRIPT.exists():
        print(f"[argus] would speak: {text}", flush=True)
        return
    env = {
        **os.environ,
        "FRIDAY_TTS_PRIORITY":           "1",
        "FRIDAY_TTS_BYPASS_CURSOR_DEFER": "true",
        "FRIDAY_TTS_USE_SESSION_STICKY_VOICE": "false",
        "FRIDAY_TTS_VOICE":              ARGUS_VOICE,
    }
    if ARGUS_RATE:
        env["FRIDAY_TTS_RATE"] = ARGUS_RATE
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
        print(f"[argus] spoke: {text[:120]}", flush=True)
    except Exception as exc:
        print(f"[argus] speak error: {exc}", file=sys.stderr)

# ── JSONL parsing ─────────────────────────────────────────────────────────────

def _has_file_edits(content: list) -> bool:
    for item in content:
        if isinstance(item, dict) and item.get("type") == "tool_use":
            if item.get("name") in FILE_EDIT_TOOLS:
                return True
    return False

def _parse_role(line: str) -> tuple[str, bool]:
    """Returns (role, has_edits). role is 'user', 'assistant', or '' if unparseable."""
    try:
        obj = json.loads(line.strip())
    except (json.JSONDecodeError, ValueError):
        return "", False
    role = obj.get("role", "")
    if role != "assistant":
        return role, False
    msg = obj.get("message", {}) or {}
    content = msg.get("content", [])
    if not isinstance(content, list):
        content = []
    return "assistant", _has_file_edits(content)

# ── Session helper ────────────────────────────────────────────────────────────

def _read_chat_id() -> str | None:
    if not _SESSION_FILE.exists():
        return None
    try:
        data = json.loads(_SESSION_FILE.read_text(encoding="utf-8"))
        return data.get("chat_id") or None
    except Exception:
        return None

def _find_jsonl(chat_id: str) -> Path | None:
    folder = _TRANSCRIPTS_ROOT / chat_id
    if not folder.is_dir():
        return None
    matches = list(folder.glob("*.jsonl"))
    if not matches:
        return None
    return max(matches, key=lambda p: p.stat().st_mtime)

# ── Watcher state ─────────────────────────────────────────────────────────────

class _State:
    __slots__ = (
        "chat_id", "jsonl_path", "read_bytes",
        "has_pending_edits",
        "last_user_time", "last_content_time",
        "last_reminder_time", "reminder_count",
    )

    def __init__(self) -> None:
        self.chat_id: str | None = None
        self.jsonl_path: Path | None = None
        self.read_bytes: int = 0
        self.has_pending_edits: bool = False
        self.last_user_time: float = time.monotonic()
        self.last_content_time: float = time.monotonic()
        self.last_reminder_time: float = 0.0
        self.reminder_count: int = 0

    def reset_pending(self) -> None:
        self.has_pending_edits = False
        self.last_user_time = time.monotonic()
        self.last_reminder_time = 0.0
        self.reminder_count = 0

# ── ARGUS reminder phrases ────────────────────────────────────────────────────
# First alert — informative, confident, direct.

_FIRST_PROMPTS = [
    "Argus here, VP Security. Claude's wrapped and there are changes in the editor waiting on you. Accept or reject when you're ready.",
    "This is Argus, VP Security. Claude finished making edits. They're in the editor, pending your call.",
    "Argus, Security. Claude's done and there are pending file changes in the editor. Your move.",
    "Heads up from Argus, VP Security. Claude's changes are in the editor. Worth a quick look.",
]

# Repeat alerts — drier, slightly impatient, still professional.

_REPEAT_PROMPTS = [
    "Argus, Security again. Those Claude edits are still pending. They're not going to accept themselves.",
    "Still Argus, VP Security. The changes are still there. Accept or reject at your convenience.",
    "Argus checking in from Security. Pending Claude edits in the editor. Still unreviewed.",
    "Right, Argus. Those changes from Claude are still sitting there. Whenever you're ready.",
    "Argus, VP Security, gentle but persistent. Claude's edits are still pending in the editor.",
]

def _pick_reminder(repeat: bool) -> str:
    pool = _REPEAT_PROMPTS if repeat else _FIRST_PROMPTS
    return random.choice(pool)

# ── Main loop ─────────────────────────────────────────────────────────────────

def _poll(state: _State) -> None:
    now = time.monotonic()

    # Reload chat_id each cycle — picks up new conversations automatically
    chat_id = _read_chat_id()
    if chat_id != state.chat_id:
        state.chat_id = chat_id
        state.jsonl_path = None
        state.read_bytes = 0
        state.has_pending_edits = False
        state.last_user_time = now
        state.last_content_time = now
        state.last_reminder_time = 0.0
        state.reminder_count = 0
        if chat_id:
            state.jsonl_path = _find_jsonl(chat_id)
            if state.jsonl_path:
                try:
                    state.read_bytes = state.jsonl_path.stat().st_size
                except OSError:
                    state.read_bytes = 0
                print(f"[argus] watching {chat_id[:8]}... -> {state.jsonl_path.name}", flush=True)

    if not state.jsonl_path or not state.jsonl_path.exists():
        if chat_id:
            found = _find_jsonl(chat_id)
            if found:
                state.jsonl_path = found
                try:
                    state.read_bytes = state.jsonl_path.stat().st_size
                except OSError:
                    state.read_bytes = 0
        return

    # Read any new bytes appended since last poll
    try:
        size = state.jsonl_path.stat().st_size
    except OSError:
        return

    if size > state.read_bytes:
        state.last_content_time = now
        try:
            with state.jsonl_path.open("rb") as fh:
                fh.seek(state.read_bytes)
                new_bytes = fh.read(size - state.read_bytes)
        except OSError:
            return
        state.read_bytes = size

        for raw_line in new_bytes.decode("utf-8", errors="replace").splitlines():
            raw_line = raw_line.strip()
            if not raw_line:
                continue
            role, has_edits = _parse_role(raw_line)
            if role == "user":
                if state.has_pending_edits:
                    print("[argus] user responded — pending state cleared", flush=True)
                state.reset_pending()
            elif role == "assistant" and has_edits:
                if not state.has_pending_edits:
                    print("[argus] file edits detected in Claude's turn", flush=True)
                state.has_pending_edits = True

    # Decide whether to fire a reminder
    if not state.has_pending_edits:
        return
    if (now - state.last_content_time) < IDLE_SEC:
        return  # Claude still writing
    if (now - state.last_user_time) < ARGUS_TIMEOUT:
        return
    is_repeat = state.reminder_count > 0
    if is_repeat and (now - state.last_reminder_time) < ARGUS_REPEAT:
        return

    msg = _pick_reminder(repeat=is_repeat)
    _speak(msg)
    state.last_reminder_time = now
    state.reminder_count += 1
    print(f"[argus] reminder #{state.reminder_count} fired", flush=True)


def main() -> None:
    if not ARGUS_ENABLED:
        print("[argus] disabled (FRIDAY_ARGUS_ENABLED=false) — standing down.", flush=True)
        return

    if not NARRATION_ON:
        print("[argus] FRIDAY_CURSOR_NARRATION is off — running silently (no voice).", flush=True)

    print(
        f"[argus] Argus (VP Security) on watch  voice={ARGUS_VOICE}, timeout={ARGUS_TIMEOUT}s, "
        f"repeat={ARGUS_REPEAT}s, idle={IDLE_SEC}s | transcripts={_TRANSCRIPTS_ROOT}",
        flush=True,
    )

    state = _State()
    while True:
        try:
            _poll(state)
        except KeyboardInterrupt:
            print("[argus] standing down.", flush=True)
            sys.exit(0)
        except Exception as exc:
            print(f"[argus] error: {exc}", file=sys.stderr)
        time.sleep(POLL_SEC)


if __name__ == "__main__":
    main()
