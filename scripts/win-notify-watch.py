#!/usr/bin/env python3
"""
win-notify-watch.py — Windows toast notification watcher.

Reads Windows Push Notification (WPN) toasts and speaks them through
friday-speak.py, bypassing system mute entirely.

State is persisted in PostgreSQL:
  • win_notify_watermark  — last processed notification Order (survives restarts)
  • win_notify_dedup      — recent content hashes to suppress duplicates
  • win_notify_history    — full spoken-notification audit log

The WPN database (%LOCALAPPDATA%\\Microsoft\\Windows\\Notifications\\wpndatabase.db)
is a Windows system file maintained by the OS.  It is opened read-only solely
to receive live notification data; all application state lives in PostgreSQL.

Supported sources (auto-detected):
  WhatsApp (Phone Link), Telegram, Teams, Slack, Discord, Signal, and any
  other app that posts Windows toast notifications.

Env variables (in .env):
  FRIDAY_WIN_NOTIFY_WATCH        master switch — true/false (default true)
  FRIDAY_WIN_NOTIFY_POLL_SEC     poll interval in seconds (default 2)
  FRIDAY_WIN_NOTIFY_APPS         comma-separated app patterns to include (empty = all)
  FRIDAY_WIN_NOTIFY_IGNORE       comma-separated app patterns to skip
  FRIDAY_WIN_NOTIFY_VOICE        TTS voice override (blank = session voice)
  FRIDAY_WIN_NOTIFY_PRIORITY     TTS priority for generic apps (default 0)
  OPENCLAW_DATABASE_URL          PostgreSQL connection string (required)

Run:
  python scripts/win-notify-watch.py
"""
from __future__ import annotations

import hashlib
import json
import os
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Optional

import psycopg2
import psycopg2.extras

_REPO_ROOT = Path(__file__).resolve().parent.parent
_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

# ── .env loader ──────────────────────────────────────────────────────────────
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

# ── Config ───────────────────────────────────────────────────────────────────
_MASTER = os.environ.get("FRIDAY_WIN_NOTIFY_WATCH", "true").strip().lower()
if _MASTER in ("0", "false", "no", "off"):
    print("[win-notify] FRIDAY_WIN_NOTIFY_WATCH is off — exiting.")
    sys.exit(0)

POLL_SEC        = float(os.environ.get("FRIDAY_WIN_NOTIFY_POLL_SEC", "2").strip())
NOTIFY_VOICE    = os.environ.get("FRIDAY_WIN_NOTIFY_VOICE", "").strip()
GENERIC_PRIORITY = os.environ.get("FRIDAY_WIN_NOTIFY_PRIORITY", "0").strip()
DATABASE_URL    = os.environ.get("OPENCLAW_DATABASE_URL", "").strip()
PC_AGENT_URL    = os.environ.get("PC_AGENT_URL", "http://127.0.0.1:3847").rstrip("/")
PC_AGENT_SECRET = os.environ.get("PC_AGENT_SECRET", "").strip()
MACHINE_ID      = socket.gethostname()

_DND_KEY = "openclaw:dnd"

# Notification dedup window in seconds
_DEDUP_WINDOW_SEC = 15

# How often (polls) to purge expired dedup rows from PostgreSQL
_DEDUP_CLEANUP_EVERY = 150  # every 5 minutes at 2s poll

_APPS_RAW = os.environ.get("FRIDAY_WIN_NOTIFY_APPS", "").strip()
INCLUDE_PATTERNS: list[str] = (
    [p.strip().lower() for p in _APPS_RAW.split(",") if p.strip()]
    if _APPS_RAW else []
)

_IGNORE_DEFAULT = (
    "Cursor,Intel,AcerIncorporated,ULICTekInc,PredatorSense,Xbox,"
    "DynamicLighting,InputSwitch,ParentalControls,Windows.Defender,"
    "WindowsStore,Widgets,GamingApp"
)
_IGNORE_RAW = os.environ.get("FRIDAY_WIN_NOTIFY_IGNORE", _IGNORE_DEFAULT).strip()
IGNORE_PATTERNS: list[str] = [p.strip().lower() for p in _IGNORE_RAW.split(",") if p.strip()]

# WPN system database (Windows Push Notification platform — OS-managed file)
_WPN_DB = (
    Path(os.environ.get("LOCALAPPDATA", ""))
    / "Microsoft" / "Windows" / "Notifications" / "wpndatabase.db"
)

# ── App name mapping ──────────────────────────────────────────────────────────
_NAME_MAP: list[tuple[str, str]] = [
    ("com.whatsapp",        "WhatsApp"),
    ("whatsapp",            "WhatsApp"),
    ("org.telegram",        "Telegram"),
    ("telegramdesktop",     "Telegram"),
    ("telegrammessengerllp","Telegram"),
    ("com.slack",           "Slack"),
    ("slack",               "Slack"),
    ("msteams",             "Teams"),
    ("discord",             "Discord"),
    ("signal",              "Signal"),
    ("claude_",             "Claude"),
    ("anysphere.cursor",    "Cursor"),
    ("yourphone",           "Phone Link"),
    ("windows.defender",    "Windows Defender"),
    ("spotify",             "Spotify"),
    ("gmail",               "Gmail"),
    ("outlook",             "Outlook"),
]

_MESSAGING_IDS: tuple[str, ...] = (
    "whatsapp", "telegram", "slack", "msteams", "discord", "signal", "yourphone",
)


def _friendly_name(primary_id: str) -> str:
    pid = primary_id.lower()
    for key, name in _NAME_MAP:
        if key in pid:
            return name
    if "!" in primary_id:
        return primary_id.rsplit("!", 1)[-1]
    parts = primary_id.rsplit(".", 1)
    return parts[-1] if len(parts) > 1 else primary_id


def _is_messaging(primary_id: str) -> bool:
    pid = primary_id.lower()
    return any(k in pid for k in _MESSAGING_IDS)


def _should_include(app_name: str, primary_id: str) -> bool:
    combined = (app_name + " " + primary_id).lower()
    if IGNORE_PATTERNS and any(p in combined for p in IGNORE_PATTERNS):
        return False
    if INCLUDE_PATTERNS and not any(p in combined for p in INCLUDE_PATTERNS):
        return False
    return True


def _parse_toast_xml(payload: bytes | str) -> tuple[str, str]:
    """Return (title, body) from a toast XML payload."""
    try:
        text = payload.decode("utf-8", errors="replace") if isinstance(payload, bytes) else payload
        root = ET.fromstring(text)
        texts: list[str] = []
        for visual in root.iter("visual"):
            for binding in visual.iter("binding"):
                for elem in binding.iter("text"):
                    t = (elem.text or "").strip()
                    if t:
                        texts.append(t)
        if not texts:
            for elem in root.iter("text"):
                t = (elem.text or "").strip()
                if t:
                    texts.append(t)
        title = texts[0] if texts else ""
        body  = " ".join(texts[1:]) if len(texts) > 1 else ""
        return title, body
    except Exception:
        return "", ""


def _content_hash(app: str, title: str, body: str) -> str:
    return hashlib.sha1(f"{app}|{title}|{body}".encode()).hexdigest()


def _is_dnd() -> bool:
    """Check Redis openclaw:dnd — returns True when Do Not Disturb is on."""
    try:
        import redis as _redis
        rc = _redis.Redis.from_url(
            os.environ.get("OPENCLAW_REDIS_URL", "redis://127.0.0.1:6379"),
            socket_connect_timeout=1,
            socket_timeout=1,
        )
        return rc.get(_DND_KEY) == b"1"
    except Exception:
        return False


def _post_json(url: str, payload: dict, secret: str = "") -> None:
    """Fire-and-forget JSON POST — errors are logged but never propagate."""
    try:
        data = json.dumps(payload).encode()
        req = urllib.request.Request(
            url,
            data=data,
            headers={
                "Content-Type": "application/json",
                **({"Authorization": f"Bearer {secret}"} if secret else {}),
            },
            method="POST",
        )
        urllib.request.urlopen(req, timeout=5)
    except Exception as exc:
        print(f"[win-notify] POST {url} failed: {exc}", flush=True)


def _speak(app: str, title: str, body: str, priority: str = "0") -> None:
    speech = f"{app}: {title}" + (f" {body}" if body and body != title else "")

    # Emit win_notify SSE event to UI (no DND check — always show in UI)
    _post_json(
        f"{PC_AGENT_URL}/voice/event",
        {"type": "win_notify", "app": app, "title": title, "body": body, "priority": priority},
        secret=PC_AGENT_SECRET,
    )

    # Respect DND for audio only
    if _is_dnd():
        print(f"[win-notify] DND on — skipping speech for [{app}]", flush=True)
        return

    # Try pc-agent /voice/speak-async first (gives SSE speak event + TTS)
    if PC_AGENT_SECRET:
        _post_json(
            f"{PC_AGENT_URL}/voice/speak-async",
            {"text": speech, "channel": "winnotify", "personaKey": "dexter"},
            secret=PC_AGENT_SECRET,
        )
        return

    # Fallback: direct TTS via friday-speak.py
    if not _SPEAK_SCRIPT.exists():
        print(f"[win-notify] speak script not found: {_SPEAK_SCRIPT}", flush=True)
        return
    env = os.environ.copy()
    env["FRIDAY_TTS_PRIORITY"]            = priority
    env["FRIDAY_TTS_BYPASS_CURSOR_DEFER"] = "true"
    if NOTIFY_VOICE:
        env["FRIDAY_TTS_VOICE"] = NOTIFY_VOICE
    try:
        subprocess.Popen(
            [sys.executable, str(_SPEAK_SCRIPT), speech],
            env=env,
            cwd=str(_REPO_ROOT),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception as exc:
        print(f"[win-notify] speak error: {exc}", flush=True)


# ── PostgreSQL helpers ────────────────────────────────────────────────────────

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS win_notify_watermark (
    machine_id   TEXT        NOT NULL PRIMARY KEY,
    last_order   BIGINT      NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS win_notify_dedup (
    content_hash TEXT        NOT NULL PRIMARY KEY,
    app_name     TEXT,
    spoken_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS win_notify_history (
    id           BIGSERIAL   PRIMARY KEY,
    machine_id   TEXT        NOT NULL,
    app_name     TEXT,
    title        TEXT,
    body         TEXT,
    priority     TEXT,
    spoken_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""


def _pg_connect() -> psycopg2.extensions.connection:
    if not DATABASE_URL:
        raise RuntimeError(
            "OPENCLAW_DATABASE_URL is not set. "
            "Add it to .env (e.g. postgresql://openclaw:openclaw@127.0.0.1:5433/openclaw)."
        )
    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = True
    return conn


def _ensure_schema(pg: psycopg2.extensions.connection) -> None:
    with pg.cursor() as cur:
        cur.execute(_SCHEMA_SQL)


def _load_watermark(pg: psycopg2.extensions.connection) -> int:
    with pg.cursor() as cur:
        cur.execute(
            "SELECT last_order FROM win_notify_watermark WHERE machine_id = %s",
            (MACHINE_ID,),
        )
        row = cur.fetchone()
        return row[0] if row else 0


def _save_watermark(pg: psycopg2.extensions.connection, order: int) -> None:
    with pg.cursor() as cur:
        cur.execute(
            """
            INSERT INTO win_notify_watermark (machine_id, last_order, updated_at)
            VALUES (%s, %s, NOW())
            ON CONFLICT (machine_id) DO UPDATE
               SET last_order = EXCLUDED.last_order,
                   updated_at = NOW()
            """,
            (MACHINE_ID, order),
        )


def _is_duplicate(pg: psycopg2.extensions.connection, content_hash: str) -> bool:
    with pg.cursor() as cur:
        cur.execute(
            """
            SELECT 1 FROM win_notify_dedup
            WHERE content_hash = %s
              AND spoken_at > NOW() - INTERVAL '%s seconds'
            """,
            (content_hash, _DEDUP_WINDOW_SEC),
        )
        return cur.fetchone() is not None


def _record_dedup(pg: psycopg2.extensions.connection, content_hash: str, app: str) -> None:
    with pg.cursor() as cur:
        cur.execute(
            """
            INSERT INTO win_notify_dedup (content_hash, app_name, spoken_at)
            VALUES (%s, %s, NOW())
            ON CONFLICT (content_hash) DO UPDATE SET spoken_at = NOW()
            """,
            (content_hash, app),
        )


def _record_history(
    pg: psycopg2.extensions.connection,
    app: str,
    title: str,
    body: str,
    priority: str,
) -> None:
    with pg.cursor() as cur:
        cur.execute(
            """
            INSERT INTO win_notify_history (machine_id, app_name, title, body, priority, spoken_at)
            VALUES (%s, %s, %s, %s, %s, NOW())
            """,
            (MACHINE_ID, app, title, body, priority),
        )


def _cleanup_dedup(pg: psycopg2.extensions.connection) -> None:
    with pg.cursor() as cur:
        cur.execute(
            "DELETE FROM win_notify_dedup WHERE spoken_at < NOW() - INTERVAL '1 hour'"
        )


# ── WPN system database reader ────────────────────────────────────────────────
# The WPN database is a Windows system SQLite file managed by the OS.
# We open it read-only to receive live notification data; no app state is stored here.

def _wpn_open() -> sqlite3.Connection:
    if not _WPN_DB.exists():
        raise FileNotFoundError(
            f"WPN database not found at {_WPN_DB}. "
            "Windows notification platform database is missing."
        )
    conn = sqlite3.connect(_WPN_DB.as_uri() + "?mode=ro", uri=True, timeout=3)
    conn.row_factory = sqlite3.Row
    return conn


def _wpn_max_order(wpn: sqlite3.Connection) -> int:
    row = wpn.execute('SELECT COALESCE(MAX("Order"), 0) FROM Notification').fetchone()
    return row[0] if row else 0


def _wpn_fetch_new(wpn: sqlite3.Connection, after_order: int) -> list[sqlite3.Row]:
    return wpn.execute(
        """
        SELECT n."Order", n.Type, n.Payload, h.PrimaryId
        FROM   Notification n
        JOIN   NotificationHandler h ON n.HandlerId = h.RecordId
        WHERE  n."Order" > ?
          AND  n.Type = 'toast'
          AND  n.Payload IS NOT NULL
        ORDER  BY n."Order" ASC
        """,
        (after_order,),
    ).fetchall()


# ── Main loop ─────────────────────────────────────────────────────────────────

def _watch_loop() -> None:
    if not _WPN_DB.exists():
        print(f"[win-notify] WPN database not found at {_WPN_DB}", flush=True)
        sys.exit(1)

    print(f"[win-notify] Connecting to PostgreSQL for state management…", flush=True)
    pg: Optional[psycopg2.extensions.connection] = None
    wpn: Optional[sqlite3.Connection] = None
    last_order = 0
    poll_count = 0

    while True:
        try:
            # ── Reconnect PostgreSQL if needed ────────────────────────────
            if pg is None or pg.closed:
                pg = _pg_connect()
                _ensure_schema(pg)
                last_order = _load_watermark(pg)
                print(
                    f"[win-notify] PostgreSQL connected. "
                    f"Resuming from watermark Order={last_order}.",
                    flush=True,
                )

            # ── Reconnect WPN system database if needed ───────────────────
            if wpn is None:
                wpn = _wpn_open()
                # If no persisted watermark (first run), snapshot current max
                if last_order == 0:
                    last_order = _wpn_max_order(wpn)
                    _save_watermark(pg, last_order)
                print(
                    f"[win-notify] WPN system database open. "
                    f"Watching for new notifications after Order={last_order}.",
                    flush=True,
                )

            # ── Fetch new rows from WPN system database ───────────────────
            rows = _wpn_fetch_new(wpn, last_order)

            for row in rows:
                order     = row["Order"]
                pid       = row["PrimaryId"] or ""
                payload   = row["Payload"]

                title, body = _parse_toast_xml(payload)
                app = _friendly_name(pid)

                if not title and not body:
                    last_order = max(last_order, order)
                    continue

                # Special: Cursor agent "Done" toasts — bypass IGNORE, emit SSE, no speech.
                if "anysphere.cursor" in pid.lower() or app == "Cursor":
                    _post_json(
                        f"{PC_AGENT_URL}/voice/event",
                        {
                            "type": "cursor_agent_done",
                            "task": title,
                            "detail": body,
                            "ts": int(time.time()),
                        },
                        secret=PC_AGENT_SECRET,
                    )
                    print(f"[win-notify] [Cursor done] {title!r}", flush=True)
                    last_order = max(last_order, order)
                    continue

                if not _should_include(app, pid):
                    last_order = max(last_order, order)
                    continue

                chash = _content_hash(app, title, body)
                if _is_duplicate(pg, chash):
                    last_order = max(last_order, order)
                    continue

                priority = "1" if _is_messaging(pid) else GENERIC_PRIORITY

                print(
                    f"[win-notify] [{app}] {title!r}"
                    + (f" — {body!r}" if body else ""),
                    flush=True,
                )

                _speak(app, title, body, priority=priority)
                _record_dedup(pg, chash, app)
                _record_history(pg, app, title, body, priority)

                last_order = max(last_order, order)

            # Persist watermark to PostgreSQL after each poll
            if rows:
                _save_watermark(pg, last_order)

            # Periodic dedup cleanup
            poll_count += 1
            if poll_count % _DEDUP_CLEANUP_EVERY == 0:
                _cleanup_dedup(pg)

        except sqlite3.OperationalError as exc:
            err = str(exc).lower()
            if "locked" in err or "unable to open" in err:
                print(f"[win-notify] WPN DB temporarily unavailable ({exc}), retrying…", flush=True)
            else:
                print(f"[win-notify] WPN DB error: {exc}", flush=True)
            if wpn:
                try:
                    wpn.close()
                except Exception:
                    pass
            wpn = None

        except (psycopg2.OperationalError, psycopg2.InterfaceError) as exc:
            print(f"[win-notify] PostgreSQL error: {exc} — reconnecting in 5s…", flush=True)
            if pg and not pg.closed:
                try:
                    pg.close()
                except Exception:
                    pass
            pg = None
            time.sleep(5)
            continue

        except Exception as exc:
            print(f"[win-notify] unexpected error: {exc}", flush=True)

        time.sleep(POLL_SEC)


if __name__ == "__main__":
    print("[win-notify] Starting Windows notification watcher (PostgreSQL state)…", flush=True)
    if not DATABASE_URL:
        print(
            "[win-notify] ERROR: OPENCLAW_DATABASE_URL is not set in .env. "
            "Add postgresql://... to .env and restart.",
            flush=True,
        )
        sys.exit(1)
    try:
        _watch_loop()
    except KeyboardInterrupt:
        print("\n[win-notify] Stopped.", flush=True)
