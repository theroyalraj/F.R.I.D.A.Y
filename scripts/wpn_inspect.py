#!/usr/bin/env python3
"""
wpn_inspect.py — quick read-only inspection of the Windows WPN notification database.
Shows recent notification handlers and the last 10 toast entries so we can find
the PrimaryId Cursor uses for its toast notifications.

Run:  python scripts/wpn_inspect.py
"""
import os
import sqlite3
from pathlib import Path

_DB = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "Windows" / "Notifications" / "wpndatabase.db"

def main():
    if not _DB.exists():
        print(f"WPN DB not found at {_DB}")
        return

    try:
        conn = sqlite3.connect(_DB.as_uri() + "?mode=ro", uri=True, timeout=5)
        conn.row_factory = sqlite3.Row
    except Exception as e:
        print(f"Could not open WPN DB: {e}")
        return

    print("=== NotificationHandler — all registered apps ===")
    try:
        rows = conn.execute("SELECT PrimaryId, CreatedTime FROM NotificationHandler ORDER BY CreatedTime DESC").fetchall()
        for r in rows:
            pid = r["PrimaryId"] or ""
            lower = pid.lower()
            tag = ""
            if "cursor" in lower or "anysphere" in lower:
                tag = " *** CURSOR ***"
            elif "whatsapp" in lower or "yourphone" in lower:
                tag = " [WhatsApp/Phone Link]"
            elif "telegram" in lower:
                tag = " [Telegram]"
            print(f"  {pid}{tag}")
    except Exception as e:
        print(f"  error: {e}")

    print()
    print("=== Last 15 toast Notifications (newest first) ===")
    try:
        rows = conn.execute(
            """
            SELECT n."Order", n.Type, n.Payload, h.PrimaryId
            FROM   Notification n
            JOIN   NotificationHandler h ON n.HandlerId = h.RecordId
            WHERE  n.Type = 'toast'
            ORDER  BY n."Order" DESC
            LIMIT  15
            """
        ).fetchall()
        for r in rows:
            pid = r["PrimaryId"] or ""
            payload = r["Payload"] or ""
            preview = (payload[:120].replace("\n", " ") if isinstance(payload, str)
                       else payload[:120].decode("utf-8", errors="replace").replace("\n", " "))
            print(f"  Order={r['Order']} | {pid[:60]}")
            print(f"    {preview}")
    except Exception as e:
        print(f"  error: {e}")

    conn.close()


if __name__ == "__main__":
    main()
