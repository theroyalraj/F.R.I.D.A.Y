#!/usr/bin/env python3
"""
cursor-reply-watch.py — tail Cursor agent JSONL transcripts and speak assistant prose only.

Uses watchdog OS file notifications under CURSOR_TRANSCRIPTS_DIR (with a periodic rescan fallback)
instead of polling. Requires: pip install -r scripts/requirements-cursor-reply-watch.txt

Watches every agent-transcript UUID folder under CURSOR_TRANSCRIPTS_DIR. Main chat UUID is
session-voice.json "chat_id"; any other UUID is treated as a Task subagent transcript.

Env (defaults on unless explicitly false/off/0/no):
  FRIDAY_CURSOR_SPEAK_REPLY — narrate main Composer assistant text
  FRIDAY_CURSOR_SPEAK_SUBAGENT_REPLY — narrate subagent assistant text
  FRIDAY_CURSOR_SPEAK_THINKING — capture and speak extended-thinking content before Cursor
    redacts it (default: true). Thinking blocks appear briefly in the JSONL before being
    replaced with [REDACTED]. This watcher catches them on the first tail read and speaks
    them, preserving the reasoning as audio.

When FRIDAY_CURSOR_NARRATION is on, the Cursor agent already speaks live (ack / status / done),
so main and subagent JSONL TTS default OFF to avoid double voice. Opt back in:
  FRIDAY_CURSOR_SPEAK_REPLY_WITH_NARRATION=true
  FRIDAY_CURSOR_SPEAK_SUBAGENT_WITH_NARRATION=true

Thinking capture from JSONL defaults ON with narration (live agent thinking TTS is unreliable).
Set FRIDAY_CURSOR_SPEAK_THINKING_WITH_NARRATION=false to disable watcher thinking only.

Optional:
  FRIDAY_CURSOR_REPLY_VOICE / FRIDAY_CURSOR_REPLY_RATE — override main Composer transcript TTS; else
  .session-voice.json cursor_reply_voice; else Sentinel persona (OPENCLAW_SENTINEL_*).
  CURSOR_TRANSCRIPTS_DIR — override path to agent-transcripts

Thinking TTS pacing (batched sentences + sized chunks; avoids a firehose of tiny clips):
  FRIDAY_CURSOR_THINKING_TTS_RATE — optional fixed Edge rate for thinking (when unset, rate is adaptive).
    Thinking playback is **non-priority** so FRIDAY_TTS_PRIORITY=1 speaks pre-empt it.
  FRIDAY_CURSOR_THINKING_INCREMENTAL_SLOW — extra percentage points to slow mid-stream chunks (default 2)
  FRIDAY_CURSOR_THINKING_PAUSE_MIN / FRIDAY_CURSOR_THINKING_PAUSE_MAX — base seconds between intra-batch chunks (defaults 0.07–0.16; scaled by block size)
  FRIDAY_CURSOR_THINKING_OPENER_CHANCE — 0–1 chance to prefix first chunk with a soft lead-in (default 0.35)
  FRIDAY_CURSOR_THINKING_OPENER_CONTEXT — auto (default) picks neutral vs code-roast vs calm-boundary openers from chunk text; neutral = reflective only
  FRIDAY_CURSOR_THINKING_MAX_CHUNK_CHARS — merge/split target width (default 520)
  FRIDAY_CURSOR_THINKING_MIN_BATCH_CHARS — incremental JSONL: accumulate at least this many chars before starting TTS (default 220)
  FRIDAY_CURSOR_THINKING_MIN_CHUNK_MERGE_CHARS — merge adjacent pacing chunks smaller than this (default 90)

JSONL thinking does not set FRIDAY_TTS_THINKING — that flag enables a separate singleton in friday-speak that
drops audio when busy (e.g. live agent thinking narration). Watcher thinking only needs the global TTS lock.

Incremental thinking (same line growing across JSONL updates):
  Thinking blocks may carry final/partial flags — we only speak immediately when final is true (or partial is explicitly false).
  When flags are missing, we buffer and speak once after FRIDAY_CURSOR_THINKING_DEBOUNCE_SEC of no updates (default 0.65).

Filesystem debounce (rapid JSONL writes):
  FRIDAY_CURSOR_FILE_DEBOUNCE_SEC — coalesce events per file before tail read (default 0.035)

Run:  python scripts/cursor-reply-watch.py

Thinking smoke tests — python scripts/cursor-watcher-smoke-thinking.py
  Default: same TTS pipeline as cursor-thinking-ocr.py (strip_to_prose + scrub + _speak_thinking_paced).
  --jsonl: append synthetic type=thinking for this watcher; needs watcher running and chat_id in .session-voice.json.

Voice-agent chat vs thinking (this script only):
  Short user-facing chunks that Cursor sometimes emits inside JSONL *thinking* blocks — OpenClaw / Open Claw,
  Done-dot completion lines, summary headers, “started working” — are spoken via the same async path as
  normal assistant *chat* (Sentinel cursor-reply voice on main Composer, subagent voice on Task transcripts),
  not the thinking pacing voice. Long reasoning stays on thinking TTS.
"""

from __future__ import annotations

import hashlib
import json
import os
import queue
import random
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

try:
    from watchdog.events import FileSystemEventHandler
    from watchdog.observers import Observer
except ImportError:
    print(
        "cursor-reply-watch: missing watchdog — install with:\n"
        "  pip install -r scripts/requirements-cursor-reply-watch.txt",
        flush=True,
    )
    raise SystemExit(1) from None

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

_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

# Same default as skill-gateway/scripts/pick-session-voice.py — set CURSOR_TRANSCRIPTS_DIR in .env for other machines.
_TRANSCRIPTS_ROOT = Path(os.environ.get(
    "CURSOR_TRANSCRIPTS_DIR",
    r"C:\Users\rajut\.cursor\projects\d-code-openclaw\agent-transcripts",
)).resolve()
_SESSION_VOICE = _REPO_ROOT / ".session-voice.json"
_SKILL_SCRIPTS = _REPO_ROOT / "skill-gateway" / "scripts"
if str(_SKILL_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SKILL_SCRIPTS))
from thinking_openers import pick_thinking_opener

_PICK_SCRIPT = _SKILL_SCRIPTS / "pick-session-voice.py"
_SPEAK_SCRIPT = _REPO_ROOT / "skill-gateway" / "scripts" / "friday-speak.py"

# Legacy poll tuning (unused when watchdog is active; kept for reference / tooling).
POLL_SEC = 0.35
POLL_ACTIVE_SEC = 0.15
# Fallback directory rescan if an OS file event is missed (network drive, driver quirks).
RESCAN_SEC = 30.0
_ACTIVE_WINDOW_SEC = 5.0
_SPOKEN_HASHES_MAX = 500

# Monotonic counter: advances once per thinking block (per call to _speak_thinking_paced).
# Ensures voice changes between spans/blocks, not between sentences within the same block.
_thinking_pool_idx: int = 0

_SENTINEL_VOICE: str | None = None
_SENTINEL_RATE: str | None = None


def _load_sentinel_persona() -> None:
    global _SENTINEL_VOICE, _SENTINEL_RATE
    try:
        from openclaw_company import get_persona

        s = get_persona("sentinel")
        _SENTINEL_VOICE = (s.get("voice") or "").strip() or None
        _SENTINEL_RATE = (s.get("rate") or "").strip() or None
    except Exception:
        _SENTINEL_VOICE, _SENTINEL_RATE = None, None


_load_sentinel_persona()


def _resolve_cursor_reply_voice() -> tuple[str | None, str | None]:
    """Env FRIDAY_CURSOR_REPLY_VOICE → session cursor_reply_voice → Sentinel persona (company registry)."""
    ev = os.environ.get("FRIDAY_CURSOR_REPLY_VOICE", "").strip()
    if ev:
        rr = os.environ.get("FRIDAY_CURSOR_REPLY_RATE", "").strip() or None
        return ev, rr
    try:
        cv = (_load_session().get("cursor_reply_voice") or "").strip()
        if cv:
            return cv, None
    except Exception:
        pass
    return _SENTINEL_VOICE, _SENTINEL_RATE


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


def _thinking_parse_line(line: str) -> tuple[str, str]:
    """Extract thinking from one assistant JSONL line.

    Returns (raw_text, stream_kind):
      - stream_kind ``final`` — explicit end of thinking; speak now (after strip_to_prose + hash dedup).
      - ``partial`` — streaming chunk; buffer and wait for ``final`` or debounce idle.
      - ``unknown`` — no final/partial hints; buffer and coalesce by prefix + debounce.

    Sources: ``type: thinking`` blocks; text before ``[REDACTED]`` (buffered like ``unknown`` — it often grows line-by-line).
    Block/message keys honoured: ``final`` (bool), ``partial`` (bool).
    """
    try:
        obj = json.loads(line)
    except Exception:
        return "", ""
    if obj.get("role") != "assistant":
        return "", ""
    msg = obj.get("message") or {}
    content = msg.get("content")
    if not isinstance(content, list):
        return "", ""

    thinking_parts: list[str] = []
    redacted_parts: list[str] = []
    final_true = False
    final_false = False
    partial_true = False
    partial_false = False

    for block in content:
        if not isinstance(block, dict):
            continue
        btype = block.get("type", "")
        if btype == "thinking":
            t = block.get("thinking") or block.get("text") or ""
            if isinstance(t, str) and t.strip() and not _is_fully_redacted(t):
                thinking_parts.append(t.strip())
            fv = block.get("final")
            if fv is True:
                final_true = True
            elif fv is False:
                final_false = True
            pv = block.get("partial")
            if pv is True:
                partial_true = True
            elif pv is False:
                partial_false = True
        elif btype == "text":
            t = block.get("text") or ""
            if isinstance(t, str) and "[REDACTED]" in t:
                before = t.split("[REDACTED]")[0].strip()
                if before and len(before) > 30:
                    redacted_parts.append(before)

    mf = msg.get("final")
    if mf is True:
        final_true = True
    elif mf is False:
        final_false = True

    raw_thinking = "\n\n".join(thinking_parts).strip()
    raw_redacted = "\n\n".join(redacted_parts).strip()

    if raw_thinking:
        if final_true:
            kind = "final"
        elif final_false or partial_true:
            kind = "partial"
        elif partial_false:
            kind = "final"
        else:
            kind = "unknown"
        return raw_thinking, kind

    if raw_redacted:
        return raw_redacted, "unknown"

    return "", ""


def _is_fully_redacted(text: str) -> bool:
    """True if the text is essentially just redaction markers with no useful content."""
    cleaned = _RE_REDACTED.sub("", text).strip()
    return len(cleaned) < 10


_RE_FENCED = re.compile(r"```[\w]*\s*.*?```", re.DOTALL)
_RE_INLINE_CODE = re.compile(r"`[^`\n]+`")
_RE_URL = re.compile(r"https?://[^\s\)\]\>]+", re.IGNORECASE)
# Windows drive paths and obvious slash-separated repo paths
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
# Thinking blocks that are really user-facing “chat” → use reply TTS (Sentinel / subagent), not thinking pacing.
_RE_VOICE_AGENT_CHAT = re.compile(
    r"(?is)"
    r"\bopenclaw\b|\bopen\s+claw(?:\s+labs)?\b|"
    r"\bstarted\s+working\b|\bit(?:'s| is)\s+working\b|\bnow\s+working\b|"
    r"(?:^|[\n\r])\s*summary\s*[:\.]|\bto\s+summarize\b"
)
# Inline env-var tokens (UPPER_SNAKE env vars, camelCase/snake_case identifiers adjacent to = or () )
_RE_ENV_VAR_TOKEN = re.compile(r"\b[A-Z][A-Z0-9_]{3,}\b")
# Code-heavy characters used to detect code-like lines
_CODE_DENSITY_CHARS = frozenset("=()[]{}|<>@$#\\")


def _is_code_line(line: str) -> bool:
    """Return True if this line looks like code rather than prose.

    Heuristics (any one is enough to reject):
    - Starts with a shell sigil or common statement keyword
    - Looks like an env-var assignment (ALL_CAPS= or ALL_CAPS =)
    - Python/JS/TS keyword at the start
    - PowerShell verb-noun ($env:, Set-, Get-, Start-, Stop-, etc.)
    - High density of code-punctuation characters
    - Braces/brackets dominate (JSON/dict/array literals)
    """
    t = line.strip()
    if not t:
        return False
    # Shell sigils
    if t[0] in "$@{[":
        return True
    # Env var assignment: UPPER_SNAKE= or UPPER_SNAKE =
    if re.match(r"^[A-Z][A-Z0-9_]{2,}\s*=", t):
        return True
    tl = t.lower()
    # Python statement keywords at line start
    if re.match(
        r"^(?:def |async def |class |import |from |return |raise |yield |"
        r"if |elif |else:|for |while |try:|except|with |pass$|break$|continue$|"
        r"assert |lambda )",
        tl,
    ):
        return True
    # JS/TS keywords
    if re.match(
        r"^(?:const |let |var |function |async function |export |import |"
        r"interface |type |enum |=>)",
        tl,
    ):
        return True
    # PowerShell: $env:, verb-noun commands
    if re.match(r"^\$", t) or re.match(
        r"^(?:get-|set-|start-|stop-|new-|remove-|add-|invoke-|write-|read-|"
        r"format-|select-|where-|sort-|group-|measure-|test-|copy-|move-|rename-)",
        tl,
    ):
        return True
    # Shell command prefixes (extended)
    if re.match(
        r"^(?:python3?\s|node\s|npm\s|npx\s|pnpm\s|yarn\s|git\s|curl\s|wget\s|"
        r"pwsh\s|powershell\s|cd\s|ls\s|dir\s|echo\s|cat\s|grep\s|rg\s|pip\s|"
        r"docker\s|kubectl\s|az\s|aws\s|ssh\s|scp\s|chmod\s|mv\s|cp\s|rm\s|"
        r"mkdir\s|touch\s|source\s|export\s|set\s)",
        tl,
    ):
        return True
    # Starts with _ (Python private/dunder identifier)
    if t.startswith("_"):
        return True
    # Method/attribute call at statement level: word.word( or word(with-no-space
    if re.match(r"^\w[\w]*\.\w+\s*\(", t):
        return True
    if re.match(r"^\w+\(", t):  # bare function call: subprocess.run( → already above; run( etc.
        return True
    # Subscript assignment: word['key'] = … or word["key"] =
    if re.search(r"\]\s*=", t):
        return True
    # High code-character density (>18% of line is =()[]{}|<>@$#\)
    code_chars = sum(1 for c in t if c in _CODE_DENSITY_CHARS)
    if len(t) > 8 and code_chars / len(t) > 0.18:
        return True
    return False


def _strip_env_var_tokens(s: str) -> str:
    """Replace ALL_CAPS_SNAKE tokens with nothing — they sound robotic when spoken."""
    return _RE_ENV_VAR_TOKEN.sub("", s)


# ── File-path to speech conversion (keep file mentions but make them speakable) ─
_FRIENDLY_FILE_NAMES: dict[str, str] = {
    "friday-speak.py": "the speak script",
    "friday-listen.py": "the listen script",
    "friday-ambient.py": "the ambient script",
    "friday-play.py": "the play script",
    "friday-music-scheduler.py": "the music scheduler",
    "cursor-reply-watch.py": "the cursor reply watcher",
    "gmail-watch.py": "the email watcher",
    "pick-session-voice.py": "the voice picker",
    "friday_speaker.py": "the speaker module",
    "friday-speak": "the speak script",
    "fridaySpeak.js": "the speak bridge",
    "fridayPlay.js": "the play bridge",
    "server.js": "the server",
    ".env": "the env file",
    "docker-compose.yml": "docker compose",
}


def _file_to_speech(match: re.Match) -> str:
    """Convert a file path match to a speakable name."""
    full = match.group(0)
    basename = full.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    friendly = _FRIENDLY_FILE_NAMES.get(basename)
    if friendly:
        return friendly
    name, _, ext = basename.rpartition(".")
    if ext and name:
        return f"{name} dot {ext}"
    return basename


def _narration_enabled() -> bool:
    return _env_bool("FRIDAY_CURSOR_NARRATION", False)


def strip_to_prose(raw: str) -> str:
    """Remove code noise, convert file paths to speakable names — keep reasoning prose."""
    if not raw or not raw.strip():
        return ""
    s = raw
    s = _RE_REDACTED.sub(" ", s)
    s = _RE_FENCED.sub("", s)
    s = _RE_INLINE_CODE.sub("", s)
    s = _RE_URL.sub("", s)
    s = _RE_WIN_PATH.sub(_file_to_speech, s)
    s = _RE_SLASH_FILE.sub(_file_to_speech, s)
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
        if tl := t.lower():
            if tl.startswith("$ ") or tl.startswith("> "):
                continue
        if _is_code_line(t):
            continue
        # Strip env-var tokens from otherwise-prose lines
        cleaned = _strip_env_var_tokens(t)
        cleaned = cleaned.strip(" ,;:")
        if not cleaned:
            continue
        lines_out.append(cleaned)
    s = "\n".join(lines_out)
    s = re.sub(r"\n{3,}", "\n\n", s)
    s = re.sub(r"[ \t]{2,}", " ", s)
    s = _RE_REDACTED.sub(" ", s)
    s = re.sub(r"\s{2,}", " ", s).strip()
    # Drop result if almost no alphanumeric content remains
    if s and len(re.sub(r"[^a-zA-Z0-9]", "", s)) < 6:
        return ""
    return s


def _speak_main(text: str) -> None:
    from friday_speaker import speaker

    v, r = _resolve_cursor_reply_voice()
    kw: dict = {
        "session": "cursor-reply",
        "priority": True,
        "bypass_cursor_defer": True,
    }
    if v:
        kw["voice"] = v
        kw["use_session_sticky"] = False
    if r:
        kw["rate"] = r
    speaker.speak(text, **kw)


def _speak_subagent(text: str) -> None:
    from friday_speaker import speaker

    speaker.speak(
        text,
        session="subagent",
        priority=True,
        bypass_cursor_defer=True,
    )


def _env_float(key: str, default: float) -> float:
    raw = os.environ.get(key, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _file_event_debounce_sec() -> float:
    """Coalesce rapid writes to the same JSONL before reading (ms-scale)."""
    v = _env_float("FRIDAY_CURSOR_FILE_DEBOUNCE_SEC", 0.035)
    return max(0.005, min(v, 1.0))


def _wrap_oversized_chunk(chunk: str, lim: int) -> list[str]:
    """Split a long chunk at spaces so no fragment exceeds lim characters."""
    chunk = chunk.strip()
    if not chunk:
        return []
    if len(chunk) <= lim:
        return [chunk]
    out: list[str] = []
    rest = chunk
    while rest:
        if len(rest) <= lim:
            out.append(rest.strip())
            break
        break_at = rest.rfind(" ", 0, lim)
        if break_at < max(40, lim // 3):
            break_at = lim
        piece = rest[:break_at].strip()
        rest = rest[break_at:].strip()
        if piece:
            out.append(piece)
    return out


def _split_thinking_into_chunks(text: str, *, max_chunk_chars: int) -> list[str]:
    """Split thinking prose on sentence boundaries, merge small bits, cap chunk size."""
    text = text.strip()
    if not text:
        return []
    sentences = [s.strip() for s in re.split(r"(?<=[.!?…])\s+", text) if s.strip()]
    if not sentences:
        sentences = [text]
    chunks: list[str] = []
    buf = ""
    for s in sentences:
        if not buf:
            buf = s
        elif len(buf) + 1 + len(s) <= max_chunk_chars:
            buf = f"{buf} {s}"
        else:
            chunks.extend(_wrap_oversized_chunk(buf, max_chunk_chars))
            buf = s
    if buf:
        chunks.extend(_wrap_oversized_chunk(buf, max_chunk_chars))
    return [c for c in chunks if c.strip()]


def _merge_tiny_chunks(
    chunks: list[str], *, min_chars: int, max_chars: int
) -> list[str]:
    """Merge adjacent split fragments so pacing does not emit dozens of sub‑sentence blips."""
    if not chunks:
        return []
    out: list[str] = []
    buf = ""
    for c in chunks:
        c = c.strip()
        if not c:
            continue
        cand = f"{buf} {c}".strip() if buf else c
        if not buf:
            buf = c
        elif len(cand) <= max_chars and (len(buf) < min_chars or len(c) < min_chars):
            buf = cand
        else:
            out.append(buf)
            buf = c
    if buf:
        out.append(buf)
    return out


def _thinking_pause_scale(full_len: int) -> float:
    """Shorter thinking → tighter gaps between paced chunks (scaled × PAUSE_MIN/MAX)."""
    n = max(0, int(full_len))
    if n < 400:
        return 0.50
    if n < 900:
        return 0.70
    if n < 1600:
        return 0.88
    return 1.0


def _speak_thinking_paced(
    full_text: str,
    *,
    incremental: bool = False,
    rate_basis_len: int | None = None,
) -> None:
    """Speak extended thinking one sentence-sized chunk at a time with pauses (human pacing).

    ``rate_basis_len`` — when speaking an early sentence of a long still-growing block,
    pass the **current total** character length of the block so adaptive rate stays slow
    enough; defaults to ``len(full_text)`` (this batch only).
    """
    from friday_speaker import speaker, thinking_tts_rate_for_length

    max_chars = int(_env_float("FRIDAY_CURSOR_THINKING_MAX_CHUNK_CHARS", 520))
    max_chars = max(120, min(max_chars, 1600))
    chunks = _split_thinking_into_chunks(full_text, max_chunk_chars=max_chars)
    min_merge = int(_env_float("FRIDAY_CURSOR_THINKING_MIN_CHUNK_MERGE_CHARS", 90))
    min_merge = max(40, min(min_merge, max_chars))
    chunks = _merge_tiny_chunks(chunks, min_chars=min_merge, max_chars=max_chars)
    if not chunks:
        return

    basis = rate_basis_len if rate_basis_len is not None else len(full_text)
    basis = max(basis, len(full_text))

    fixed = os.environ.get("FRIDAY_CURSOR_THINKING_TTS_RATE", "").strip() or None
    thinking_rate = thinking_tts_rate_for_length(
        basis, incremental=incremental, fixed_rate=fixed
    )

    # Dedicated thinking voice — env override → session file → None (falls back to subagent slot).
    _thinking_voice_raw = os.environ.get("FRIDAY_TTS_THINKING_VOICE", "").strip()
    if not _thinking_voice_raw:
        try:
            import json as _json_tv
            _sv_tv = _json_tv.loads((_REPO_ROOT / ".session-voice.json").read_text(encoding="utf-8"))
            _thinking_voice_raw = _sv_tv.get("thinking_voice", "").strip()
        except Exception:
            pass
    _thinking_voice: str | None = _thinking_voice_raw if _thinking_voice_raw else None

    # Per-block voice pool — merge dedicated thinking voice with FRIDAY_CURSOR_THINKING_VOICE_POOL
    # so SAGE / FRIDAY_TTS_THINKING_VOICE participates in rotation, not replaced by pool-only ids.
    global _thinking_pool_idx
    _watcher_blocked = {v.strip() for v in os.environ.get("FRIDAY_TTS_VOICE_BLOCK", "").split(",") if v.strip()}
    _watcher_blocked |= {"en-AU-WilliamNeural", "en-AU-WilliamMultilingualNeural", "en-GB-RyanNeural", "en-GB-ThomasNeural"}
    _tv_pool_raw = os.environ.get("FRIDAY_CURSOR_THINKING_VOICE_POOL", "").strip()
    _pool_extra = (
        [v.strip() for v in _tv_pool_raw.split(",") if v.strip() and v.strip() not in _watcher_blocked]
        if _tv_pool_raw
        else []
    )
    _merged_pool: list[str] = []
    if _thinking_voice and _thinking_voice not in _watcher_blocked:
        _merged_pool.append(_thinking_voice)
    for _pv in _pool_extra:
        if _pv not in _merged_pool:
            _merged_pool.append(_pv)
    _thinking_pool = _merged_pool if len(_merged_pool) > 1 else []

    # Pick ONE voice for this entire block, advance counter for the next block/span.
    if _thinking_pool:
        _block_voice: str | None = _thinking_pool[_thinking_pool_idx % len(_thinking_pool)]
        _thinking_pool_idx += 1
    else:
        _block_voice = _thinking_voice

    # Tiny single blip: blocking + same rate as paced path (no FRIDAY_TTS_THINKING — avoids singleton skip).
    if len(chunks) == 1 and len(chunks[0]) < 160:
        speaker.speak_blocking(
            chunks[0].strip(),
            session="subagent",
            voice=_block_voice,
            priority=False,
            bypass_cursor_defer=True,
            rate=thinking_rate,
        )
        return

    pause_lo = _env_float("FRIDAY_CURSOR_THINKING_PAUSE_MIN", 0.07)
    pause_hi = _env_float("FRIDAY_CURSOR_THINKING_PAUSE_MAX", 0.16)
    if pause_hi < pause_lo:
        pause_lo, pause_hi = pause_hi, pause_lo
    pmul = _thinking_pause_scale(basis)
    pause_lo *= pmul
    pause_hi *= pmul
    opener_chance = _env_float("FRIDAY_CURSOR_THINKING_OPENER_CHANCE", 0.35)
    if opener_chance > 1.0:
        opener_chance = min(opener_chance / 100.0, 1.0)

    def run() -> None:
        for i, raw in enumerate(chunks):
            c = raw.strip()
            if not c:
                continue
            if i == 0 and random.random() < opener_chance:
                c = pick_thinking_opener(c) + c
            # All chunks in this block use the same voice — voice only changes on a new block/span.
            speaker.speak_blocking(
                c,
                session="subagent",
                voice=_block_voice,
                priority=False,
                bypass_cursor_defer=True,
                rate=thinking_rate,
            )
            if i >= len(chunks) - 1:
                break
            gap = random.uniform(pause_lo, pause_hi)
            if c.rstrip().endswith("?"):
                gap += random.uniform(0.06, 0.18) * pmul
            time.sleep(gap)

    threading.Thread(target=run, daemon=True, name="cursor-thinking-tts").start()


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


def _is_voice_agent_chat_prose(s: str) -> bool:
    """True if this thinking-derived prose should use chat/reply TTS, not thinking pacing."""
    t = s.strip()
    if len(t) < 8:
        return False
    tl = t.lower()
    if tl.startswith("done."):
        return len(t) <= 3500
    if len(t) > 650:
        return False
    return bool(_RE_VOICE_AGENT_CHAT.search(t))


class ThinkingFlushCtx:
    """Arm thinking debounce timers that enqueue flush work (serialized worker, no lock in Timer)."""

    __slots__ = ("work_q", "speak_main", "speak_sub")

    def __init__(
        self,
        work_q: "queue.Queue",
        speak_main: bool,
        speak_sub: bool,
    ) -> None:
        self.work_q = work_q
        self.speak_main = speak_main
        self.speak_sub = speak_sub


_RESCAN_WORK = "__rescan__"
_FLUSH_THINK_WORK = "__flush_think__"


def _thinking_debounce_sec() -> float:
    v = _env_float("FRIDAY_CURSOR_THINKING_DEBOUNCE_SEC", 0.65)
    return max(0.15, min(v, 30.0))


def _thinking_min_batch_chars() -> int:
    """Incremental stream: wait until at least this many characters of prose before TTS."""
    v = _env_float("FRIDAY_CURSOR_THINKING_MIN_BATCH_CHARS", 220)
    return max(60, min(int(v), 4000))


def _thinking_speak_once(
    thinking_prose: str,
    spoken_hashes: set,
    *,
    incremental: bool = False,
    rate_basis_len: int | None = None,
    is_main: bool = True,
    speak_main: bool = True,
    speak_sub: bool = True,
) -> None:
    h = _content_hash(thinking_prose)
    if h in spoken_hashes:
        return
    if _is_voice_agent_chat_prose(thinking_prose):
        spoken_hashes.add(h)
        whom = "main" if is_main else "subagent"
        print(
            f"cursor-reply-watch: [thinking→chat] {len(thinking_prose)} chars via {whom} reply voice "
            f"(incremental={incremental})",
            flush=True,
        )
        if is_main and speak_main:
            _speak_main(thinking_prose)
        elif (not is_main) and speak_sub:
            _speak_subagent(thinking_prose)
        else:
            # Reply channel off under narration — fall back to thinking voice so it is still heard.
            _speak_thinking_paced(
                thinking_prose,
                incremental=incremental,
                rate_basis_len=rate_basis_len,
            )
        return
    spoken_hashes.add(h)
    print(
        f"cursor-reply-watch: [thinking] speaking {len(thinking_prose)} chars batched pacing "
        f"(incremental={incremental})",
        flush=True,
    )
    _speak_thinking_paced(
        thinking_prose,
        incremental=incremental,
        rate_basis_len=rate_basis_len,
    )


def _thinking_buffer_update(
    st: dict,
    thinking_prose: str,
    *,
    now: float,
    spoken_hashes: set,
    is_main: bool,
    speak_main: bool,
    speak_sub: bool,
    path_str: str | None = None,
    thinking_ctx: ThinkingFlushCtx | None = None,
) -> None:
    """Incremental streaming: speak NEW sentences as they arrive, not all at once.

    Tracks how much text has been spoken so far (``thinking_spoken_len``).
    When new prose extends the previous buffer, extract unseen tail, split into
    sentences, and speak ready ones immediately (keeping the last partial sentence
    buffered in case it's still being appended).
    """
    prev = (st.get("thinking_pending") or "").strip()
    spoken_len = st.get("thinking_spoken_len", 0)

    if prev and not thinking_prose.startswith(prev):
        batch_prev = (st.pop("thinking_batch_buf", None) or "").strip()
        tail = prev[spoken_len:].strip()
        merged_prev = " ".join(x for x in (batch_prev, tail) if x).strip()
        if merged_prev:
            _thinking_speak_once(
                merged_prev,
                spoken_hashes,
                incremental=True,
                rate_basis_len=len(prev),
                is_main=is_main,
                speak_main=speak_main,
                speak_sub=speak_sub,
            )
        st["thinking_spoken_len"] = 0
        spoken_len = 0

    st["thinking_pending"] = thinking_prose

    unseen = thinking_prose[spoken_len:].strip()
    if not unseen:
        st["thinking_debounce_at"] = now + _thinking_debounce_sec()
        if path_str and thinking_ctx is not None:
            _schedule_thinking_flush(path_str, st, thinking_ctx)
        return

    parts = re.split(r"(?<=[.!?…])\s+", unseen)
    if len(parts) <= 1:
        st["thinking_debounce_at"] = now + _thinking_debounce_sec()
        if path_str and thinking_ctx is not None:
            _schedule_thinking_flush(path_str, st, thinking_ctx)
        return

    ready = parts[:-1]
    ready_text = " ".join(ready).strip()
    if ready_text:
        min_b = _thinking_min_batch_chars()
        batch = (st.get("thinking_batch_buf") or "").strip()
        batch = f"{batch} {ready_text}".strip() if batch else ready_text
        new_spoken = spoken_len + len(unseen) - len(parts[-1])
        st["thinking_spoken_len"] = new_spoken
        if len(batch) >= min_b:
            _thinking_speak_once(
                batch,
                spoken_hashes,
                incremental=True,
                rate_basis_len=len(thinking_prose),
                is_main=is_main,
                speak_main=speak_main,
                speak_sub=speak_sub,
            )
            st["thinking_batch_buf"] = ""
        else:
            st["thinking_batch_buf"] = batch

    st["thinking_debounce_at"] = now + _thinking_debounce_sec()
    if path_str and thinking_ctx is not None:
        _schedule_thinking_flush(path_str, st, thinking_ctx)


def _cancel_thinking_timer(st: dict) -> None:
    t = st.pop("_thinking_timer", None)
    if isinstance(t, threading.Timer):
        t.cancel()


def _thinking_clear_pending(st: dict) -> None:
    _cancel_thinking_timer(st)
    st.pop("thinking_pending", None)
    st.pop("thinking_debounce_at", None)
    st.pop("thinking_spoken_len", None)
    st.pop("thinking_batch_buf", None)


def _flush_thinking_debounce(
    st: dict,
    now: float,
    *,
    speak_main: bool,
    speak_sub: bool,
) -> None:
    """If pending thinking has been idle long enough, speak remaining tail."""
    is_main = bool(st.get("is_main", True))
    pend = (st.get("thinking_pending") or "").strip()
    if not pend:
        batch = (st.pop("thinking_batch_buf", None) or "").strip()
        if batch:
            _thinking_speak_once(
                batch,
                st["spoken_hashes"],
                rate_basis_len=len(batch),
                is_main=is_main,
                speak_main=speak_main,
                speak_sub=speak_sub,
            )
        _thinking_clear_pending(st)
        return
    dead = st.get("thinking_debounce_at")
    if dead is None or now < dead:
        return
    spoken_hashes = st["spoken_hashes"]
    spoken_len = st.get("thinking_spoken_len", 0)
    batch = (st.pop("thinking_batch_buf", None) or "").strip()
    tail = pend[spoken_len:].strip()
    merged = " ".join(x for x in (batch, tail) if x).strip()
    if merged:
        _thinking_speak_once(
            merged,
            spoken_hashes,
            rate_basis_len=len(pend),
            is_main=is_main,
            speak_main=speak_main,
            speak_sub=speak_sub,
        )
    _thinking_clear_pending(st)


def _schedule_thinking_flush(path_str: str, st: dict, ctx: ThinkingFlushCtx) -> None:
    """Cancel any prior debounce timer and arm a new one for this state's thinking_debounce_at."""
    _cancel_thinking_timer(st)
    dead = st.get("thinking_debounce_at")
    if dead is None:
        return
    delay = max(0.001, dead - time.monotonic())

    def fire() -> None:
        ctx.work_q.put((_FLUSH_THINK_WORK, path_str))

    timer = threading.Timer(delay, fire)
    timer.daemon = True
    st["_thinking_timer"] = timer
    timer.start()


def _rescan_transcript_paths(state_map: dict[str, dict]) -> None:
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
            st = state_map.pop(old, None)
            if st is not None:
                _cancel_thinking_timer(st)


def _jsonl_under_root(path: Path) -> bool:
    try:
        path.resolve().relative_to(_TRANSCRIPTS_ROOT)
    except ValueError:
        return False
    return path.suffix.lower() == ".jsonl"


def _process_jsonl_path(
    path_str: str,
    state_map: dict[str, dict],
    *,
    now: float,
    main_uuid: str,
    speak_main: bool,
    speak_sub: bool,
    speak_thinking: bool,
    thinking_ctx: ThinkingFlushCtx | None,
) -> None:
    st = state_map.get(path_str)
    if st is None:
        return
    p = Path(path_str)
    try:
        sz = p.stat().st_size
    except OSError:
        return
    off = st["offset"]
    if sz < off:
        off = 0
        st["carry"] = ""
    st["offset"] = off
    if sz == off:
        return
    st["last_activity"] = now
    try:
        with p.open("r", encoding="utf-8", errors="replace") as f:
            f.seek(off)
            chunk = f.read()
        st["offset"] = sz
    except OSError:
        return

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
        st["is_main"] = is_main

        if speak_thinking:
            thinking_raw, stream_kind = _thinking_parse_line(line)
            if thinking_raw:
                thinking_prose = strip_to_prose(thinking_raw)
                if thinking_prose:
                    if stream_kind == "final":
                        spoken_len = st.get("thinking_spoken_len", 0)
                        tail = thinking_prose[spoken_len:].strip()
                        batch = (st.pop("thinking_batch_buf", None) or "").strip()
                        merged = " ".join(x for x in (batch, tail) if x).strip()
                        _thinking_clear_pending(st)
                        if merged:
                            _thinking_speak_once(
                                merged,
                                spoken_hashes,
                                rate_basis_len=len(thinking_prose),
                                is_main=is_main,
                                speak_main=speak_main,
                                speak_sub=speak_sub,
                            )
                    else:
                        _thinking_buffer_update(
                            st,
                            thinking_prose,
                            now=now,
                            spoken_hashes=spoken_hashes,
                            is_main=is_main,
                            speak_main=speak_main,
                            speak_sub=speak_sub,
                            path_str=path_str,
                            thinking_ctx=thinking_ctx,
                        )

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


class _TranscriptEventHandler(FileSystemEventHandler):
    """Debounced filesystem notifications → enqueue path work for the single consumer worker."""

    def __init__(self, work_q: "queue.Queue") -> None:
        super().__init__()
        self._work_q = work_q
        self._debounce_lock = threading.Lock()
        self._path_timers: dict[str, threading.Timer] = {}

    def close(self) -> None:
        with self._debounce_lock:
            for t in self._path_timers.values():
                t.cancel()
            self._path_timers.clear()

    def on_created(self, event) -> None:  # noqa: ANN001
        if event.is_directory:
            self._work_q.put(_RESCAN_WORK)
            return
        self._queue_path(event.src_path)

    def on_modified(self, event) -> None:  # noqa: ANN001
        if event.is_directory:
            return
        self._queue_path(event.src_path)

    def _queue_path(self, src_path: str) -> None:
        path = Path(src_path)
        if not _jsonl_under_root(path):
            return
        try:
            key = str(path.resolve())
        except OSError:
            return
        debounce = _file_event_debounce_sec()
        with self._debounce_lock:
            old = self._path_timers.pop(key, None)
            if old is not None:
                old.cancel()

            def run() -> None:
                with self._debounce_lock:
                    self._path_timers.pop(key, None)
                self._work_q.put(key)

            t = threading.Timer(debounce, run)
            t.daemon = True
            self._path_timers[key] = t
            t.start()


def _periodic_rescan_enqueue(work_q: "queue.Queue", stop: threading.Event) -> None:
    while not stop.wait(timeout=RESCAN_SEC):
        work_q.put(_RESCAN_WORK)


def _transcript_worker_loop(
    work_q: "queue.Queue",
    state_map: dict[str, dict],
    *,
    speak_main: bool,
    speak_sub: bool,
    speak_thinking: bool,
    warned_no_chat: list[bool],
) -> None:
    """Single consumer: all JSONL reads / TTS / rescan / thinking flushes run here (no lock needed)."""
    while True:
        item = work_q.get()
        try:
            if item is None:
                return
            if item == _RESCAN_WORK:
                _rescan_transcript_paths(state_map)
                continue
            if isinstance(item, tuple) and len(item) == 2 and item[0] == _FLUSH_THINK_WORK:
                path_str = item[1]
                st = state_map.get(path_str)
                if st is not None:
                    st.pop("_thinking_timer", None)
                    _flush_thinking_debounce(
                        st,
                        time.monotonic(),
                        speak_main=speak_main,
                        speak_sub=speak_sub,
                    )
                continue
            if isinstance(item, str):
                key = item
                if key not in state_map:
                    _rescan_transcript_paths(state_map)
                    if key not in state_map:
                        continue
                session = _load_session()
                main_uuid = (session.get("chat_id") or "").strip()
                if not main_uuid and not warned_no_chat[0]:
                    warned_no_chat[0] = True
                    print(
                        "cursor-reply-watch: .session-voice.json has no chat_id yet — open main Composer chat once "
                        "so pick-session-voice can run, or paste chat_id from agent-transcripts.",
                        flush=True,
                    )
                thinking_ctx = (
                    ThinkingFlushCtx(work_q, speak_main, speak_sub)
                    if speak_thinking
                    else None
                )
                now = time.monotonic()
                _process_jsonl_path(
                    key,
                    state_map,
                    now=now,
                    main_uuid=main_uuid,
                    speak_main=speak_main,
                    speak_sub=speak_sub,
                    speak_thinking=speak_thinking,
                    thinking_ctx=thinking_ctx,
                )
        finally:
            work_q.task_done()


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
        # Live narration covers ack/status/done — suppress main/sub JSONL TTS unless *_WITH_NARRATION.
        # Thinking from JSONL defaults ON here (WITH_NARRATION default true); live agent thinking TTS is unreliable.
        if speak_main and not _env_bool("FRIDAY_CURSOR_SPEAK_REPLY_WITH_NARRATION", False):
            speak_main = False
        if speak_sub and not _env_bool("FRIDAY_CURSOR_SPEAK_SUBAGENT_WITH_NARRATION", False):
            speak_sub = False
        if speak_thinking and not _env_bool("FRIDAY_CURSOR_SPEAK_THINKING_WITH_NARRATION", True):
            speak_thinking = False
    any_active = speak_main or speak_sub or speak_thinking
    if not any_active:
        if _narration_enabled() and (req_main or req_sub or req_thinking):
            print(
                "cursor-reply-watch: no active speak channels under current .env "
                "(with FRIDAY_CURSOR_NARRATION, enable *_WITH_NARRATION for main/sub echo; "
                "thinking from JSONL is on by default — turn off with FRIDAY_CURSOR_SPEAK_THINKING=false "
                "or FRIDAY_CURSOR_SPEAK_THINKING_WITH_NARRATION=false). Exiting.",
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
    warned_no_chat: list[bool] = [False]

    _merge_new_paths(state_map, seek_end=True)

    print(
        f"cursor-reply-watch: root={_TRANSCRIPTS_ROOT} main={speak_main} subagent={speak_sub} "
        f"thinking={speak_thinking} mode=watchdog rescan_sec={RESCAN_SEC}",
        flush=True,
    )

    if not _TRANSCRIPTS_ROOT.is_dir():
        print(
            f"cursor-reply-watch: transcript root missing — {_TRANSCRIPTS_ROOT}",
            flush=True,
        )

    work_q: queue.Queue = queue.Queue()
    stop_side = threading.Event()

    worker_thread = threading.Thread(
        target=_transcript_worker_loop,
        args=(work_q, state_map),
        kwargs={
            "speak_main": speak_main,
            "speak_sub": speak_sub,
            "speak_thinking": speak_thinking,
            "warned_no_chat": warned_no_chat,
        },
        name="cursor-reply-worker",
        daemon=True,
    )
    worker_thread.start()

    handler = _TranscriptEventHandler(work_q)
    observer = Observer()
    observer.schedule(handler, str(_TRANSCRIPTS_ROOT), recursive=True)
    observer.start()

    rescan_thread = threading.Thread(
        target=_periodic_rescan_enqueue,
        args=(work_q, stop_side),
        name="cursor-reply-rescan",
        daemon=True,
    )
    rescan_thread.start()

    try:
        while True:
            time.sleep(86400.0)
    except KeyboardInterrupt:
        pass
    finally:
        stop_side.set()
        handler.close()
        observer.stop()
        observer.join(timeout=5.0)
        for st in state_map.values():
            _cancel_thinking_timer(st)
        work_q.put(None)
        worker_thread.join(timeout=10.0)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("cursor-reply-watch: stopped.", flush=True)
        sys.exit(0)
