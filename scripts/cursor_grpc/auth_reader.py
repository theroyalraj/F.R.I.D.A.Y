#!/usr/bin/env python3
"""Read Cursor authentication from local SQLite (read-only). Adapted from community demos."""

from __future__ import annotations

import json
import platform
import sqlite3
from pathlib import Path
from typing import Any, Dict, Optional

from .constants import CURSOR_EMBEDDED_AI_KEY


class CursorAuthReader:
    def __init__(self) -> None:
        self.cursor_data_path = self._find_cursor_data_path()
        self.storage_path: Optional[Path] = None
        if self.cursor_data_path:
            for path in [
                self.cursor_data_path / "globalStorage" / "state.vscdb",
                self.cursor_data_path / "storage" / "state.vscdb",
                self.cursor_data_path / "state.vscdb",
                self.cursor_data_path / "globalStorage" / "storage.json",
            ]:
                if path.exists():
                    self.storage_path = path
                    break

    def _find_cursor_data_path(self) -> Optional[Path]:
        home = Path.home()
        system = platform.system()
        if system == "Linux":
            paths = [
                home / ".config" / "Cursor" / "User",
                home / ".config" / "cursor" / "User",
                home / ".cursor" / "User",
            ]
        elif system == "Darwin":
            paths = [
                home / "Library" / "Application Support" / "Cursor" / "User",
                home / "Library" / "Application Support" / "cursor" / "User",
            ]
        elif system == "Windows":
            paths = [
                home / "AppData" / "Roaming" / "Cursor" / "User",
                home / "AppData" / "Roaming" / "cursor" / "User",
            ]
        else:
            return None
        for path in paths:
            if path.exists():
                return path
        for base_path in paths:
            parent = base_path.parent
            if parent.exists():
                return parent
        return None

    def read_sqlite_storage(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        if not self.storage_path or self.storage_path.suffix != ".vscdb":
            return out
        try:
            db_uri = f"file:{self.storage_path}?mode=ro&immutable=1"
            conn = sqlite3.connect(db_uri, uri=True, timeout=10.0)
            cur = conn.cursor()
            for table in ("ItemTable", "cursorDiskKV"):
                try:
                    cur.execute(f"SELECT key, value FROM {table}")
                    for key, value in cur.fetchall():
                        if not key or not isinstance(key, str) or not key.startswith("cursorAuth/"):
                            continue
                        if isinstance(value, bytes):
                            value = value.decode("utf-8", errors="replace")
                        try:
                            out[key] = json.loads(value)
                        except Exception:
                            out[key] = value
                except sqlite3.Error:
                    continue
            conn.close()
        except Exception:
            pass
        return out

    def get_auth_tokens(self) -> Dict[str, Optional[str]]:
        tokens: Dict[str, Optional[str]] = {
            "access_token": None,
            "refresh_token": None,
            "openai_key": None,
            "claude_key": None,
            "google_key": None,
            "email": None,
            "stripe_customer_id": None,
            "membership_type": None,
            "embedded_ai_key": CURSOR_EMBEDDED_AI_KEY,
        }
        if not self.storage_path:
            return tokens
        storage = self.read_sqlite_storage()
        mapping = {
            "cursorAuth/accessToken": "access_token",
            "cursorAuth/refreshToken": "refresh_token",
            "cursorAuth/openAIKey": "openai_key",
            "cursorAuth/claudeKey": "claude_key",
            "cursorAuth/googleKey": "google_key",
            "cursorAuth/cachedEmail": "email",
            "cursorAuth/stripeCustomerId": "stripe_customer_id",
            "cursorAuth/stripeMembershipType": "membership_type",
        }
        for sk, tk in mapping.items():
            if sk in storage:
                tokens[tk] = storage[sk]
        return tokens

    def get_bearer_token(self) -> Optional[str]:
        return self.get_auth_tokens().get("access_token")
