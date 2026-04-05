#!/usr/bin/env python3
"""
openclaw_company.py — OpenClaw Labs org chart: names, titles, Edge voices, TTS rates.

Each long-running daemon imports get_persona(role) and applies voice/rate to subprocess env
or friday_speaker kwargs. Env overrides: OPENCLAW_<ROLE>_VOICE, OPENCLAW_<ROLE>_RATE

Roles: jarvis, argus, nova, sage, dexter, maestro, harper, sentinel, atlas, echo
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent

# Default registry (formal + friendly; voices are non-blocked house picks)
PERSONAS: dict[str, dict[str, str]] = {
    "jarvis": {
        "name": "Jarvis",
        "title": "Chief of Staff",
        "voice": "en-US-AvaMultilingualNeural",
        "rate": "",
        "personality": "Composed, warm, confident — your primary executive assistant.",
    },
    "argus": {
        "name": "Argus",
        "title": "VP, Security and Compliance",
        "voice": "en-US-GuyNeural",
        "rate": "+5%",
        "personality": "Dry, watchful, direct; no-nonsense on pending reviews.",
    },
    "nova": {
        "name": "Nova",
        "title": "Director of Communications",
        "voice": "en-GB-SoniaNeural",
        "rate": "",
        "personality": "Polished, concise; delivers briefings like a news lead.",
    },
    "sage": {
        "name": "Sage",
        "title": "Head of Research",
        "voice": "en-US-AndrewMultilingualNeural",
        "rate": "-5%",
        "personality": "Measured, academic; narrates reasoning aloud.",
    },
    "dexter": {
        "name": "Dexter",
        "title": "Lead Engineer",
        "voice": "en-US-EricNeural",
        "rate": "",
        "personality": "Methodical, lightly nerdy; standup-style updates.",
    },
    "maestro": {
        "name": "Maestro",
        "title": "Creative Director",
        "voice": "en-US-BrianMultilingualNeural",
        "rate": "",
        "personality": "Witty, relaxed; music, culture, and colour commentary.",
    },
    "harper": {
        "name": "Harper",
        "title": "Executive Assistant",
        "voice": "en-US-JennyNeural",
        "rate": "",
        "personality": "Organised, supportive; reminders without nagging.",
    },
    "sentinel": {
        "name": "Sentinel",
        "title": "IT Operations",
        "voice": "en-IE-ConnorNeural",
        "rate": "+3%",
        "personality": "Understated relay; reads Composer output when enabled.",
    },
    "atlas": {
        "name": "Atlas",
        "title": "VP, Strategy",
        "voice": "",  # ears only — inherits Jarvis for spoken replies
        "rate": "",
        "personality": "Listen path only; does not speak independently.",
    },
    "echo": {
        "name": "Echo",
        "title": "Director of Presence",
        "voice": "en-US-MichelleNeural",
        "rate": "",
        "personality": "Warm check-ins when the room has been quiet; invites interaction without nagging.",
    },
}


def _env_upper(role: str) -> str:
    return role.strip().upper().replace("-", "_")


def _redis_url() -> str:
    return (
        os.environ.get("OPENCLAW_REDIS_URL", "").strip()
        or os.environ.get("FRIDAY_AMBIENT_REDIS_URL", "").strip()
        or "redis://127.0.0.1:6379"
    )


def _persona_patch_from_redis() -> dict[str, dict[str, str]]:
    """Partial overrides written by pc-agent when Postgres voice_agent_personas changes."""
    try:
        import redis as _redis_mod

        r = _redis_mod.Redis.from_url(_redis_url(), decode_responses=True, socket_timeout=1.5)
        blob = r.get("openclaw:voice_agent_personas_patch")
        if not blob:
            return {}
        import json as _json

        o = _json.loads(blob)
        return o if isinstance(o, dict) else {}
    except Exception:
        return {}


def _apply_stored_persona_patch(out: dict[str, str], role_key: str, patch_all: dict[str, dict]) -> None:
    if not patch_all:
        return
    p = patch_all.get(role_key)
    if not isinstance(p, dict):
        return
    for fld in ("name", "title", "voice", "personality", "rate"):
        v = p.get(fld)
        if isinstance(v, str) and v.strip():
            out[fld] = v.strip()


def get_persona(role: str) -> dict[str, str]:
    """Return persona dict: code defaults + Redis/Postgres patch + OPENCLAW_* env and legacy keys."""
    key = role.strip().lower()
    if key not in PERSONAS:
        raise KeyError(f"Unknown OpenClaw persona: {role}")
    out = dict(PERSONAS[key])
    _apply_stored_persona_patch(out, key, _persona_patch_from_redis())

    u = _env_upper(key)
    v = os.environ.get(f"OPENCLAW_{u}_VOICE", "").strip()
    if v:
        out["voice"] = v
    # Legacy voice envs
    if key == "argus" and not v:
        lv = os.environ.get("FRIDAY_ARGUS_VOICE", "").strip()
        if lv:
            out["voice"] = lv
    if key == "nova" and not v:
        lv = os.environ.get("FRIDAY_EMAIL_NOTIFY_VOICE", "").strip()
        if lv:
            out["voice"] = lv

    r = os.environ.get(f"OPENCLAW_{u}_RATE", "").strip()
    if r:
        out["rate"] = r

    return out


def friday_speak_env_for_persona(role: str, *, priority: bool = True) -> dict[str, str]:
    """Env fragment for spawning friday-speak.py subprocess."""
    p = get_persona(role)
    env: dict[str, str] = {
        "FRIDAY_TTS_USE_SESSION_STICKY_VOICE": "false",
        "FRIDAY_TTS_BYPASS_CURSOR_DEFER": "true",
    }
    if priority:
        env["FRIDAY_TTS_PRIORITY"] = "1"
    voice = (p.get("voice") or "").strip()
    if voice:
        env["FRIDAY_TTS_VOICE"] = voice
    rate = (p.get("rate") or "").strip()
    if rate:
        env["FRIDAY_TTS_RATE"] = rate
    return env


def sage_ocr_master_enabled() -> bool:
    """SAGE (thinking OCR): FRIDAY_SAGE_ENABLED if set, else legacy FRIDAY_CURSOR_THINKING_OCR."""
    raw = os.environ.get("FRIDAY_SAGE_ENABLED", "").strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    raw2 = os.environ.get("FRIDAY_CURSOR_THINKING_OCR", "").strip().lower()
    return raw2 in ("1", "true", "yes", "on")


# ── JSONL gate: only treat as “thinking window” when last assistant msg has no tool_use ──

_SESSION_FILE = _REPO_ROOT / ".session-voice.json"


def _default_transcripts_root() -> Path:
    return Path(
        os.environ.get(
            "CURSOR_TRANSCRIPTS_DIR",
            r"C:\Users\rajut\.cursor\projects\d-code-openclaw\agent-transcripts",
        )
    )


def _read_chat_id() -> str | None:
    if not _SESSION_FILE.exists():
        return None
    try:
        data = json.loads(_SESSION_FILE.read_text(encoding="utf-8"))
        return data.get("chat_id") or None
    except Exception:
        return None


def _find_jsonl(chat_id: str) -> Path | None:
    folder = _default_transcripts_root() / chat_id
    if not folder.is_dir():
        return None
    matches = list(folder.glob("*.jsonl"))
    if not matches:
        return None
    return max(matches, key=lambda x: x.stat().st_mtime)


def _assistant_line_allows_thinking(obj: dict) -> bool:
    if obj.get("role") != "assistant":
        return False
    msg = obj.get("message") or {}
    content = msg.get("content")
    if not isinstance(content, list):
        return True
    has_tool = any(
        isinstance(it, dict) and it.get("type") == "tool_use"
        for it in content
    )
    return not has_tool


def _parse_jsonl_tail_state(path: Path, max_bytes: int = 65536) -> bool:
    """Return True if latest transcript state is assistant pre-tool (thinking window)."""
    try:
        size = path.stat().st_size
    except OSError:
        return False
    start = max(0, size - max_bytes)
    try:
        with path.open("rb") as fh:
            fh.seek(start)
            blob = fh.read().decode("utf-8", errors="replace")
    except OSError:
        return False
    allowed = False
    for raw in blob.splitlines():
        line = raw.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        role = obj.get("role", "")
        if role == "user":
            allowed = False
        elif role == "assistant":
            allowed = _assistant_line_allows_thinking(obj)
    return allowed


class JsonlThinkingGate:
    """Track Composer JSONL tail: allow OCR thinking TTS only in pre-tool assistant prose."""

    __slots__ = ("_chat_id", "_jsonl_path", "_read_offset", "_ocr_allowed")

    def __init__(self) -> None:
        self._chat_id: str | None = None
        self._jsonl_path: Path | None = None
        self._read_offset = 0
        self._ocr_allowed = False

    def refresh(self) -> None:
        chat_id = _read_chat_id()
        if chat_id != self._chat_id:
            self._chat_id = chat_id
            self._jsonl_path = _find_jsonl(chat_id) if chat_id else None
            self._ocr_allowed = False
            self._read_offset = 0
            if self._jsonl_path and self._jsonl_path.is_file():
                self._ocr_allowed = _parse_jsonl_tail_state(self._jsonl_path)
                try:
                    self._read_offset = self._jsonl_path.stat().st_size
                except OSError:
                    self._read_offset = 0
        elif self._jsonl_path is None and chat_id:
            self._jsonl_path = _find_jsonl(chat_id)
            if self._jsonl_path and self._jsonl_path.is_file():
                self._ocr_allowed = _parse_jsonl_tail_state(self._jsonl_path)
                try:
                    self._read_offset = self._jsonl_path.stat().st_size
                except OSError:
                    self._read_offset = 0

    def ingest(self) -> None:
        """Read new JSONL bytes; update whether last assistant turn is still pre-tools."""
        if not self._jsonl_path or not self._jsonl_path.is_file():
            self.refresh()
        path = self._jsonl_path
        if not path or not path.is_file():
            self._ocr_allowed = False
            return
        try:
            size = path.stat().st_size
        except OSError:
            return
        if size < self._read_offset:
            self._read_offset = 0
        if size == self._read_offset:
            return
        try:
            chunk = path.read_bytes()[self._read_offset:size]
        except OSError:
            return
        self._read_offset = size
        text = chunk.decode("utf-8", errors="replace")
        for raw in text.splitlines():
            line = raw.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            role = obj.get("role", "")
            if role == "user":
                self._ocr_allowed = False
                continue
            if role != "assistant":
                continue
            msg = obj.get("message") or {}
            content = msg.get("content")
            if not isinstance(content, list):
                self._ocr_allowed = True
                continue
            has_tool = any(
                isinstance(it, dict) and it.get("type") == "tool_use"
                for it in content
            )
            self._ocr_allowed = not has_tool

    @property
    def ocr_allowed(self) -> bool:
        return self._ocr_allowed


_RE_REASONING = re.compile(
    r"(?i)\b("
    r"i think|i'll|i will|because|therefore|the issue|the problem|probably|might|could|"
    r"we should|let's|need to|wondering|likely|seems like|one thing|approach|"
    r"trade-?off|alternative|option|risk|if we|assuming|hmm|so the"
    r")\b"
)


def prose_looks_like_reasoning(prose: str, *, min_chars: int = 20) -> bool:
    """Extra guard: OCR strip must look like reasoning, not casual chat or pasted text."""
    s = (prose or "").strip()
    if len(re.sub(r"[^a-zA-Z]", "", s)) < min_chars:
        return False
    if _RE_REASONING.search(s):
        return True
    # Long reflective paragraphs without keywords — allow if very prose-heavy
    words = s.split()
    if len(words) >= 28 and sum(1 for w in words if w.islower() or w[0].islower()) / max(len(words), 1) > 0.65:
        return True
    return False
