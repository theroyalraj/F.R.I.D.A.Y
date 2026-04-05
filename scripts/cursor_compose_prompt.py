#!/usr/bin/env python3
"""
Print the same Cursor Composer prompts as the Listen UI quick buttons (raise MR / narrated review).
Use from a terminal or automation instead of retyping, e.g. pipe to clipboard on Windows:

  python scripts/cursor_compose_prompt.py raise-mr | clip
  python scripts/cursor_compose_prompt.py review | clip

Then paste into Cursor Composer. Does not run git or gh — Cursor follows .cursor/rules/github-pr-after-push.mdc.
"""
from __future__ import annotations

import argparse
import sys

QUICK_CURSOR_RAISE_MR = """@cursor Follow .cursor/rules/github-pr-after-push.mdc. In this workspace git repo: push the current branch if it is ahead of origin, then use gh per that rule to open or update a PR with a clear title and body from recent commits and the diff summary. If a pull request already exists for this head branch, do not create another; paste the existing link."""

QUICK_CURSOR_NARRATED_REVIEW = """@cursor Review the current working tree diff. Reply with a tight code-review summary meant to be read aloud: main risks, missing tests or edge cases, style nits if any, and one closing verdict sentence."""

PROMPTS = {
    "raise-mr": QUICK_CURSOR_RAISE_MR,
    "review": QUICK_CURSOR_NARRATED_REVIEW,
}


def main() -> int:
    p = argparse.ArgumentParser(description="Print Cursor Composer prompts for OpenClaw Listen quick actions.")
    p.add_argument(
        "which",
        nargs="?",
        default="raise-mr",
        choices=list(PROMPTS.keys()),
        help="raise-mr (default) or review",
    )
    args = p.parse_args()
    text = PROMPTS[args.which]
    sys.stdout.write(text)
    if not text.endswith("\n"):
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
