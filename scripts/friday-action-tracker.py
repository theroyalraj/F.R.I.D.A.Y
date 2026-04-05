#!/usr/bin/env python3
"""
friday-action-tracker.py — Cross-channel action tracker: Gmail + WhatsApp (Evolution),
Claude extraction, Postgres dedup, friendly spoken reminders on a fixed interval.

Env (see .env):
  FRIDAY_TRACKER_ENABLED       master switch (default true when script runs)
  OPENCLAW_DATABASE_URL        Postgres (required)
  ANTHROPIC_API_KEY            Claude API
  FRIDAY_TRACKER_POLL_SEC      default 900 (15 min)
  FRIDAY_TRACKER_MODEL         default claude-haiku-4-5
  FRIDAY_TRACKER_MAX_BATCH     messages per extraction call (default 10)
  FRIDAY_TRACKER_GMAIL_LOOKBACK_DAYS   default 3
  FRIDAY_TRACKER_WHATSAPP_SUMMARY    send text to WHATSAPP_NOTIFY_NUMBER (default true)
  FRIDAY_TRACKER_QUIET_START / FRIDAY_TRACKER_QUIET_END  optional 24h local hours
  FRIDAY_TRACKER_LISTEN_SEC    mic window after check-in prompt (default 12)
  FRIDAY_TRACKER_CHECKIN_PROMPT optional override for the yes or no question line

CLI:
  python scripts/friday-action-tracker.py --once              one cycle then exit
  python scripts/friday-action-tracker.py --once --skip-ingestion   only check-in + briefing (no Gmail/WhatsApp fetch)
"""
from __future__ import annotations

import email
import email.header
import hashlib
import imaplib
import io
import json
import logging
import os
import platform
import subprocess
import sys
import tempfile
import textwrap
import time
import urllib.error
import urllib.request
import wave
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime
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

_SPEAK_SCRIPT = _REPO_ROOT / "skill-gateway" / "scripts" / "friday-speak.py"

try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    print("[action-tracker] Install deps: pip install -r scripts/requirements-action-tracker.txt", file=sys.stderr)
    sys.exit(1)

_log = logging.getLogger("action-tracker")


def _env_bool(key: str, default: bool = True) -> bool:
    raw = os.environ.get(key, "").strip().lower()
    if raw == "":
        return default
    return raw in ("1", "true", "yes", "on")


def _env_int(key: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(key, "").split("#")[0].strip() or default))
    except ValueError:
        return default


def _env_float(key: str, default: float) -> float:
    try:
        return float(os.environ.get(key, "").split("#")[0].strip() or default)
    except ValueError:
        return default


TRACKER_ON = _env_bool("FRIDAY_TRACKER_ENABLED", True)
POLL_SEC = max(60, _env_int("FRIDAY_TRACKER_POLL_SEC", 900))
MODEL = os.environ.get("FRIDAY_TRACKER_MODEL", "claude-haiku-4-5").strip()
MAX_BATCH = max(1, min(25, _env_int("FRIDAY_TRACKER_MAX_BATCH", 10)))
LOOKBACK_DAYS = max(1, _env_int("FRIDAY_TRACKER_GMAIL_LOOKBACK_DAYS", 3))
WA_SUMMARY = _env_bool("FRIDAY_TRACKER_WHATSAPP_SUMMARY", True)

GMAIL_ADDRESS = os.environ.get("GMAIL_ADDRESS", "").strip()
GMAIL_APP_PWD = os.environ.get("GMAIL_APP_PWD", "").strip().replace(" ", "")
GMAIL_FOLDERS = [f.strip() for f in os.environ.get("FRIDAY_EMAIL_FOLDERS", "INBOX").split(",") if f.strip()]

EVOLUTION_KEY = os.environ.get("EVOLUTION_API_KEY", "").strip()
EVOLUTION_INST = os.environ.get("EVOLUTION_INSTANCE", "openclaw").strip()
EVOLUTION_PORT = os.environ.get("EVOLUTION_PORT", "8181").strip()
WHATSAPP_NOTIFY = os.environ.get("WHATSAPP_NOTIFY_NUMBER", "").strip().replace("+", "").replace(" ", "")

DB_URL = os.environ.get("OPENCLAW_DATABASE_URL", "").strip()
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()

USER_NAME = os.environ.get("FRIDAY_USER_NAME", "Raj").strip() or "Raj"
USER_CITY = os.environ.get("FRIDAY_USER_CITY", "").strip()
USER_TZ = os.environ.get("FRIDAY_USER_TZ", os.environ.get("TZ", "UTC")).strip() or "UTC"

QUIET_START = os.environ.get("FRIDAY_TRACKER_QUIET_START", "").strip()
QUIET_END = os.environ.get("FRIDAY_TRACKER_QUIET_END", "").strip()
TRACKER_LISTEN_SEC = max(3.0, _env_float("FRIDAY_TRACKER_LISTEN_SEC", 12.0))
SAMPLE_RATE = 16000
CHANNELS = 1
TTS_ACTIVE_FILE = Path(tempfile.gettempdir()) / "friday-tts-active"


def _ensure_speaker_path() -> None:
    for p in (_REPO_ROOT / "scripts", _REPO_ROOT / "skill-gateway" / "scripts"):
        s = str(p)
        if s not in sys.path:
            sys.path.insert(0, s)


def _wait_for_tts_clear(timeout: float = 30.0) -> None:
    deadline = time.time() + timeout
    while TTS_ACTIVE_FILE.exists():
        try:
            age = time.time() - TTS_ACTIVE_FILE.stat().st_mtime
            if age > 120:
                TTS_ACTIVE_FILE.unlink(missing_ok=True)
                break
        except OSError:
            break
        if time.time() > deadline:
            break
        time.sleep(0.2)


def _interpret_yes_no(transcript: str | None) -> str:
    """Return 'yes' or 'no'. Unknown / empty / mic failure callers should use 'yes' (user default)."""
    if not transcript:
        return "yes"
    t = transcript.lower().strip()
    yes_w = (
        "yes",
        "yeah",
        "yep",
        "sure",
        "please",
        "go ahead",
        "ok",
        "okay",
        "alright",
        "read",
        "tell me",
        "yup",
    )
    no_w = ("no", "nope", "nah", "skip", "not now", "later", "don't", "dont", "nothing", "pass")
    has_yes = any(x in t for x in yes_w)
    has_no = any(x in t for x in no_w)
    if has_no and not has_yes:
        return "no"
    if has_yes and has_no:
        return "yes"
    if t in ("n",):
        return "no"
    if t in ("y",):
        return "yes"
    return "yes"


def _numpy_to_audio_data(audio_int16, sr_recognizer) -> object:
    import speech_recognition as sr

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(audio_int16.tobytes())
    raw = buf.getvalue()
    return sr.AudioData(raw[44:], SAMPLE_RATE, 2)


def _record_after_tracker_prompt(mic_idx: int | None) -> object | None:
    """Wait for speech within TRACKER_LISTEN_SEC, then record until silence (same idea as friday-notify-followup-listen)."""
    import numpy as np
    import sounddevice as sd

    try:
        import speech_recognition as sr
    except ImportError:
        return None

    BLOCK = int(SAMPLE_RATE * 0.1)
    threshold = float(os.environ.get("LISTEN_ENERGY_THRESHOLD", "300"))
    silence_sec = float(os.environ.get("LISTEN_SILENCE_SEC", "1.2"))
    phrase_limit = float(os.environ.get("LISTEN_PHRASE_LIMIT", "8"))
    max_chunks = int(phrase_limit / 0.1)
    silence_chunks = max(1, int(silence_sec / 0.1))
    kwargs = {"device": mic_idx} if mic_idx is not None else {}
    listen_deadline = time.monotonic() + max(1.0, TRACKER_LISTEN_SEC)

    try:
        stream_ctx = sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=CHANNELS,
            dtype="int16",
            blocksize=BLOCK,
            **kwargs,
        )
    except Exception as e:
        _log.warning("Mic open failed: %s", e)
        return None

    chunks: list = []
    silent = 0
    chunks_since_speech = 0

    with stream_ctx as stream:
        while time.monotonic() < listen_deadline:
            block, _ = stream.read(BLOCK)
            block = block.flatten()
            rms = float(np.sqrt(np.mean(block.astype(np.float32) ** 2)))
            if rms > threshold:
                chunks = [block]
                chunks_since_speech = 1
                silent = 0
                break
        else:
            return None

        while chunks_since_speech < max_chunks:
            block, _ = stream.read(BLOCK)
            block = block.flatten()
            rms = float(np.sqrt(np.mean(block.astype(np.float32) ** 2)))
            if rms > threshold:
                silent = 0
                chunks.append(block)
                chunks_since_speech += 1
            else:
                chunks.append(block)
                chunks_since_speech += 1
                silent += 1
                if silent >= silence_chunks:
                    break

    if not chunks:
        return None
    return np.concatenate(chunks)


def _mic_index() -> int | None:
    raw = os.environ.get("LISTEN_DEVICE_INDEX")
    if not raw:
        return None
    try:
        return int(raw.split("#")[0].strip())
    except ValueError:
        return None


def _prompt_listen_yes_no() -> str:
    """Speak check-in question, listen for yes or no. Mic or STT failure → yes."""
    os.environ["FRIDAY_DEFER_WHEN_CURSOR"] = "false"
    _ensure_speaker_path()
    try:
        from friday_speaker import speaker
    except ImportError:
        _log.warning("friday_speaker missing → default yes")
        return "yes"

    custom = (os.environ.get("FRIDAY_TRACKER_CHECKIN_PROMPT") or "").strip()
    n = int(round(TRACKER_LISTEN_SEC))
    if custom:
        prompt = custom
    else:
        prompt = (
            f"Hey {USER_NAME}, time for your fifteen-minute check-in. "
            f"Want me to read your action plan for today? Say yes or no — I am listening for about {n} seconds."
        )

    _wait_for_tts_clear(45.0)
    try:
        speaker.speak_blocking(
            prompt,
            priority=True,
            bypass_cursor_defer=True,
            interrupt_music=True,
            use_session_sticky=True,
            timeout=120.0,
        )
    except Exception as e:
        _log.warning("Check-in speak failed: %s → default yes", e)
        return "yes"
    time.sleep(0.35)
    _wait_for_tts_clear(20.0)

    try:
        import numpy as np  # noqa: F401
        import sounddevice as sd  # noqa: F401
        import speech_recognition as sr
    except ImportError:
        _log.warning("Listen deps missing (numpy, sounddevice, SpeechRecognition) → default yes")
        return "yes"

    audio = _record_after_tracker_prompt(_mic_index())
    if audio is None:
        _log.info("No speech in listen window → default yes")
        return "yes"

    recognizer = sr.Recognizer()
    try:
        audio_data = _numpy_to_audio_data(audio, recognizer)
        lang = os.environ.get("LISTEN_LANGUAGE", "en-US")
        text = recognizer.recognize_google(audio_data, language=lang)
    except sr.UnknownValueError:
        _log.info("Could not understand reply → default yes")
        return "yes"
    except sr.RequestError as e:
        _log.warning("STT error %s → default yes", e)
        return "yes"

    text = (text or "").strip()
    _log.info("Heard: %s", text[:120])
    return _interpret_yes_no(text)


def _fetch_briefing_payload(conn) -> tuple[list[dict], list[dict]]:
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            SELECT id, title, detail, priority, category, source, due_natural, created_at
            FROM action_items
            WHERE status = 'pending'
            ORDER BY
              CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
              created_at DESC
            LIMIT 30
            """
        )
        actions = [dict(r) for r in cur.fetchall()]
        cur.execute(
            """
            SELECT id, title, detail, priority, source, created_at
            FROM todos
            WHERE NOT done
            ORDER BY created_at DESC
            LIMIT 30
            """
        )
        todos = [dict(r) for r in cur.fetchall()]
    return actions, todos


def _local_today_context() -> str:
    try:
        from zoneinfo import ZoneInfo

        tz = ZoneInfo(USER_TZ)
        now = datetime.now(tz)
        return f"{now.strftime('%A')}, {now.strftime('%B')} {now.day}, {now.year} ({USER_TZ})"
    except Exception:
        return datetime.utcnow().strftime("%Y-%m-%d UTC")


def _briefing_template_plain(actions: list[dict], todos: list[dict]) -> str:
    if not actions and not todos:
        return (
            f"{USER_NAME}, you are all clear — no pending action items and no open todos on the list for today. "
            f"Nice one."
        )
    parts = [f"{USER_NAME}, here is your plan for today."]
    if actions:
        parts.append(
            "Pending actions: " + "; ".join(a.get("title", "") for a in actions[:12] if a.get("title"))
        )
    if todos:
        parts.append("Open todos: " + "; ".join(t.get("title", "") for t in todos[:12] if t.get("title")))
    return " ".join(parts)


def _briefing_spoken_text(actions: list[dict], todos: list[dict]) -> str:
    if not actions and not todos:
        return _briefing_template_plain([], [])
    if not ANTHROPIC_KEY:
        return _briefing_template_plain(actions, todos)

    today = _local_today_context()
    system = f"""You are Friday, {USER_NAME}'s assistant. Output ONE short paragraph for text-to-speech only.
Rules: no markdown, no bullets, no symbols that sound wrong spoken. Spell out numbers if few. Warm and clear.
Today is {today}. Summarize what they should focus on today from the lists. If an item has a due hint, mention it naturally.
Keep under eight sentences unless the list is huge — then hit the top priorities first."""
    payload = {
        "pending_actions": [
            {
                "title": a.get("title"),
                "detail": (a.get("detail") or "")[:200],
                "priority": a.get("priority"),
                "due": a.get("due_natural"),
                "source": a.get("source"),
            }
            for a in actions
        ],
        "open_todos": [
            {"title": t.get("title"), "detail": (t.get("detail") or "")[:200], "priority": t.get("priority")}
            for t in todos
        ],
    }
    user = json.dumps(payload, ensure_ascii=False)
    raw = _call_claude(system, user, max_tokens=700)
    if not raw:
        return _briefing_template_plain(actions, todos)
    return raw.replace("*", "").replace("#", "").strip()


def _decode_header(raw: str) -> str:
    parts = email.header.decode_header(raw or "")
    out = []
    for part, enc in parts:
        if isinstance(part, bytes):
            out.append(part.decode(enc or "utf-8", errors="replace"))
        else:
            out.append(str(part))
    return "".join(out)


def _extract_sender(from_header: str) -> str:
    d = _decode_header(from_header)
    if "<" in d:
        n = d.split("<")[0].strip().strip('"').strip("'")
        if n:
            return n
    return d.split("@")[0] if "@" in d else d


def _title_hash(title: str) -> str:
    n = " ".join((title or "").lower().split())
    return hashlib.sha256(n.encode("utf-8")).hexdigest()


def db_connect():
    if not DB_URL:
        raise RuntimeError("OPENCLAW_DATABASE_URL not set")
    return psycopg2.connect(DB_URL)


def db_scanned(cur, source: str, msg_id: str) -> bool:
    cur.execute(
        "SELECT 1 FROM message_scan_log WHERE source = %s AND source_message_id = %s LIMIT 1",
        (source, msg_id),
    )
    return cur.fetchone() is not None


def db_log_scan(cur, source: str, msg_id: str, action_count: int, snippet: str | None) -> None:
    cur.execute(
        """
        INSERT INTO message_scan_log (source, source_message_id, action_count, raw_snippet)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT (source, source_message_id) DO UPDATE SET
          scanned_at = now(), action_count = EXCLUDED.action_count,
          raw_snippet = EXCLUDED.raw_snippet
        """,
        (source, msg_id, action_count, (snippet or "")[:2000] or None),
    )


def db_hash_exists_pending(cur, th: str) -> bool:
    cur.execute(
        "SELECT 1 FROM action_items WHERE title_hash = %s AND status = %s LIMIT 1",
        (th, "pending"),
    )
    return cur.fetchone() is not None


def db_insert_action(cur, row: dict) -> None:
    cur.execute(
        """
        INSERT INTO action_items (
          title, detail, title_hash, category, priority, status, source,
          source_message_id, source_sender, source_subject, due_at, due_natural, metadata
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
        """,
        (
            row["title"],
            row.get("detail"),
            row["title_hash"],
            row.get("category", "general"),
            row.get("priority", "medium"),
            "pending",
            row["source"],
            row.get("source_message_id"),
            row.get("source_sender"),
            row.get("source_subject"),
            row.get("due_at"),
            row.get("due_natural"),
            json.dumps(row.get("metadata") or {}),
        ),
    )


def db_open_action_titles(cur) -> list[str]:
    cur.execute(
        "SELECT title FROM action_items WHERE status = %s ORDER BY created_at DESC LIMIT 40",
        ("pending",),
    )
    return [r[0] for r in cur.fetchall()]


def db_bump_reminders(cur, ids: list[str]) -> None:
    for uid in ids:
        cur.execute(
            """
            UPDATE action_items
            SET last_reminded_at = now(), remind_count = remind_count + 1, updated_at = now()
            WHERE id = %s::uuid
            """,
            (uid,),
        )


def _quiet_now() -> bool:
    if not QUIET_START or not QUIET_END:
        return False
    try:
        from zoneinfo import ZoneInfo

        tz = ZoneInfo(USER_TZ)
        h = datetime.now(tz).hour
        qs = int(QUIET_START)
        qe = int(QUIET_END)
        if qs == qe:
            return False
        if qs > qe:
            return h >= qs or h < qe
        return qs <= h < qe
    except Exception:
        return False


def _call_claude(system: str, user: str, max_tokens: int = 2048) -> str:
    if not ANTHROPIC_KEY:
        return ""
    body = json.dumps(
        {
            "model": MODEL,
            "max_tokens": max_tokens,
            "system": system,
            "messages": [{"role": "user", "content": user}],
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        headers={
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return (data.get("content") or [{}])[0].get("text", "").strip()
    except Exception as e:
        print(f"[action-tracker] Claude API error: {e}", file=sys.stderr)
        return ""


def _extract_actions_batch(messages: list[dict], open_titles: list[str]) -> list[dict]:
    """Return list of action dicts ready for insert (without title_hash)."""
    if not messages or not ANTHROPIC_KEY:
        return []
    ctx = f"User name: {USER_NAME}."
    if USER_CITY:
        ctx += f" City: {USER_CITY}. Timezone: {USER_TZ}."
    open_list = "\n".join(f"- {t}" for t in open_titles[:35]) if open_titles else "(none)"
    system = f"""You are an executive assistant. {ctx}

You receive a JSON array of inbound messages. Each has: source, message_id, sender, subject_or_chat, body, received_at.

Task:
1. For each message, extract ZERO or more concrete action items for {USER_NAME} (things they should do, reply to, prepare, pay, schedule, follow up).
2. Do NOT duplicate an existing open action (list below). Merge or skip if the same obligation already exists.
3. source_message_id MUST exactly equal the message_id from that message in the input (do not invent ids).
4. Output ONLY valid JSON (no markdown fences) with this shape:
{{"actions":[
  {{"source":"gmail|whatsapp","source_message_id":"string","source_sender":"string","source_subject":"string",
    "title":"short actionable title","detail":"optional","category":"general|email-reply|meeting-prep|purchase|follow-up|personal|work",
    "priority":"critical|high|medium|low","due_natural":"optional human due hint","due_iso":"YYYY-MM-DDTHH:MM:SSZ or null"}} 
]}}

Rules:
- Skip newsletters, automated receipts with no action, pure FYI.
- Titles must be speakable and specific.
- priority: critical only for true urgency or hard deadlines mentioned.

Existing open action titles (do not duplicate):
{open_list}
"""
    user = json.dumps({"messages": messages}, ensure_ascii=False)
    raw = _call_claude(system, user, max_tokens=4096)
    if not raw:
        return []
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        print(f"[action-tracker] bad JSON from Claude: {raw[:200]}", file=sys.stderr)
        return []
    actions = data.get("actions") if isinstance(data, dict) else None
    if not isinstance(actions, list):
        return []
    out = []
    for a in actions:
        if not isinstance(a, dict):
            continue
        t = (a.get("title") or "").strip()
        if not t:
            continue
        src = a.get("source") or "unknown"
        mid = str(a.get("source_message_id") or "").strip()
        if not mid:
            continue
        due_at = None
        if a.get("due_iso"):
            try:
                due_at = datetime.fromisoformat(str(a["due_iso"]).replace("Z", "+00:00"))
            except ValueError:
                due_at = None
        pr = a.get("priority", "medium")
        if pr not in ("critical", "high", "medium", "low"):
            pr = "medium"
        cat = (a.get("category") or "general").strip() or "general"
        out.append(
            {
                "title": t[:500],
                "detail": (a.get("detail") or "")[:2000] or None,
                "category": cat[:80],
                "priority": pr,
                "source": src[:40],
                "source_message_id": mid[:500],
                "source_sender": (a.get("source_sender") or "")[:500] or None,
                "source_subject": (a.get("source_subject") or "")[:500] or None,
                "due_at": due_at,
                "due_natural": (a.get("due_natural") or "")[:500] or None,
                "metadata": {},
            }
        )
    return out


def _speak(text: str) -> None:
    if not text or not _SPEAK_SCRIPT.exists():
        print(f"[action-tracker] would speak: {text[:120]}", flush=True)
        return
    env = {**os.environ, "FRIDAY_TTS_PRIORITY": "1", "FRIDAY_TTS_BYPASS_CURSOR_DEFER": "true"}
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
    except Exception as e:
        print(f"[action-tracker] speak failed: {e}", file=sys.stderr)


def _speak_blocking_tracker(text: str, *, timeout: float = 120.0) -> None:
    if not (text or "").strip():
        return
    os.environ.setdefault("FRIDAY_DEFER_WHEN_CURSOR", "false")
    _ensure_speaker_path()
    try:
        from friday_speaker import speaker as _spk

        _spk.speak_blocking(
            text,
            priority=True,
            bypass_cursor_defer=True,
            interrupt_music=True,
            use_session_sticky=True,
            timeout=timeout,
        )
    except Exception as e:
        _log.warning("Blocking TTS failed (%s); using async speak", e)
        _speak(text)


def _whatsapp_text(text: str) -> None:
    if not WA_SUMMARY or not WHATSAPP_NOTIFY or not EVOLUTION_KEY or EVOLUTION_KEY == "change-me":
        return
    url = f"http://127.0.0.1:{EVOLUTION_PORT}/message/sendText/{EVOLUTION_INST}"
    body = json.dumps({"number": WHATSAPP_NOTIFY, "text": text[:3500]}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json", "apikey": EVOLUTION_KEY},
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=15)
    except urllib.error.HTTPError as e:
        print(f"[action-tracker] WhatsApp send HTTP {e.code}", file=sys.stderr)
    except Exception as e:
        print(f"[action-tracker] WhatsApp send failed: {e}", file=sys.stderr)


def _imap_connect():
    m = imaplib.IMAP4_SSL("imap.gmail.com", 993)
    m.login(GMAIL_ADDRESS, GMAIL_APP_PWD)
    return m


def _imap_fetch_messages() -> list[dict]:
    if not GMAIL_ADDRESS or not GMAIL_APP_PWD:
        return []
    out: list[dict] = []
    since = (datetime.utcnow() - timedelta(days=LOOKBACK_DAYS)).strftime("%d-%b-%Y")
    try:
        conn = _imap_connect()
    except Exception as e:
        print(f"[action-tracker] IMAP connect failed: {e}", file=sys.stderr)
        return []
    try:
        for folder in GMAIL_FOLDERS:
            try:
                conn.select(folder, readonly=True)
            except Exception:
                continue
            try:
                typ, data = conn.uid("search", None, f"(SINCE {since})")
            except Exception:
                typ, data = conn.uid("search", None, "ALL")
            if typ != "OK" or not data or not data[0]:
                continue
            uids = [u.decode() for u in data[0].split() if u]
            for uid in uids:
                msg_id = f"gmail:{folder}:{uid}"
                env = _fetch_envelope(conn, uid)
                body = _fetch_body(conn, uid)
                out.append(
                    {
                        "source": "gmail",
                        "message_id": msg_id,
                        "sender": env.get("from", ""),
                        "subject_or_chat": env.get("subject", ""),
                        "body": body,
                        "received_at": env.get("date", ""),
                    }
                )
    finally:
        try:
            conn.logout()
        except Exception:
            pass
    return out


def _fetch_envelope(conn, uid: str) -> dict:
    _, data = conn.uid("fetch", uid.encode(), "(RFC822.HEADER)")
    if not data or not data[0] or not isinstance(data[0], tuple):
        return {"from": "unknown", "subject": "", "date": ""}
    msg = email.message_from_bytes(data[0][1])
    date_str = msg.get("Date", "")
    try:
        date = parsedate_to_datetime(date_str).isoformat()
    except Exception:
        date = date_str
    return {
        "from": _extract_sender(msg.get("From", "")),
        "subject": _decode_header(msg.get("Subject", "")),
        "date": date,
    }


def _fetch_body(conn, uid: str) -> str:
    try:
        _, data = conn.uid("fetch", uid.encode(), "(RFC822)")
        if not data or not data[0] or not isinstance(data[0], tuple):
            return ""
        msg = email.message_from_bytes(data[0][1])
        body = ""
        if msg.is_multipart():
            for part in msg.walk():
                ct = part.get_content_type()
                cd = str(part.get("Content-Disposition", ""))
                if ct == "text/plain" and "attachment" not in cd:
                    body = part.get_payload(decode=True).decode(
                        part.get_content_charset() or "utf-8", errors="replace"
                    )
                    break
        else:
            pl = msg.get_payload(decode=True)
            body = pl.decode(msg.get_content_charset() or "utf-8", errors="replace") if pl else ""
        return textwrap.shorten(body.strip(), width=3000, placeholder="…")
    except Exception:
        return ""


def _evolution_messages() -> list[dict]:
    if not EVOLUTION_KEY or EVOLUTION_KEY == "change-me":
        return []
    base = f"http://127.0.0.1:{EVOLUTION_PORT}"
    payload = json.dumps({"where": {"key": {"fromMe": False}}, "limit": 40}).encode("utf-8")
    paths = (
        f"/chat/findMessages/{EVOLUTION_INST}",
        f"/message/findMessages/{EVOLUTION_INST}",
    )
    for path in paths:
        req = urllib.request.Request(
            base + path,
            data=payload,
            headers={"Content-Type": "application/json", "apikey": EVOLUTION_KEY},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except Exception:
            continue
        msgs = _flatten_evolution_messages(data)
        if msgs:
            return msgs
    return []


def _flatten_evolution_messages(data) -> list[dict]:
    """Best-effort parse Evolution findMessages JSON."""
    out = []
    candidates = []
    if isinstance(data, dict):
        for k in ("messages", "data", "records"):
            v = data.get(k)
            if isinstance(v, list):
                candidates = v
                break
        if not candidates and "message" in data:
            candidates = [data]
    elif isinstance(data, list):
        candidates = data
    for item in candidates:
        if not isinstance(item, dict):
            continue
        m = item.get("message") or item
        if isinstance(m, dict) and "conversation" in m:
            text = str(m.get("conversation") or "")
        elif isinstance(m, dict) and m.get("extendedTextMessage"):
            text = str(m.get("extendedTextMessage", {}).get("text") or "")
        else:
            text = str(item.get("text") or item.get("body") or "")
        key = item.get("key") or m.get("key") if isinstance(m, dict) else {}
        if isinstance(key, dict) and key.get("fromMe") is True:
            continue
        mid = ""
        if isinstance(key, dict):
            mid = str(key.get("id") or "")
        if not mid:
            mid = str(item.get("id") or item.get("_id") or hashlib.sha256(text.encode()).hexdigest()[:16])
        jid = ""
        if isinstance(key, dict):
            jid = str(key.get("remoteJid") or "")
        if "@g.us" in jid:
            continue
        if not text.strip():
            continue
        out.append(
            {
                "source": "whatsapp",
                "message_id": f"wa:{mid}:{jid}",
                "sender": jid.split("@")[0] if jid else "unknown",
                "subject_or_chat": "WhatsApp",
                "body": textwrap.shorten(text.strip(), width=3000, placeholder="…"),
                "received_at": item.get("messageTimestamp") or item.get("timestamp") or "",
            }
        )
    return out


def run_ingestion_cycle(conn) -> int:
    """Collect new messages, extract actions, insert. Returns number of new action rows."""
    inserted = 0
    with conn.cursor() as cur:
        open_titles = db_open_action_titles(cur)
        raw_msgs = _imap_fetch_messages() + _evolution_messages()
        pending = [m for m in raw_msgs if not db_scanned(cur, m["source"], m["message_id"])]

        for i in range(0, len(pending), MAX_BATCH):
            batch = pending[i : i + MAX_BATCH]
            if not batch:
                continue
            llm_msgs = [
                {
                    "source": b["source"],
                    "message_id": b["message_id"],
                    "sender": b["sender"],
                    "subject_or_chat": b["subject_or_chat"],
                    "body": b["body"],
                    "received_at": str(b["received_at"]),
                }
                for b in batch
            ]
            actions = _extract_actions_batch(llm_msgs, open_titles)
            for a in actions:
                th = _title_hash(a["title"])
                if db_hash_exists_pending(cur, th):
                    continue
                a["title_hash"] = th
                try:
                    db_insert_action(cur, a)
                    inserted += 1
                    open_titles.insert(0, a["title"])
                except Exception as e:
                    print(f"[action-tracker] insert skip: {e}", file=sys.stderr)
            for m in batch:
                n = sum(1 for x in actions if x.get("source_message_id") == m["message_id"])
                db_log_scan(
                    cur,
                    m["source"],
                    m["message_id"],
                    n,
                    (m.get("body") or "")[:400],
                )
    conn.commit()
    return inserted


def run_briefing_cycle(conn) -> None:
    """Every poll: ask (spoken) whether to hear today's plan; listen for yes or no; default yes if listen fails."""
    if _quiet_now():
        print("[action-tracker] quiet hours — skipping check-in", flush=True)
        return

    answer = _prompt_listen_yes_no()
    if answer == "no":
        _speak_blocking_tracker(
            f"No problem, {USER_NAME}. Skipping this check-in. I will ask again next round.",
            timeout=90.0,
        )
        print("[action-tracker] user declined check-in", flush=True)
        return

    actions, todos = _fetch_briefing_payload(conn)
    speech = _briefing_spoken_text(actions, todos)
    _speak_blocking_tracker(speech, timeout=300.0)
    _whatsapp_text(speech)
    ids = [str(a["id"]) for a in actions]
    if ids:
        with conn.cursor() as cur:
            db_bump_reminders(cur, ids)
        conn.commit()
    print(f"[action-tracker] briefing ({len(actions)} actions, {len(todos)} todos)", flush=True)


def main() -> None:
    once = "--once" in sys.argv
    skip_ingestion = "--skip-ingestion" in sys.argv
    if skip_ingestion and not once:
        print("[action-tracker] --skip-ingestion only works with --once", file=sys.stderr)
        sys.exit(2)
    if not TRACKER_ON:
        print("[action-tracker] FRIDAY_TRACKER_ENABLED is off — exiting.", flush=True)
        return
    if not DB_URL:
        print("[action-tracker] OPENCLAW_DATABASE_URL required — exiting.", file=sys.stderr)
        sys.exit(1)
    if not _log.handlers:
        _h = logging.StreamHandler(sys.stderr)
        _h.setFormatter(logging.Formatter("[action-tracker] %(levelname)s: %(message)s"))
        _log.addHandler(_h)
        _log.setLevel(logging.INFO)
    if once:
        print(
            "[action-tracker] --once: single cycle"
            + (" (briefing only)" if skip_ingestion else " (ingestion + check-in)"),
            flush=True,
        )
    else:
        print(
            f"[action-tracker] starting — poll every {POLL_SEC}s | model={MODEL} | db=ok",
            flush=True,
        )
    while True:
        try:
            conn = db_connect()
            try:
                if not skip_ingestion:
                    run_ingestion_cycle(conn)
                run_briefing_cycle(conn)
            finally:
                conn.close()
        except KeyboardInterrupt:
            print("[action-tracker] stopped.", flush=True)
            sys.exit(0)
        except Exception as e:
            print(f"[action-tracker] cycle error: {e}", file=sys.stderr)
            if once:
                sys.exit(1)
            time.sleep(POLL_SEC)
            continue
        if once:
            print("[action-tracker] --once complete", flush=True)
            return
        time.sleep(POLL_SEC)


if __name__ == "__main__":
    main()
