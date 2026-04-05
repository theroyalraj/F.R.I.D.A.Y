"""
Contextual lead-ins for thinking TTS (friday-speak FRIDAY_TTS_THINKING, cursor-reply-watch).

Pools are separate so cheeky code-roast lines and boundary-setting lines are not spoken
over neutral reasoning.

Env:
  FRIDAY_CURSOR_THINKING_OPENER_CONTEXT  auto (default) | neutral
    auto  — pick pool from chunk text (hostile / code mess / neutral)
    neutral — always reflective openers only
"""
from __future__ import annotations

import os
import random
import re

# ── Reflective / analytical / confident / curious / casual (safe default) ─────
NEUTRAL_OPENERS: tuple[str, ...] = (
    "Hmm. ",
    "Interesting — ",
    "Actually — ",
    "Wait — ",
    "Hang on — ",
    "Hold on a second — ",
    "That's a good question — ",
    "Now that I look at this — ",
    "Okay, this is nuanced — ",
    "There's a subtlety here — ",
    "This is worth unpacking — ",
    "So here's what's happening — ",
    "Let me reason through this — ",
    "Okay, thinking this through — ",
    "The thing to notice here is — ",
    "This is more involved than it looks — ",
    "Let me connect the dots here — ",
    "Right. ",
    "So — ",
    "Now — ",
    "Right, so — ",
    "Okay, so — ",
    "Here's the thing — ",
    "The key insight is — ",
    "What matters here is — ",
    "From what I can tell — ",
    "Based on what I'm seeing — ",
    "If I'm reading this correctly — ",
    "The way this works is — ",
    "So the pattern here is — ",
    "What's going on under the hood is — ",
    "Let me think — ",
    "Let me see — ",
    "Let me check — ",
    "Let me dig into this — ",
    "Let me trace through this — ",
    "Okay, pulling this apart — ",
    "Let me walk through the logic — ",
    "Bear with me on this one — ",
    "I want to make sure I get this right — ",
    "Okay, working through this step by step — ",
    "Okay — ",
    "Alright — ",
    "Right then — ",
    "So look — ",
    "Okay, here's my read — ",
    "So basically — ",
    "Yeah, so — ",
    "Alright, so — ",
    "Let me break this down — ",
    "Okay, let me lay this out — ",
)

# ── Messy code / bugs / tests (only when chunk matches tech-frustration cues) ─
CODE_ROAST_OPENERS: tuple[str, ...] = (
    "Oh boy. ",
    "Oh no. ",
    "Wow, okay — ",
    "Who wrote this? ",
    "Yikes — ",
    "Well that's creative — ",
    "Brave choice — ",
    "Oh, we're doing this are we — ",
    "Someone was feeling adventurous — ",
    "This is a cry for help — ",
    "Bold strategy, let's see if it pays off — ",
    "I have questions. Many questions — ",
    "Tell me you didn't test this — ",
    "I'm not mad, I'm just disappointed — ",
    "Whoever did this owes me an explanation — ",
    "This has big 'it works on my machine' energy — ",
    "Ah yes, the classic 'fix it later' approach — ",
    "Pain. Pure pain — ",
    "This code has a certain chaotic energy — ",
    "It's giving spaghetti code — ",
    "First time? ",
    "Skill issue detected — ",
    "This ain't it, chief — ",
    "We need to talk — ",
    "Confused screaming — ",
    "Task failed successfully — ",
    "Not gonna lie — ",
    "How do I even begin — ",
    "Bro really said 'trust me' — ",
    "You see what happened was — ",
    "Ladies and gentlemen, we got him — ",
    "Outstanding move — ",
    "I'm going to pretend I didn't see that — ",
    "Modern problems require modern solutions — ",
    "That's rough, buddy — ",
    "They don't know — ",
    "Big brain time — ",
    "This one's tangled — ",
    "Rough edge case — ",
    "Classic mystery meat — ",
)

# ── Hostile / abusive toward the assistant (calm boundary, not jokes) ────────
HOSTILE_OPENERS: tuple[str, ...] = (
    "I will stay professional here — ",
    "Let us keep this constructive — ",
    "I am here to help with the work — ",
    "Happy to continue when we focus on the task — ",
    "I will answer the technical side calmly — ",
    "Let us reset and work on what you need — ",
)

_ASSISTANT_HOSTILE = re.compile(
    r"\b("
    r"shut\s+up|stfu\b|"
    r"fuck\s+you|screw\s+you|"
    r"you\s*(idiot|moron|stupid|useless|trash|worthless)|"
    r"you\s+are\s+(an?\s+)?(idiot|moron|stupid|useless|trash|worthless|hopeless|pathetic)|"
    r"you'?re\s+(an?\s+)?(idiot|moron|stupid|useless|trash|worthless|hopeless|pathetic)|"
    r"you\s+dumb\s*(bot|ass|assistant)?|"
    r"dumb\s*bot|useless\s*bot|"
    r"hate\s+you|worst\s+(bot|assistant|ai)|"
    r"kill\s+yourself|\bkys\b"
    r")\b",
    re.IGNORECASE,
)

_CODE_MESS = re.compile(
    r"\b("
    r"bug|bugs\b|error\b|exception|stack\s*trace|traceback|"
    r"failing\s*test|tests?\s+failing|lint\s+error|syntax\s+error|runtime\s+error|"
    r"typescript\s+error|undefined\s+is\s+not|null\s*pointer|segfault|"
    r"refactor|tech\s*debt|legacy\s+code|spaghetti|monolith|hacky|hotfix|"
    r"this\s+code|this\s+file|this\s+function|this\s+module|who\s+wrote|"
    r"works?\s+on\s+my\s+machine|broken\s+build|ci\s+failing|regression|workaround|"
    r"memory\s+leak|deadlock|race\s+condition"
    r")\b",
    re.IGNORECASE,
)


def pick_thinking_opener(text: str) -> str:
    """
    Return one opener string suited to the chunk. Caller still applies opener probability.
    """
    mode = os.environ.get("FRIDAY_CURSOR_THINKING_OPENER_CONTEXT", "auto").strip().lower()
    if mode in ("neutral", "only_neutral", "safe"):
        return random.choice(NEUTRAL_OPENERS)

    sample = (text or "").strip()
    if not sample:
        return random.choice(NEUTRAL_OPENERS)

    if _ASSISTANT_HOSTILE.search(sample):
        return random.choice(HOSTILE_OPENERS)
    if _CODE_MESS.search(sample):
        return random.choice(CODE_ROAST_OPENERS)
    return random.choice(NEUTRAL_OPENERS)
