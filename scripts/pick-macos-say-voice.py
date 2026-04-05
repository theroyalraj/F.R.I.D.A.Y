#!/usr/bin/env python3
"""List or suggest macOS say(1) voices for FRIDAY_MACOS_SAY_VOICE in .env."""

from __future__ import annotations

import argparse
import platform
import subprocess
import sys


def _run_say_v_list() -> str:
    r = subprocess.run(
        ["say", "-v", "?"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    return (r.stdout or "") + (r.stderr or "")


def _suggest_voice(lines: list[str]) -> str | None:
    """Prefer en_US voices common on many Macs (creative defaults)."""
    order = (
        "Samantha",
        "Alex",
        "Victoria",
        "Karen",
        "Moira",
        "Daniel",
        "Tessa",
        "Veena",
    )
    upper_blob = "\n".join(lines).upper()
    for name in order:
        if name.upper() in upper_blob:
            return name
    return None


def main() -> None:
    p = argparse.ArgumentParser(description="macOS say voice picker for OpenClaw")
    p.add_argument("--list", action="store_true", help="Print say -v ? output")
    p.add_argument("--suggest", action="store_true", help="Print one suggested voice name only")
    args = p.parse_args()

    if platform.system() != "Darwin":
        print("pick-macos-say-voice: only macOS is supported.", file=sys.stderr)
        sys.exit(2)

    text = _run_say_v_list()
    if args.list:
        print(text, end="" if text.endswith("\n") else "\n")
        return
    if args.suggest:
        lines = text.splitlines()
        s = _suggest_voice(lines)
        if s:
            print(s)
        else:
            print("Samantha", file=sys.stderr)
            print("Samantha")
        return

    sug = _suggest_voice(text.splitlines())
    print("Voices on this Mac (say -v ?):\n")
    print(text, end="" if text.endswith("\n") else "\n")
    if sug:
        print(f"\nSuggested for .env: FRIDAY_MACOS_SAY_VOICE={sug}")
        print("Optional pacing: FRIDAY_MACOS_SAY_RATE=180   # words per minute, try 150 to 200")


if __name__ == "__main__":
    main()
