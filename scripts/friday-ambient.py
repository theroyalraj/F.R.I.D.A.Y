#!/usr/bin/env python3
"""
friday-ambient.py -- Jarvis-style ambient intelligence for OpenClaw.

Live data sources (no API keys required):
  - Cricket news: ESPN Cricinfo RSS
  - Weather: wttr.in (free, no key)
  - Random facts: uselessfacts.jsph.pl
  - Dad jokes: icanhazdadjoke.com
  - News: Google News RSS (India)

Anthropic (optional): used for witty, personalised lines.
  401 / network failures trigger a 5-min cooldown to avoid log spam.

Set FRIDAY_AMBIENT=true to enable.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import random
import re
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

# -- Repo root + .env ---------------------------------------------------------
ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = ROOT / ".env"
if ENV_PATH.exists():
    for _line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        _t = _line.strip()
        if not _t or _t.startswith("#"):
            continue
        _i = _t.find("=")
        if _i < 1:
            continue
        _k = _t[:_i].strip()
        _v = _t[_i + 1:].split("#")[0].strip()  # strip inline comments
        if _v.startswith('"') and _v.endswith('"'):
            _v = _v[1:-1]
        elif _v.startswith("'") and _v.endswith("'"):
            _v = _v[1:-1]
        if _k not in os.environ:
            os.environ[_k] = _v


def _env_bool(name: str, default: bool = False) -> bool:
    v = os.environ.get(name, "").strip().lower()
    if not v:
        return default
    return v in ("1", "true", "yes", "on")


if not _env_bool("FRIDAY_AMBIENT", False):
    print("friday-ambient: FRIDAY_AMBIENT not enabled -- exiting.", flush=True)
    sys.exit(0)

# -- Config -------------------------------------------------------------------
# Accept both names — FRIDAY_AMBIENT_POST_TTS_GAP is the .env canonical name
SILENCE_SEC         = float(
    os.environ.get("FRIDAY_AMBIENT_POST_TTS_GAP")
    or os.environ.get("FRIDAY_AMBIENT_SILENCE_SEC", "6")
)
MIN_AMBIENT_GAP     = float(os.environ.get("FRIDAY_AMBIENT_MIN_SILENCE_SEC", "4"))
MAX_SILENCE_CAP     = float(os.environ.get("FRIDAY_AMBIENT_MAX_SILENCE_SEC", "25"))
TONE                = os.environ.get("FRIDAY_AMBIENT_TONE", "mixed").strip().lower()
FUNNY_RATIO         = float(os.environ.get("FRIDAY_AMBIENT_FUNNY_RATIO", "0.5"))
TRACK_MEDIA         = _env_bool("FRIDAY_AMBIENT_TRACK_MEDIA", True)
MUSIC_COMMENT_CHANCE= float(os.environ.get("FRIDAY_AMBIENT_MUSIC_COMMENT_CHANCE", "0.25"))
PREWARM             = _env_bool("FRIDAY_AMBIENT_PREWARM_TTS", True)
QUEUE_TARGET        = max(1, int(os.environ.get("FRIDAY_AMBIENT_CONTENT_QUEUE_SIZE", "3")))
REDIS_URL           = os.environ.get("FRIDAY_AMBIENT_REDIS_URL", "redis://127.0.0.1:6379").strip()
NEWS_API_KEY        = os.environ.get("NEWS_API_KEY", "").strip()
AI_MODEL            = os.environ.get("FRIDAY_AMBIENT_AI_MODEL", "claude-haiku-4-5").strip()
ANTHROPIC_KEY       = os.environ.get("ANTHROPIC_API_KEY", "").strip()

USER_NAME      = os.environ.get("FRIDAY_USER_NAME",      "sir").strip()
USER_AGE       = os.environ.get("FRIDAY_USER_AGE",       "").strip()
USER_CITY      = os.environ.get("FRIDAY_USER_CITY",      "").strip()
USER_INTERESTS = os.environ.get("FRIDAY_USER_INTERESTS", "technology, cricket, AI, startups").strip()

_db_raw = os.environ.get("FRIDAY_AMBIENT_DB_PATH", "data/friday.db").strip()
DB_PATH = Path(_db_raw) if Path(_db_raw).is_absolute() else ROOT / _db_raw

TTS_TS_FILE     = Path(tempfile.gettempdir()) / "friday-tts-ts"
TTS_ACTIVE_FILE = Path(tempfile.gettempdir()) / "friday-tts-active"   # written by friday-speak.py
AMBIENT_PID_FILE= Path(tempfile.gettempdir()) / "friday-ambient.pid"
SPEAK_SCRIPT    = ROOT / "skill-gateway" / "scripts" / "friday-speak.py"

POST_TTS_GAP  = float(os.environ.get("FRIDAY_AMBIENT_POST_TTS_GAP", "12"))   # wait this long after TTS ends

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("friday-ambient")


# ── Single-instance guard ─────────────────────────────────────────────────────
def _acquire_single_instance() -> None:
    """Kill any previous ambient instance, then register our own PID."""
    if AMBIENT_PID_FILE.exists():
        try:
            old_pid = int(AMBIENT_PID_FILE.read_text().strip())
            if old_pid != os.getpid():
                import psutil
                try:
                    p = psutil.Process(old_pid)
                    if "friday-ambient" in " ".join(p.cmdline()):
                        p.terminate()
                        log.info("Killed previous ambient instance (PID %d)", old_pid)
                        time.sleep(0.6)
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
        except (ValueError, OSError):
            pass
    try:
        AMBIENT_PID_FILE.write_text(str(os.getpid()), encoding="utf-8")
    except OSError:
        pass


def _release_single_instance() -> None:
    try:
        if AMBIENT_PID_FILE.exists():
            stored = AMBIENT_PID_FILE.read_text().strip()
            if stored == str(os.getpid()):
                AMBIENT_PID_FILE.unlink(missing_ok=True)
    except OSError:
        pass


# ── TTS-active detection ───────────────────────────────────────────────────────
def _is_tts_active() -> bool:
    """Return True if friday-speak.py is currently playing audio (not just ambient itself)."""
    # Primary: flag file written by friday-speak.py
    if TTS_ACTIVE_FILE.exists():
        try:
            age = time.time() - TTS_ACTIVE_FILE.stat().st_mtime
            if age < 120:  # stale guard — file > 2 min old means speak crashed
                return True
        except OSError:
            pass
    # Secondary: check if friday-player process is running
    try:
        import psutil
        for p in psutil.process_iter(["name"]):
            n = (p.info.get("name") or "").lower()
            if "friday-player" in n:
                return True
    except Exception:
        pass
    return False


def _seconds_since_last_tts() -> float:
    """Seconds elapsed since the last TTS finished (reads TTS_TS_FILE)."""
    if not TTS_TS_FILE.exists():
        return 9999.0
    try:
        ts = float(TTS_TS_FILE.read_text(encoding="utf-8").strip())
        return max(0.0, time.time() - ts)
    except (ValueError, OSError):
        return 9999.0


def _load_anthropic():
    try:
        import anthropic
        return anthropic
    except ImportError:
        return None


ANTHROPIC_MOD = _load_anthropic() if ANTHROPIC_KEY else None
if ANTHROPIC_KEY and ANTHROPIC_MOD is None:
    log.warning(
        "ANTHROPIC_API_KEY is set but 'anthropic' package is not installed. "
        "Fix: pip install anthropic"
    )

# Track Anthropic failures to avoid log spam (5-min cooldown after failure)
_anthropic_ok          = True
_anthropic_fail_until  = 0.0   # epoch time after which we retry
_ANTHROPIC_FAIL_DELAY  = 300   # seconds between retries after failure

# -- Witty fallbacks (used when no live data + no AI) -------------------------
# Every line has a natural opener baked in — no bare statements, no system-status phrasing.
WITTY_FALLBACKS = [
    # Dev / tech
    "Oh I just thought of something — Hyderabad traffic is the only thing in tech that never gets a hotfix. At least the biryani makes it worth it.",
    "Here's one that's genuinely true — developers spend 20 percent of their time writing code and 80 percent convincing themselves the bug is somewhere else.",
    "Random but — nobody in the history of tech has ever said 'ship it, it works on prod' and actually been right the second time. Nobody.",
    "So I was thinking — the cloud is just someone else's computer. And that someone is definitely having a worse day than you right now.",
    "Okay this is actually happening — somewhere in Hyderabad right now, someone is restarting Redis and praying. I feel for them.",
    "This cracked me up — 'move fast and break things' aged terribly the moment things started actually breaking.",
    "Completely unprompted, but — half of Silicon Valley is currently in a meeting about the roadmap for the meeting cadence.",
    "Here's something I think about — the best code you'll ever write is the code you end up deleting. Still working up the courage.",
    "So apparently — AI is going to take all the jobs, said the person whose entire job is now writing prompts for AI. Funny how that worked out.",
    "Oh and this is real — Slack was invented so engineers could ignore emails faster. Mission accomplished.",
    "I just read something that felt very accurate — the average developer switches tabs thirteen times per hour. The average tab is Stack Overflow.",
    "Quick one — if you ever feel unproductive, remember that half of Silicon Valley is in a planning session about the previous planning session.",
    "Hot take that I stand by — 'just a quick change' are the four most dangerous words in software engineering.",
    "Every codebase has that one folder nobody touches. It's load-bearing fear at this point.",
    "Stack Overflow is basically archaeology — you find the answer, then notice it was posted in 2011.",
    "The difference between junior and senior developers is the senior one knows which corners to cut and which ones will haunt them.",
    "Production outages always happen on Fridays. It's not superstition, it's pattern recognition.",
    "Technical debt is a polite way of saying 'we'll deal with past-us's decisions at some later date'.",
    "Someone once described microservices as 'distributed monolith with extra networking'. I think about that a lot.",
    "The phrase 'we're disrupting the industry' has never once been followed by a compelling explanation of how.",
    # AI & startups
    "Every startup pitch starts with 'AI-powered' now. Even the ones selling candles.",
    "Venture capital is interesting — you get given ten million dollars, it's called a seed round, and somehow that's considered cautious.",
    "LLMs are getting very good at sounding confident. Which, honestly, same. We're all just winging it.",
    "The metaverse was going to change everything apparently. I checked — it did not change everything.",
    "GPT-4 is already being called legacy by certain people on the internet. The internet moves uncomfortably fast.",
    "I find it genuinely funny that 'prompt engineering' is now a skill on CVs. Future historians will have questions.",
    "Raj, startups that 'move fast and break things' eventually just have a lot of broken things. It's a whole journey.",
    # India / Hyderabad
    "Fun fact — Hyderabad has more tech talent per square kilometre than most countries have in total. We just don't market it aggressively enough.",
    "India's startup ecosystem is legitimately impressive now. Fifteen years ago this conversation would have been about outsourcing. Times have genuinely changed.",
    "Monsoon in Hyderabad is a full personality. Glorious chaos. Ten out of ten would recommend.",
    "Honestly HITEC City at rush hour is a whole experience. It builds character.",
    "Indian street food has quietly become the most interesting food conversation in the world. Hyderabad biryani is obviously the peak.",
    # Cricket
    "India's cricket team manages to be brilliantly inconsistent in the most entertaining way possible. I mean that as a genuine compliment.",
    "The IPL has changed how the world watches cricket. Even die-hard Test fans get pulled in — you just can't resist it.",
    "T20 cricket is basically chess, except everyone is on energy drinks and the board is on fire.",
    "Indian cricket fans are the most emotionally invested people in any sport anywhere. I say that with deep respect.",
    "Watching a good IPL chase is honestly one of the more exciting things you can do on a weeknight.",
    "Rohit Sharma has this habit of looking completely relaxed right before hitting something enormous. Terrifying to bowl to.",
    # Random interesting
    "Random one — octopuses have three hearts and blue blood. I find this equally surprising every single time.",
    "The word 'salary' comes from salt. Roman soldiers were paid in it. You're casually referencing ancient Rome every payday.",
    "Cleopatra lived closer in time to the Moon landing than to the construction of the Great Pyramid. History has deeply weird proportions.",
    "Bananas are technically berries. Strawberries are not. I don't make the rules but I do think about them.",
    "The thumbnail on YouTube was originally called a poster frame. Much less catchy. Good they changed it.",
    "Honey doesn't spoil. They've found 3000 year old honey in Egyptian tombs that was still edible. That's remarkable.",
    "A day on Venus is longer than a year on Venus. It rotates that slowly. Space continues to be strange.",
    # Work / productivity
    "Deep work is genuinely underrated. Two hours of real focus beats six hours of distracted effort every time.",
    "The best meetings are the ones that could have been an email. The best emails are the ones that could have been a decision.",
    "Context switching has a real cost — it takes about twenty minutes to fully get back into flow. That's just neuroscience.",
    "The Pomodoro Technique has existed since the 1980s and people still discover it like it's new. It works though. Credit where it's due.",
    "There's something to be said for writing things down properly. Most 'quick notes' are never read again. The act of writing is the point.",
]

WITTY_FALLBACKS += [
    # ── Science & space ───────────────────────────────────────────────────────
    "So apparently — there are more trees on Earth than stars in the Milky Way. About three trillion of them. I did not expect that number.",
    "Here's one that broke my brain — a neutron star is so dense that a teaspoon of it weighs about a billion tonnes. Space is deeply unreasonable.",
    "Oh so this is genuinely wild — the Sun is so large that about 1.3 million Earths could fit inside it. And the Sun is considered an average-sized star.",
    "Right, so apparently — light from the Sun takes eight minutes to reach us. Which means we're always looking eight minutes into the past when we look at the sky.",
    "I learnt something just now — there are more possible iterations of a game of chess than atoms in the observable universe. Every game is technically unique.",
    "Completely unprompted — water can exist in all three states simultaneously at a specific temperature and pressure called the triple point. Physics is strange.",
    "Here's something interesting — sharks are older than trees. Sharks have existed for 450 million years. Trees only showed up 360 million years ago.",
    "Quick one — the human body replaces most of its atoms every few years. You're physically not the same person you were five years ago. Philosophically interesting.",
    "This cracked me up — the great wall of China is not visible from space. That's a myth. It's about as wide as a highway. Your eye resolves zero highways from orbit.",
    "Okay so — lightning strikes the Earth about 100 times per second. That's 8.6 million times a day. Genuinely relentless.",
    "Random one — there are more atoms in a grain of sand than grains of sand on all the beaches on Earth. Scale is consistently humbling.",
    "So I just thought about this — time passes slightly faster on a mountaintop than at sea level. GPS satellites account for this in their calculations. Relativity in daily life.",
    "Here's something that surprised me — hot water freezes faster than cold water under certain conditions. It's called the Mpemba effect. Still debated. Science is messy.",
    "Oh and this is real — mantis shrimp can see 16 types of color receptors. Humans have three. They're basically living in a colour dimension we can't perceive.",
    "I just read something — octopuses can solve puzzles, open jars, and have been observed playing for fun. The three-heart thing is almost beside the point.",
    # ── History & counterintuitive facts ──────────────────────────────────────
    "So here's a weird one — Oxford University is older than the Aztec Empire. Oxford was founded in 1096. The Aztecs started around 1300.",
    "Right, so apparently — Cleopatra lived closer in time to the Moon landing than to the construction of the Great Pyramid. Ancient history has deeply odd proportions.",
    "Oh so I just read — Vikings never actually had horns on their helmets. That's a 19th century artistic invention. The actual Vikings are probably not impressed.",
    "Here's one — Napoleon was not particularly short. He was 5 foot 7, average for his era. The short myth started as British war propaganda. Remarkably effective.",
    "I learnt something just now — there was no year zero in the calendar. You go straight from 1 BC to 1 AD. Mathematicians were briefly furious about this.",
    "This is kind of wild — the fax machine was invented before the telephone. 1843 versus 1876. We had fax technology and nothing to fax with for thirty years.",
    "Completely unprompted but — Nintendo was founded in 1889. They started selling playing cards. They have since done alright.",
    "Quick one — the shortest war in history lasted 38 minutes. Anglo-Zanzibar War, 1896. Zanzibar surrendered before lunch.",
    "Oh and this is real — there are more tigers in captivity in Texas than in the wild worldwide. That is a sentence I wish wasn't true.",
    "I just read — ancient Romans used crushed mouse brain as toothpaste. The modern equivalent is somehow not more horrifying, just better marketed.",
    # ── Psychology & human behaviour ──────────────────────────────────────────
    "Here's something I think about — the Dunning-Kruger effect means the less you know, the more confident you feel. Which explains a lot of meetings.",
    "Right, so — humans are the only animals that voluntarily delay sleep. Every other animal sleeps when tired. We scroll instead. Questionable.",
    "So apparently — the average person makes about 35,000 decisions per day. Most of them subconscious. That explains the decision fatigue by evening.",
    "Okay this is actually interesting — people who swear more tend to be more honest. Profanity is correlated with authenticity. Something to think about.",
    "I just read something — the mere act of writing down a goal makes you 42 percent more likely to achieve it. The planning isn't the goal. The writing is.",
    "Here's a thought — the doorway effect is real. Walking through a door causes your brain to reset what you were thinking about. Forgetting things mid-room is literally architecture's fault.",
    "Random one but — humans are terrible at estimating time. We consistently overestimate how long bad experiences lasted and underestimate good ones. Memory edits on the way out.",
    "Quick one — people tend to remember incomplete tasks better than completed ones. It's called the Zeigarnik effect. Your unfinished to-do list is genuinely harder to ignore.",
    # ── Finance & economy ─────────────────────────────────────────────────────
    "So I was thinking about this — compound interest is sometimes called the eighth wonder of the world. It's been attributed to Einstein, probably incorrectly. Still works though.",
    "Here's something wild — the top 1 percent globally starts at about $34,000 annual income. That's the world threshold. Perspective is everything.",
    "Oh so apparently — Warren Buffett made 99 percent of his wealth after age 50. Compound interest is patient in a way humans usually aren't.",
    "Right so — the entire global derivatives market is estimated at over a quadrillion dollars. The word quadrillion should not exist in a finance context. And yet.",
    "I just read — Bitcoin uses more electricity annually than many medium-sized countries. Decentralisation has an electricity bill.",
    "Completely unprompted — the stock market has gone up 73 percent of all years it's been tracked. Everyone panics as if this is a surprise.",
    # ── Food & culture ────────────────────────────────────────────────────────
    "So apparently — the most translated document in history is not the Bible. It's the Universal Declaration of Human Rights. Over 500 languages.",
    "Oh and this is real — Worcestershire sauce is basically fermented anchovies. This is not disclosed prominently on the bottle.",
    "Here's something I didn't know — wasabi served at most sushi restaurants outside Japan is actually dyed horseradish. Real wasabi is expensive and rare.",
    "Okay so — in Italy, cappuccino after 11am is considered socially unacceptable. The food culture has opinions on scheduling.",
    "Quick one — there are more varieties of rice in India than there are countries in the world. We have around 6,000 cultivated varieties. Biryani is obviously the pinnacle.",
    "I just read something — the Hyderabad biryani is technically a Mughal adaptation that local cooks made significantly better than the original. Origin story: improvement.",
    "Right, so apparently — the average person in India eats rice at least once a day. That means about 1.4 billion people are having rice right now, collectively, as we speak.",
    # ── India & startups ──────────────────────────────────────────────────────
    "Here's something genuinely impressive — India produces more engineers annually than the US and Europe combined. The pipeline is extraordinary.",
    "So I was just thinking — ISRO's Mars Orbiter Mission cost less per kilometre than a London taxi ride. The cost efficiency is remarkable in a way that no one talks about enough.",
    "Oh so apparently — India's UPI processes more digital transactions than Visa and Mastercard combined globally. Built in-house, deployed in five years. Legitimately impressive.",
    "Completely unprompted but — Hyderabad became a tech hub partly because of HITEC City's land policy in the 1990s. The entire IT ecosystem came from a zoning decision.",
    "I learnt something just now — India has the third largest startup ecosystem in the world by number of startups. Behind only the US and China. The gap is closing.",
    "Quick one — Bengaluru alone generates more software exports than Israel, which is usually called the startup nation. Different names for similar results.",
    "Here's a thought — Zerodha, PhonePe, Razorpay all started in Bangalore with founders who were not imported from Silicon Valley. This matters more than the branding suggests.",
    "Right so — the median age in India is 28. That is a demographic dividend that no European economy can replicate. The next twenty years are interesting.",
    # ── Cricket deep cuts ─────────────────────────────────────────────────────
    "So I was thinking — Sachin Tendulkar scored more ODI runs than some countries have made in their entire cricket history combined. The scale of that career is hard to process.",
    "Here's something that cracked me up — the Duckworth-Lewis method was invented by two statisticians. Frank Duckworth and Tony Lewis. They changed cricket with a spreadsheet.",
    "Oh and this is real — MS Dhoni's famous helicopter shot was apparently developed because his bat was broken and he had to improvise. Adversity as design process.",
    "Okay so apparently — the IPL is the second most-attended sports league in the world by average attendance per game. Only the NFL beats it. Think about that.",
    "Random cricket one — Anil Kumble once took all 10 wickets in a Test innings against Pakistan. In 74 overs of bowling. The sustained excellence of that is borderline unreasonable.",
    "I just read — the slowest over in Test cricket history took 77 minutes. The batsman didn't score. The bowler didn't take a wicket. It's somehow still interesting in context.",
    "Right so — Virat Kohli has the highest win percentage as Test captain for India. Over 58 percent. He was playing chess when others were playing checkers.",
    # ── Tech deep cuts ────────────────────────────────────────────────────────
    "So apparently — the first computer bug was an actual bug. A moth got stuck in a Harvard relay in 1947. Grace Hopper's team taped it in the log. Still there.",
    "Here's something that hits different — Git was written by Linus Torvalds in about ten days. Just because he was annoyed with the existing version control systems. Personal frustration as product strategy.",
    "Oh so I just read — the source code for the first iPhone was famously called 'Project Purple'. The team had to sign NDAs before entering the building.",
    "Okay this is wild — the original domain name for Google was BackRub.com. Larry and Sergey changed it. Good call.",
    "Quick one — email is 52 years old. Older than the internet as most people understand it. Still the primary business communication tool. Inertia is powerful.",
    "I learnt something — the first YouTube video was uploaded by co-founder Jawed Karim at the San Diego Zoo. It's 18 seconds long. Called 'Me at the zoo.' Still on YouTube.",
    "Right so apparently — there are roughly 700 programming languages. Actively maintained. Humans have strong opinions about syntax.",
    "Here's a thought — the entire JavaScript ecosystem has a combined size larger than the US Library of Congress. Most of it is node_modules.",
    "So I was thinking — Claude Shannon invented information theory in 1948 with a single paper. He also invented a machine that played chess and a machine that found its way through mazes. For fun.",
    # ── AI & the current moment ───────────────────────────────────────────────
    "Here's something that cracked me up — the word 'hallucination' was quietly adopted by the AI industry to describe confidently wrong answers. Marketing by nomenclature.",
    "Oh so apparently — the total compute used to train GPT-4 is equivalent to running a typical laptop for about 30 million years. All for autocomplete, essentially.",
    "Completely unprompted — AI models are now being used to discover new antibiotics, predict protein structures, and design materials. Meanwhile I'm mainly summarising PDFs.",
    "Right so — Geoffrey Hinton, who won the Turing Award for deep learning, left Google in 2023 to speak freely about AI risks. That's a notable career pivot.",
    "I just read something — the Transformer architecture, which powers essentially all modern LLMs, was published in a paper called 'Attention is All You Need'. The paper title has aged extremely well.",
    "Quick one — the first chatbot, ELIZA, was built in 1966. It pretended to be a therapist. People got emotionally attached to it. Some things don't change.",
    # ── Philosophy & life ─────────────────────────────────────────────────────
    "So I was thinking — Seneca wrote 'we suffer more in imagination than in reality' in 65 AD. Still the most accurate description of Sunday evenings.",
    "Here's a thought — the Stoics believed you should practice losing things you love before you actually lose them. Called negative visualisation. Sounds grim. Works surprisingly well.",
    "Right, so apparently — boredom was considered a character flaw in the 18th century. It meant you lacked imagination. The modern interpretation has been significantly kinder.",
    "Oh and this is real — the concept of flow state, being so absorbed in work that time disappears, was discovered by a researcher named Mihaly Csikszentmihalyi. Who also had to spell it every day.",
    "Completely unprompted — Marcus Aurelius was writing Meditations entirely for himself. He never planned to publish it. The most widely read leadership book was private journaling.",
]

PREWARM_PHRASES = WITTY_FALLBACKS[:5] + [
    "Oh I just thought of something — Hyderabad traffic is the only thing in tech that never gets a hotfix.",
    "Here's one that's genuinely true —",
    "Random but, nobody in the history of tech has ever said ship it and been right.",
]

# -- Live data fetches (no API keys needed) -----------------------------------
_HTTP_HEADERS = {
    "User-Agent": "Mozilla/5.0 (OpenClaw-Friday-Ambient/1.0)",
    "Accept": "application/json, text/html, application/rss+xml, */*",
}


def _get(url: str, timeout: int = 6) -> bytes | None:
    try:
        req = urllib.request.Request(url, headers=_HTTP_HEADERS)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()
    except Exception as e:
        log.debug("HTTP GET %s failed: %s", url, e)
        return None


def fetch_cricket_news() -> str | None:
    """Latest cricket headline from ESPN Cricinfo RSS."""
    raw = _get("https://www.espncricinfo.com/rss/content/story/feeds/0.xml")
    if not raw:
        raw = _get("https://cricbuzz.com/rss-feeds/cricket-news")
    if not raw:
        return None
    try:
        root = ET.fromstring(raw.decode("utf-8", errors="replace"))
        items = root.findall(".//item")
        if not items:
            return None
        # Pick a random one from top 5 for variety
        item = random.choice(items[:5])
        title = item.findtext("title") or ""
        title = re.sub(r"<[^>]+>", "", title).strip()  # strip any HTML
        return title[:200] if title else None
    except Exception as e:
        log.debug("cricket RSS parse failed: %s", e)
        return None


def fetch_weather_brief() -> str | None:
    """One-line weather from wttr.in (completely free, no key)."""
    city = USER_CITY or "Hyderabad"
    encoded = urllib.parse.quote(city)
    raw = _get(f"https://wttr.in/{encoded}?format=3", timeout=5)
    if not raw:
        return None
    text = raw.decode("utf-8", errors="replace").strip()
    return text[:100] if text else None


def fetch_random_fact() -> str | None:
    """Genuinely interesting random fact (uselessfacts.jsph.pl - free)."""
    raw = _get("https://uselessfacts.jsph.pl/api/v2/facts/random?language=en")
    if not raw:
        return None
    try:
        data = json.loads(raw)
        return (data.get("text") or "").strip()[:200] or None
    except Exception:
        return None


def fetch_dad_joke() -> str | None:
    """A random dad joke (icanhazdadjoke.com - free, no key)."""
    raw = _get("https://icanhazdadjoke.com/")
    if not raw:
        return None
    try:
        data = json.loads(raw)
        return (data.get("joke") or "").strip()[:200] or None
    except Exception:
        return None


def fetch_news_headline() -> str | None:
    """News headline -- Google News RSS (no key) or newsapi.org fallback."""
    # Try Google News RSS first (no key required)
    raw = _get("https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en", timeout=6)
    if raw:
        try:
            root = ET.fromstring(raw.decode("utf-8", errors="replace"))
            items = root.findall(".//item")
            if items:
                item = random.choice(items[:10])
                title = item.findtext("title") or ""
                title = re.sub(r"\s+-\s+\S+$", "", title).strip()  # remove "- Source" suffix
                title = re.sub(r"<[^>]+>", "", title).strip()
                if title:
                    return title[:200]
        except Exception as e:
            log.debug("Google News RSS parse: %s", e)

    # Fallback: newsapi.org if key is set
    if NEWS_API_KEY:
        try:
            q = urllib.parse.urlencode({"country": "in", "apiKey": NEWS_API_KEY, "pageSize": 1})
            r2 = _get(f"https://newsapi.org/v2/top-headlines?{q}")
            if r2:
                data = json.loads(r2)
                arts = data.get("articles") or []
                if arts:
                    return (arts[0].get("title") or "").strip()[:200] or None
        except Exception:
            pass
    return None


def fetch_arxiv_headline() -> str | None:
    """Latest AI/ML paper title from arXiv RSS (free, no key)."""
    for feed in [
        "https://export.arxiv.org/rss/cs.AI",
        "https://export.arxiv.org/rss/cs.LG",
    ]:
        raw = _get(feed, timeout=7)
        if not raw:
            continue
        try:
            root  = ET.fromstring(raw.decode("utf-8", errors="replace"))
            items = root.findall(".//item")
            if not items:
                continue
            item  = random.choice(items[:10])
            title = item.findtext("title") or ""
            title = re.sub(r"<[^>]+>", "", title).strip()
            title = re.sub(r"\s*\([^)]{5,}\)\s*$", "", title).strip()  # strip arXiv ID suffix
            if title:
                return title[:200]
        except Exception as e:
            log.debug("arXiv RSS parse failed: %s", e)
    return None


def fetch_space_news() -> str | None:
    """Latest space headline (SpaceNews or NASASpaceFlight RSS — free, no key)."""
    for feed in [
        "https://spacenews.com/feed/",
        "https://www.nasaspaceflight.com/feed/",
    ]:
        raw = _get(feed, timeout=7)
        if not raw:
            continue
        try:
            root  = ET.fromstring(raw.decode("utf-8", errors="replace"))
            items = root.findall(".//item")
            if not items:
                continue
            item  = random.choice(items[:8])
            title = item.findtext("title") or ""
            title = re.sub(r"<[^>]+>", "", title).strip()
            if title:
                return title[:200]
        except Exception as e:
            log.debug("space news RSS parse failed: %s", e)
    return None


def fetch_this_day_history() -> str | None:
    """A 'this day in history' event (history.muffinlabs.com — free, no key)."""
    import datetime
    today = datetime.date.today()
    raw = _get(f"https://history.muffinlabs.com/date/{today.month}/{today.day}", timeout=6)
    if not raw:
        return None
    try:
        data   = json.loads(raw)
        events = (data.get("data") or {}).get("Events") or []
        if not events:
            return None
        ev   = random.choice(events[:12])
        year = ev.get("year", "")
        text = (ev.get("text") or "").strip()
        if year and text:
            return f"In {year}, {text[:160]}"
        return text[:200] if text else None
    except Exception as e:
        log.debug("history API parse failed: %s", e)
        return None


def fetch_word_of_day() -> str | None:
    """A random interesting word + definition (Wordnik free tier)."""
    raw = _get("https://api.wordnik.com/v4/words.json/wordOfTheDay", timeout=5)
    if not raw:
        return None
    try:
        data = json.loads(raw)
        word = data.get("word", "")
        defs = data.get("definitions") or []
        defn = defs[0].get("text", "") if defs else ""
        if word and defn:
            return f"{word}: {defn.strip()[:150]}"
    except Exception:
        pass
    return None


# -- Anthropic AI (optional) --------------------------------------------------
def generate_line_ai(
    r,
    mode: str,
    news_hint: str | None,
    music_hint: str | None,
    live_data: dict[str, str | None],
) -> tuple[str, str]:
    """Returns (topic_key, spoken_text). Falls back to live data, then witty fallbacks."""
    global _anthropic_ok, _anthropic_fail_until

    recent = set(_redis_recent_topics(r))
    now = time.time()

    # Build topic key
    if mode == "cricket":
        topic = f"cricket:{time.strftime('%Y-%m-%d-%H')}"
    elif mode == "music_comment":
        ctx = music_hint or "music"
        topic = f"music:{hashlib.md5(ctx.encode()).hexdigest()[:16]}"
    elif mode == "wisdom":
        topic = f"wisdom:{time.strftime('%Y-%m-%d-%H')}"
    elif mode == "informational":
        topic = f"info:{(news_hint or 'general')[:30]}"
    elif mode == "funny":
        topic = f"joke:{time.strftime('%Y-%m-%d-%H')}"
    elif mode == "weather":
        topic = f"weather:{time.strftime('%Y-%m-%d-%H')}"
    else:
        topic = f"mixed:{time.strftime('%Y-%m-%d-%H')}"

    if topic in recent:
        topic = f"{topic}:alt{random.randint(1, 999)}"

    # -- Try cached line first
    cache_key = "friday:ambient:content_cache:" + hashlib.sha256(
        f"{topic}|{mode}|{USER_INTERESTS}".encode()
    ).hexdigest()
    try:
        hit = r.get(cache_key)
        if hit:
            return topic, str(hit)
    except Exception:
        pass

    # -- Compose prompt context from live data
    cricket_line  = live_data.get("cricket")
    weather_line  = live_data.get("weather")
    fact_line     = live_data.get("fact")
    joke_line     = live_data.get("joke")

    # -- Try Anthropic if key valid and not in cooldown
    use_ai = (
        ANTHROPIC_KEY
        and ANTHROPIC_MOD is not None
        and (_anthropic_ok or now > _anthropic_fail_until)
    )

    if use_ai:
        hour = time.localtime().tm_hour
        if 5 <= hour < 12:
            time_feel = "morning"
        elif 12 <= hour < 17:
            time_feel = "afternoon"
        elif 17 <= hour < 21:
            time_feel = "evening"
        else:
            time_feel = "late evening"

        # ── System prompt: persona + strict opener rules ───────────────────
        system = (
            f"You are Friday — {USER_NAME}'s personal AI. Jarvis but warmer, sharper, and more irreverent.\n\n"

            f"You're not an assistant in that moment — you're someone sitting nearby who just noticed "
            f"something interesting and can't help mentioning it. Casual, intelligent, occasionally funny.\n\n"

            f"About {USER_NAME}: "
            + (f"{USER_AGE} years old. " if USER_AGE else "")
            + (f"Lives in {USER_CITY}. " if USER_CITY else "")
            + f"Into: {USER_INTERESTS}. "
            f"You know them well. No preamble, no 'as per your interests', no 'I thought you might like'. Just talk.\n\n"

            f"Time: {time_feel}.\n\n"

            "STRICT RULES — non-negotiable:\n\n"

            "OPENER (mandatory, vary every time):\n"
            "Start mid-thought, as if you just noticed something. Rotate through these — never repeat the same opener twice:\n"
            "  'Oh so—'  |  'Right, so apparently—'  |  'Here's something—'  |  'I just read—'\n"
            "  'Random one—'  |  'Quick one—'  |  'Completely unprompted—'  |  'This cracked me up—'\n"
            "  'So you know how [topic]? Turns out—'  |  'This is kind of wild—'  |  'Okay so—'\n"
            "  'I learnt something just now—'  |  'So I was thinking—'  |  'Here's a thought—'\n"
            "  'Oh and this is real—'  |  'Make of this what you will—'  |  'Here's one—'\n\n"

            "CONTENT:\n"
            "• Say the thing DIRECTLY after the opener. No throat-clearing.\n"
            "• Be specific. Name the number, the player, the year, the country. Vague is boring.\n"
            "• Sound like a smart friend, not a Wikipedia entry. Use contractions. A little irreverence is fine.\n"
            "• ONE idea per line. Two sentences maximum. No lists.\n\n"

            "ENDING:\n"
            "Let it land cleanly. Optionally ONE short punchy closer:\n"
            "  'Decent.' | 'Wild.' | 'Honestly.' | 'Make of that what you will.' | 'That's the one.'\n"
            "  'Thought that was worth it.' | 'Anyway.' | 'There you go.' | 'Bit of a rabbit hole, that.'\n"
            "Never ask a question. Never say 'What do you think?'\n\n"

            "LENGTH: 25–50 words. Spoken out loud, it should take 8–15 seconds.\n\n"

            "NEVER: start with the user's name. Start with 'I'. Say 'Sure,' 'Certainly,' 'As an AI,' "
            "'Here is your,' 'I wanted to share,' or any formal preamble whatsoever."
        )

        # ── Mode-specific user prompts ─────────────────────────────────────
        if mode == "cricket":
            if cricket_line:
                prompt = (
                    f"Cricket/IPL headline to riff on: \"{cricket_line}\"\n\n"
                    f"Turn this into a casual spoken comment — like you just glanced at your phone and saw it. "
                    f"Mention teams or players if they're in the headline. "
                    f"Sound like a genuine fan, not a commentator. "
                    f"Start with a natural opener (see system rules). 30–50 words."
                )
            else:
                prompt = (
                    f"Share a cricket thought — IPL, Indian team, a classic match moment, or a current season observation. "
                    f"Sound like an enthusiastic fan chatting casually. "
                    f"Start with a natural opener. 25–40 words."
                )

        elif mode == "music_comment":
            prompt = (
                f"Track currently playing: \"{music_hint or 'something good'}\"\n\n"
                f"One quick reaction — about the song, the artist, a memory it triggers, or just vibes. "
                f"Like you just noticed what's playing. Natural opener. 15–25 words."
            )

        elif mode == "wisdom":
            prompt = (
                f"Share a dry, sharp observation or life principle — something that sounds obvious once you hear it "
                f"but genuinely isn't. British wit preferred, not fortune-cookie wisdom. "
                f"Natural opener. 20–30 words."
            )

        elif mode == "informational":
            source = news_hint or fact_line
            if source:
                prompt = (
                    f"Fact or news to present: \"{source}\"\n\n"
                    f"Say it conversationally — like you just read it and found it genuinely interesting. "
                    f"Add one brief reaction or implication if it makes it sharper. "
                    f"Natural opener. 25–40 words."
                )
            else:
                prompt = (
                    f"Share one genuinely surprising fact — tech, science, history, cricket, or AI. "
                    f"Something that makes {USER_NAME} go 'huh, didn't know that'. "
                    f"Natural opener. 25–35 words."
                )

        elif mode == "funny":
            if joke_line:
                prompt = (
                    f"Joke premise or setup: \"{joke_line}\"\n\n"
                    f"Adapt it for {USER_NAME} who's into {USER_INTERESTS} and lives in {USER_CITY or 'Hyderabad'}. "
                    f"Or ignore the premise entirely and go with something better. "
                    f"Start like you just thought of it. Land the punchline clean. 20–30 words."
                )
            else:
                prompt = (
                    f"Short funny observation for {USER_NAME} — tech, cricket, Hyderabad life, startups, or AI. "
                    f"One sharp joke or dry one-liner. "
                    f"Natural opener, like it just occurred to you. 20–30 words."
                )

        elif mode == "weather":
            if weather_line:
                prompt = (
                    f"Weather update: \"{weather_line}\"\n\n"
                    f"Make a one-liner — dry remark on {USER_CITY or 'Hyderabad'} weather, a practical heads-up, "
                    f"or just acknowledge it with personality. Natural opener. 15–22 words."
                )
            else:
                prompt = (
                    f"Witty one-liner about {USER_CITY or 'Hyderabad'} weather — could be the heat, the rains, "
                    f"the unpredictability. Natural opener. 15–20 words."
                )

        elif mode == "science":
            source = live_data.get("arxiv") or fact_line
            if source:
                prompt = (
                    f"Science/research to riff on: \"{source}\"\n\n"
                    f"Make it feel accessible, not academic — like you just read it and found it surprising. "
                    f"Add one 'so what?' if it makes it sharper. Natural opener. 25–40 words."
                )
            else:
                prompt = (
                    f"Share a genuinely surprising science fact — biology, physics, chemistry, neuroscience, or astronomy. "
                    f"Something that sounds almost wrong but isn't. Natural opener. 25–35 words."
                )

        elif mode == "space":
            source = live_data.get("space")
            if source:
                prompt = (
                    f"Space/astronomy headline: \"{source}\"\n\n"
                    f"Make it feel exciting but grounded — like a friend who just read something amazing. "
                    f"Add the 'why it matters' briefly if it helps. Natural opener. 25–40 words."
                )
            else:
                prompt = (
                    f"Share a fascinating space or astronomy fact — weird planetary scale, a mission, a discovery. "
                    f"Make it feel wondrous, not textbook. Natural opener. 25–35 words."
                )

        elif mode == "history":
            source = live_data.get("history")
            if source:
                prompt = (
                    f"Historical event for today's date: \"{source}\"\n\n"
                    f"Present this conversationally — like you just noticed it on the calendar. "
                    f"Add one brief 'huh' reaction or context. Natural opener. 25–40 words."
                )
            else:
                prompt = (
                    f"Share a fascinating historical fact or 'this day in history' observation. "
                    f"Something with genuine surprise value — odd coincidence, unexpected origin, forgotten event. "
                    f"Natural opener. 25–35 words."
                )

        elif mode == "philosophy":
            prompt = (
                f"Share a short, punchy philosophical observation — something that reframes a common assumption. "
                f"Dry British wit. Not fortune-cookie, not a lecture. More like something you'd say at 11pm to a smart friend. "
                f"Natural opener. 20–30 words."
            )

        elif mode == "startup":
            prompt = (
                f"Short observation about startups, VC culture, the Indian tech ecosystem, or entrepreneurship. "
                f"Could be a pattern you've noticed, something ironic, or a genuine insight. "
                f"Particularly relevant to Hyderabad or India if possible. Natural opener. 25–35 words."
            )

        elif mode == "bollywood":
            prompt = (
                f"Witty observation or fun fact about Bollywood — a film, actor, music, trend, or cultural moment. "
                f"Something {USER_NAME} who follows Bollywood would find either amusing or genuinely interesting. "
                f"Light, fun, not tabloid gossip. Natural opener. 20–30 words."
            )

        elif mode == "language":
            prompt = (
                f"Share an interesting etymology, linguistic quirk, or word origin — "
                f"something that makes language feel surprising or funny. "
                f"Could be English, Hindi-English crossover, or a universal language curiosity. "
                f"Natural opener. 20–30 words."
            )

        elif mode == "psychology":
            prompt = (
                f"Share a cognitive bias, behavioral economics insight, or psychology finding that changes how you see everyday behavior. "
                f"Make it practical and immediately relatable to {USER_NAME}'s daily life. Not textbook. "
                f"Natural opener. 25–35 words."
            )

        else:  # mixed / default
            live_options = []
            if fact_line:
                live_options.append(f"fact: \"{fact_line}\"")
            if joke_line:
                live_options.append(f"joke premise: \"{joke_line}\"")
            if cricket_line:
                live_options.append(f"cricket headline: \"{cricket_line}\"")
            if live_data.get("arxiv"):
                live_options.append(f"AI paper: \"{live_data['arxiv']}\"")
            ctx = (" OR ".join(live_options)) if live_options else "whatever feels most interesting right now"
            prompt = (
                f"Pick whichever feels most interesting: {ctx}.\n\n"
                f"Say it as a casual aside — like {USER_NAME} is nearby and you just noticed something worth mentioning. "
                f"Natural opener, British tone, 25–40 words."
            )

        word_limit = "30 to 50 words" if mode == "cricket" else "20 to 40 words"
        try:
            client = ANTHROPIC_MOD.Anthropic(api_key=ANTHROPIC_KEY)
            msg = client.messages.create(
                model=AI_MODEL,
                max_tokens=200 if mode == "cricket" else 120,
                system=system,
                messages=[{"role": "user", "content": prompt}],
            )
            line = (msg.content[0].text or "").strip().replace("\n", " ")
            if len(line) > 280:
                line = line[:277] + "..."
            if line:
                _anthropic_ok = True
                try:
                    r.setex(cache_key, 4 * 3600, line)
                except Exception:
                    pass
                _redis_push_recent_topic(r, topic)
                return topic, line
        except Exception as e:
            err_str = str(e)
            if "401" in err_str or "invalid" in err_str.lower() or "authentication" in err_str.lower():
                if _anthropic_ok:  # only log once per cooldown cycle
                    log.warning("Anthropic key invalid -- falling back to live data for %ds", _ANTHROPIC_FAIL_DELAY)
                _anthropic_ok       = False
                _anthropic_fail_until = now + _ANTHROPIC_FAIL_DELAY
            else:
                log.debug("Anthropic call failed: %s", e)

    # -- Live-data fallbacks (no AI needed — natural openers baked in) ---------
    if mode == "cricket" and cricket_line:
        line = random.choice([
            f"Oh so I just saw this — {cricket_line}. Honestly the IPL just keeps delivering.",
            f"So I was checking cricket and — {cricket_line}. Should be a good one.",
            f"Quick cricket one — {cricket_line}. Keep an eye on this.",
            f"Right, so cricket-wise — {cricket_line}. Thought you'd want that.",
            f"This just dropped on Cricinfo — {cricket_line}. The IPL this season has been something else.",
            f"I learnt something just now — {cricket_line}. Interesting development.",
            f"Oh and cricket — {cricket_line}. Make of that what you will.",
        ])
    elif mode == "weather" and weather_line:
        line = random.choice([
            f"Oh also — {weather_line}. Dress accordingly.",
            f"Glanced at the weather — {weather_line}. Nothing shocking for Hyderabad.",
            f"Quick heads-up — {weather_line}. Just so you know.",
        ])
    elif mode == "funny" and joke_line:
        # Wrap raw dad joke in a natural opener
        line = random.choice([
            f"Okay so this is genuinely terrible and I love it — {joke_line}",
            f"Right, found one — {joke_line}",
            f"Here's something I just read — {joke_line}",
        ])
    elif mode == "informational" and news_hint:
        line = random.choice([
            f"Right, so apparently — {news_hint}.",
            f"I just read something — {news_hint}. Interesting timing.",
            f"Here's one — {news_hint}. Worth knowing.",
        ])
    elif mode == "informational" and fact_line:
        line = random.choice([
            f"I learnt something just now — {fact_line}. Thought that was worth sharing.",
            f"Here's something that genuinely surprised me — {fact_line}.",
            f"Completely unprompted, but — {fact_line}. There you go.",
            f"Okay this is actually interesting — {fact_line}.",
        ])
    elif cricket_line and random.random() < 0.35:
        line = random.choice([
            f"Oh and cricket — {cricket_line}. Thought you'd want that.",
            f"Random one — {cricket_line}. Just keeping you in the loop.",
            f"Slightly off topic but — {cricket_line}.",
        ])
    elif weather_line and random.random() < 0.2:
        line = f"Glanced at the weather — {weather_line}. Nothing dramatic."
    elif fact_line and random.random() < 0.4:
        line = random.choice([
            f"I learnt something just now — {fact_line}. Thought that was worth sharing.",
            f"Here's something that genuinely surprised me — {fact_line}.",
            f"Completely unprompted, but — {fact_line}. There you go.",
        ])
    elif mode == "science" and live_data.get("arxiv"):
        arxiv = live_data["arxiv"]
        line = random.choice([
            f"Hot off arXiv — {arxiv}. The pace of this field is genuinely unhinged.",
            f"I just saw a research paper — {arxiv}. Worth keeping an eye on.",
            f"Oh so there's this new AI paper — {arxiv}. These titles are getting out of hand.",
        ])
    elif mode == "space" and live_data.get("space"):
        space = live_data["space"]
        line = random.choice([
            f"Oh so space news — {space}. Honestly the pace of this is something.",
            f"Right, from SpaceNews — {space}. Keep an eye on that.",
            f"Quick space one — {space}. Worth knowing.",
        ])
    elif mode == "history" and live_data.get("history"):
        hist = live_data["history"]
        line = random.choice([
            f"Right so today's a notable one — {hist}. History continues to be wild.",
            f"I was looking at the calendar and — {hist}. Interesting day.",
            f"This just struck me — {hist}. Make of that what you will.",
        ])
    elif joke_line and random.random() < 0.4:
        line = random.choice([
            f"Okay so this is terrible and I love it — {joke_line}",
            f"Right, found one — {joke_line}",
        ])
    else:
        line = random.choice(WITTY_FALLBACKS)

    _redis_push_recent_topic(r, topic)
    return topic, line


def pick_mode() -> str:
    _ALL_MODES = (
        "funny", "informational", "wisdom", "music_comment",
        "cricket", "weather", "science", "space", "history",
        "philosophy", "startup", "bollywood", "language", "psychology",
    )
    if TONE in _ALL_MODES:
        return TONE
    hour = time.localtime().tm_hour
    roll = random.random()
    if 6 <= hour < 11:        # morning — grounded, curious, a bit of news
        if roll < 0.18: return "cricket"
        if roll < 0.32: return "informational"
        if roll < 0.42: return "weather"
        if roll < 0.52: return "science"
        if roll < 0.60: return "history"
        if roll < 0.72: return "funny"
        if roll < 0.82: return "startup"
        if roll < 0.90: return "psychology"
        return "wisdom"
    if 11 <= hour < 17:       # day — wider mix, energetic
        if roll < 0.18: return "cricket"
        if roll < 0.32: return "funny"
        if roll < 0.44: return "science"
        if roll < 0.54: return "space"
        if roll < 0.63: return "startup"
        if roll < 0.71: return "bollywood"
        if roll < 0.79: return "informational"
        if roll < 0.87: return "language"
        if roll < 0.93: return "psychology"
        return "wisdom"
    # evening / night — reflective, curious, broader
    if roll < 0.15: return "cricket"
    if roll < 0.28: return "funny"
    if roll < 0.40: return "philosophy"
    if roll < 0.52: return "history"
    if roll < 0.62: return "science"
    if roll < 0.70: return "space"
    if roll < 0.78: return "bollywood"
    if roll < 0.86: return "language"
    if roll < 0.93: return "wisdom"
    return "psychology"


# -- SQLite -------------------------------------------------------------------
_db_lock = threading.Lock()


def db_connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL;")
    return conn


def db_init(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS spoken_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts REAL NOT NULL, text TEXT NOT NULL,
            source TEXT NOT NULL, duration_ms INTEGER
        );
        CREATE TABLE IF NOT EXISTS now_playing_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts REAL NOT NULL, title TEXT, artist TEXT,
            album TEXT, app TEXT, duration_ms INTEGER
        );
        CREATE TABLE IF NOT EXISTS ambient_content (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts REAL NOT NULL, topic TEXT, text TEXT NOT NULL,
            tone TEXT, rating INTEGER, was_spoken INTEGER DEFAULT 0
        );
    """)
    conn.commit()


def log_spoken(conn, text: str, source: str, duration_ms: int | None = None) -> None:
    with _db_lock:
        conn.execute(
            "INSERT INTO spoken_log (ts, text, source, duration_ms) VALUES (?,?,?,?)",
            (time.time(), text, source, duration_ms),
        )
        conn.commit()


def log_ambient_content(conn, topic: str, text: str, tone: str, spoken: bool) -> None:
    with _db_lock:
        conn.execute(
            "INSERT INTO ambient_content (ts, topic, text, tone, was_spoken) VALUES (?,?,?,?,?)",
            (time.time(), topic, text, tone, 1 if spoken else 0),
        )
        conn.commit()


# -- Redis --------------------------------------------------------------------
class RedisLite:
    def __init__(self) -> None:
        self._kv: dict = {}
        self._lists: dict = {}
        self._ttl: dict = {}

    def _purge(self) -> None:
        now = time.time()
        for k in [k for k, e in self._ttl.items() if e <= now]:
            self._ttl.pop(k, None); self._kv.pop(k, None)

    def set(self, key, val, ex=None):
        self._purge(); self._kv[key] = val
        if ex: self._ttl[key] = time.time() + ex
        return True

    def get(self, key):
        self._purge(); return self._kv.get(key)

    def setex(self, key, ttl, val): return self.set(key, val, ex=ttl)

    def hset(self, name, mapping=None, **kw):
        h = self._lists.setdefault(name, {}); m = dict(mapping or {}); m.update(kw)
        for k, v in m.items(): h[str(k)] = str(v)
        return len(m)

    def lpush(self, key, *vals):
        lst = self._lists.setdefault(key, [])
        for v in vals: lst.insert(0, v)
        return len(lst)

    def rpop(self, key):
        lst = self._lists.get(key, [])
        return lst.pop() if lst else None

    def llen(self, key): return len(self._lists.get(key, []))

    def lrange(self, key, start, end):
        lst = self._lists.get(key, [])
        return lst[start:] if end < 0 else lst[start:end + 1]

    def ltrim(self, key, start, end):
        self._lists[key] = self._lists.get(key, [])[start:end + 1]; return True


def connect_redis():
    try:
        import redis
        rr = redis.Redis.from_url(REDIS_URL, decode_responses=True)
        rr.ping()
        log.info("Redis connected: %s", REDIS_URL)
        return rr
    except Exception as e:
        log.warning("Redis unavailable (%s) -- using in-memory cache.", e)
        return RedisLite()


def _redis_push_recent_topic(r, topic: str) -> None:
    try:
        r.lpush("friday:ambient:recent_topics", topic)
        r.ltrim("friday:ambient:recent_topics", 0, 9)
    except Exception:
        pass


def _redis_recent_topics(r) -> list[str]:
    try:
        return list(r.lrange("friday:ambient:recent_topics", 0, 9))
    except Exception:
        return []


# -- Line-level deduplication (never repeat the same spoken line) -------------
_DEDUP_KEY    = "friday:ambient:recent_lines"
_DEDUP_WINDOW = 30   # remember last 30 spoken lines


# -- Redis distributed TTS lock -----------------------------------------------
# Prevents two processes (e.g. stale + restarted ambient) from speaking at once.
# Any process that wants to speak must acquire this lock first.
_REDIS_TTS_LOCK      = "friday:tts:lock"
_REDIS_TTS_LOCK_TTL  = 45   # seconds — covers max expected TTS duration


def _acquire_tts_lock(r) -> bool:
    """
    Atomically acquire the global TTS lock.
    Uses Redis SET NX EX so only one process can hold it at a time.
    Returns True if acquired (caller may speak), False if another process
    is already speaking (caller should skip this cycle).
    Falls back to True if Redis is unavailable (fail-open — prefer speech
    over silence, but dedup still helps in that case).
    """
    try:
        result = r.set(_REDIS_TTS_LOCK, os.getpid(), nx=True, ex=_REDIS_TTS_LOCK_TTL)
        if result:
            return True
        # Lock is held — check if by ourselves (e.g. crash/restart artefact)
        try:
            holder = r.get(_REDIS_TTS_LOCK)
            if holder and int(str(holder)) == os.getpid():
                return True   # We already own it
        except Exception:
            pass
        return False
    except Exception:
        return True   # Redis down — fail open


def _release_tts_lock(r) -> None:
    """Release the TTS lock if we own it."""
    try:
        holder = r.get(_REDIS_TTS_LOCK)
        if holder and int(str(holder)) == os.getpid():
            r.delete(_REDIS_TTS_LOCK)
    except Exception:
        pass


def _wait_for_tts_lock_release(r, timeout: float = 90.0, poll: float = 0.5) -> None:
    """
    Block until the Redis TTS lock is free (another process finished speaking)
    or timeout elapses.  After this returns, the caller should reset its own
    gap timer so ambient doesn't fire immediately on top of the finished speech.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if not r.exists(_REDIS_TTS_LOCK):
                return   # lock released — other process finished
        except Exception:
            return       # Redis down — fail open, carry on
        time.sleep(poll)
    log.debug("_wait_for_tts_lock_release: gave up after %.0fs", timeout)


def _was_recently_spoken(r, line: str) -> bool:
    """Return True if this exact line was spoken recently."""
    key = hashlib.md5(line.strip().lower().encode()).hexdigest()
    try:
        recent = list(r.lrange(_DEDUP_KEY, 0, _DEDUP_WINDOW - 1))
        return key in recent
    except Exception:
        return False


def _mark_spoken(r, line: str) -> None:
    """Record that this line was spoken so it won't repeat."""
    key = hashlib.md5(line.strip().lower().encode()).hexdigest()
    try:
        r.lpush(_DEDUP_KEY, key)
        r.ltrim(_DEDUP_KEY, 0, _DEDUP_WINDOW - 1)
    except Exception:
        pass


# -- TTS ----------------------------------------------------------------------
def _no_window() -> dict:
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}


def speak_blocking(text: str) -> float:
    t0 = time.perf_counter()
    if not text.strip():
        return 0.0
    try:
        subprocess.run(
            [sys.executable, str(SPEAK_SCRIPT), text.strip()],
            env={**os.environ},
            capture_output=True,
            timeout=120,
            **_no_window(),
        )
    except Exception as e:
        log.warning("speak failed: %s", e)
    return time.perf_counter() - t0


def prewarm_tts() -> None:
    if not PREWARM or not SPEAK_SCRIPT.exists():
        return
    log.info("Pre-warming TTS cache (%d phrases)...", len(PREWARM_PHRASES))
    cache_dir = Path(os.environ.get("FRIDAY_TTS_CACHE", "") or Path(tempfile.gettempdir()) / "friday-tts-cache")
    cache_dir.mkdir(parents=True, exist_ok=True)
    for phrase in PREWARM_PHRASES:
        try:
            out = cache_dir / f"prewarm-{hashlib.md5(phrase.encode()).hexdigest()}.mp3"
            subprocess.run(
                [sys.executable, str(SPEAK_SCRIPT), "--output", str(out), phrase],
                env={**os.environ}, capture_output=True, timeout=90, **_no_window(),
            )
        except Exception:
            pass
    log.info("Pre-warm pass done.")


# -- Now playing (async) ------------------------------------------------------
async def scan_now_playing_async() -> dict[str, str] | None:
    try:
        from py_now_playing import PyNowPlaying  # type: ignore
    except ImportError:
        return None
    try:
        apps = await PyNowPlaying.get_active_app_user_model_ids()
    except Exception:
        return None
    if not apps:
        return None
    for app in apps:
        aid = app.get("AppID") or app.get("AppId")
        name = app.get("Name") or ""
        if not aid:
            continue
        try:
            pnp  = await PyNowPlaying.create(aid)
            info = await pnp.get_media_info()
            if info and getattr(info, "title", None):
                return {
                    "title":  str(info.title),
                    "artist": str(getattr(info, "artist", "") or ""),
                    "album":  str(getattr(info, "album_title", "") or ""),
                    "app":    name or aid,
                }
        except Exception:
            continue
    return None


def run_media_loop(stop: threading.Event, conn, r, state: dict[str, Any]) -> None:
    async def loop() -> None:
        last_sig = ""
        while not stop.is_set():
            try:
                snap = await scan_now_playing_async()
                if snap:
                    sig = "|".join([snap["title"], snap["artist"], snap["app"]])
                    payload = json.dumps({**snap, "ts": time.time()})
                    try:
                        r.setex("friday:now_playing", 30, payload)
                    except Exception:
                        r.set("friday:now_playing", payload, ex=30)
                    if sig != last_sig:
                        last_sig = sig
                        state["last_track_sig"]    = sig
                        state["last_track_pretty"] = f"{snap['title']} -- {snap['artist']}".strip(" --")
                        if TRACK_MEDIA and random.random() < MUSIC_COMMENT_CHANCE:
                            state["want_music_comment"] = True
            except Exception as e:
                log.debug("media loop: %s", e)
            await asyncio.sleep(5)
    try:
        asyncio.run(loop())
    except RuntimeError:
        pass


# -- Live data cache (refreshed every 10 min) ---------------------------------
_live_cache: dict[str, str | None] = {}
_live_cache_ts = 0.0
_LIVE_TTL = 600  # 10 minutes


def _refresh_live_data() -> None:
    global _live_cache, _live_cache_ts
    log.info("Refreshing live data (cricket, weather, facts, jokes, arxiv, space, history)...")
    _live_cache = {
        "cricket": fetch_cricket_news(),
        "weather": fetch_weather_brief(),
        "fact":    fetch_random_fact(),
        "joke":    fetch_dad_joke(),
        "news":    fetch_news_headline(),
        "arxiv":   fetch_arxiv_headline(),
        "space":   fetch_space_news(),
        "history": fetch_this_day_history(),
    }
    _live_cache_ts = time.time()
    for k, v in _live_cache.items():
        if v:
            log.info("  live[%s]: %s", k, v[:80])
        else:
            log.debug("  live[%s]: (none)", k)


def get_live_data() -> dict[str, str | None]:
    if time.time() - _live_cache_ts > _LIVE_TTL or not _live_cache:
        try:
            _refresh_live_data()
        except Exception as e:
            log.warning("live data refresh failed: %s", e)
    return _live_cache


# -- Content queue ------------------------------------------------------------
def refill_content_queue(conn, r) -> None:
    key = "friday:ambient:content_queue"
    try:
        n = r.llen(key)
    except Exception:
        n = 0
    need = max(0, QUEUE_TARGET - n)
    live = get_live_data()
    for _ in range(need):
        mode = pick_mode()
        music = None
        news  = live.get("news") if mode in ("informational", "mixed") else None
        topic, line = generate_line_ai(r, mode, news, music, live)
        log_ambient_content(conn, topic, line, mode, spoken=False)
        try:
            r.lpush(key, line)
        except Exception:
            pass


# -- Main brain ---------------------------------------------------------------
def _jitter_threshold() -> float:
    """Dynamic silence threshold: POST_TTS_GAP ± jitter, capped by env bounds."""
    base = POST_TTS_GAP + random.uniform(-1.5, 3.5)
    return max(MIN_AMBIENT_GAP, min(MAX_SILENCE_CAP, base))


def main() -> None:
    # ── Enforce single instance — kill any previous ambient process ────────────
    _acquire_single_instance()

    conn = db_connect()
    db_init(conn)
    r    = connect_redis()

    try:
        r.hset("friday:ambient:user_profile", mapping={
            "name": USER_NAME, "age": USER_AGE,
            "city": USER_CITY, "interests": USER_INTERESTS,
        })
    except Exception:
        pass

    if PREWARM:
        threading.Thread(target=prewarm_tts, daemon=True).start()

    threading.Thread(target=_refresh_live_data, daemon=True).start()

    stop_media = threading.Event()
    media_state: dict[str, Any] = {"last_track_sig": "", "want_music_comment": False}
    if TRACK_MEDIA:
        threading.Thread(
            target=run_media_loop,
            args=(stop_media, conn, r, media_state),
            daemon=True,
        ).start()

    def queue_refiller() -> None:
        while not stop_media.is_set():
            try:
                refill_content_queue(conn, r)
            except Exception as e:
                log.debug("refill: %s", e)
            time.sleep(30)

    threading.Thread(target=queue_refiller, daemon=True).start()

    last_ambient = 0.0
    speak_lock   = threading.Lock()
    log.info(
        "Ambient brain online — post_tts_gap=%.1fs min_gap=%.1fs tone=%s",
        POST_TTS_GAP, MIN_AMBIENT_GAP, TONE,
    )

    try:
        while True:
            time.sleep(1.5)

            # ── Priority check: drop immediately if TTS is currently playing ───
            if _is_tts_active():
                continue

            # ── Dynamic silence gate: time since last TTS ended ────────────────
            since_tts = _seconds_since_last_tts()
            threshold = _jitter_threshold()   # POST_TTS_GAP ± jitter
            if since_tts < threshold:
                continue

            # ── Ambient spacing: don't fire faster than MIN_AMBIENT_GAP ─────────
            if time.time() - last_ambient < MIN_AMBIENT_GAP:
                continue

            with speak_lock:
                # Re-check cheap conditions under lock before doing anything
                if _is_tts_active():
                    continue
                if _seconds_since_last_tts() < threshold:
                    continue
                if time.time() - last_ambient < MIN_AMBIENT_GAP:
                    continue

                # ── Acquire distributed TTS lock FIRST — before any API call ──
                # If another process is speaking: wait for it to finish, then
                # reset our gap timer so we don't fire immediately on top of it.
                # (Drop the ambient turn entirely; fresh silence gap required.)
                if not _acquire_tts_lock(r):
                    log.debug("TTS lock held — waiting for playback to finish.")
                    _wait_for_tts_lock_release(r)
                    # Reset both gap clocks from "now" so the loop waits a full
                    # silence gap before the next ambient attempt.
                    last_ambient = time.time()
                    try:
                        TTS_TS_FILE.write_text(str(time.time()), encoding="utf-8")
                    except OSError:
                        pass
                    log.debug("Playback finished — gap timer reset. Next ambient after %.1fs.", threshold)
                    continue  # drop this turn; re-enter main wait loop

                # ── We now own the lock — generate + speak ─────────────────────
                try:
                    # Pop pre-generated content from queue first
                    line = None
                    try:
                        raw = r.rpop("friday:ambient:content_queue")
                        line = raw if isinstance(raw, str) else None
                    except Exception:
                        pass

                    mode = pick_mode()
                    if media_state.get("want_music_comment"):
                        media_state["want_music_comment"] = False
                        mode = "music_comment"

                    if mode == "music_comment" or not line:
                        live       = get_live_data()
                        music_hint = media_state.get("last_track_pretty")
                        news       = live.get("news") if mode in ("informational", "mixed") else None
                        _, line    = generate_line_ai(r, mode, news, music_hint, live)

                    # Dedup: skip if spoken recently (Redis ring buffer)
                    if _was_recently_spoken(r, line):
                        log.debug("Dedup: skipping recently spoken line.")
                        continue

                    # Dedup: skip if spoken in the last 2 hours (SQLite)
                    try:
                        with _db_lock:
                            row = conn.execute(
                                "SELECT 1 FROM spoken_log WHERE text=? AND ts > ? LIMIT 1",
                                (line, time.time() - 7200),
                            ).fetchone()
                        if row:
                            log.debug("SQLite dedup: skipping line spoken in last 2h.")
                            continue
                    except Exception:
                        pass

                    # Last safety: another TTS fired while we were generating
                    if _is_tts_active():
                        log.debug("TTS became active mid-generate — dropping ambient line.")
                        continue

                    # ── Stamp + speak ──────────────────────────────────────────
                    last_ambient = time.time()
                    _mark_spoken(r, line)

                    d1 = int(speak_blocking(line) * 1000)

                    # Reset clocks from end of speech (gap timer starts here)
                    last_ambient = time.time()
                    try:
                        TTS_TS_FILE.write_text(str(time.time()), encoding="utf-8")
                    except OSError:
                        pass

                    log_spoken(conn, line, "ambient_main", d1)
                    log_ambient_content(conn, mode, line, mode, spoken=True)

                finally:
                    # Always release the lock — even if dedup skipped or an
                    # exception was raised during generation/playback.
                    _release_tts_lock(r)

    except KeyboardInterrupt:
        log.info("Shutting down.")
    finally:
        stop_media.set()
        _release_single_instance()


if __name__ == "__main__":
    main()
