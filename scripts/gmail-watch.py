#!/usr/bin/env python3
"""
gmail-watch.py — Long-running IMAP daemon that watches for new emails,
summarizes them with Claude, speaks a rich notification, and creates
todos/reminders/calendar events in OpenClaw.

How it works:
  1. Connects to Gmail IMAP, selects INBOX (read-only).
  2. Snapshots the current UNSEEN UIDs on startup (does not announce old mail).
  3. Polls every FRIDAY_EMAIL_POLL_SEC (default 30) for new UNSEEN UIDs.
  4. For each new UID in a poll:
       a. Fetches full body.
       b. Calls email-analyze.py (Claude Haiku) for summary + action items.
       c. Speaks once per mail, or — if several arrive together and FRIDAY_EMAIL_DIGEST is on —
          one digest after processing all (optional wait until other TTS finishes).
       d. POSTs any todos/reminders to pc-agent /todos API.
       e. If a meeting is detected, creates a calendar .ics event.
  5. Reconnects automatically on IMAP errors / dropped connections.

Env (in .env):
  GMAIL_ADDRESS             Gmail address
  GMAIL_APP_PWD             16-char Google App Password (spaces OK, stripped internally)
  FRIDAY_EMAIL_WATCH        true/false — master switch (default true when script runs)
  FRIDAY_EMAIL_POLL_SEC     polling interval in seconds (default 30)
  FRIDAY_EMAIL_FOLDERS      comma-separated IMAP folders (default INBOX)
  FRIDAY_EMAIL_NOTIFY_VOICE voice override for email announcements (blank = session voice)
  FRIDAY_EMAIL_ANALYZE      true/false — enable AI summary+actions (default true)
  FRIDAY_EMAIL_DIGEST       when several new mails arrive in one poll, one spoken digest (default true)
  FRIDAY_EMAIL_DIGEST_MAX   max individual blurbs inside a digest (default 8)
  FRIDAY_EMAIL_SPEAK_AFTER_TTS_CLEAR  wait until no TTS is playing before digest (default true; avoids cutting off WhatsApp)
  FRIDAY_EMAIL_TTS_CLEAR_TIMEOUT_SEC  max seconds to wait for playback to finish (default 20)
  PC_AGENT_URL              pc-agent base URL (default http://127.0.0.1:3847)

Run:
  python scripts/gmail-watch.py
  npm run start:email-watch      (if wired in package.json)
"""
from __future__ import annotations

import email
import email.header
import imaplib
import json
import os
import platform
import subprocess
import sys
import tempfile
import textwrap
import time
import urllib.request
import urllib.error
from email.utils import parsedate_to_datetime
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_SCRIPTS_DIR = Path(__file__).resolve().parent
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

_SPEAK_SCRIPT = _REPO_ROOT / "skill-gateway" / "scripts" / "friday-speak.py"
_ANALYZE_SCRIPT = _REPO_ROOT / "scripts" / "email-analyze.py"
_CALENDAR_SCRIPT = _REPO_ROOT / "scripts" / "create-calendar-event.py"

GMAIL_ADDRESS = os.environ.get("GMAIL_ADDRESS", "").strip()
GMAIL_APP_PWD = os.environ.get("GMAIL_APP_PWD", "").strip().replace(" ", "")
IMAP_HOST = "imap.gmail.com"
IMAP_PORT = 993

POLL_SEC = max(10, int(os.environ.get("FRIDAY_EMAIL_POLL_SEC", "30")))
FOLDERS = [f.strip() for f in os.environ.get("FRIDAY_EMAIL_FOLDERS", "INBOX").split(",") if f.strip()]
NOTIFY_VOICE = os.environ.get("FRIDAY_EMAIL_NOTIFY_VOICE", "").strip()  # overrides NOVA company voice
USER_NAME = os.environ.get("FRIDAY_USER_NAME", "").strip() or "sir"
PC_AGENT_URL = os.environ.get("PC_AGENT_URL", "http://127.0.0.1:3847").rstrip("/")


def _env_bool(key: str, default: bool = True) -> bool:
    raw = os.environ.get(key, "").strip().lower()
    if raw == "":
        return default
    return raw in ("1", "true", "yes", "on")


def _env_int(key: str, default: int) -> int:
    try:
        return int(os.environ.get(key, "").split("#")[0].strip() or str(default))
    except ValueError:
        return default


def _env_float(key: str, default: float) -> float:
    try:
        return float(os.environ.get(key, "").split("#")[0].strip() or default)
    except ValueError:
        return default


EMAIL_ANALYZE = _env_bool("FRIDAY_EMAIL_ANALYZE", True)
EMAIL_DIGEST = _env_bool("FRIDAY_EMAIL_DIGEST", True)
EMAIL_DIGEST_MAX = max(1, min(20, _env_int("FRIDAY_EMAIL_DIGEST_MAX", 8)))
EMAIL_SPEAK_AFTER_TTS_CLEAR = _env_bool("FRIDAY_EMAIL_SPEAK_AFTER_TTS_CLEAR", True)
EMAIL_TTS_CLEAR_TIMEOUT = max(1.0, min(120.0, _env_float("FRIDAY_EMAIL_TTS_CLEAR_TIMEOUT_SEC", 20.0)))

TTS_ACTIVE_FILE = Path(tempfile.gettempdir()) / "friday-tts-active"


def _wait_for_tts_clear(timeout: float) -> None:
    """Block until friday-speak is not holding the TTS active marker (or timeout)."""
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
        time.sleep(0.25)


def _decode_header(raw: str) -> str:
    parts = email.header.decode_header(raw or "")
    out = []
    for part, enc in parts:
        if isinstance(part, bytes):
            out.append(part.decode(enc or "utf-8", errors="replace"))
        else:
            out.append(str(part))
    return "".join(out)


def _extract_sender_name(from_header: str) -> str:
    """'Raj Utkarsh <raj@example.com>' → 'Raj Utkarsh'"""
    decoded = _decode_header(from_header)
    if "<" in decoded:
        name = decoded.split("<")[0].strip().strip('"').strip("'")
        if name:
            return name
    return decoded.split("@")[0] if "@" in decoded else decoded


def _connect() -> imaplib.IMAP4_SSL:
    m = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
    m.login(GMAIL_ADDRESS, GMAIL_APP_PWD)
    return m


def _get_unseen_uids(conn: imaplib.IMAP4_SSL, folder: str) -> set[str]:
    conn.select(folder, readonly=True)
    _, data = conn.uid("search", None, "UNSEEN")
    raw = data[0] if data and data[0] else b""
    return {u.decode() for u in raw.split() if u}


def _fetch_envelope(conn: imaplib.IMAP4_SSL, uid: str) -> dict:
    _, data = conn.uid("fetch", uid.encode(), "(RFC822.HEADER)")
    if not data or not data[0] or not isinstance(data[0], tuple):
        return {"from": "unknown", "subject": "(no subject)", "date": ""}
    msg = email.message_from_bytes(data[0][1])
    date_str = msg.get("Date", "")
    try:
        date = parsedate_to_datetime(date_str).strftime("%I:%M %p")
    except Exception:
        date = ""
    return {
        "uid": uid,
        "from": _extract_sender_name(msg.get("From", "unknown")),
        "subject": _decode_header(msg.get("Subject", "(no subject)")),
        "date": date,
    }


def _fetch_full_body(conn: imaplib.IMAP4_SSL, uid: str) -> str:
    """Fetch full RFC822 message and extract plain text body (up to 4000 chars)."""
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
            body = msg.get_payload(decode=True).decode(
                msg.get_content_charset() or "utf-8", errors="replace"
            )
        return textwrap.shorten(body.strip(), width=4000, placeholder="… [truncated]")
    except Exception as exc:
        print(f"[gmail-watch] body fetch failed: {exc}", file=sys.stderr)
        return ""


def _analyze_email(envelope: dict, body: str) -> dict | None:
    """Call email-analyze.py to get Claude's summary + actions. Returns None on failure."""
    if not EMAIL_ANALYZE or not _ANALYZE_SCRIPT.exists():
        return None
    payload = json.dumps(
        {
            "from": envelope.get("from", ""),
            "subject": envelope.get("subject", ""),
            "body": body,
            "date": envelope.get("date", ""),
        },
        ensure_ascii=False,
    ).encode("utf-8")
    kwargs: dict = {}
    if platform.system() == "Windows":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        result = subprocess.run(
            [sys.executable, str(_ANALYZE_SCRIPT)],
            input=payload,
            capture_output=True,
            timeout=30,
            cwd=str(_REPO_ROOT),
            **kwargs,
        )
        if result.returncode != 0:
            print(f"[gmail-watch] analyze stderr: {result.stderr.decode(errors='replace')[:300]}", file=sys.stderr)
            return None
        return json.loads(result.stdout.decode("utf-8"))
    except Exception as exc:
        print(f"[gmail-watch] analyze failed: {exc}", file=sys.stderr)
        return None


def _post_json(path: str, data: dict) -> bool:
    """POST JSON to pc-agent. Returns True on success."""
    url = f"{PC_AGENT_URL}{path}"
    payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status < 300
    except Exception as exc:
        print(f"[gmail-watch] POST {path} failed: {exc}", file=sys.stderr)
        return False


def _post_todos_and_reminders(analysis: dict, email_subject: str) -> None:
    """POST todos and reminders extracted by Claude to pc-agent."""
    source = f"email: {email_subject[:60]}"
    todo_ids = []
    for item in analysis.get("todos", []):
        title = item.get("title", "").strip()
        if not title:
            continue
        resp_ok = _post_json(
            "/todos",
            {
                "title": title,
                "detail": item.get("detail", ""),
                "priority": item.get("priority", "medium"),
                "source": source,
            },
        )
        if resp_ok:
            todo_ids.append(title)
            print(f"[gmail-watch] todo created: {title}", flush=True)

    for item in analysis.get("reminders", []):
        title = item.get("title", "").strip()
        if not title:
            continue
        _post_json(
            "/todos/reminders",
            {
                "title": title,
                "dueIso": item.get("due_iso"),
                "dueNatural": item.get("due_natural", ""),
            },
        )
        print(f"[gmail-watch] reminder created: {title}", flush=True)


def _create_calendar_event(meeting: dict) -> None:
    """Call create-calendar-event.py to create a Windows Calendar .ics event."""
    if not _CALENDAR_SCRIPT.exists():
        return
    args = [
        sys.executable,
        str(_CALENDAR_SCRIPT),
        "--title", meeting.get("title", "Meeting"),
    ]
    if meeting.get("date_iso"):
        args += ["--date", meeting["date_iso"]]
    if meeting.get("time_iso"):
        args += ["--time", meeting["time_iso"]]
    if meeting.get("duration_minutes"):
        args += ["--duration", str(meeting["duration_minutes"])]
    if meeting.get("location"):
        args += ["--location", meeting["location"]]

    kwargs: dict = {}
    if platform.system() == "Windows":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        subprocess.Popen(args, cwd=str(_REPO_ROOT), **kwargs)
        print(f"[gmail-watch] calendar event triggered: {meeting.get('title')}", flush=True)
    except Exception as exc:
        print(f"[gmail-watch] calendar event failed: {exc}", file=sys.stderr)


def _build_speak_text(envelope: dict, analysis: dict | None) -> str:
    """Build rich spoken notification text."""
    sender = envelope.get("from", "someone")
    subject = envelope.get("subject", "(no subject)")

    if analysis is None:
        return (
            f"Nova here, Director of Communications. New email from {sender}. "
            f"Subject: {subject}."
        )

    speak_summary = (analysis.get("speak_summary") or "").strip()
    if not speak_summary:
        speak_summary = f"Subject: {subject}."

    parts = [f"Nova here, Director of Communications. New email from {sender}."]

    # Add summary
    parts.append(speak_summary)

    # Announce action items
    todos = analysis.get("todos", [])
    reminders = analysis.get("reminders", [])
    meeting = analysis.get("meeting")

    if meeting:
        date_nat = meeting.get("date_natural", "")
        time_nat = meeting.get("time_natural", "")
        dt = f"{date_nat} {time_nat}".strip()
        parts.append(f"There's a meeting invite: {meeting.get('title', 'Meeting')}{(', ' + dt) if dt else ''}. I've added it to your calendar.")

    if todos:
        n = len(todos)
        label = "action item" if n == 1 else "action items"
        parts.append(f"I've added {n} {label} to your to-do list.")

    if reminders and not todos:
        parts.append("I've set a reminder for you.")

    return " ".join(parts)


def _apply_analysis_actions(envelope: dict, analysis: dict | None) -> None:
    if not analysis:
        return
    if analysis.get("todos") or analysis.get("reminders"):
        _post_todos_and_reminders(analysis, envelope.get("subject", ""))
    meeting = analysis.get("meeting")
    if meeting:
        _create_calendar_event(meeting)


def _build_digest_speak_text(entries: list[tuple[dict, dict | None]]) -> str:
    """One announcement for several new messages (avoids stacked priority TTS vs WhatsApp)."""
    n = len(entries)
    if n == 0:
        return ""
    if n == 1:
        env, ana = entries[0]
        return _build_speak_text(env, ana)
    intro = f"Nova here, Director of Communications. You have {n} new emails."
    parts: list[str] = [intro]
    cap = min(n, EMAIL_DIGEST_MAX)
    for envelope, analysis in entries[:cap]:
        sender = envelope.get("from", "someone")
        subject = envelope.get("subject", "(no subject)")
        sm = (analysis or {}).get("speak_summary") if analysis else None
        sm = (sm or "").strip()
        if sm:
            parts.append(f"From {sender}: {textwrap.shorten(sm, width=130, placeholder='')}")
        else:
            parts.append(f"From {sender}, subject {subject}.")
    rest = n - cap
    if rest > 0:
        parts.append(f"Plus {rest} more in your inbox.")
    return " ".join(parts)


def _speak_text(text: str) -> None:
    """Fire-and-forget highest priority TTS for email notification (NOVA, Director of Comms)."""
    env = {
        **os.environ,
        "FRIDAY_TTS_PRIORITY": "1",
        "FRIDAY_TTS_BYPASS_CURSOR_DEFER": "true",
    }
    if NOTIFY_VOICE:
        env["FRIDAY_TTS_VOICE"] = NOTIFY_VOICE
        env["FRIDAY_TTS_USE_SESSION_STICKY_VOICE"] = "false"
    else:
        try:
            from openclaw_company import friday_speak_env_for_persona

            env.update(friday_speak_env_for_persona("nova", priority=True))
        except Exception:
            env["FRIDAY_TTS_USE_SESSION_STICKY_VOICE"] = "false"
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
        print(f"[nova] spoke: {text[:120]}", flush=True)
    except Exception as exc:
        print(f"[gmail-watch] speak failed: {exc}", file=sys.stderr, flush=True)


def _process_new_email(
    conn: imaplib.IMAP4_SSL, uid: str, *, speak: bool = True
) -> tuple[dict, dict | None]:
    """Fetch → analyze → todos/calendar; optional single-mail TTS."""
    envelope = _fetch_envelope(conn, uid)
    print(f"[gmail-watch] new email UID {uid}: from={envelope['from']} subject={envelope['subject'][:60]}", flush=True)

    body = _fetch_full_body(conn, uid) if EMAIL_ANALYZE else ""
    analysis = _analyze_email(envelope, body) if (body or not EMAIL_ANALYZE) else None

    _apply_analysis_actions(envelope, analysis)

    if speak:
        _speak_text(_build_speak_text(envelope, analysis))
    return envelope, analysis


def _run_watch_loop() -> None:
    print(f"[gmail-watch] connecting to {GMAIL_ADDRESS} ...", flush=True)
    conn = _connect()

    # Snapshot current unseen — don't announce old mail
    known_unseen: dict[str, set[str]] = {}
    for folder in FOLDERS:
        uids = _get_unseen_uids(conn, folder)
        known_unseen[folder] = uids
        print(f"[gmail-watch] {folder}: {len(uids)} unseen (snapshot, not announced)", flush=True)

    print(
        f"[gmail-watch] polling every {POLL_SEC}s for new emails in {', '.join(FOLDERS)} "
        f"| analyze={EMAIL_ANALYZE} | digest={EMAIL_DIGEST}",
        flush=True,
    )

    reconnect_backoff = 0
    while True:
        time.sleep(POLL_SEC)
        try:
            conn.noop()
            reconnect_backoff = 0
        except Exception:
            reconnect_backoff = min(reconnect_backoff + 1, 5)
            wait = POLL_SEC * reconnect_backoff
            print(f"[gmail-watch] connection lost, reconnecting in {wait}s ...", flush=True)
            time.sleep(wait)
            try:
                conn = _connect()
                print("[gmail-watch] reconnected", flush=True)
            except Exception as exc:
                print(f"[gmail-watch] reconnect failed: {exc}", file=sys.stderr, flush=True)
                continue

        for folder in FOLDERS:
            try:
                current = _get_unseen_uids(conn, folder)
            except Exception:
                try:
                    conn = _connect()
                except Exception:
                    break
                try:
                    current = _get_unseen_uids(conn, folder)
                except Exception:
                    continue

            prev = known_unseen.get(folder, set())
            new_uids = current - prev
            known_unseen[folder] = current

            if not new_uids:
                continue

            print(f"[gmail-watch] {folder}: {len(new_uids)} new email(s)", flush=True)
            uids_list = sorted(new_uids)
            if EMAIL_DIGEST and len(uids_list) > 1:
                entries: list[tuple[dict, dict | None]] = []
                for uid in uids_list:
                    try:
                        envelope, analysis = _process_new_email(conn, uid, speak=False)
                        entries.append((envelope, analysis))
                    except Exception as exc:
                        print(f"[gmail-watch] process failed for UID {uid}: {exc}", file=sys.stderr, flush=True)
                if entries:
                    if EMAIL_SPEAK_AFTER_TTS_CLEAR:
                        _wait_for_tts_clear(EMAIL_TTS_CLEAR_TIMEOUT)
                    _speak_text(_build_digest_speak_text(entries))
            else:
                for uid in uids_list:
                    try:
                        _process_new_email(conn, uid, speak=True)
                    except Exception as exc:
                        print(f"[gmail-watch] process failed for UID {uid}: {exc}", file=sys.stderr, flush=True)


def main() -> None:
    if not _env_bool("FRIDAY_EMAIL_WATCH", True):
        print("[gmail-watch] FRIDAY_EMAIL_WATCH is off — exiting.", flush=True)
        return
    if not GMAIL_ADDRESS or not GMAIL_APP_PWD:
        print("[gmail-watch] ERROR: set GMAIL_ADDRESS and GMAIL_APP_PWD in .env", file=sys.stderr, flush=True)
        sys.exit(1)

    while True:
        try:
            _run_watch_loop()
        except KeyboardInterrupt:
            print("[gmail-watch] stopped.", flush=True)
            sys.exit(0)
        except Exception as exc:
            print(f"[gmail-watch] crash: {exc} — restarting in 30s", file=sys.stderr, flush=True)
            time.sleep(30)


if __name__ == "__main__":
    main()
