#!/usr/bin/env python3
"""
gmail.py — Read, search and list Gmail via IMAP (built-in Python, no extra deps).

Usage:
  python scripts/gmail.py list [--count N] [--folder FOLDER] [--offset N]
  python scripts/gmail.py read <UID>
  python scripts/gmail.py search <query>
  python scripts/gmail.py unread [--count N] [--offset N]

Config (env or .env):
  GMAIL_ADDRESS   your Gmail address
  GMAIL_APP_PWD   16-char App Password (no spaces)
"""
from __future__ import annotations
import email
import email.header
import imaplib
import json
import os
import sys
import textwrap
from pathlib import Path
from email.utils import parsedate_to_datetime

# ── Load .env ─────────────────────────────────────────────────────────────────
_root = Path(__file__).resolve().parent.parent
_env  = _root / ".env"
if _env.exists():
    for _line in _env.read_text(encoding="utf-8").splitlines():
        _t = _line.strip()
        if not _t or _t.startswith("#"): continue
        _i = _t.find("=")
        if _i < 1: continue
        _k = _t[:_i].strip()
        _v = _t[_i+1:].split("#")[0].strip().strip('"').strip("'")
        if _k not in os.environ:
            os.environ[_k] = _v

GMAIL_ADDRESS = os.environ.get("GMAIL_ADDRESS", "").strip()
GMAIL_APP_PWD = os.environ.get("GMAIL_APP_PWD", "").strip().replace(" ", "")
IMAP_HOST     = "imap.gmail.com"
IMAP_PORT     = 993

def _connect() -> imaplib.IMAP4_SSL:
    if not GMAIL_ADDRESS or not GMAIL_APP_PWD:
        print("ERROR: set GMAIL_ADDRESS and GMAIL_APP_PWD in .env", file=sys.stderr)
        sys.exit(1)
    m = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
    m.login(GMAIL_ADDRESS, GMAIL_APP_PWD)
    return m

def _decode_header(raw: str) -> str:
    parts = email.header.decode_header(raw or "")
    out = []
    for part, enc in parts:
        if isinstance(part, bytes):
            out.append(part.decode(enc or "utf-8", errors="replace"))
        else:
            out.append(str(part))
    return "".join(out)

def _fetch_envelope(m: imaplib.IMAP4_SSL, uid: str) -> dict:
    _, data = m.uid("fetch", uid, "(RFC822.HEADER)")
    msg = email.message_from_bytes(data[0][1])
    date_str = msg.get("Date", "")
    try:
        date = parsedate_to_datetime(date_str).strftime("%Y-%m-%d %H:%M")
    except Exception:
        date = date_str
    return {
        "uid":     uid.decode() if isinstance(uid, bytes) else uid,
        "from":    _decode_header(msg.get("From", "")),
        "subject": _decode_header(msg.get("Subject", "(no subject)")),
        "date":    date,
    }

def _fetch_full(m: imaplib.IMAP4_SSL, uid: str) -> dict:
    _, data = m.uid("fetch", uid, "(RFC822)")
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
    date_str = msg.get("Date", "")
    try:
        date = parsedate_to_datetime(date_str).strftime("%Y-%m-%d %H:%M")
    except Exception:
        date = date_str
    return {
        "uid":     uid.decode() if isinstance(uid, bytes) else uid,
        "from":    _decode_header(msg.get("From", "")),
        "to":      _decode_header(msg.get("To", "")),
        "subject": _decode_header(msg.get("Subject", "(no subject)")),
        "date":    date,
        "body":    textwrap.shorten(body.strip(), width=4000, placeholder="… [truncated]"),
    }

def _paginate_uids(raw_uids: list, count: int, offset: int) -> list:
    """Return up to ``count`` UIDs, skipping the newest ``offset`` (older mail page)."""
    if not raw_uids:
        return []
    count = max(1, int(count))
    offset = max(0, int(offset))
    if offset >= len(raw_uids):
        return []
    if offset == 0:
        picked = raw_uids[-count:]
    else:
        picked = raw_uids[-(offset + count) : -offset]
    return picked


def cmd_list(args):
    count = int(_arg(args, "--count", "10"))
    off = int(_arg(args, "--offset", "0"))
    folder = _arg(args, "--folder", "INBOX")
    m = _connect()
    m.select(folder, readonly=True)
    _, uids = m.uid("search", None, "ALL")
    all_uids = uids[0].split()
    picked = _paginate_uids(all_uids, count, off)
    results = [_fetch_envelope(m, u) for u in reversed(picked)]
    m.logout()
    print(json.dumps(results, ensure_ascii=False, indent=2))

def cmd_unread(args):
    count = int(_arg(args, "--count", "10"))
    off = int(_arg(args, "--offset", "0"))
    m = _connect()
    m.select("INBOX", readonly=True)
    _, uids = m.uid("search", None, "UNSEEN")
    all_uids = uids[0].split()
    picked = _paginate_uids(all_uids, count, off)
    results = [_fetch_envelope(m, u) for u in reversed(picked)]
    m.logout()
    print(json.dumps(results, ensure_ascii=False, indent=2))

def cmd_read(args):
    if not args:
        print("Usage: gmail.py read <UID>", file=sys.stderr); sys.exit(1)
    uid = args[0].encode()
    m = _connect()
    m.select("INBOX", readonly=True)
    result = _fetch_full(m, uid)
    m.logout()
    print(json.dumps(result, ensure_ascii=False, indent=2))

def cmd_search(args):
    if not args:
        print("Usage: gmail.py search <query>", file=sys.stderr); sys.exit(1)
    query = " ".join(args)
    m = _connect()
    m.select("INBOX", readonly=True)
    _, uids = m.uid("search", None, f'SUBJECT "{query}"')
    all_uids = uids[0].split()[-10:]
    results = [_fetch_envelope(m, u) for u in reversed(all_uids)]
    m.logout()
    print(json.dumps(results, ensure_ascii=False, indent=2))

def _arg(args, flag, default):
    for i, a in enumerate(args):
        if a == flag and i + 1 < len(args):
            return args[i + 1]
    return default

def main():
    argv = sys.argv[1:]
    if not argv:
        print(__doc__); sys.exit(0)
    cmd  = argv[0]
    rest = argv[1:]
    {"list": cmd_list, "unread": cmd_unread, "read": cmd_read, "search": cmd_search}.get(
        cmd, lambda _: (print(f"Unknown command: {cmd}", file=sys.stderr), sys.exit(1))
    )(rest)

if __name__ == "__main__":
    main()
