#!/usr/bin/env python3
"""
cursor-thinking-ocr.py — periodic screenshot + Windows OCR of the Cursor window,
speak **new** reasoning prose (not code) in the background.

Cursor often omits thinking blocks from JSONL; this is a live screen-text fallback.

Requirements (see scripts/requirements-cursor-thinking-ocr.txt):
  pip install -r scripts/requirements-cursor-thinking-ocr.txt

Env (from .env):
  FRIDAY_CURSOR_THINKING_OCR — master switch (default false)
  FRIDAY_CURSOR_THINKING_OCR_INTERVAL_SEC — capture period (default 1.0)
  FRIDAY_CURSOR_THINKING_OCR_TITLE — substring to match window title (default: Cursor)
  FRIDAY_CURSOR_THINKING_OCR_RIGHT_PCT — use right N%% of window for capture (default 42;
    Composer / thinking usually sits on the right)
  FRIDAY_CURSOR_THINKING_OCR_MIN_DELTA_CHARS — minimum new prose chars before TTS (default 24)
  FRIDAY_CURSOR_THINKING_OCR_LANG — winocr language tag (default en)

Run:
  python scripts/cursor-thinking-ocr.py
  python scripts/cursor-thinking-ocr.py --once   # one frame, print OCR + exit (no TTS)
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import re
import sys
import time
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


def _env_bool(key: str, default: bool = False) -> bool:
    raw = os.environ.get(key, "").strip().lower()
    if raw == "":
        return default
    if raw in ("0", "false", "no", "off"):
        return False
    if raw in ("1", "true", "yes", "on"):
        return True
    return default


def _env_float(key: str, default: float) -> float:
    raw = os.environ.get(key, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _load_cursor_reply_watch():
    """Reuse strip_to_prose + paced thinking TTS from cursor-reply-watch.py."""
    p = Path(__file__).resolve().parent / "cursor-reply-watch.py"
    spec = importlib.util.spec_from_file_location("_crw_ocr_shim", p)
    if spec is None or spec.loader is None:
        raise RuntimeError("cursor-reply-watch.py not found")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _normalize_ocr(s: str) -> str:
    s = (s or "").replace("\r\n", "\n").replace("\r", "\n")
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def _longest_common_prefix(a: str, b: str) -> int:
    n = min(len(a), len(b))
    i = 0
    while i < n and a[i] == b[i]:
        i += 1
    return i


def _delta_text(prev: str, cur: str) -> str:
    """Best-effort new tail: streaming OCR may rewrite earlier lines."""
    prev_n = _normalize_ocr(prev)
    cur_n = _normalize_ocr(cur)
    if not cur_n:
        return ""
    if not prev_n:
        return cur_n
    if cur_n.startswith(prev_n):
        return cur_n[len(prev_n) :].strip()
    k = _longest_common_prefix(prev_n, cur_n)
    if k > int(0.55 * min(len(prev_n), len(cur_n))) and k >= 20:
        return cur_n[k:].strip()
    return cur_n


_RE_FILE_BASENAME = re.compile(
    r"(?:^|\s)([\w\-]+)\.(py|js|ts|tsx|jsx|mjs|json|md|yaml|yml|toml|rs|go|cs|java|txt|ps1)\b",
    re.IGNORECASE,
)


def _file_basenames_in_text(s: str) -> set[str]:
    return {
        f"{m.group(1)}.{m.group(2)}".lower()
        for m in _RE_FILE_BASENAME.finditer(s or "")
    }


def _friendly_file_mention(basename: str) -> str | None:
    name = (basename or "").strip()
    if not name or len(name) < 3 or "." not in name:
        return None
    stem, ext = name.rsplit(".", 1)
    return f"{stem.replace('_', ' ')} dot {ext}"


def _find_cursor_hwnd(title_sub: str):
    try:
        import win32gui
    except ImportError:
        print("cursor-thinking-ocr: install pywin32", file=sys.stderr)
        return None

    target = title_sub.strip() or "Cursor"
    result: list[int] = []

    def cb(hwnd, _):
        try:
            if not win32gui.IsWindowVisible(hwnd):
                return
            title = win32gui.GetWindowText(hwnd) or ""
            if target.lower() in title.lower():
                result.append(hwnd)
        except Exception:
            pass

    try:
        win32gui.EnumWindows(cb, None)
    except Exception:
        return None
    return result[0] if result else None


def _capture_hwnd_region(hwnd: int, right_pct: float):
    import mss
    import mss.tools
    from PIL import Image

    try:
        import win32gui
    except ImportError:
        return None

    try:
        if win32gui.IsIconic(hwnd):
            return None
        left, top, right, bottom = win32gui.GetWindowRect(hwnd)
    except Exception:
        return None

    w = max(1, right - left)
    h = max(1, bottom - top)
    pct = max(5.0, min(right_pct, 100.0))
    crop_w = max(80, int(w * (pct / 100.0)))
    cap_left = int(left + (w - crop_w))
    cap_top = int(top)
    region = {
        "left": cap_left,
        "top": cap_top,
        "width": crop_w,
        "height": h,
    }
    with mss.mss() as sct:
        shot = sct.grab(region)
        return Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")


def _ocr_pil(img, lang: str) -> str:
    import winocr

    try:
        r = winocr.recognize_pil_sync(img, lang=lang or "en")
        if isinstance(r, dict):
            return (r.get("text") or "").strip()
    except Exception as e:
        print(f"cursor-thinking-ocr: OCR failed: {e}", flush=True)
    return ""


def main() -> None:
    ap = argparse.ArgumentParser(description="OCR Cursor window and speak new thinking prose")
    ap.add_argument("--once", action="store_true", help="Single capture + print; no loop, no TTS")
    args = ap.parse_args()

    title_sub = os.environ.get("FRIDAY_CURSOR_THINKING_OCR_TITLE", "Cursor").strip()
    interval = max(0.25, _env_float("FRIDAY_CURSOR_THINKING_OCR_INTERVAL_SEC", 1.0))
    right_pct = max(5.0, min(100.0, _env_float("FRIDAY_CURSOR_THINKING_OCR_RIGHT_PCT", 42.0)))
    min_delta = max(4, int(_env_float("FRIDAY_CURSOR_THINKING_OCR_MIN_DELTA_CHARS", 24.0)))
    lang = (os.environ.get("FRIDAY_CURSOR_THINKING_OCR_LANG", "en") or "en").strip()

    if not args.once and not _env_bool("FRIDAY_CURSOR_THINKING_OCR", False):
        print(
            "cursor-thinking-ocr: FRIDAY_CURSOR_THINKING_OCR is off — set true in .env or pass --once",
            flush=True,
        )
        return

    crw = _load_cursor_reply_watch()
    strip_to_prose = crw.strip_to_prose
    speak_thinking = crw._speak_thinking_paced  # noqa: SLF001

    prev_raw = ""
    prev_file_basenames: set[str] | None = None

    if args.once:
        hwnd = _find_cursor_hwnd(title_sub)
        if not hwnd:
            print("cursor-thinking-ocr: no Cursor window", file=sys.stderr)
            sys.exit(2)
        img = _capture_hwnd_region(hwnd, right_pct)
        if img is None:
            print("cursor-thinking-ocr: capture failed", file=sys.stderr)
            sys.exit(3)
        t = _ocr_pil(img, lang)
        print(_normalize_ocr(t))
        return

    print(
        f"cursor-thinking-ocr: interval={interval}s right={right_pct}% title~={title_sub!r}",
        flush=True,
    )

    while True:
        hwnd = _find_cursor_hwnd(title_sub)
        if not hwnd:
            time.sleep(interval)
            continue
        img = _capture_hwnd_region(hwnd, right_pct)
        if img is None:
            time.sleep(interval)
            continue
        raw = _ocr_pil(img, lang)
        norm = _normalize_ocr(raw)

        basenames = _file_basenames_in_text(norm)
        if prev_file_basenames is not None:
            new_names = basenames - prev_file_basenames
            if new_names:
                pick = sorted(new_names)[0]
                mention = _friendly_file_mention(pick)
                if mention:
                    file_line = f"Switching context — looks like {mention}."
                    speak_thinking(
                        file_line,
                        incremental=True,
                        rate_basis_len=len(file_line),
                    )
        prev_file_basenames = set(basenames)

        delta = _delta_text(prev_raw, norm)
        prev_raw = norm

        prose = strip_to_prose(delta) if delta else ""
        if prose and len(re.sub(r"[^a-zA-Z0-9]", "", prose)) >= min_delta:
            speak_thinking(prose, incremental=True, rate_basis_len=len(norm))

        time.sleep(interval)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("cursor-thinking-ocr: stopped.", flush=True)
        sys.exit(0)
