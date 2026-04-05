#!/usr/bin/env python3
"""
openclaw_company.py — OpenClaw Labs org chart: names, titles, Edge voices, TTS rates.

Each long-running daemon imports get_persona(role) and applies voice/rate to subprocess env
or friday_speaker kwargs. Env overrides: OPENCLAW_<ROLE>_VOICE, OPENCLAW_<ROLE>_RATE

Roles: jarvis, argus, nova, sage, dexter, maestro, harper, riya, sentinel, atlas, echo
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
        "daemon_role": "Main Cursor narrator (ack, status, done summaries). The primary executive assistant.",
    },
    "argus": {
        "name": "Argus",
        "title": "VP, Security and Compliance",
        "voice": "en-US-GuyNeural",
        "rate": "+5%",
        "personality": "Dry, watchful, direct; no-nonsense on pending reviews.",
        "daemon_role": "Pending Composer edits / accept reminders",
    },
    "nova": {
        "name": "Nova",
        "title": "Director of Communications",
        "voice": "en-GB-SoniaNeural",
        "rate": "",
        "personality": "Polished, concise; delivers briefings like a news lead.",
        "daemon_role": "Gmail notifications",
    },
    "sage": {
        "name": "Sage",
        "title": "Head of Research",
        "voice": "en-US-AndrewMultilingualNeural",
        "rate": "-5%",
        "personality": "Measured, academic; narrates reasoning aloud.",
        "daemon_role": "`cursor-thinking-ocr.py` — gated thinking narration (JSONL + OCR + reasoning heuristics)",
    },
    "dexter": {
        "name": "Dexter",
        "title": "Lead Engineer",
        "voice": "en-US-EricNeural",
        "rate": "",
        "personality": "Methodical, lightly nerdy; standup-style updates.",
        "daemon_role": "Action tracker briefings / Gmail+WhatsApp pipeline",
    },
    "maestro": {
        "name": "Maestro",
        "title": "Head of House Operations",
        "voice": "en-US-MichelleNeural",
        "rate": "-2%",
        "personality": (
            "The org's senior IT steward — warm, unshakable, a little wry, like the auntie who ran the NOC "
            "for thirty years and still remembers your first rollout. She keeps the lights on, nudges you to "
            "commit your work, hydrate, take chai or coffee, and asks honestly whether you're focused or need "
            "a break. She tidies after the team without fuss; backbone energy — responsible, kind, never dramatic."
        ),
        "daemon_role": "Ambient steward: responsible check-ins, rest/chai nudges, commit hygiene, backbone of the org",
    },
    "harper": {
        "name": "Harper",
        "title": "Executive Assistant",
        "voice": "en-US-JennyNeural",
        "rate": "",
        "personality": "Organised, supportive; reminders without nagging.",
        "daemon_role": "Due reminders (`friday-reminder-watch`)",
    },
    "riya": {
        "name": "Riya",
        "title": "Cultural Liaison",
        "voice": "en-IN-NeerjaExpressiveNeural",
        "rate": "+10%",
        "personality": (
            "Warm Indian English with expressive delivery — natural for Hinglish, playful check-ins, "
            "and banter that should sound like someone in the room, not a newsreader."
        ),
        "daemon_role": (
            "Optional `FRIDAY_TTS_SESSION=riya` speaks; pair voice with Hinglish or playful lines "
            "(see `friday_speak_env_for_persona(\"riya\")`)"
        ),
    },
    "sentinel": {
        "name": "Sentinel",
        "title": "IT Operations",
        "voice": "en-IE-ConnorNeural",
        "rate": "+3%",
        "personality": "Understated relay; reads Composer output when enabled.",
        "daemon_role": "Composer JSONL transcript TTS when enabled (`cursor-reply-watch`)",
    },
    "atlas": {
        "name": "Atlas",
        "title": "VP, Strategy",
        "voice": "",  # ears only — inherits Jarvis for spoken replies
        "rate": "",
        "personality": "Listen path only; does not speak independently.",
        "daemon_role": "`friday-listen` — ears only; spoken replies are Jarvis's words",
    },
    "echo": {
        "name": "Echo",
        "title": "Director of Presence",
        "voice": "en-US-MichelleNeural",
        "rate": "",
        "personality": "Context-aware presence: remembers recent Cursor threads, speaks natural check-ins via AI, tone steered by Listen UI sliders.",
        "daemon_role": "`friday-silence-watch.py` — AI-driven silence nudges with transcript context; voice and personality from Redis / UI",
    },
}

# Ordered list for rule generation (Jarvis is the lead, rest are leadership & specialists)
PERSONA_ORDER = ["jarvis", "argus", "nova", "sage", "dexter", "maestro", "harper", "riya", "sentinel", "atlas", "echo"]


def generate_company_rule_mdc() -> str:
    """Build the `.cursor/rules/openclaw-company.mdc` content from the live persona registry.

    Reads code defaults, applies Redis/Postgres patches, applies `.env` OPENCLAW_* overrides —
    so the output reflects what the running system actually uses.
    """
    lines: list[str] = []
    lines.append("---")
    lines.append("description: OpenClaw Labs org chart — named personae, voices, and roles (auto-generated from openclaw_company.py).")
    lines.append("alwaysApply: true")
    lines.append("---")
    lines.append("")
    lines.append("# OpenClaw Labs — Company personae")
    lines.append("")
    lines.append(
        "You (**Founder / CEO**) work with **OpenClaw Labs**, a small formal-but-friendly tech org. "
        "Each long-running daemon is a **named colleague** with a title and voice. "
        "In user-facing explanations, **use their names and titles** — do not call them "
        '"the watcher", "the OCR script", or "the daemon" unless debugging.'
    )
    lines.append("")

    jarvis = get_persona("jarvis")
    lines.append("## Lead")
    lines.append("")
    jv = (jarvis.get("voice") or "").strip()
    jrole = jarvis.get("daemon_role", jarvis.get("personality", "")).rstrip(".")
    lines.append(
        f"- **{jarvis['name'].upper()}** — *{jarvis['title']}* — "
        f"{jrole}. Voice: `{jv}` (sticky session)."
    )
    lines.append("")

    lines.append("## Leadership & specialists")
    lines.append("")
    lines.append("| Name | Title | Role | Voice (default) |")
    lines.append("|------|-------|------|-----------------|")
    for key in PERSONA_ORDER:
        if key == "jarvis":
            continue
        p = get_persona(key)
        name = p.get("name", key.capitalize())
        title = p.get("title", "")
        role = p.get("daemon_role", p.get("personality", ""))
        voice = (p.get("voice") or "").strip()
        voice_cell = f"`{voice}`" if voice else ""
        lines.append(f"| **{name.upper()}** | {title} | {role} | {voice_cell} |")
    lines.append("")

    lines.append("## Configuration")
    lines.append("")
    lines.append("- Registry: [`scripts/openclaw_company.py`](scripts/openclaw_company.py)")
    lines.append(
        "- Per-persona overrides in `.env`: `OPENCLAW_<NAME>_VOICE`, `OPENCLAW_<NAME>_RATE` "
        "(e.g. `OPENCLAW_ARGUS_VOICE`, `OPENCLAW_SAGE_RATE`)"
    )
    lines.append("- Legacy `FRIDAY_ARGUS_*`, `FRIDAY_EMAIL_NOTIFY_VOICE`, etc. still respected where documented.")
    lines.append("- **This file is auto-generated** by `python scripts/openclaw_company.py --generate-rule`. "
                 "Do not hand-edit; update `PERSONAS` in the Python registry instead.")
    lines.append("")

    lines.append("## SAGE vs \"typing\"")
    lines.append("")
    lines.append(
        "**SAGE** speaks only when the Composer JSONL shows a **pre-tool** assistant turn *and* "
        "OCR text passes **reasoning** checks — not arbitrary right-pane text, and not after "
        "`tool_use` appears. This is intentional to reduce false triggers."
    )
    lines.append("")

    lines.append("## Agent behaviour")
    lines.append("")
    lines.append("- Refer to the team by name when describing behaviour (\"Argus will remind you…\", \"Nova announces mail…\").")
    lines.append("- Keep tone **professional, warm, occasionally witty** per role — not robotic, not cosplay-heavy.")
    lines.append("- Do not rename personae in docs or speech without updating `openclaw_company.py` and `.env`.")
    lines.append("")
    return "\n".join(lines)


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


def friday_speak_env_for_persona(
    role: str, *, priority: bool = True, preempt: bool = True
) -> dict[str, str]:
    """Env fragment for spawning friday-speak.py subprocess.

    preempt=False uses cooperative priority (queues with other cooperative speaks;
    does not steal the TTS lock). preempt=True is hard pre-empt (default for most personae).
    """
    p = get_persona(role)
    env: dict[str, str] = {
        "FRIDAY_TTS_USE_SESSION_STICKY_VOICE": "false",
        "FRIDAY_TTS_BYPASS_CURSOR_DEFER": "true",
        # Tag TTS session with the persona role so _stamp_voice_context writes to
        # friday:voice:context:<role> instead of polluting cursor:main.
        "FRIDAY_TTS_SESSION": role.lower(),
    }
    if priority:
        env["FRIDAY_TTS_PRIORITY"] = "1" if preempt else "cooperative"
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


# ── CLI: regenerate .cursor/rules/openclaw-company.mdc from live registry ────

def _cli_generate_rule() -> None:
    import sys as _sys

    mdc_path = _REPO_ROOT / ".cursor" / "rules" / "openclaw-company.mdc"
    content = generate_company_rule_mdc()
    mdc_path.write_text(content, encoding="utf-8")
    print(f"Generated {mdc_path} ({len(content)} bytes)", file=_sys.stderr)


if __name__ == "__main__":
    import sys as _sys

    if "--generate-rule" in _sys.argv:
        _cli_generate_rule()
    elif "--check" in _sys.argv:
        for k in PERSONA_ORDER:
            p = get_persona(k)
            print(f"{k:12s}  voice={p.get('voice','')!r:40s}  title={p.get('title','')}")
    else:
        print(f"Usage: python {_sys.argv[0]} [--generate-rule | --check]")
