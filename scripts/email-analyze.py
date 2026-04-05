#!/usr/bin/env python3
"""
email-analyze.py — Calls Claude Haiku to summarize an email and extract action items,
todos, reminders, and meeting/calendar details.

Input (stdin JSON):
  { "from": "...", "subject": "...", "body": "...", "date": "..." }

Output (stdout JSON):
  {
    "summary": "2-3 sentence plain English summary",
    "action_needed": true|false,
    "todos": [
      { "title": "...", "detail": "...", "priority": "high|medium|low" }
    ],
    "reminders": [
      { "title": "...", "due_iso": "YYYY-MM-DDTHH:MM:SS" or null, "due_natural": "..." }
    ],
    "meeting": null | {
      "title": "...",
      "date_natural": "...",
      "date_iso": "YYYY-MM-DD" or null,
      "time_natural": "...",
      "time_iso": "HH:MM" or null,
      "duration_minutes": 60,
      "location": "...",
      "attendees": ["..."]
    },
    "speak_summary": "spoken-friendly 1-2 sentence summary for TTS"
  }

Usage:
  echo '{"from":"...", "subject":"...", "body":"...", "date":"..."}' | python scripts/email-analyze.py
  python scripts/email-analyze.py --from "Alice" --subject "Q4 review" --body "..."
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

_root = Path(__file__).resolve().parent.parent
_env = _root / ".env"
if _env.exists():
    for _line in _env.read_text(encoding="utf-8").splitlines():
        _t = _line.strip()
        if not _t or _t.startswith("#"):
            continue
        _i = _t.find("=")
        if _i < 1:
            continue
        _k = _t[:_i].strip()
        _v = _t[_i + 1 :].split("#")[0].strip().strip('"').strip("'")
        if _k not in os.environ:
            os.environ[_k] = _v

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
NOTIFY_AI_MODEL = os.environ.get("NOTIFY_AI_MODEL", "claude-haiku-4-5").strip()

_SYSTEM = """You are an intelligent email assistant that helps the user understand and act on their emails.

Given an email (from, subject, date, body), you will produce a structured JSON response with:

1. A plain English **summary** (2-3 sentences) covering the main point and any key details.
2. Whether any **action is needed** (boolean).
3. A list of **todos** — specific tasks the user should do because of this email.
4. A list of **reminders** — time-sensitive items the user should be reminded about, with estimated ISO dates if possible.
5. A **meeting** object if the email contains a meeting invitation or scheduling request.
6. A **speak_summary** — one short spoken line only: the gist of the message in at most about twenty-five words. No greeting, no sign-off, no Nova intro. Plain English for TTS (no markdown, symbols, or brackets).

Rules:
- Only include todos/reminders/meeting if genuinely present in the email.
- Keep todo titles short and actionable ("Reply to Alice about the proposal").
- For reminders, parse any mentioned dates/times relative to the email's date field.
- For meetings, extract all available details (title, date, time, duration, location, attendees).
- speak_summary must be fully speakable, under twenty-five words, no markdown or symbols.
- Respond ONLY with valid JSON matching the schema — no extra text, no markdown fences.

JSON schema:
{
  "summary": "string",
  "action_needed": boolean,
  "todos": [{"title": "string", "detail": "string", "priority": "high|medium|low"}],
  "reminders": [{"title": "string", "due_iso": "YYYY-MM-DDTHH:MM:SS or null", "due_natural": "string"}],
  "meeting": null | {
    "title": "string",
    "date_natural": "string",
    "date_iso": "YYYY-MM-DD or null",
    "time_natural": "string",
    "time_iso": "HH:MM or null",
    "duration_minutes": number,
    "location": "string",
    "attendees": ["string"]
  },
  "speak_summary": "string"
}"""


def _parse_cli_args(argv: list[str]) -> dict:
    """Parse --from --subject --body --date flags from CLI args."""
    result: dict = {}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--from", "--subject", "--body", "--date") and i + 1 < len(argv):
            key = a.lstrip("-").replace("-", "_")
            result[key] = argv[i + 1]
            i += 2
        else:
            i += 1
    return result


def analyze_email(from_: str, subject: str, body: str, date: str = "") -> dict:
    """Call Claude to analyze the email and return structured JSON."""
    try:
        import anthropic
    except ImportError:
        return _fallback(subject)

    if not ANTHROPIC_API_KEY:
        return _fallback(subject)

    body_snippet = body.strip()[:3000]
    user_msg = f"""From: {from_}
Date: {date}
Subject: {subject}

Body:
{body_snippet}"""

    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    try:
        msg = client.messages.create(
            model=NOTIFY_AI_MODEL,
            max_tokens=1024,
            system=_SYSTEM,
            messages=[{"role": "user", "content": user_msg}],
        )
        raw = msg.content[0].text.strip()
        # Strip accidental markdown fences
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        return json.loads(raw)
    except Exception as e:
        print(f"[email-analyze] Claude call failed: {e}", file=sys.stderr)
        return _fallback(subject)


def _fallback(subject: str) -> dict:
    """Return a minimal no-analysis result when Claude is unavailable."""
    return {
        "summary": f"New email: {subject}",
        "action_needed": False,
        "todos": [],
        "reminders": [],
        "meeting": None,
        "speak_summary": f"New email about {subject}.",
    }


def main() -> None:
    argv = sys.argv[1:]
    if argv and not argv[0].startswith("--"):
        # Positional: from subject body
        data = {
            "from": argv[0] if len(argv) > 0 else "",
            "subject": argv[1] if len(argv) > 1 else "",
            "body": argv[2] if len(argv) > 2 else "",
            "date": argv[3] if len(argv) > 3 else "",
        }
    elif argv:
        data = _parse_cli_args(argv)
    else:
        raw = sys.stdin.read()
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            data = {"from": "", "subject": raw[:200], "body": raw, "date": ""}

    result = analyze_email(
        from_=data.get("from", ""),
        subject=data.get("subject", ""),
        body=data.get("body", ""),
        date=data.get("date", ""),
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
