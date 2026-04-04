"""
Windows foreground process helper — yield mic/TTS when the IDE has focus.

Used by friday-listen, friday-ambient, and friday-speak (optional) so dictation
or Cursor voice mode is not competed with by Friday.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path


def _env_bool(name: str, default: bool) -> bool:
    v = os.environ.get(name, "").strip().lower()
    if not v:
        return default
    return v in ("1", "true", "yes", "on")


def _defer_exe_hints() -> tuple[str, ...]:
    raw = os.environ.get("FRIDAY_DEFER_FOCUS_EXES", "").strip().lower()
    if not raw:
        return ("cursor",)
    parts = tuple(p.strip() for p in raw.split(",") if p.strip())
    return parts if parts else ("cursor",)


def foreground_exe_basename() -> str | None:
    """Lowercase basename of the foreground window's process (Windows only)."""
    if sys.platform != "win32":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32

        hwnd = user32.GetForegroundWindow()
        if not hwnd:
            return None
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if not pid.value:
            return None

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
        if not h:
            return None
        try:
            buf = ctypes.create_unicode_buffer(4096)
            size = wintypes.DWORD(4096)
            if not kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
                return None
            return Path(buf.value).name.lower()
        finally:
            kernel32.CloseHandle(h)
    except Exception:
        return None


def should_defer_voice_for_cursor() -> bool:
    """
    True when Friday should not capture mic or play ambient TTS — a configured
    app (default: Cursor) owns the foreground window.
    """
    if sys.platform != "win32":
        return False
    if not _env_bool("FRIDAY_DEFER_WHEN_CURSOR", True):
        return False
    exe = foreground_exe_basename()
    if not exe:
        return False
    for hint in _defer_exe_hints():
        if hint in exe:
            return True
    return False
