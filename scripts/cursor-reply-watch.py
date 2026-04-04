#!/usr/bin/env python3
"""
cursor-reply-watch.py — tail Cursor agent JSONL transcripts and speak assistant prose only.

Watches every agent-transcript UUID folder under CURSOR_TRANSCRIPTS_DIR. Main chat UUID is
session-voice.json "chat_id"; any other UUID is treated as a Task subagent transcript.

Env (defaults on unless explicitly false/off/0/no):
  FRIDAY_CURSOR_SPEAK_REPLY — narrate main Composer assistant text
  FRIDAY_CURSOR_SPEAK_SUBAGENT_REPLY — narrate subagent assistant text
  FRIDAY_CURSOR_SPEAK_THINKING — capture and speak extended-thinking content before Cursor
    redacts it (default: true). Thinking blocks appear briefly in the JSONL before being
    replaced with [REDACTED]. This watcher catches them on the first poll pass and speaks
    them, preserving the reasoning as audio.

When FRIDAY_CURSOR_NARRATION is on, the Cursor agent already speaks live (ack / status / done),
so main and subagent JSONL TTS default OFF to avoid double voice. Opt back in:
  FRIDAY_CURSOR_SPEAK_REPLY_WITH_NARRATION=true
  FRIDAY_CURSOR_SPEAK_SUBAGENT_WITH_NARRATION=true

Optional:
  FRIDAY_CURSOR_REPLY_VOICE — Edge voice id for main transcript TTS (see pick-session-voice --cursor-reply)
  CURSOR_TRANSCRIPTS_DIR — override path to agent-transcripts

Run:  python scripts/cursor-reply-watch.py
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
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

# Same default as skill-gateway/scripts/pick-session-voice.py — set CURSOR_TRANSCRIPTS_DIR in .env for other machines.
_TRANSCRIPTS_ROOT = Path(os.environ.get(
    "CURSOR_TRANSCRIPTS_DIR",
    r"C:\Users\rajut\.cursor\projects\d-code-openclaw\agent-transcripts",
)).resolve()
_SESSION_VOICE = _REPO_ROOT / ".session-voice.json"
_PICK_SCRIPT = _REPO_ROOT / "skill-gateway" / "scripts" / "pick-session-voice.py"
_SPEAK_SCRIPT = _REPO_ROOT / "skill-gateway" / "scripts" / "friday-speak.py"

POLL_SEC = 0.35
POLL_ACTIVE_SEC = 0.15
RESCAN_SEC = 10.0
_ACTIVE_WINDOW_SEC = 5.0
_SPOKEN_HASHES_MAX = 500


def _env_bool(key: str, default: bool = True) -> bool:
    raw = os.environ.get(key, "").strip().lower()
    if raw == "":
        return default
    if raw in ("0", "false", "no", "off"):
        return False
    if raw in ("1", "true", "yes", "on"):
        return True
    return default


def _load_session() -> dict:
    try:
        return json.loads(_SESSION_VOICE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _list_transcript_files() -> list[Path]:
    out: list[Path] = []
    try:
        if not _TRANSCRIPTS_ROOT.is_dir():
            return out
        for sub in _TRANSCRIPTS_ROOT.iterdir():
            if not sub.is_dir():
                continue
            name = sub.name
            jp = sub / f"{name}.jsonl"
            if jp.is_file():
                out.append(jp.resolve())
    except Exception:
        pass
    return sorted(out)


def _assistant_text_from_line(line: str) -> str:
    try:
        obj = json.loads(line)
    except Exception:
        return ""
    if obj.get("role") != "assistant":
        return ""
    msg = obj.get("message") or {}
    content = msg.get("content")
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") != "text":
            continue
        t = block.get("text")
        if isinstance(t, str) and t.strip():
            parts.append(t)
    return "\n\n".join(parts).strip()


def _thinking_text_from_line(line: str) -> str:
    """Extract thinking/reasoning content from an assistant JSONL line.

    Cursor extended-thinking appears as either:
      - {"type": "thinking", "thinking": "..."} blocks in the content array
      - Inline in text blocks before [REDACTED] markers (the visible pre-redaction text)
    Both are captured here. Returns empty string if nothing found or already redacted.
    """
    try:
        obj = json.loads(line)
    except Exception:
        return ""
    if obj.get("role") != "assistant":
        return ""
    msg = obj.get("message") or {}
    content = msg.get("content")
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        btype = block.get("type", "")
        # Explicit thinking blocks (Anthropic extended-thinking format)
        if btype == "thinking":
            t = block.get("thinking") or block.get("text") or ""
            if isinstance(t, str) and t.strip() and not _is_fully_redacted(t):
                parts.append(t.strip())
        # Text blocks that contain pre-redaction thinking (visible text before [REDACTED])
        elif btype == "text":
            t = block.get("text") or ""
            if isinstance(t, str) and "[REDACTED]" in t:
                before = t.split("[REDACTED]")[0].strip()
                if before and len(before) > 30:
                    parts.append(before)
    return "\n\n".join(parts).strip()


def _is_fully_redacted(text: str) -> bool:
    """True if the text is essentially just redaction markers with no useful content."""
    cleaned = _RE_REDACTED.sub("", text).strip()
    return len(cleaned) < 10


_RE_FENCED = re.compile(r"```[\w]*\s*.*?```", re.DOTALL)
_RE_INLINE_CODE = re.compile(r"`[^`\n]+`")
_RE_URL = re.compile(r"https?://[^\s\)\]\>]+", re.IGNORECASE)
# Windows drive paths and obvious slash-separated repo paths (keep heuristics light)
_RE_WIN_PATH = re.compile(r"\b[A-Za-z]:\\[^\s\)\]\,\"\']+")
_RE_SLASH_FILE = re.compile(r"(?<![\w/])(?:\.{0,2}/)+[\w./\-]{3,}\.(?:py|js|ts|tsx|jsx|mjs|json|yaml|yml|toml|md|rs|go|cs|java|kt|txt|ps1|sh)\b")
_RE_MD_HEADER = re.compile(r"(?m)^#{1,6}\s+")
_RE_MD_BOLD = re.compile(r"\*\*([^*]+)\*\*")
_RE_MD_ITALIC = re.compile(r"(?<!\*)\*([^*]+)\*(?!\*)")
_RE_BULLET = re.compile(r"(?m)^\s*[-*+]\s+")
# Cursor tool results / logs often contain privacy placeholders — do not send to TTS.
_RE_REDACTED = re.compile(
    r"\*+\s*redacted\s*\*+|`\s*redacted\s*`|"
    r"<\s*redacted[^>]*>|\[\s*redacted\s*\]|\{\s*redacted\s*\}|\(\s*redacted\s*\)|"
    r"\bredacted\s*[:;.,!?…]+|\bredacted\b",
    re.IGNORECASE,
)


def _narration_enabled() -> bool:
    return _env_bool("FRIDAY_CURSOR_NARRATION", False)


def strip_to_prose(raw: str) -> str:
    """Remove code, paths, commands, markdown noise — keep reasoning prose."""
    if not raw or not raw.strip():
        return ""
    s = raw
    s = _RE_REDACTED.sub(" ", s)
    s = _RE_FENCED.sub("", s)
    s = _RE_INLINE_CODE.sub("", s)
    s = _RE_URL.sub("", s)
    s = _RE_WIN_PATH.sub("", s)
    s = _RE_SLASH_FILE.sub("", s)
    s = _RE_MD_HEADER.sub("", s)
    s = _RE_MD_BOLD.sub(r"\1", s)
    s = _RE_MD_ITALIC.sub(r"\1", s)
    s = _RE_BULLET.sub("", s)
    lines_out: list[str] = []
    for line in s.splitlines():
        t = line.strip()
        if not t:
            lines_out.append("")
            continue
        tl = t.lower()
        if tl.startswith("$ ") or tl.startswith("> "):
            continue
        if re.match(
            r"^(?:python3?\s|npm\s|npx\s|pnpm\s|yarn\s|git\s|curl\s|wget\s|pwsh\s|powershell\s|cd\s)",
            tl,
        ):
            continue
        lines_out.append(line)
    s = "\n".join(lines_out)
    s = re.sub(r"\n{3,}", "\n\n", s)
    s = re.sub(r"[ \t]{2,}", " ", s)
    s = _RE_REDACTED.sub(" ", s)
    s = re.sub(r"\s{2,}", " ", s).strip()
    # Drop lines that are only placeholders / punctuation
    if s and len(re.sub(r"[^a-zA-Z0-9]", "", s)) < 2:
        return ""
    return s


def _speak_main(text: str) -> None:
    from friday_speaker import speaker

    speaker.speak(
        text,
        session="cursor-reply",
        bypass_cursor_defer=True,
    )


def _speak_subagent(text: str) -> None:
    from friday_speaker import speaker

    speaker.speak(
        text,
        session="subagent",
        priority=True,
        bypass_cursor_defer=True,
    )


def _ensure_cursor_reply_voice() -> None:
    try:
        subprocess.run(
            [sys.executable, str(_PICK_SCRIPT), "--cursor-reply"],
            cwd=str(_REPO_ROOT),
            env=os.environ.copy(),
            capture_output=True,
            text=True,
            timeout=30,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception:
        pass


def _ensure_subagent_voice() -> None:
    try:
        subprocess.run(
            [sys.executable, str(_PICK_SCRIPT), "--subagent"],
            cwd=str(_REPO_ROOT),
            env={**os.environ, "FRIDAY_TTS_SESSION": "subagent"},
            capture_output=True,
            text=True,
            timeout=30,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception:
        pass


def _maybe_seed_chat_id_if_single_transcript() -> None:
    """If session has no chat_id but exactly one transcript exists, sync from pick-session-voice (no welcome)."""
    if _load_session().get("chat_id"):
        return
    files = _list_transcript_files()
    if len(files) != 1:
        return
    try:
        subprocess.run(
            [sys.executable, str(_PICK_SCRIPT)],
            cwd=str(_REPO_ROOT),
            env={**os.environ, "FRIDAY_PICK_SESSION_NO_WELCOME": "true"},
            capture_output=True,
            text=True,
            timeout=30,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception:
        pass


def _content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _merge_new_paths(state_map: dict[str, dict], *, seek_end: bool) -> None:
    for p in _list_transcript_files():
        ps = str(p.resolve())
        if ps in state_map:
            continue
        try:
            off = p.stat().st_size if seek_end else 0
        except OSError:
            off = 0
        state_map[ps] = {
            "offset": off,
            "carry": "",
            "spoken_hashes": set(),
            "last_activity": 0.0,
        }


def main() -> None:
    req_main = _env_bool("FRIDAY_CURSOR_SPEAK_REPLY", True)
    req_sub = _env_bool("FRIDAY_CURSOR_SPEAK_SUBAGENT_REPLY", True)
    req_thinking = _env_bool("FRIDAY_CURSOR_SPEAK_THINKING", True)
    speak_main = req_main
    speak_sub = req_sub
    speak_thinking = req_thinking
    if _narration_enabled():
        # Agent narration already speaks reasoning live — suppress watcher
        # duplicates unless explicitly opted back in.
        if speak_main and not _env_bool("FRIDAY_CURSOR_SPEAK_REPLY_WITH_NARRATION", False):
            speak_main = False
        if speak_sub and not _env_bool("FRIDAY_CURSOR_SPEAK_SUBAGENT_WITH_NARRATION", False):
            speak_sub = False
        if speak_thinking and not _env_bool("FRIDAY_CURSOR_SPEAK_THINKING_WITH_NARRATION", False):
            speak_thinking = False
    any_active = speak_main or speak_sub or speak_thinking
    if not any_active:
        if _narration_enabled() and (req_main or req_sub or req_thinking):
            print(
                "cursor-reply-watch: FRIDAY_CURSOR_NARRATION is on — transcript TTS suppressed "
                "(narrate-thinking rule speaks reasoning live; watcher thinking also off). "
                "Set _WITH_NARRATION vars to re-enable. Exiting.",
                flush=True,
            )
        else:
            print(
                "cursor-reply-watch: all speak channels off — exiting.",
                flush=True,
            )
        return

    if speak_main:
        _ensure_cursor_reply_voice()
    if speak_sub or speak_thinking:
        _ensure_subagent_voice()
    _maybe_seed_chat_id_if_single_transcript()

    state_map: dict[str, dict] = {}
    last_rescan = 0.0
    warned_no_chat = False

    _merge_new_paths(state_map, seek_end=True)

    print(
        f"cursor-reply-watch: root={_TRANSCRIPTS_ROOT} main={speak_main} subagent={speak_sub} thinking={speak_thinking}",
        flush=True,
    )

    while True:
        now = time.monotonic()
        if now - last_rescan >= RESCAN_SEC:
            last_rescan = now
            known = {str(p.resolve()) for p in _list_transcript_files()}
            for p in known:
                if p not in state_map:
                    try:
                        off = Path(p).stat().st_size
                    except OSError:
                        off = 0
                    state_map[p] = {
                        "offset": off,
                        "carry": "",
                        "spoken_hashes": set(),
                        "last_activity": 0.0,
                    }
            for old in list(state_map.keys()):
                if old not in known:
                    del state_map[old]

        session = _load_session()
        main_uuid = (session.get("chat_id") or "").strip()
        if not main_uuid and not warned_no_chat:
            warned_no_chat = True
            print(
                "cursor-reply-watch: .session-voice.json has no chat_id yet — open main Composer chat once "
                "so pick-session-voice can run, or paste chat_id from agent-transcripts.",
                flush=True,
            )

        any_recently_active = False
        for path_str, st in list(state_map.items()):
            p = Path(path_str)
            try:
                sz = p.stat().st_size
            except OSError:
                continue
            off = st["offset"]
            if sz < off:
                off = 0
                st["carry"] = ""
            if sz == off:
                continue
            st["last_activity"] = now
            any_recently_active = True
            try:
                with p.open("r", encoding="utf-8", errors="replace") as f:
                    f.seek(off)
                    chunk = f.read()
                st["offset"] = sz
            except OSError:
                continue

            data = st["carry"] + chunk
            lines = data.split("\n")
            st["carry"] = lines.pop() if lines else ""
            folder_uuid = p.parent.name
            spoken_hashes: set = st["spoken_hashes"]

            for line in lines:
                if not line.strip():
                    continue

                if not main_uuid:
                    continue

                is_main = bool(folder_uuid == main_uuid)
                is_sub = not is_main

                # --- thinking capture (runs even when reply TTS is off) ---
                if speak_thinking:
                    thinking_raw = _thinking_text_from_line(line)
                    if thinking_raw:
                        thinking_prose = strip_to_prose(thinking_raw)
                        if thinking_prose:
                            h = _content_hash(thinking_prose)
                            if h not in spoken_hashes:
                                spoken_hashes.add(h)
                                print(f"cursor-reply-watch: [thinking] speaking {len(thinking_prose)} chars", flush=True)
                                _speak_subagent(thinking_prose)

                # --- regular reply TTS ---
                raw_text = _assistant_text_from_line(line)
                if not raw_text:
                    continue
                prose = strip_to_prose(raw_text)
                if not prose:
                    continue

                h = _content_hash(prose)
                if h in spoken_hashes:
                    continue
                spoken_hashes.add(h)

                if len(spoken_hashes) > _SPOKEN_HASHES_MAX:
                    to_remove = list(spoken_hashes)[:_SPOKEN_HASHES_MAX // 2]
                    for old_h in to_remove:
                        spoken_hashes.discard(old_h)

                if is_main and speak_main:
                    _speak_main(prose)
                elif is_sub and speak_sub:
                    _speak_subagent(prose)

        # Adaptive polling: faster when transcripts are actively being written
        if any_recently_active or any(
            now - st.get("last_activity", 0) < _ACTIVE_WINDOW_SEC
            for st in state_map.values()
        ):
            time.sleep(POLL_ACTIVE_SEC)
        else:
            time.sleep(POLL_SEC)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("cursor-reply-watch: stopped.", flush=True)
        sys.exit(0)
