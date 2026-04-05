#!/usr/bin/env python3
"""
friday-silence-watch.py — ECHO (Director of Presence): context-aware, AI-driven check-ins
after silence (FRIDAY_SILENCE_IDLE_SEC, jittered). Reads last N Cursor JSONL transcripts,
generates lines via Anthropic with tunable personality (Redis openclaw:echo:config from
Listen UI PUT /settings/echo). Reserve fallback: pre-cached AI lines in Redis — no static scripts.

Uses Redis friday:tts:last_activity (stamped by friday-speak.py).

Skips while: TTS lock, friday-play, FRIDAY_SILENCE_DEFER_WHEN_CURSOR + Cursor focus, etc.

Env (see also OPENCLAW_ECHO_* and FRIDAY_SILENCE_* in .env):
  FRIDAY_SILENCE_WATCH, FRIDAY_SILENCE_IDLE_SEC, FRIDAY_SILENCE_REARM_SEC, FRIDAY_SILENCE_POLL_SEC
  FRIDAY_SILENCE_JITTER_RANGE, FRIDAY_SILENCE_CONTEXT_DEPTH, FRIDAY_SILENCE_CONTEXT_SCAN_SEC
  FRIDAY_SILENCE_MAX_NUDGES_HOUR, FRIDAY_SILENCE_USE_AI, FRIDAY_SILENCE_AI_MODEL
  FRIDAY_SILENCE_RESERVE_SIZE, ANTHROPIC_API_KEY, CURSOR_TRANSCRIPTS_DIR
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import random
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

ENV_PATH = ROOT / ".env"
if ENV_PATH.exists():
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        t = line.strip()
        if not t or t.startswith("#") or "=" not in t:
            continue
        k, _, rest = t.partition("=")
        k = k.strip()
        v = rest.split("#", 1)[0].strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v

from friday_win_focus import should_defer_ambient_for_cursor  # noqa: E402
from openclaw_company import friday_speak_env_for_persona  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("friday-silence-watch")

SPEAK_SCRIPT = ROOT / "skill-gateway" / "scripts" / "friday-speak.py"
TTS_ACTIVE_FILE = Path(tempfile.gettempdir()) / "friday-tts-active"
PLAY_PID_FILE = Path(tempfile.gettempdir()) / "friday-play.pid"

_REDIS_ACTIVITY = "friday:tts:last_activity"
_REDIS_TTS_LOCK = "friday:tts:lock"
_REDIS_REARM = "openclaw:silence_watch:last_nudge"
_REDIS_ECHO_CONFIG = "openclaw:echo:config"
_REDIS_MEMOS = "openclaw:echo:conversation_memos"
_REDIS_RESERVE = "openclaw:echo:line_reserve"
_REDIS_REFERENCED = "openclaw:echo:referenced_topics"
_REDIS_NUDGE_HOUR = "openclaw:echo:nudge_count_hour"
_REDIS_RECENT_SPOKEN = "openclaw:echo:recent_spoken_hashes"

_TRANSCRIPTS_ROOT = Path(
    os.environ.get(
        "CURSOR_TRANSCRIPTS_DIR",
        r"C:\Users\rajut\.cursor\projects\d-code-openclaw\agent-transcripts",
    )
).resolve()

_DELIVERY_STYLES: list[tuple[str, str]] = [
    ("callback", "Pick ONE thing from the recent conversations and bring it up naturally — genuine curiosity or a thought you had, not a status report."),
    ("gentle_observation", "Comment on the pattern — the quiet stretch, how long they have been focused, or the time of day. Observation, not a checklist question."),
    ("tangent", "Something from their recent work sparks a related thought. Share it like you just connected two dots."),
    ("offer_subtle", "Offer one specific, concrete thing you could check or do that ties to what they were working on — never generic."),
    ("warmth", "Pure warmth. No agenda, no ask. One or two short sentences."),
    ("playful", "Light, kind humour about the situation — late night, long slog, another refactor — never mean-spirited."),
    ("continuation", "Pick up a thread mid-thought, as if you have been mulling it since they last mentioned it."),
]

_anthropic_ok = True
_anthropic_fail_until = 0.0
_ANTHROPIC_FAIL_DELAY = 300

_r_client = None


def _env_bool(name: str, default: bool = False) -> bool:
    v = os.environ.get(name, "").strip().lower()
    if not v:
        return default
    return v in ("1", "true", "yes", "on")


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip().split("#")[0].strip()
    if not raw:
        return default
    try:
        return int(raw, 10)
    except ValueError:
        return default


def _redis_url() -> str:
    return (
        os.environ.get("OPENCLAW_REDIS_URL", "").strip()
        or os.environ.get("FRIDAY_AMBIENT_REDIS_URL", "").strip()
        or "redis://127.0.0.1:6379"
    )


def _redis():
    global _r_client
    if _r_client is not None:
        return _r_client
    try:
        import redis as redis_mod

        _r_client = redis_mod.Redis.from_url(
            _redis_url(),
            decode_responses=True,
            socket_connect_timeout=1.5,
            socket_timeout=1.5,
        )
        _r_client.ping()
    except Exception as e:
        log.warning("Redis unavailable (%s) — limited mode", e)
        _r_client = False
    return _r_client


def _house_voice_blocklist() -> set[str]:
    bl = {v.strip() for v in os.environ.get("FRIDAY_TTS_VOICE_BLOCK", "").split(",") if v.strip()}
    bl |= {
        "en-AU-WilliamNeural",
        "en-AU-WilliamMultilingualNeural",
        "en-GB-RyanNeural",
        "en-GB-ThomasNeural",
    }
    return bl


def _default_echo_config() -> dict[str, Any]:
    return {
        "humor": max(0, min(100, _env_int("OPENCLAW_ECHO_HUMOR", 40))),
        "warmth": max(0, min(100, _env_int("OPENCLAW_ECHO_WARMTH", 70))),
        "directness": max(0, min(100, _env_int("OPENCLAW_ECHO_DIRECTNESS", 50))),
        "curiosity": max(0, min(100, _env_int("OPENCLAW_ECHO_CURIOSITY", 60))),
        "formality": max(0, min(100, _env_int("OPENCLAW_ECHO_FORMALITY", 30))),
        "idleSec": max(30, _env_int("FRIDAY_SILENCE_IDLE_SEC", 120)),
        "rearmSec": max(60, _env_int("FRIDAY_SILENCE_REARM_SEC", 300)),
        "voice": (os.environ.get("OPENCLAW_ECHO_VOICE", "").strip() or "en-US-MichelleNeural"),
    }


def _get_echo_config(r) -> dict[str, Any]:
    base = _default_echo_config()
    if r and r is not False:
        try:
            raw = r.get(_REDIS_ECHO_CONFIG)
            if raw:
                o = json.loads(raw)
                if isinstance(o, dict):
                    for k in base:
                        if k in o and o[k] is not None:
                            if k == "voice" and isinstance(o[k], str) and o[k].strip():
                                base[k] = o[k].strip()[:120]
                            elif k != "voice":
                                try:
                                    n = int(float(o[k]))
                                    if k in ("idleSec", "rearmSec"):
                                        base[k] = max(30 if k == "idleSec" else 60, n)
                                    else:
                                        base[k] = max(0, min(100, n))
                                except (TypeError, ValueError):
                                    pass
        except Exception:
            pass
    bl = _house_voice_blocklist()
    if base["voice"] in bl:
        log.warning("ECHO voice %s is blocklisted — falling back to Ava multilingual", base["voice"])
        base["voice"] = "en-US-AvaMultilingualNeural"
    return base


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


def _user_text_from_line(line: str) -> str:
    try:
        obj = json.loads(line)
    except Exception:
        return ""
    if obj.get("role") != "user":
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


def _strip_user_query(raw: str, max_len: int = 400) -> str:
    t = raw.strip()
    if "<user_query>" in t:
        i = t.find("<user_query>")
        j = t.find("</user_query>")
        if j > i:
            t = t[i + 12 : j].strip()
    t = t.replace("<user_query>", "").replace("</user_query>", "")
    t = " ".join(t.split())
    if len(t) > max_len:
        t = t[: max_len - 1] + "…"
    return t


def _list_transcript_jsonl_paths() -> list[Path]:
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
    except OSError:
        pass
    return out


def _transcript_dirs_recent_count_sec(within_sec: float) -> int:
    n = 0
    now = time.time()
    try:
        for sub in _TRANSCRIPTS_ROOT.iterdir():
            if not sub.is_dir():
                continue
            try:
                if now - sub.stat().st_mtime <= within_sec:
                    n += 1
            except OSError:
                continue
    except OSError:
        pass
    return n


def _scan_transcript_memos(depth: int) -> list[dict[str, Any]]:
    paths = _list_transcript_jsonl_paths()
    paths.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    memos: list[dict[str, Any]] = []
    now = time.time()
    for jp in paths[:depth]:
        try:
            age_s = now - jp.parent.stat().st_mtime
            age_m = int(age_s // 60)
            cid = jp.parent.name
            first_user = ""
            first_asst = ""
            n = 0
            with jp.open(encoding="utf-8", errors="replace") as f:
                for line in f:
                    if not first_user:
                        u = _user_text_from_line(line)
                        if u:
                            first_user = _strip_user_query(u)
                    if not first_asst:
                        a = _assistant_text_from_line(line)
                        if a:
                            first_asst = a[:320] + ("…" if len(a) > 320 else "")
                    n += 1
                    if n > 400 and first_user and first_asst:
                        break
            if not first_user and not first_asst:
                continue
            topic_h = hashlib.sha256((first_user or first_asst or cid).encode("utf-8", errors="replace")).hexdigest()[:16]
            memos.append(
                {
                    "chat_id": cid,
                    "age_minutes": age_m,
                    "user_line": first_user or "(image or attachment)",
                    "assistant_snippet": first_asst,
                    "topic_key": topic_h,
                }
            )
        except OSError:
            continue
    return memos


def _store_memos_redis(r, memos: list[dict[str, Any]]) -> None:
    if not r or r is False:
        return
    try:
        r.setex(_REDIS_MEMOS, 86400, json.dumps(memos, ensure_ascii=False))
    except Exception:
        pass


def _load_memos_redis(r) -> list[dict[str, Any]]:
    if not r or r is False:
        return []
    try:
        raw = r.get(_REDIS_MEMOS)
        if not raw:
            return []
        o = json.loads(raw)
        return o if isinstance(o, list) else []
    except Exception:
        return []


def _personality_prompt(cfg: dict[str, Any]) -> str:
    h, w, d, c, f = cfg["humor"], cfg["warmth"], cfg["directness"], cfg["curiosity"], cfg["formality"]
    parts = []
    if h < 25:
        parts.append("Keep tone earnest; humour is rare and very understated.")
    elif h < 55:
        parts.append("A touch of dry wit when it fits — do not force jokes.")
    elif h < 80:
        parts.append("Find a light, human angle often; playful but never cruel.")
    else:
        parts.append("Lean into comedic instinct — sharp, warm, surprising beats where natural.")

    if w < 35:
        parts.append("Stay matter-of-fact; avoid mushy warmth.")
    elif w < 65:
        parts.append("Naturally friendly, not performative.")
    else:
        parts.append("Genuinely warm — they should feel you care how they are doing.")

    if d < 35:
        parts.append("Hint and suggest; avoid blunt call-outs.")
    elif d < 70:
        parts.append("Clear and direct when it helps; no corporate hedging.")
    else:
        parts.append("Say what you mean plainly; respectful but blunt.")

    if c < 35:
        parts.append("Almost no questions — statements and observations only.")
    elif c < 70:
        parts.append("At most one small curious question if it feels organic.")
    else:
        parts.append("Curious mind — wonder aloud, invite reflection with light questions.")

    if f < 35:
        parts.append("Very casual — contractions, relaxed rhythm.")
    elif f < 70:
        parts.append("Professional-casual; no stiffness.")
    else:
        parts.append("Polished and composed — still human, not robotic.")

    return " ".join(parts)


def _time_feel_local() -> str:
    import time as _t

    h = _t.localtime().tm_hour
    if 5 <= h < 12:
        return "morning"
    if 12 <= h < 17:
        return "afternoon"
    if 17 <= h < 21:
        return "evening"
    if h >= 23 or h < 5:
        return "late night"
    return "evening"


def _idle_multiplier_time_of_day() -> float:
    h = time.localtime().tm_hour
    if h >= 23 or h < 5:
        return 1.5
    if h < 8:
        return 2.0
    return 1.0


def _idle_multiplier_activity(transcripts_touched_1h: int) -> float:
    if transcripts_touched_1h >= 5:
        return 2.0
    if transcripts_touched_1h <= 1:
        return 0.9
    return 1.0


def _jittered_idle_sec(base: int, jitter_range: int) -> float:
    if jitter_range <= 0:
        return float(base)
    return float(base) + random.uniform(-jitter_range, jitter_range)


def _jittered_rearm_sec(rearm: float) -> int:
    j = rearm * random.uniform(0.82, 1.18)
    return max(60, int(j))


def _hourly_nudge_allowed(r, cap: int) -> bool:
    if cap <= 0:
        return True
    if not r or r is False:
        return True
    try:
        n = r.incr(_REDIS_NUDGE_HOUR)
        if n == 1:
            r.expire(_REDIS_NUDGE_HOUR, 3600)
        return n <= cap
    except Exception:
        return True


def _topic_already_used(r, topic_key: str) -> bool:
    if not r or r is False or not topic_key:
        return False
    try:
        return bool(r.sismember(_REDIS_REFERENCED, topic_key))
    except Exception:
        return False


def _mark_topic_used(r, topic_key: str) -> None:
    if not r or r is False or not topic_key:
        return
    try:
        r.sadd(_REDIS_REFERENCED, topic_key)
        r.expire(_REDIS_REFERENCED, 86400 * 7)
    except Exception:
        pass


def _line_is_duplicate(r, text: str) -> bool:
    if not r or r is False or not text.strip():
        return False
    h = hashlib.sha256(text.strip().encode("utf-8", errors="ignore")).hexdigest()
    try:
        recent = r.lrange(_REDIS_RECENT_SPOKEN, 0, 39)
        return h in recent
    except Exception:
        return False


def _record_spoken_line(r, text: str) -> None:
    if not r or r is False or not text.strip():
        return
    h = hashlib.sha256(text.strip().encode("utf-8", errors="ignore")).hexdigest()
    try:
        r.lpush(_REDIS_RECENT_SPOKEN, h)
        r.ltrim(_REDIS_RECENT_SPOKEN, 0, 39)
        r.expire(_REDIS_RECENT_SPOKEN, 86400 * 3)
    except Exception:
        pass


def _load_anthropic():
    try:
        import anthropic

        return anthropic
    except ImportError:
        return None


def _generate_line_ai(
    memos: list[dict[str, Any]],
    idle_minutes: float,
    delivery_name: str,
    delivery_instruction: str,
    cfg: dict[str, Any],
    *,
    reserve_mode: bool = False,
) -> tuple[str, str]:
    """Returns (line, topic_key used)."""
    global _anthropic_ok, _anthropic_fail_until
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    model = os.environ.get("FRIDAY_SILENCE_AI_MODEL", "claude-haiku-4-5").strip()
    use_ai = _env_bool("FRIDAY_SILENCE_USE_AI", True)
    mod = _load_anthropic() if key else None
    now = time.time()
    if not use_ai or not key or mod is None:
        return "", ""
    if not _anthropic_ok and now < _anthropic_fail_until:
        return "", ""

    user_name = os.environ.get("FRIDAY_USER_NAME", "").strip() or "they"
    pers = _personality_prompt(cfg)
    r0 = _redis()
    ctx_lines = []
    picked_topic = ""
    pool = list(memos[:6])
    for i, m in enumerate(pool, 1):
        if _topic_already_used(r0, m.get("topic_key") or ""):
            continue
        ul = (m.get("user_line") or "").strip()
        if ul:
            ctx_lines.append(f"{i}. [{m.get('age_minutes', '?')} min ago] {ul[:280]}")
            if not picked_topic:
                picked_topic = m.get("topic_key") or ""
        if len(ctx_lines) >= 5:
            break
    if not ctx_lines and pool:
        for i, m in enumerate(pool, 1):
            ul = (m.get("user_line") or "").strip()
            if ul:
                ctx_lines.append(f"{i}. [{m.get('age_minutes', '?')} min ago] {ul[:280]}")
            if len(ctx_lines) >= 5:
                break
    ctx_block = "\n".join(ctx_lines) if ctx_lines else "(No recent user messages in scanned transcripts — improvise from quiet stretch and time of day only.)"

    system = (
        "You are Echo — Director of Presence at OpenClaw Labs. You sit nearby; you notice when "
        "the room goes quiet. You remember conversational threads and bring them up like a perceptive colleague. "
        "You are NOT a generic assistant. Do not offer a menu of services. No 'I can help with' lists.\n\n"
        f"Personality steering: {pers}\n\n"
        f"DELIVERY MODE ({delivery_name}): {delivery_instruction}\n\n"
        "ABSOLUTE RULES:\n"
        f"- Never start with the user's real name ({user_name}) if it looks like a name — use 'you' or no address.\n"
        "- Never start with 'I' as the very first word.\n"
        "- No markdown, no bullet points, no emojis.\n"
        "- One paragraph only, 15–50 words unless reserve_mode asks shorter.\n"
        "- Sound mid-thought, not like a timer fired.\n"
    )
    if reserve_mode:
        system += "- Reserve line: keep it 18–40 words; still specific if context exists.\n"

    user_msg = (
        f"Recent conversation snippets (newest listed first):\n{ctx_block}\n\n"
        f"The room has been quiet about {idle_minutes:.1f} minutes. "
        f"Time of day feel: {_time_feel_local()}. "
        "Write ONE check-in line for text-to-speech."
    )

    try:
        client = mod.Anthropic(api_key=key)
        msg = client.messages.create(
            model=model,
            max_tokens=220,
            temperature=0.88,
            system=system,
            messages=[{"role": "user", "content": user_msg}],
        )
        text = ""
        for block in msg.content:
            if hasattr(block, "text"):
                text += block.text
        line = " ".join(text.strip().split())
        if len(line) > 420:
            line = line[:417] + "…"
        _anthropic_ok = True
        return line, picked_topic
    except Exception as e:
        log.warning("Anthropic ECHO generation failed: %s", e)
        _anthropic_ok = False
        _anthropic_fail_until = now + _ANTHROPIC_FAIL_DELAY
        return "", ""


def _push_reserve(r, line: str, ctx_hash: str) -> None:
    if not r or r is False or not line.strip():
        return
    cap = max(1, min(12, _env_int("FRIDAY_SILENCE_RESERVE_SIZE", 5)))
    try:
        entry = json.dumps({"line": line.strip(), "ts": time.time(), "ctx": ctx_hash}, ensure_ascii=False)
        r.lpush(_REDIS_RESERVE, entry)
        r.ltrim(_REDIS_RESERVE, 0, cap - 1)
        r.expire(_REDIS_RESERVE, 6 * 3600)
    except Exception:
        pass


def _pop_reserve(r) -> tuple[str, str]:
    if not r or r is False:
        return "", ""
    max_stale = 6 * 3600
    try:
        while True:
            raw = r.rpop(_REDIS_RESERVE)
            if not raw:
                return "", ""
            try:
                o = json.loads(raw)
            except Exception:
                continue
            line = (o.get("line") or "").strip()
            ts = float(o.get("ts") or 0)
            if time.time() - ts > max_stale:
                continue
            return line, str(o.get("ctx") or "")
    except Exception:
        return "", ""


def _refill_reserve_async(memories_snapshot: list[dict[str, Any]], cfg: dict[str, Any]) -> None:
    def _run() -> None:
        r = _redis()
        if not r or r is False:
            return
        styles = list(_DELIVERY_STYLES)
        random.shuffle(styles)
        for name, instr in styles[:2]:
            line, _tk = _generate_line_ai(memories_snapshot, 2.0, name, instr, cfg, reserve_mode=True)
            if line and not _line_is_duplicate(r, line):
                h = hashlib.sha256(json.dumps(memories_snapshot[:2], sort_keys=True).encode()).hexdigest()[:12]
                _push_reserve(r, line, h)

    threading.Thread(target=_run, daemon=True).start()


def _resolve_speak_env(cfg: dict[str, Any]) -> dict[str, str]:
    env = os.environ.copy()
    env.update(friday_speak_env_for_persona("echo", priority=True))
    voice = (cfg.get("voice") or "").strip()
    if voice and voice not in _house_voice_blocklist():
        env["FRIDAY_TTS_VOICE"] = voice
    env["FRIDAY_TTS_USE_SESSION_STICKY_VOICE"] = "false"
    log.info("ECHO speak voice=%s", env.get("FRIDAY_TTS_VOICE", ""))
    return env


def _tts_active_file() -> bool:
    if not TTS_ACTIVE_FILE.exists():
        return False
    try:
        age = time.time() - TTS_ACTIVE_FILE.stat().st_mtime
        return age < 120
    except OSError:
        return False


def _play_running() -> bool:
    if not PLAY_PID_FILE.exists():
        return False
    try:
        pid = int(PLAY_PID_FILE.read_text().strip())
        if sys.platform == "win32":
            import ctypes

            k32 = ctypes.windll.kernel32
            h = k32.OpenProcess(0x1000, False, pid)
            if not h:
                return False
            k32.CloseHandle(h)
            return True
        os.kill(pid, 0)
        return True
    except (ValueError, OSError, ProcessLookupError):
        return False


def _redis_tts_lock_held() -> bool:
    r = _redis()
    if not r or r is False:
        return False
    try:
        return bool(r.exists(_REDIS_TTS_LOCK))
    except Exception:
        return False


def _last_activity_ts(r, watch_started: float) -> float:
    if not r or r is False:
        return watch_started
    try:
        raw = r.get(_REDIS_ACTIVITY)
        if raw:
            return float(raw)
    except Exception:
        pass
    return watch_started


def main() -> None:
    if not _env_bool("FRIDAY_SILENCE_WATCH", True):
        log.info("FRIDAY_SILENCE_WATCH off — exiting")
        sys.exit(0)

    poll_sec = max(3, _env_int("FRIDAY_SILENCE_POLL_SEC", 10))
    jitter_range = max(0, _env_int("FRIDAY_SILENCE_JITTER_RANGE", 30))
    depth = max(1, min(12, _env_int("FRIDAY_SILENCE_CONTEXT_DEPTH", 3)))
    scan_interval = max(15, _env_int("FRIDAY_SILENCE_CONTEXT_SCAN_SEC", 120))
    max_hour = max(0, _env_int("FRIDAY_SILENCE_MAX_NUDGES_HOUR", 6))
    defer_cursor = _env_bool("FRIDAY_SILENCE_DEFER_WHEN_CURSOR", True)
    narration_on = _env_bool("FRIDAY_CURSOR_NARRATION", True)
    silence_requires_narration = _env_bool("FRIDAY_SILENCE_REQUIRES_NARRATION", False)

    if not SPEAK_SCRIPT.is_file():
        log.error("friday-speak.py missing at %s", SPEAK_SCRIPT)
        sys.exit(1)

    watch_started = time.time()
    last_nudge_local = 0.0
    last_scan = 0.0
    memos_cache: list[dict[str, Any]] = []

    log.info(
        "ECHO (Director of Presence) v2 — poll=%ds depth=%d transcripts=%s",
        poll_sec,
        depth,
        _TRANSCRIPTS_ROOT,
    )

    if silence_requires_narration and not narration_on:
        log.info("FRIDAY_SILENCE_REQUIRES_NARRATION on and FRIDAY_CURSOR_NARRATION off — no idle nudges")

    while True:
        time.sleep(poll_sec)

        if silence_requires_narration and not narration_on:
            continue

        if defer_cursor and should_defer_ambient_for_cursor():
            continue

        if _tts_active_file() or _play_running() or _redis_tts_lock_held():
            continue

        r = _redis()
        cfg = _get_echo_config(r)
        idle_sec = int(cfg["idleSec"])
        rearm_sec = float(cfg["rearmSec"])

        if r and r is not False:
            try:
                if r.exists(_REDIS_REARM):
                    continue
            except Exception:
                pass
        if (time.time() - last_nudge_local) < rearm_sec * 0.95:
            continue

        now = time.time()
        if now - last_scan >= scan_interval:
            memos_cache = _scan_transcript_memos(depth)
            _store_memos_redis(r, memos_cache)
            last_scan = now
        else:
            memos_cache = _load_memos_redis(r) or memos_cache

        transcripts_1h = _transcript_dirs_recent_count_sec(3600)
        eff_idle = _jittered_idle_sec(idle_sec, jitter_range)
        eff_idle *= _idle_multiplier_time_of_day()
        eff_idle *= _idle_multiplier_activity(transcripts_1h)

        base = _last_activity_ts(r, watch_started)
        idle = time.time() - base
        if idle < eff_idle:
            continue

        style = random.choice(_DELIVERY_STYLES)
        line, topic_key = _generate_line_ai(
            memos_cache,
            idle / 60.0,
            style[0],
            style[1],
            cfg,
            reserve_mode=False,
        )
        if not line.strip():
            line, rk = _pop_reserve(r)
            topic_key = rk or topic_key

        if not line.strip():
            log.warning("No ECHO line (AI unavailable and reserve empty)")
            continue

        if _line_is_duplicate(r, line):
            log.debug("Skip duplicate ECHO line hash")
            continue

        if max_hour > 0 and not _hourly_nudge_allowed(r, max_hour):
            log.debug("Hourly ECHO nudge cap reached — skipping this cycle")
            continue

        speak_env = _resolve_speak_env(cfg)
        try:
            proc = subprocess.Popen(
                [sys.executable, str(SPEAK_SCRIPT), line],
                cwd=str(ROOT),
                env=speak_env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except OSError as e:
            log.warning("Could not spawn friday-speak: %s", e)
            continue

        last_nudge_local = time.time()
        rearm_effective = _jittered_rearm_sec(rearm_sec)
        if proc.pid and r and r is not False:
            try:
                r.set(_REDIS_REARM, "1", ex=rearm_effective)
            except Exception:
                pass
        if topic_key:
            _mark_topic_used(r, topic_key)
        _record_spoken_line(r, line)
        log.info("Idle %.0fs — ECHO nudge (pid=%s)", idle, proc.pid)

        _refill_reserve_async(list(memos_cache), dict(cfg))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log.info("Stopped.")
