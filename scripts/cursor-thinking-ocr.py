#!/usr/bin/env python3
"""
SAGE — Head of Research (cursor-thinking-ocr.py).

High-frequency screenshot + Windows OCR of the Cursor right strip. Speaks only when:
  1) JSONL shows the Composer in a pre-tool assistant turn (thinking window), and
  2) OCR text passes reasoning heuristics (not idle chat or your typing in that strip).

Voice / persona: OPENCLAW_SAGE_VOICE, OPENCLAW_SAGE_RATE (see openclaw_company.py).

What it does NOT speak:
  - Lines that look like code (assignments, function calls, import, def, etc.)
  - ALL_CAPS_SNAKE env/constant names
  - camelCase or snake_case identifiers
  - Underscores, curly braces, symbols that sound broken when spoken
  - Any time the model has already started tool_use in the latest assistant JSONL line

What it DOES speak:
  - Prose reasoning during allowed window only
  - Human-style context hints when a code/env/config change is detected (throttled)
  - A short human summary when a thinking burst ends (allowed window only)

Requirements: pip install -r scripts/requirements-cursor-thinking-ocr.txt

Env (from .env):
  FRIDAY_SAGE_ENABLED / FRIDAY_CURSOR_THINKING_OCR — master (SAGE wins if set)
  FRIDAY_CURSOR_THINKING_OCR_INTERVAL_SEC — capture period (default 0.1)
  FRIDAY_CURSOR_THINKING_OCR_TITLE        — window title substring (default: Cursor)
  FRIDAY_CURSOR_THINKING_OCR_RIGHT_PCT    — right-side crop %% (default 35)
  FRIDAY_CURSOR_THINKING_OCR_MIN_DELTA    — min clean prose chars before TTS (default 20)
  FRIDAY_CURSOR_THINKING_OCR_LANG         — winocr language tag (default en)
  FRIDAY_CURSOR_THINKING_OCR_SUMMARY_GAP  — idle seconds before end-summary (default 2.5)
  FRIDAY_CURSOR_THINKING_OCR_IDLE_SEC     — idle seconds to stop speaking (default 1.8)
  FRIDAY_CURSOR_THINKING_OCR_HASH_PX      — pixel hash thumbnail height (default 36)

Run:
  python scripts/cursor-thinking-ocr.py
  python scripts/cursor-thinking-ocr.py --once   # snapshot OCR, no TTS
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import os
import random
import re
import sys
import time
from collections import deque
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
    """Reuse strip_to_prose + paced TTS from cursor-reply-watch.py."""
    p = Path(__file__).resolve().parent / "cursor-reply-watch.py"
    spec = importlib.util.spec_from_file_location("_crw_ocr_shim", p)
    if spec is None or spec.loader is None:
        raise RuntimeError("cursor-reply-watch.py not found")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ── Pixel hash gate ───────────────────────────────────────────────────────────

def _image_hash(img, hash_px: int) -> str:
    h = max(18, hash_px)
    w = max(32, int(h * 16 / 9))
    try:
        thumb = img.resize((w, h))
        return hashlib.md5(thumb.tobytes()).hexdigest()[:10]
    except Exception:
        return ""


# ── Adaptive TTS rate ─────────────────────────────────────────────────────────

_rate_ring: deque[tuple[float, int]] = deque()
_RATE_WINDOW_SEC = 2.0


def _record_chars(n: int) -> None:
    _rate_ring.append((time.monotonic(), n))


def _chars_per_sec() -> float:
    now = time.monotonic()
    while _rate_ring and now - _rate_ring[0][0] > _RATE_WINDOW_SEC:
        _rate_ring.popleft()
    if not _rate_ring:
        return 0.0
    total = sum(n for _, n in _rate_ring)
    span = now - _rate_ring[0][0] if len(_rate_ring) > 1 else 0.5
    return total / max(span, 0.1)


def _cps_to_rate_basis(cps: float) -> int:
    if cps >= 120:
        return 60
    if cps >= 60:
        return 180
    if cps >= 25:
        return 420
    if cps >= 8:
        return 900
    return 1500


# ── Smart delta classification ────────────────────────────────────────────────

# Patterns that signal the delta is code / config / not human prose
_RE_ENV_ASSIGN = re.compile(r"^[A-Z][A-Z0-9_]{2,}\s*=", re.MULTILINE)
_RE_UPPER_SNAKE = re.compile(r"\b[A-Z][A-Z0-9_]{3,}\b")
_RE_SNAKE_IDENT = re.compile(r"\b\w+_\w+\b")  # any_word_with_underscores
_RE_CAMEL_IDENT = re.compile(r"\b[a-z][A-Z]\w*\b")  # camelCase start
_RE_CODE_FRAG = re.compile(
    r"(?:def |class |import |from |return |const |let |var |function |async |\$env:|\$\w|\{|\}|=>|===|!==)"
)
_RE_SYMBOLS_HEAVY = re.compile(r"[_={}()\[\]<>@#|\\]{2,}")


def _classify_delta(raw_delta: str) -> str:
    """Classify a raw OCR delta.

    Returns:
      'prose'   — human reasoning sentences worth speaking
      'env'     — .env / constant assignment change
      'code'    — code change (function, logic, etc.)
      'mixed'   — mix of prose + code; extract prose only
      'noise'   — pure symbols/garbage, skip entirely
    """
    s = raw_delta.strip()
    if not s:
        return "noise"

    lines = [l.strip() for l in s.splitlines() if l.strip()]
    if not lines:
        return "noise"

    env_lines = sum(1 for l in lines if _RE_ENV_ASSIGN.search(l))
    code_lines = sum(1 for l in lines if _RE_CODE_FRAG.search(l))
    symbol_lines = sum(1 for l in lines if _RE_SYMBOLS_HEAVY.search(l))
    total = len(lines)

    # Mostly env assignments
    if env_lines / total >= 0.5:
        return "env"
    # Mostly code
    if (code_lines + symbol_lines) / total >= 0.4:
        return "code"
    # Some code mixed in
    if (env_lines + code_lines) > 0:
        return "mixed"
    return "prose"


# Context hints spoken when a code/env change is detected (never the actual tokens)
_ENV_HINTS = [
    "Adjusting a config setting.",
    "Tweaking a setting.",
    "Updating the config.",
    "Changing a flag in the config.",
    "Tuning a value in the env file.",
]
_CODE_HINTS = [
    "Working through some code logic.",
    "Adjusting some code.",
    "Making a code change.",
    "Tweaking the implementation.",
    "Updating the code.",
]
_HINT_COOLDOWN_SEC = 8.0  # don't repeat a code/env hint more than once per N seconds


# ── Human speech cleaner (on top of strip_to_prose) ──────────────────────────

# Underscores used as word separators sound broken ("F R I D A Y underscore T T S")
_RE_UNDERSCORE_WORD = re.compile(r"\b(\w+)_(\w+)\b")
# ALL_CAPS tokens (env vars, constants)
_RE_ALL_CAPS_TOKEN = re.compile(r"\b[A-Z][A-Z0-9_]{2,}\b")
# Standalone symbols that don't belong in speech
_RE_LONE_SYMBOLS = re.compile(r"[_={}()\[\]|\\`<>@#$%^&*~]+")
# Lines that are mostly symbols/numbers after cleaning
_RE_ALPHANUM = re.compile(r"[a-zA-Z]")
# AI model name patterns — e.g. "claude-sonnet-4-5", "gpt-4o", "gemini-pro",
# "claude-4.6-sonnet-medium-thinking", "opus 4.6", "Gemini 1.5 Pro",
# "llama-3-70b-instruct", "deepseek-v3".
# Lines are matched as a whole (stripped). Spaces are allowed for display names like "opus 4.6".
_MODEL_FAMILY = (
    r"claude|gpt|gemini|llama|mistral|mixtral|qwen|deepseek|phi|falcon|"
    r"o1|o3|o4|command|titan|haiku|sonnet|opus|flash|thinking"
)
# Full-line match: entire line is a model name (with optional version/tier suffix)
_RE_MODEL_NAME_LINE = re.compile(
    r"^(" + _MODEL_FAMILY + r")[\w.\-/: ]*$",
    re.IGNORECASE,
)
# Inline token match: model family word followed by version/tier tokens
_RE_MODEL_NAME_TOKEN = re.compile(
    r"\b(" + _MODEL_FAMILY + r")[\s\-][\w.\-]{2,}",
    re.IGNORECASE,
)
# Known Cursor UI chrome strings that should never be spoken (exact or prefix match)
_UI_CHROME = re.compile(
    r"^("
    r"Agent|Ask|Edit|Chat|Composer|Settings|Files|Search|Source Control|"
    r"Extensions|Run and Debug|Explorer|Timeline|Outline|Problems|Output|"
    r"Terminal|Debug Console|Ports|Comments|Notifications|No Notifications|"
    r"Auto-run|Auto run|Max Request|Context|Add context|@ Mention|"
    r"Summarize|Summarise|Restore|Attach|Include|Exclude|Filter|"
    r"New Chat|New Conversation|New Thread|Send|Stop|Cancel|Retry|Regenerate|"
    r"Copy|Paste|Clear|Reset|Undo|Redo|Open|Close|Save|"
    r"Normal mode|Agent mode|Ask mode|Plan mode|"
    r"Thinking\.\.\.|Generating\.\.\.|Loading\.\.\.|Streaming\.\.\.|"
    r"Press Enter|Ctrl\+|Cmd\+|Alt\+|Shift\+"
    r").*$",
    re.IGNORECASE,
)


def _scrub_for_speech(text: str) -> str:
    """Aggressively clean text so it sounds like a human speaking."""
    s = text.strip()
    # Remove ALL_CAPS tokens (env vars, constants)
    s = _RE_ALL_CAPS_TOKEN.sub("", s)
    # Replace snake_case with a space (drop the identifier entirely if short)
    def _snake_sub(m: re.Match) -> str:
        # If it's a real word compound like "well_known", humanise; otherwise drop
        a, b = m.group(1), m.group(2)
        if len(a) > 5 or len(b) > 5:
            return ""  # likely an identifier — drop
        return f"{a} {b}"
    s = _RE_UNDERSCORE_WORD.sub(_snake_sub, s)
    # Remove model name tokens (e.g. "claude-sonnet-4-5", "gpt-4o") mid-sentence
    s = _RE_MODEL_NAME_TOKEN.sub("", s)
    # Remove lone symbols
    s = _RE_LONE_SYMBOLS.sub(" ", s)
    # Collapse whitespace
    s = re.sub(r"[ \t]{2,}", " ", s)
    # Drop lines that are UI chrome, model names, or lack alphabetic content
    lines_out = [
        l.strip() for l in s.splitlines()
        if l.strip()
        and not _RE_MODEL_NAME_LINE.match(l.strip())
        and not _UI_CHROME.match(l.strip())
        and len(_RE_ALPHANUM.findall(l)) >= 3
    ]
    s = " ".join(lines_out)
    s = re.sub(r"\s{2,}", " ", s).strip()
    return s


# ── End-of-session human summary ─────────────────────────────────────────────

_SUMMARY_OPENERS = [
    "Right, so basically — ",
    "Okay, the gist is — ",
    "So to pull that together — ",
    "Alright, in short — ",
    "So what I'm working out is — ",
    "The upshot is — ",
    "To sum that up — ",
    "Right then, so — ",
    "So the core of it is — ",
]


def _make_summary_text(session_prose: str) -> str:
    s = session_prose.strip()
    if not s:
        return ""
    tail = s[-240:] if len(s) > 240 else s
    m = re.search(r"[.!?…]\s+", tail)
    if m and len(tail) - m.end() > 30:
        tail = tail[m.end():]
    opener = random.choice(_SUMMARY_OPENERS)
    return opener + tail.strip()


# ── Text normalisation helpers ────────────────────────────────────────────────

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
    prev_n = _normalize_ocr(prev)
    cur_n = _normalize_ocr(cur)
    if not cur_n:
        return ""
    if not prev_n:
        return cur_n
    if cur_n.startswith(prev_n):
        return cur_n[len(prev_n):].strip()
    k = _longest_common_prefix(prev_n, cur_n)
    if k > int(0.55 * min(len(prev_n), len(cur_n))) and k >= 20:
        return cur_n[k:].strip()
    return cur_n


# ── Window capture helpers ────────────────────────────────────────────────────

def _find_cursor_hwnd(title_sub: str):
    try:
        import win32gui
    except ImportError:
        print("sage: install pywin32", file=sys.stderr)
        return None
    target = (title_sub or "Cursor").strip()
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


def _capture_hwnd_region(hwnd: int, right_pct: float, skip_top_pct: float = 0.0, skip_bottom_pct: float = 0.0):
    """Capture rightmost right_pct% of the window, optionally skipping top/bottom fractions.

    skip_top_pct / skip_bottom_pct are percentages of total window height (0–40).
    Use them to exclude the Cursor chat header and model-selector footer from the OCR crop.
    """
    import mss
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
    skip_t = max(0, int(h * (max(0.0, min(skip_top_pct, 40.0)) / 100.0)))
    skip_b = max(0, int(h * (max(0.0, min(skip_bottom_pct, 40.0)) / 100.0)))
    crop_h = max(80, h - skip_t - skip_b)
    region = {
        "left": int(left + (w - crop_w)),
        "top": int(top + skip_t),
        "width": crop_w,
        "height": crop_h,
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
        print(f"sage: OCR error: {e}", flush=True)
    return ""


# ── Main loop ─────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true", help="One frame, print OCR, no TTS")
    args = ap.parse_args()

    from openclaw_company import (
        JsonlThinkingGate,
        get_persona,
        prose_looks_like_reasoning,
        sage_ocr_master_enabled,
    )

    title_sub      = os.environ.get("FRIDAY_CURSOR_THINKING_OCR_TITLE", "Cursor").strip()
    interval       = max(0.05, _env_float("FRIDAY_CURSOR_THINKING_OCR_INTERVAL_SEC", 0.1))
    right_pct      = max(5.0, min(100.0, _env_float("FRIDAY_CURSOR_THINKING_OCR_RIGHT_PCT", 35.0)))
    min_delta      = max(4, int(_env_float("FRIDAY_CURSOR_THINKING_OCR_MIN_DELTA", 20.0)))
    lang           = (os.environ.get("FRIDAY_CURSOR_THINKING_OCR_LANG", "en") or "en").strip()
    sum_gap        = max(1.0, _env_float("FRIDAY_CURSOR_THINKING_OCR_SUMMARY_GAP", 2.5))
    idle_sec       = max(0.5, _env_float("FRIDAY_CURSOR_THINKING_OCR_IDLE_SEC", 1.8))
    hash_px        = max(18, int(_env_float("FRIDAY_CURSOR_THINKING_OCR_HASH_PX", 36)))
    # Vertical crop: skip the top N% (title bar / chat header) and bottom N% (model selector / input box)
    skip_top_pct   = max(0.0, min(40.0, _env_float("FRIDAY_CURSOR_THINKING_OCR_SKIP_TOP_PCT", 5.0)))
    skip_bottom_pct = max(0.0, min(40.0, _env_float("FRIDAY_CURSOR_THINKING_OCR_SKIP_BOTTOM_PCT", 15.0)))

    if not args.once and not sage_ocr_master_enabled():
        print("sage: off — set FRIDAY_SAGE_ENABLED=true or FRIDAY_CURSOR_THINKING_OCR=true", flush=True)
        return

    _sp = get_persona("sage")
    os.environ["FRIDAY_TTS_THINKING_VOICE"] = _sp.get("voice") or ""
    if (_sp.get("rate") or "").strip():
        os.environ["FRIDAY_CURSOR_THINKING_TTS_RATE"] = _sp["rate"].strip()

    crw = _load_cursor_reply_watch()
    strip_to_prose = crw.strip_to_prose
    speak_thinking = crw._speak_thinking_paced  # noqa: SLF001

    if args.once:
        hwnd = _find_cursor_hwnd(title_sub)
        if not hwnd:
            print("sage: no Cursor window", file=sys.stderr); sys.exit(2)
        img = _capture_hwnd_region(hwnd, right_pct, skip_top_pct, skip_bottom_pct)
        if img is None:
            print("sage: capture failed", file=sys.stderr); sys.exit(3)
        print(_normalize_ocr(_ocr_pil(img, lang)))
        return

    print(
        f"sage: interval={interval}s right={right_pct}% "
        f"skip_top={skip_top_pct}% skip_bottom={skip_bottom_pct}% "
        f"idle={idle_sec}s sum_gap={sum_gap}s voice={_sp.get('voice')}",
        flush=True,
    )

    prev_raw  = ""
    prev_hash = ""

    last_active_t  = 0.0
    session_prose  = ""
    summary_fired  = False
    last_hint_t    = 0.0  # throttle context hints

    gate = JsonlThinkingGate()
    prev_allowed = False

    while True:
        gate.refresh()
        gate.ingest()
        allowed = gate.ocr_allowed
        if allowed != prev_allowed:
            if allowed:
                prev_raw = ""
                prev_hash = ""
                session_prose = ""
                summary_fired = False
            prev_allowed = allowed
        if not allowed:
            time.sleep(interval)
            continue

        hwnd = _find_cursor_hwnd(title_sub)
        if not hwnd:
            time.sleep(interval)
            continue

        img = _capture_hwnd_region(hwnd, right_pct, skip_top_pct, skip_bottom_pct)
        if img is None:
            time.sleep(interval)
            continue

        # ── Pixel-hash gate — skip OCR when screen unchanged ──────────────────
        cur_hash = _image_hash(img, hash_px)
        if cur_hash and cur_hash == prev_hash:
            now = time.monotonic()
            if (
                not summary_fired
                and session_prose
                and last_active_t > 0
                and now - last_active_t >= sum_gap
            ):
                summary_text = _make_summary_text(session_prose)
                if summary_text and prose_looks_like_reasoning(summary_text, min_chars=16):
                    print(f"sage: [summary] {len(summary_text)}ch", flush=True)
                    speak_thinking(summary_text, incremental=False, rate_basis_len=len(summary_text))
                summary_fired = True
                session_prose = ""
            time.sleep(interval)
            continue
        prev_hash = cur_hash

        # ── Full OCR ──────────────────────────────────────────────────────────
        raw  = _ocr_pil(img, lang)
        norm = _normalize_ocr(raw)
        now  = time.monotonic()

        delta = _delta_text(prev_raw, norm)
        prev_raw = norm

        if not delta:
            time.sleep(interval)
            continue

        # ── Classify the delta ────────────────────────────────────────────────
        kind = _classify_delta(delta)

        if kind == "noise":
            time.sleep(interval)
            continue

        # For code/env: speak a brief human hint (throttled), not the raw tokens
        if kind in ("env", "code"):
            if now - last_hint_t >= _HINT_COOLDOWN_SEC:
                hint = random.choice(_ENV_HINTS if kind == "env" else _CODE_HINTS)
                print(f"sage: [{kind}] hint: {hint!r}", flush=True)
                speak_thinking(hint, incremental=True, rate_basis_len=len(hint))
                last_hint_t = now
            time.sleep(interval)
            continue

        # For prose or mixed: clean aggressively then check enough words remain
        # strip_to_prose (from cursor-reply-watch) removes code lines, markdown, paths
        prose_pass1 = strip_to_prose(delta)
        # Our extra scrub: remove ALL_CAPS tokens, underscored identifiers, lone symbols
        prose = _scrub_for_speech(prose_pass1)

        alpha_chars = len(re.sub(r"[^a-zA-Z]", "", prose))
        word_count  = len(prose.split())

        if alpha_chars < min_delta or word_count < 3:
            time.sleep(interval)
            continue

        if not prose_looks_like_reasoning(prose, min_chars=max(12, min_delta // 2)):
            time.sleep(interval)
            continue

        # ── Active thinking: adapt rate and speak ─────────────────────────────
        _record_chars(alpha_chars)
        cps = _chars_per_sec()

        is_idle_gap = last_active_t > 0 and (now - last_active_t) >= idle_sec
        if is_idle_gap:
            session_prose = ""
            summary_fired = False

        last_active_t = now
        session_prose = (session_prose + " " + prose).strip()

        rate_basis = _cps_to_rate_basis(cps)
        print(
            f"sage: +{alpha_chars}ch {cps:.0f}ch/s basis={rate_basis} | {prose[:70]!r}",
            flush=True,
        )
        speak_thinking(prose, incremental=True, rate_basis_len=rate_basis)

        time.sleep(interval)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("sage: stopped.", flush=True)
        sys.exit(0)
