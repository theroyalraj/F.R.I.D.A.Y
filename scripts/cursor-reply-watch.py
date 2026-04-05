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

Thinking capture from JSONL defaults ON with narration (live agent thinking TTS is unreliable).
Set FRIDAY_CURSOR_SPEAK_THINKING_WITH_NARRATION=false to disable watcher thinking only.

Optional:
  FRIDAY_CURSOR_REPLY_VOICE — Edge voice id for main transcript TTS (see pick-session-voice --cursor-reply)
  CURSOR_TRANSCRIPTS_DIR — override path to agent-transcripts

Thinking TTS pacing (sentence-by-sentence, avoids one rushed blob):
  FRIDAY_CURSOR_THINKING_TTS_RATE — Edge rate for thinking only (default -5% vs repo default +7.5%)
  FRIDAY_CURSOR_THINKING_PAUSE_MIN / FRIDAY_CURSOR_THINKING_PAUSE_MAX — seconds between sentences (default 0.35–0.85)
  FRIDAY_CURSOR_THINKING_OPENER_CHANCE — 0–1 chance to prefix first sentence with a soft "Hmm / So —" style lead-in (default 0.35)
  FRIDAY_CURSOR_THINKING_MAX_CHUNK_CHARS — merge/split target width (default 300)

JSONL thinking does not set FRIDAY_TTS_THINKING — that flag enables a separate singleton in friday-speak that
drops audio when busy (e.g. live agent thinking narration). Watcher thinking only needs the global TTS lock.

Incremental thinking (same line growing across JSONL updates):
  Thinking blocks may carry final/partial flags — we only speak immediately when final is true (or partial is explicitly false).
  When flags are missing, we buffer and speak once after FRIDAY_CURSOR_THINKING_DEBOUNCE_SEC of no updates (default 0.85).

Run:  python scripts/cursor-reply-watch.py
"""

from __future__ import annotations

import hashlib
import json
import os
import random
import re
import subprocess
import sys
import threading
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


_THINKING_OPENERS = (
    # Reflective / analytical
    "Hmm. ",
    "Interesting — ",
    "Actually — ",
    "Wait — ",
    "Hang on — ",
    "Hold on a second — ",
    "That's a good question — ",
    "Now that I look at this — ",
    "Okay, this is nuanced — ",
    "There's a subtlety here — ",
    "This is worth unpacking — ",
    "So here's what's happening — ",
    "Let me reason through this — ",
    "Okay, thinking this through — ",
    "The thing to notice here is — ",
    "This is more involved than it looks — ",
    "Let me connect the dots here — ",
    # Confident / knowledgeable
    "Right. ",
    "So — ",
    "Now — ",
    "Right, so — ",
    "Okay, so — ",
    "Here's the thing — ",
    "The key insight is — ",
    "What matters here is — ",
    "From what I can tell — ",
    "Based on what I'm seeing — ",
    "If I'm reading this correctly — ",
    "The way this works is — ",
    "So the pattern here is — ",
    "What's going on under the hood is — ",
    # Curious / exploratory
    "Let me think — ",
    "Let me see — ",
    "Let me check — ",
    "Let me dig into this — ",
    "Let me trace through this — ",
    "Okay, pulling this apart — ",
    "Let me walk through the logic — ",
    "Bear with me on this one — ",
    "I want to make sure I get this right — ",
    "Okay, working through this step by step — ",
    # Casual / human
    "Okay — ",
    "Alright — ",
    "Right then — ",
    "So look — ",
    "Okay, here's my read — ",
    "So basically — ",
    "Yeah, so — ",
    "Alright, so — ",
    "Let me break this down — ",
    "Okay, let me lay this out — ",
    # Cheeky / roast
    "Oh boy. ",
    "Oh no. ",
    "Wow, okay — ",
    "Who wrote this? ",
    "Yikes — ",
    "Well that's creative — ",
    "Brave choice — ",
    "Oh, we're doing this are we — ",
    "Someone was feeling adventurous — ",
    "This is a cry for help — ",
    "Bold strategy, let's see if it pays off — ",
    "I have questions. Many questions — ",
    "Tell me you didn't test this — ",
    "I'm not mad, I'm just disappointed — ",
    "Whoever did this owes me an explanation — ",
    "This has big 'it works on my machine' energy — ",
    "Ah yes, the classic 'fix it later' approach — ",
    "I see someone chose violence today — ",
    "Pain. Pure pain — ",
    "This code has a certain chaotic energy — ",
    # Meme / internet culture
    "It's giving spaghetti code — ",
    "First time? ",
    "Skill issue detected — ",
    "This ain't it, chief — ",
    "We need to talk — ",
    "So anyway, I started blasting — ",
    "Confused screaming — ",
    "Task failed successfully — ",
    "Not gonna lie — ",
    "Top ten anime betrayals — ",
    "How do I even begin — ",
    "Bro really said 'trust me' — ",
    "You see what happened was — ",
    "Ladies and gentlemen, we got him — ",
    "Outstanding move — ",
    "I'm going to pretend I didn't see that — ",
    "Modern problems require modern solutions — ",
    "That's rough, buddy — ",
    "They don't know — ",
    "Big brain time — ",
)


def _env_float(key: str, default: float) -> float:
    raw = os.environ.get(key, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


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


def _speak_thinking_paced(full_text: str) -> None:
    """Speak extended thinking one sentence-sized chunk at a time with pauses (human pacing)."""
    from friday_speaker import speaker

    max_chars = int(_env_float("FRIDAY_CURSOR_THINKING_MAX_CHUNK_CHARS", 300))
    max_chars = max(80, min(max_chars, 1200))
    chunks = _split_thinking_into_chunks(full_text, max_chunk_chars=max_chars)
    if not chunks:
        return

    thinking_rate = os.environ.get("FRIDAY_CURSOR_THINKING_TTS_RATE", "-5%").strip() or "-5%"

    # Tiny single blip: blocking + same rate as paced path (no FRIDAY_TTS_THINKING — avoids singleton skip).
    if len(chunks) == 1 and len(chunks[0]) < 160:
        speaker.speak_blocking(
            chunks[0].strip(),
            session="subagent",
            priority=True,
            bypass_cursor_defer=True,
            rate=thinking_rate,
        )
        return

    pause_lo = _env_float("FRIDAY_CURSOR_THINKING_PAUSE_MIN", 0.35)
    pause_hi = _env_float("FRIDAY_CURSOR_THINKING_PAUSE_MAX", 0.85)
    if pause_hi < pause_lo:
        pause_lo, pause_hi = pause_hi, pause_lo
    opener_chance = _env_float("FRIDAY_CURSOR_THINKING_OPENER_CHANCE", 0.35)
    if opener_chance > 1.0:
        opener_chance = min(opener_chance / 100.0, 1.0)

    def run() -> None:
        for i, raw in enumerate(chunks):
            c = raw.strip()
            if not c:
                continue
            if i == 0 and random.random() < opener_chance:
                c = random.choice(_THINKING_OPENERS) + c
            speaker.speak_blocking(
                c,
                session="subagent",
                priority=True,
                bypass_cursor_defer=True,
                rate=thinking_rate,
            )
            if i >= len(chunks) - 1:
                break
            gap = random.uniform(pause_lo, pause_hi)
            if c.rstrip().endswith("?"):
                gap += random.uniform(0.12, 0.38)
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


def _thinking_debounce_sec() -> float:
    v = _env_float("FRIDAY_CURSOR_THINKING_DEBOUNCE_SEC", 0.85)
    return max(0.15, min(v, 30.0))


def _thinking_speak_once(thinking_prose: str, spoken_hashes: set) -> None:
    h = _content_hash(thinking_prose)
    if h in spoken_hashes:
        return
    spoken_hashes.add(h)
    print(
        f"cursor-reply-watch: [thinking] speaking {len(thinking_prose)} chars (paced)",
        flush=True,
    )
    _speak_thinking_paced(thinking_prose)


def _thinking_buffer_update(
    st: dict,
    thinking_prose: str,
    *,
    now: float,
    spoken_hashes: set,
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
        tail = prev[spoken_len:].strip()
        if tail:
            _thinking_speak_once(tail, spoken_hashes)
        st["thinking_spoken_len"] = 0
        spoken_len = 0

    st["thinking_pending"] = thinking_prose

    unseen = thinking_prose[spoken_len:].strip()
    if not unseen:
        st["thinking_debounce_at"] = now + _thinking_debounce_sec()
        return

    parts = re.split(r"(?<=[.!?…])\s+", unseen)
    if len(parts) <= 1:
        st["thinking_debounce_at"] = now + _thinking_debounce_sec()
        return

    ready = parts[:-1]
    ready_text = " ".join(ready).strip()
    if ready_text:
        _thinking_speak_once(ready_text, spoken_hashes)
        st["thinking_spoken_len"] = spoken_len + len(unseen) - len(parts[-1])

    st["thinking_debounce_at"] = now + _thinking_debounce_sec()


def _thinking_clear_pending(st: dict) -> None:
    st.pop("thinking_pending", None)
    st.pop("thinking_debounce_at", None)
    st.pop("thinking_spoken_len", None)


def _flush_thinking_debounce(st: dict, now: float) -> None:
    """If pending thinking has been idle long enough, speak remaining tail."""
    pend = (st.get("thinking_pending") or "").strip()
    if not pend:
        _thinking_clear_pending(st)
        return
    dead = st.get("thinking_debounce_at")
    if dead is None or now < dead:
        return
    spoken_hashes = st["spoken_hashes"]
    spoken_len = st.get("thinking_spoken_len", 0)
    tail = pend[spoken_len:].strip()
    if tail:
        _thinking_speak_once(tail, spoken_hashes)
    _thinking_clear_pending(st)


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
            if sz != off:
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
                        thinking_raw, stream_kind = _thinking_parse_line(line)
                        if thinking_raw:
                            thinking_prose = strip_to_prose(thinking_raw)
                            if thinking_prose:
                                if stream_kind == "final":
                                    spoken_len = st.get("thinking_spoken_len", 0)
                                    tail = thinking_prose[spoken_len:].strip()
                                    _thinking_clear_pending(st)
                                    if tail:
                                        _thinking_speak_once(
                                            tail, spoken_hashes
                                        )
                                else:
                                    _thinking_buffer_update(
                                        st,
                                        thinking_prose,
                                        now=now,
                                        spoken_hashes=spoken_hashes,
                                    )

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

        if speak_thinking:
            now_flush = time.monotonic()
            for st in state_map.values():
                _flush_thinking_debounce(st, now_flush)

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
