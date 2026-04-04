#!/usr/bin/env python3
"""
gmail-watch.py — Long-running IMAP daemon that watches for new emails and
narrates them at highest TTS priority (pre-empts all other speech).

How it works:
  1. Connects to Gmail IMAP, selects INBOX (read-only).
  2. Snapshots the current UNSEEN UIDs on startup (does not announce old mail).
  3. Polls every FRIDAY_EMAIL_POLL_SEC (default 30) for new UNSEEN UIDs.
  4. For each new UID: fetches sender + subject, speaks via friday-speak.py
     with FRIDAY_TTS_PRIORITY=1 (pre-empts ambient, music, and any other TTS).
  5. Reconnects automatically on IMAP errors / dropped connections.

Env (in .env):
  GMAIL_ADDRESS             Gmail address
  GMAIL_APP_PWD             16-char Google App Password (spaces OK, stripped internally)
  FRIDAY_EMAIL_WATCH        true/false — master switch (default true when script runs)
  FRIDAY_EMAIL_POLL_SEC     polling interval in seconds (default 30)
  FRIDAY_EMAIL_FOLDERS      comma-separated IMAP folders (default INBOX)
  FRIDAY_EMAIL_NOTIFY_VOICE voice override for email announcements (blank = session voice)

Run:
  python scripts/gmail-watch.py
  npm run start:email-watch      (if wired in package.json)
"""
from __future__ import annotations

import email
import email.header
import imaplib
import os
import platform
import subprocess
import sys
import time
from email.utils import parsedate_to_datetime
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

_SPEAK_SCRIPT = _REPO_ROOT / "skill-gateway" / "scripts" / "friday-speak.py"
GMAIL_ADDRESS = os.environ.get("GMAIL_ADDRESS", "").strip()
GMAIL_APP_PWD = os.environ.get("GMAIL_APP_PWD", "").strip().replace(" ", "")
IMAP_HOST = "imap.gmail.com"
IMAP_PORT = 993

POLL_SEC = max(10, int(os.environ.get("FRIDAY_EMAIL_POLL_SEC", "30")))
FOLDERS = [f.strip() for f in os.environ.get("FRIDAY_EMAIL_FOLDERS", "INBOX").split(",") if f.strip()]
NOTIFY_VOICE = os.environ.get("FRIDAY_EMAIL_NOTIFY_VOICE", "").strip()
USER_NAME = os.environ.get("FRIDAY_USER_NAME", "").strip() or "sir"


def _env_bool(key: str, default: bool = True) -> bool:
    raw = os.environ.get(key, "").strip().lower()
    if raw == "":
        return default
    return raw in ("1", "true", "yes", "on")


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


def _speak_email(sender: str, subject: str) -> None:
    """Fire-and-forget highest priority TTS for email notification."""
    text = f"New email from {sender}. Subject: {subject}."
    env = {
        **os.environ,
        "FRIDAY_TTS_PRIORITY": "1",
        "FRIDAY_TTS_BYPASS_CURSOR_DEFER": "true",
    }
    if NOTIFY_VOICE:
        env["FRIDAY_TTS_VOICE"] = NOTIFY_VOICE
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
        print(f"[gmail-watch] spoke: {text}", flush=True)
    except Exception as exc:
        print(f"[gmail-watch] speak failed: {exc}", file=sys.stderr, flush=True)


def _run_watch_loop() -> None:
    print(f"[gmail-watch] connecting to {GMAIL_ADDRESS} ...", flush=True)
    conn = _connect()

    # Snapshot current unseen — don't announce old mail
    known_unseen: dict[str, set[str]] = {}
    for folder in FOLDERS:
        uids = _get_unseen_uids(conn, folder)
        known_unseen[folder] = uids
        print(f"[gmail-watch] {folder}: {len(uids)} unseen (snapshot, not announced)", flush=True)

    print(f"[gmail-watch] polling every {POLL_SEC}s for new emails in {', '.join(FOLDERS)}", flush=True)

    reconnect_backoff = 0
    while True:
        time.sleep(POLL_SEC)
        try:
            conn.noop()
            reconnect_backoff = 0
        except Exception:
            # Connection dropped — reconnect
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
            for uid in sorted(new_uids):
                try:
                    env = _fetch_envelope(conn, uid)
                    _speak_email(env["from"], env["subject"])
                except Exception as exc:
                    print(f"[gmail-watch] fetch/speak failed for UID {uid}: {exc}", file=sys.stderr, flush=True)


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
