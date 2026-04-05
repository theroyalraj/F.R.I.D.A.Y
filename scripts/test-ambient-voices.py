#!/usr/bin/env python3
"""
Speak short lines for every Edge voice path friday-ambient can use (given .env).

- Default: only paths active with your current settings (if FRIDAY_AMBIENT_MAIN_VOICE_ONLY
  is true, that is usually just FRIDAY_TTS_VOICE).
- --probe-all: also speaks Hindi / Hinglish / optional AMBIENT + SUB voices so you can
  verify Edge routing before turning main-voice-only off.
- When set in .env: **FRIDAY_AMBIENT_CARETAKER_VOICES** (Hindi check-in sample each) and
  **FRIDAY_AMBIENT_MEME_ZONE_QUIP_VOICE** (default Neerja if unset).

Usage:
  python scripts/test-ambient-voices.py --dry-run
  python scripts/test-ambient-voices.py --pause 3
  python scripts/test-ambient-voices.py --probe-all
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEAK = ROOT / "skill-gateway" / "scripts" / "friday-speak.py"


def load_dotenv() -> None:
    env_path = ROOT / ".env"
    if not env_path.is_file():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        t = line.strip()
        if not t or t.startswith("#"):
            continue
        i = t.find("=")
        if i < 1:
            continue
        k = t[:i].strip()
        v = t[i + 1 :].split("#")[0].strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


def _main_voice_only() -> bool:
    v = os.environ.get("FRIDAY_AMBIENT_MAIN_VOICE_ONLY", "").strip().lower()
    return v in ("1", "true", "yes", "on")


def _no_window() -> dict:
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}


def _indic_override(text: str) -> str | None:
    sys.path.insert(0, str(ROOT / "skill-gateway" / "scripts"))
    try:
        from indic_tts_voice import edge_voice_override_for_text  # noqa: PLC0415

        return edge_voice_override_for_text(text)
    finally:
        try:
            sys.path.remove(str(ROOT / "skill-gateway" / "scripts"))
        except ValueError:
            pass


def build_cases(*, probe_all: bool) -> list[tuple[str, str, dict[str, str]]]:
    """
    Return list of (label, phrase, env_overrides) for friday-speak subprocess.
    env_overrides always merged with sticky bypass + optional FRIDAY_TTS_VOICE.
    """
    main_only = _main_voice_only()
    main_voice = (
        os.environ.get("FRIDAY_TTS_VOICE", "en-US-EmmaMultilingualNeural").strip()
        or "en-US-EmmaMultilingualNeural"
    )

    cases: list[tuple[str, str, dict[str, str]]] = []

    cases.append(
        (
            "ambient_main_FRIDAY_TTS_VOICE",
            f"Ambient main voice check. Using {main_voice.split('-')[-1] if main_voice else 'default'}.",
            {"FRIDAY_TTS_VOICE": main_voice},
        )
    )

    want_extra = (not main_only) or probe_all

    if want_extra:
        hi = "नमस्ते, यह हिंदी आवाज़ की जाँच है।"
        hi_v = _indic_override(hi)
        if hi_v:
            cases.append(
                (
                    "routing_devanagari" + ("_probe" if main_only else ""),
                    hi,
                    {"FRIDAY_TTS_VOICE": hi_v},
                )
            )

        hing = "Arre yaar, yeh Hinglish routing test hai — theek hai na?"
        hg_v = _indic_override(hing)
        if hg_v:
            cases.append(
                (
                    "routing_hinglish" + ("_probe" if main_only else ""),
                    hing,
                    {"FRIDAY_TTS_VOICE": hg_v},
                )
            )

        av = os.environ.get("FRIDAY_AMBIENT_TTS_VOICE", "").strip()
        if av:
            cases.append(
                (
                    "FRIDAY_AMBIENT_TTS_VOICE",
                    "Dedicated ambient alternate voice line.",
                    {"FRIDAY_TTS_VOICE": av},
                )
            )

        sub_rate = os.environ.get("FRIDAY_AMBIENT_SUB_VOICE_RATE", "+9%")
        sub_pitch = os.environ.get("FRIDAY_AMBIENT_SUB_VOICE_PITCH", "+3Hz")
        subv = os.environ.get("FRIDAY_AMBIENT_SUB_TTS_VOICE", "").strip()
        if subv:
            cases.append(
                (
                    "FRIDAY_AMBIENT_SUB_TTS_VOICE",
                    "Sub-agent voice check. Found something interesting.",
                    {
                        "FRIDAY_TTS_VOICE": subv,
                        "FRIDAY_TTS_RATE": sub_rate,
                        "FRIDAY_TTS_PITCH": sub_pitch,
                    },
                )
            )
        elif not main_only:
            cases.append(
                (
                    "sub_agent_style_same_voice",
                    "Sub-agent timing style on the main voice. Got it.",
                    {
                        "FRIDAY_TTS_VOICE": main_voice,
                        "FRIDAY_TTS_RATE": sub_rate,
                        "FRIDAY_TTS_PITCH": sub_pitch,
                    },
                )
            )

        ck_raw = os.environ.get("FRIDAY_AMBIENT_CARETAKER_VOICES", "").strip()
        if ck_raw:
            cr_ct = os.environ.get("FRIDAY_AMBIENT_CARETAKER_RATE", "").strip()
            cp_ct = (
                os.environ.get("FRIDAY_AMBIENT_CARETAKER_PITCH", "").strip()
                or os.environ.get("FRIDAY_AMBIENT_SUB_VOICE_PITCH", "+3Hz")
            )
            sub_rate_fallback = os.environ.get("FRIDAY_AMBIENT_SUB_VOICE_RATE", "+9%")
            for idx, cv in enumerate([x.strip() for x in ck_raw.split(",") if x.strip()]):
                cases.append(
                    (
                        f"caretaker_checkin_friday_ambient_caretaker_voices_{idx}",
                        "चेक-इन आवाज़ — यह हिंदी में मास्ट्रो की लाइन है।",
                        {
                            "FRIDAY_TTS_VOICE": cv,
                            "FRIDAY_TTS_RATE": cr_ct or sub_rate_fallback,
                            "FRIDAY_TTS_PITCH": cp_ct,
                        },
                    )
                )

        mq = os.environ.get("FRIDAY_AMBIENT_MEME_ZONE_QUIP_VOICE", "").strip()
        if not mq:
            mq = "en-IN-NeerjaExpressiveNeural"
        cases.append(
            (
                "meme_zone_quip_FRIDAY_AMBIENT_MEME_ZONE_QUIP_VOICE",
                "Meme zone quip voice — quick line after you stop a clip early.",
                {"FRIDAY_TTS_VOICE": mq},
            )
        )

    # De-dupe identical (voice, rate, pitch, text) — keep first label
    seen: set[tuple] = set()
    out: list[tuple[str, str, dict[str, str]]] = []
    for label, phrase, extra in cases:
        v = extra.get("FRIDAY_TTS_VOICE", main_voice)
        r = extra.get("FRIDAY_TTS_RATE", os.environ.get("FRIDAY_TTS_RATE", ""))
        p = extra.get("FRIDAY_TTS_PITCH", os.environ.get("FRIDAY_TTS_PITCH", ""))
        key = (v, r, p, phrase[:80])
        if key in seen:
            continue
        seen.add(key)
        out.append((label, phrase, extra))
    return out


def run_one(label: str, phrase: str, extra: dict[str, str], *, dry_run: bool) -> int:
    env = {
        **os.environ,
        "FRIDAY_TTS_USE_SESSION_STICKY_VOICE": "false",
        "FRIDAY_TTS_BYPASS_CURSOR_DEFER": "true",
        **extra,
    }
    env.pop("FRIDAY_TTS_PRIORITY", None)
    print(f"\n[{label}] voice={extra.get('FRIDAY_TTS_VOICE', '(env default)')} "
          f"rate={extra.get('FRIDAY_TTS_RATE', '-')} pitch={extra.get('FRIDAY_TTS_PITCH', '-')}")
    print(f"  text: {phrase[:120]}{'...' if len(phrase) > 120 else ''}")
    if dry_run:
        return 0
    if not SPEAK.is_file():
        print("  ERROR: friday-speak.py not found", file=sys.stderr)
        return 1
    r = subprocess.run(
        [sys.executable, str(SPEAK), phrase],
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        **_no_window(),
    )
    if r.returncode != 0:
        err = (r.stderr or r.stdout or "").strip()[:500]
        print(f"  FAILED ({r.returncode}): {err}")
        return r.returncode
    print("  ok")
    return 0


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    load_dotenv()
    ap = argparse.ArgumentParser(description="Test every ambient-related TTS voice path.")
    ap.add_argument(
        "--probe-all",
        action="store_true",
        help="Also speak Hindi/Hinglish (and optional AMBIENT/SUB) even when MAIN_VOICE_ONLY is true.",
    )
    ap.add_argument(
        "--pause",
        type=float,
        default=2.5,
        metavar="SEC",
        help="Seconds between lines (default 2.5).",
    )
    ap.add_argument("--dry-run", action="store_true", help="Print plan only; no audio.")
    args = ap.parse_args()

    if not args.dry_run and not SPEAK.is_file():
        print(f"Missing {SPEAK}", file=sys.stderr)
        return 1

    main_only = _main_voice_only()
    print("friday-ambient voice test")
    print(f"  FRIDAY_AMBIENT_MAIN_VOICE_ONLY = {main_only}  (when true, ambient sticks to FRIDAY_TTS_VOICE only)")
    if args.probe_all and main_only:
        print("  --probe-all: extra lines are marked _probe; not used by ambient until MAIN_VOICE_ONLY is false.")

    cases = build_cases(probe_all=args.probe_all)
    print(f"  {len(cases)} speak case(s).\n")

    rc = 0
    for i, (label, phrase, extra) in enumerate(cases):
        if i and not args.dry_run:
            time.sleep(max(0.0, args.pause))
        c = run_one(label, phrase, extra, dry_run=args.dry_run)
        if c != 0:
            rc = c
    print("\nDone.")
    return rc


if __name__ == "__main__":
    sys.exit(main())
