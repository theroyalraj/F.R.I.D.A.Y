"""
Short mail lines for TTS — shared by win-notify-watch.py and gmail-watch.py.
Speaks: by whom + a capped snippet only (no long Nova intros, no full body).
Env (first match wins):
  FRIDAY_MAIL_SPEAK_SNIP_CHARS
  FRIDAY_WIN_NOTIFY_MAIL_SNIP_CHARS
  FRIDAY_EMAIL_SPEAK_SNIP_CHARS
Default 120 characters for the snippet after the sender line.
"""
from __future__ import annotations

import os
import re


def mail_snip_max_chars() -> int:
    for key in (
        "FRIDAY_MAIL_SPEAK_SNIP_CHARS",
        "FRIDAY_WIN_NOTIFY_MAIL_SNIP_CHARS",
        "FRIDAY_EMAIL_SPEAK_SNIP_CHARS",
    ):
        raw = os.environ.get(key, "").strip()
        if raw:
            try:
                n = int(raw)
                return max(40, min(400, n))
            except ValueError:
                pass
    return 120


def strip_browser_prefix(s: str) -> str:
    """Windows sometimes embeds 'Chrome:' inside the toast text — not only the app id."""
    t = (s or "").strip()
    while t:
        low = t.lower()
        stripped = False
        for p in ("google chrome:", "chrome:", "microsoft edge:", "edge:"):
            if low.startswith(p):
                t = t[len(p) :].strip()
                stripped = True
                break
        if not stripped:
            break
    return t


def clean_mail_noise(s: str) -> str:
    """Strip URLs and mail UI noise from a toast or line."""
    if not s:
        return ""
    t = s.strip()
    t = strip_browser_prefix(t)
    t = re.sub(r"https?://[^\s]+", " ", t, flags=re.I)
    t = re.sub(r"\bmail\.google\.com[^\s]*", " ", t, flags=re.I)
    t = re.sub(r"\bwww\.[^\s]+", " ", t, flags=re.I)
    t = re.sub(r"\bstatus\?\s*$", "", t, flags=re.I)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def strip_re_fwd(s: str) -> str:
    t = (s or "").strip()
    low = t.lower()
    for p in ("re:", "fwd:", "fw:"):
        if low.startswith(p):
            t = t[len(p) :].strip()
            low = t.lower()
    return t


def short_mail_snippet(s: str, max_chars: int | None = None) -> str:
    """First sentence or a short prefix — never a wall of text."""
    if max_chars is None:
        max_chars = mail_snip_max_chars()
    if not s:
        return ""
    s = strip_re_fwd(s).strip()
    if not s:
        return ""
    s = clean_mail_noise(s)
    if not s:
        return ""
    if len(s) <= max_chars:
        return s
    for sep in (". ", "! ", "? "):
        idx = s.find(sep)
        if 10 <= idx <= max_chars + 40:
            return s[: idx + 1].strip()
    cut = s[:max_chars]
    sp = cut.rfind(" ")
    if sp > max_chars // 2:
        return cut[:sp].strip() + "…"
    return cut.strip() + "…"


def build_mail_from_snippet(who: str, raw_message: str) -> str:
    """Spoken line: Mail from {who}. {snippet}."""
    w = strip_browser_prefix((who or "").strip())
    raw = strip_browser_prefix((raw_message or "").strip())
    if raw.lower() == w.lower():
        raw = ""
    msg = short_mail_snippet(raw) if raw else ""
    if w and msg:
        return f"Mail from {w}. {msg}"
    if w:
        return f"Mail from {w}."
    if msg:
        return f"Mail. {msg}"
    return "New mail."
