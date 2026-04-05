#!/usr/bin/env python3
"""
Thinking TTS smoke test — default path matches cursor-thinking-ocr.py (not JSONL tailing).

OCR pipeline (same as cursor-thinking-ocr.py):
  strip_to_prose(delta) → _scrub_for_speech(prose) → gates → _speak_thinking_paced(..., incremental=True)

Use this when you use FRIDAY_CURSOR_THINKING_OCR and want to verify the same voice, rate, and chunking
without running a live screen capture.

Optional --jsonl appends one synthetic type=thinking line for cursor-reply-watch.py (legacy JSONL path).

Usage:
  python scripts/cursor-watcher-smoke-thinking.py
  python scripts/cursor-watcher-smoke-thinking.py "Your prose here — no env names or code."
  python scripts/cursor-watcher-smoke-thinking.py --jsonl   # watcher / JSONL test only

Requires: same as cursor-reply-watch (friday_speaker, etc.). No need for cursor-reply-watch process when
using the default OCR-equivalent path.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
import time
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
_ENV = _ROOT / ".env"
if _ENV.exists():
    for line in _ENV.read_text(encoding="utf-8").splitlines():
        t = line.strip()
        if not t or t.startswith("#") or "=" not in t:
            continue
        k, _, rest = t.partition("=")
        k, v = k.strip(), rest.split("#", 1)[0].strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


def _env_float(key: str, default: float) -> float:
    raw = os.environ.get(key, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _load_cursor_reply_watch():
    p = Path(__file__).resolve().parent / "cursor-reply-watch.py"
    spec = importlib.util.spec_from_file_location("_crw_smoke_shim", p)
    if spec is None or spec.loader is None:
        raise RuntimeError("cursor-reply-watch.py not found")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _load_cursor_thinking_ocr():
    p = Path(__file__).resolve().parent / "cursor-thinking-ocr.py"
    spec = importlib.util.spec_from_file_location("_ocr_smoke_shim", p)
    if spec is None or spec.loader is None:
        raise RuntimeError("cursor-thinking-ocr.py not found")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _transcripts_root() -> Path:
    return Path(
        os.environ.get(
            "CURSOR_TRANSCRIPTS_DIR",
            r"C:\Users\rajut\.cursor\projects\d-code-openclaw\agent-transcripts",
        )
    ).resolve()


def _run_ocr_equivalent(prose_raw: str) -> int:
    crw = _load_cursor_reply_watch()
    ocr = _load_cursor_thinking_ocr()
    strip_to_prose = crw.strip_to_prose
    scrub = ocr._scrub_for_speech
    speak_thinking = crw._speak_thinking_paced  # noqa: SLF001

    min_delta = max(4, int(_env_float("FRIDAY_CURSOR_THINKING_OCR_MIN_DELTA", 20.0)))
    prose_pass1 = strip_to_prose(prose_raw)
    prose = scrub(prose_pass1)
    alpha_chars = len(re.sub(r"[^a-zA-Z]", "", prose))
    word_count = len(prose.split())

    if alpha_chars < min_delta or word_count < 3:
        print(
            f"cursor-watcher-smoke-thinking: after strip and scrub, prose too short "
            f"({alpha_chars} alpha chars, {word_count} words; need >={min_delta} chars and >=3 words). "
            f"Try longer human prose without heavy code or symbols.",
            file=sys.stderr,
        )
        return 2
    if not prose.strip():
        print("cursor-watcher-smoke-thinking: empty prose after strip_to_prose and scrub.", file=sys.stderr)
        return 2

    basis = len(prose)
    print(
        f"cursor-watcher-smoke-thinking: OCR-equivalent speak ({alpha_chars} alpha chars, {word_count} words) — "
        f"first line: {prose[:72]!r}…",
        flush=True,
    )
    speak_thinking(prose, incremental=True, rate_basis_len=basis)
    return 0


def _run_jsonl_append(thinking: str) -> int:
    chat_id = (os.environ.get("CURSOR_SMOKE_CHAT_ID") or "").strip()
    _session = _ROOT / ".session-voice.json"
    if not chat_id and _session.exists():
        try:
            chat_id = (json.loads(_session.read_text(encoding="utf-8")).get("chat_id") or "").strip()
        except Exception:
            chat_id = ""

    if not chat_id:
        print(
            "cursor-watcher-smoke-thinking: --jsonl needs chat_id — set CURSOR_SMOKE_CHAT_ID or .session-voice.json",
            file=sys.stderr,
        )
        return 2

    root = _transcripts_root()
    jsonl = root / chat_id / f"{chat_id}.jsonl"
    if not jsonl.is_file():
        print(f"cursor-watcher-smoke-thinking: missing transcript file: {jsonl}", file=sys.stderr)
        return 2

    line_obj = {
        "role": "assistant",
        "message": {
            "content": [
                {
                    "type": "thinking",
                    "thinking": thinking,
                    "final": True,
                }
            ],
            "final": True,
        },
    }
    line = json.dumps(line_obj, ensure_ascii=False) + "\n"
    with jsonl.open("a", encoding="utf-8") as f:
        f.write(line)

    print(f"cursor-watcher-smoke-thinking: --jsonl appended one thinking line to {jsonl}", flush=True)
    print("Ensure cursor-reply-watch.py is running with thinking capture on.", flush=True)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Thinking TTS smoke: OCR-equivalent path (default) or --jsonl.")
    ap.add_argument(
        "--jsonl",
        action="store_true",
        help="Append synthetic thinking line to main Composer JSONL (watcher test) instead of direct TTS.",
    )
    ap.add_argument(
        "text",
        nargs="*",
        help="Prose to speak (OCR path) or thinking body (--jsonl). Default: Agra sample prose.",
    )
    args = ap.parse_args()
    custom = " ".join(args.text).strip()
    ts = int(time.time())

    if args.jsonl:
        thinking = custom or (
            f"JSONL watcher smoke at second {ts}. Thinking about Agra: the Taj Mahal and the Yamuna riverfront. "
            f"If you hear this, cursor-reply-watch read this line from the transcript file."
        )
        return _run_jsonl_append(thinking)

    prose_raw = custom or (
        "So for this smoke test I am thinking about Agra. The Taj Mahal faces the Yamuna and the old fort "
        "still anchors the north side of town. If you hear this in the same cadence as screen OCR thinking, "
        "the strip and scrub path matched the live OCR daemon."
    )
    return _run_ocr_equivalent(prose_raw)


if __name__ == "__main__":
    raise SystemExit(main())
