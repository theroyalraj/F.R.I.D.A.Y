#!/usr/bin/env python3
"""
friday-music-scheduler.py — background daemon that plays a song at a fixed interval.

Picks a random song from FRIDAY_MUSIC_SCHEDULER_PLAYLIST or FRIDAY_MUSIC_PLAYLIST and plays it via
friday-play.py every FRIDAY_MUSIC_INTERVAL_MIN minutes (default: 30). Boot entry music uses FRIDAY_ENTRY_PLAYLIST separately.

Skips if TTS is currently active (friday-tts-active lock exists) or if friday-play
is already running. Respects FRIDAY_MUSIC_SCHEDULER=false to disable.

Optional “ask first” (default off): speak a short prompt and wait for voice yes/no from
friday-listen.py (same machine). Set FRIDAY_MUSIC_ASK_BEFORE_PLAY=true.

By default each playlist entry plays at most once per scheduler process (one OpenClaw run).
Set FRIDAY_MUSIC_SESSION_NO_REPEAT=false to allow the same track to come up again randomly.

Usage:
  python scripts/friday-music-scheduler.py

Env vars (all optional — reads .env):
  FRIDAY_MUSIC_SCHEDULER       true/false to enable/disable (default: true if script is run)
  FRIDAY_MUSIC_INTERVAL_MIN    minutes between songs (default: 30)
  FRIDAY_MUSIC_SCHEDULER_PLAYLIST  optional — comma-separated phrases for this daemon only; if unset, FRIDAY_MUSIC_PLAYLIST
  FRIDAY_MUSIC_PLAYLIST        legacy flat list OR international pool when FRIDAY_MUSIC_HINDI_PLAYLIST is set
  FRIDAY_MUSIC_HINDI_PLAYLIST  optional — if non-empty, enables weighted pick: ~FRIDAY_MUSIC_HINDI_WEIGHT_PCT% Hindi vs intl
  FRIDAY_MUSIC_INTL_PLAYLIST   optional international pool; if empty, FRIDAY_MUSIC_PLAYLIST (or scheduler playlist) is used
  FRIDAY_MUSIC_HINDI_WEIGHT_PCT  Hindi vs intl: use 0.025 for two point five percent (fraction 0<w<1), or 70 for seventy percent (integer or >=1 = percent). Other pool tried if first is exhausted.
  (Use search phrases with "latest", "trending", "new" in Hindi/Intl lines so yt-dlp surfaces fresher chart results.)
  FRIDAY_MUSIC_SESSION_NO_REPEAT true (default) = never replay a track until restart/npm run start:all
  FRIDAY_MUSIC_FIRST_WAIT_SEC  seconds before first song (optional; default min(120, interval))
  FRIDAY_MUSIC_ASK_BEFORE_PLAY true = speak a prompt and wait for mic yes/no before playing
                                 (recommended true — avoids surprise music when the scheduler fires)
  FRIDAY_MUSIC_ASK_WAIT_SEC    seconds to wait for an answer (default: 90)
  FRIDAY_MUSIC_ASK_POST_PROMPT_SEC  seconds of silence after the ask TTS before yes/no counts (default: 5)
  FRIDAY_SCHEDULER_PLAY_SECONDS  clip length for scheduler plays (default: FRIDAY_PLAY_SECONDS)
  FRIDAY_PLAY_SECONDS          fallback when scheduler entry seconds unset (default: 45)
  FRIDAY_PLAY_VOLUME           ffplay volume 0-100 (default: 70)
"""

import json
import logging
import os
import random
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

ENV_PATH = ROOT / ".env"
if ENV_PATH.exists():
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        t = line.strip()
        if not t or t.startswith("#") or "=" not in t:
            continue
        k, _, rest = t.partition("=")
        k = k.strip()
        v = rest.split("#", 1)[0].strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v

PLAY_SCRIPT = ROOT / "skill-gateway" / "scripts" / "friday-play.py"
SPEAK_SCRIPT = ROOT / "skill-gateway" / "scripts" / "friday-speak.py"
TTS_ACTIVE_FILE = Path(tempfile.gettempdir()) / "friday-tts-active"
PLAY_PID_FILE = Path(tempfile.gettempdir()) / "friday-play.pid"
MUSIC_OFFER_FILE = Path(tempfile.gettempdir()) / "friday-music-offer.json"
MUSIC_OFFER_RESPONSE_FILE = Path(tempfile.gettempdir()) / "friday-music-offer-response.txt"


def _python_for_friday_play() -> str:
    if sys.platform != "win32":
        return sys.executable
    override = os.environ.get("FRIDAY_PYTHON_CHILD", "").strip()
    if override:
        return override
    base = Path(sys.executable)
    w = base.parent / "pythonw.exe"
    if w.is_file():
        return str(w)
    return sys.executable


_autoplay_raw = os.environ.get("FRIDAY_AUTOPLAY", "true").lower()
AUTOPLAY_ENABLED = _autoplay_raw not in ("false", "0", "off", "no")

INTERVAL_MIN = float(os.environ.get("FRIDAY_MUSIC_INTERVAL_MIN", "30"))
DEFAULT_SONG = os.environ.get("FRIDAY_STARTUP_SONG", "Back in Black AC DC")
_SCHEDULER_ONLY = os.environ.get("FRIDAY_MUSIC_SCHEDULER_PLAYLIST", "").strip()
_BASE_MUSIC_RAW = _SCHEDULER_ONLY or os.environ.get("FRIDAY_MUSIC_PLAYLIST", "").strip()


def _split_csv(raw: str) -> list[str]:
    return [s.strip() for s in raw.split(",") if s.strip()]


HINDI_POOL = _split_csv(os.environ.get("FRIDAY_MUSIC_HINDI_PLAYLIST", "").strip())
_INTL_ENV = os.environ.get("FRIDAY_MUSIC_INTL_PLAYLIST", "").strip()
INTL_POOL = _split_csv(_INTL_ENV) if _INTL_ENV else _split_csv(_BASE_MUSIC_RAW)
if HINDI_POOL and not INTL_POOL:
    INTL_POOL = [DEFAULT_SONG]

_hindi_w_raw = os.environ.get("FRIDAY_MUSIC_HINDI_WEIGHT_PCT", "70").strip().split("#")[0].strip()
try:
    _hw = float(_hindi_w_raw)
    # 0 < w < 1  → fraction (e.g. 0.025 = 2.5% Hindi); else percent 0–100 (e.g. 70 = 70%)
    if 0 < _hw < 1:
        HINDI_WEIGHT = max(0.0, min(1.0, _hw))
    else:
        HINDI_WEIGHT = max(0.0, min(100.0, _hw)) / 100.0
except ValueError:
    HINDI_WEIGHT = 0.70

WEIGHTED_HINDI_MODE = bool(HINDI_POOL)

# Legacy single-list mode when no Hindi pool configured
LEGACY_PLAYLIST = _split_csv(_BASE_MUSIC_RAW) if _BASE_MUSIC_RAW else [DEFAULT_SONG]

# Tracks successfully played this process lifetime (cleared only when scheduler restarts).
_SESSION_PLAYED: set[str] = set()


def _session_no_repeat() -> bool:
    v = os.environ.get("FRIDAY_MUSIC_SESSION_NO_REPEAT", "true").strip().lower()
    return v not in ("0", "false", "no", "off")


def _pick_from_pool(pool: list[str], label: str) -> str | None:
    """Pick one search phrase from pool; respects session no-repeat."""
    if not pool:
        return None
    if not _session_no_repeat():
        choice = random.choice(pool)
        log.info("pick [%s]: %r (repeat allowed; pool=%d)", label, choice, len(pool))
        return choice
    avail = [s for s in pool if s not in _SESSION_PLAYED]
    if not avail:
        log.debug("pool %s exhausted (%d played)", label, len(pool))
        return None
    choice = random.choice(avail)
    log.info(
        "pick [%s]: %r | unused=%d/%d | played=%s",
        label,
        choice,
        len(avail),
        len(pool),
        sorted(_SESSION_PLAYED) if _SESSION_PLAYED else "none",
    )
    return choice


def _pick_scheduled_track() -> str | None:
    """
    Choose the next scheduler track. Weighted Hindi/intl when FRIDAY_MUSIC_HINDI_PLAYLIST is set.
    Tries the weighted-first pool, then the other if the first has no unused tracks (session no-repeat).
    """
    if not WEIGHTED_HINDI_MODE:
        if not _session_no_repeat():
            choice = random.choice(LEGACY_PLAYLIST)
            log.info("pick: %r (repeat allowed; playlist=%d)", choice, len(LEGACY_PLAYLIST))
            return choice
        pool = [s for s in LEGACY_PLAYLIST if s not in _SESSION_PLAYED]
        if not pool:
            log.info(
                "pick: SKIP — all %d entr(y/ies) in scheduler playlist already played this run; "
                "no scheduler music until OpenClaw restart (FRIDAY_MUSIC_SESSION_NO_REPEAT=true)",
                len(LEGACY_PLAYLIST),
            )
            return None
        choice = random.choice(pool)
        log.info(
            "pick: %r | unused=%d/%d | already_played=%s",
            choice,
            len(pool),
            len(LEGACY_PLAYLIST),
            sorted(_SESSION_PLAYED) if _SESSION_PLAYED else "none",
        )
        return choice

    prefer_hindi = random.random() < HINDI_WEIGHT
    order = (
        (("hindi", HINDI_POOL), ("intl", INTL_POOL))
        if prefer_hindi
        else (("intl", INTL_POOL), ("hindi", HINDI_POOL))
    )
    for label, p in order:
        c = _pick_from_pool(p, label)
        if c is not None:
            return c
    log.info(
        "pick: SKIP — hindi and intl pools exhausted this session (no-repeat); restart stack to reset"
    )
    return None


def _record_played(song: str) -> None:
    if _session_no_repeat() and song:
        _SESSION_PLAYED.add(song)
        log.info("session played: %d unique track(s) so far", len(_SESSION_PLAYED))


def _ask_before_play_enabled() -> bool:
    v = os.environ.get("FRIDAY_MUSIC_ASK_BEFORE_PLAY", "").strip().lower()
    return v in ("1", "true", "yes", "on")


def _ask_wait_sec() -> float:
    raw = os.environ.get("FRIDAY_MUSIC_ASK_WAIT_SEC", "").strip().split("#")[0].strip()
    if raw:
        try:
            return max(15.0, min(float(raw), 600.0))
        except ValueError:
            pass
    return 90.0


def _ask_post_prompt_sec() -> float:
    """Seconds after ask TTS finishes before friday-listen may record yes/no (and before scheduler polls)."""
    raw = os.environ.get("FRIDAY_MUSIC_ASK_POST_PROMPT_SEC", "").strip().split("#")[0].strip()
    if raw:
        try:
            return max(0.0, min(float(raw), 120.0))
        except ValueError:
            pass
    return 5.0


_MUSIC_ASK_PROMPTS = (
    "Fancy a bit of noise? I had {song} lined up — say yes if you want it, or no if you're heads-down.",
    "Vibe check — mind if I put on {song}? Yes or no, your call.",
    "It's gone quiet. Want {song}, or shall I leave the silence alone? Just say yes or no.",
    "I could spin {song} — interested, or would you rather skip? Yes or no works.",
    "Quick one — {song} sounds good about now. Play it, or nah?",
    "{name}, permission to drop {song}? Yes means go, no means I'll park it.",
)


def _offer_prompt(song: str) -> str:
    name = (os.environ.get("FRIDAY_USER_NAME", "") or "").strip() or "mate"
    tmpl = random.choice(_MUSIC_ASK_PROMPTS)
    return tmpl.format(song=song, name=name)


def _speak_ask(prompt: str) -> None:
    try:
        from openclaw_company import friday_speak_env_for_persona

        env = {**os.environ, **friday_speak_env_for_persona("maestro", priority=True)}
    except Exception:
        env = {
            **os.environ,
            "FRIDAY_TTS_PRIORITY": "1",
            "FRIDAY_TTS_BYPASS_CURSOR_DEFER": "true",
        }
    kw: dict = {"cwd": str(ROOT), "env": env, "timeout": 120}
    if sys.platform == "win32":
        kw["creationflags"] = subprocess.CREATE_NO_WINDOW
    try:
        subprocess.run([sys.executable, str(SPEAK_SCRIPT), prompt], **kw)
    except Exception as e:
        log.warning("Ask prompt speak failed: %s", e)


def _wait_for_music_offer_result(deadline: float) -> str:
    """Poll response file from friday-listen. Returns yes | no | timeout (timeout = no music, witty line from scheduler)."""
    MUSIC_OFFER_RESPONSE_FILE.unlink(missing_ok=True)
    while time.time() < deadline:
        if MUSIC_OFFER_RESPONSE_FILE.is_file():
            try:
                raw = MUSIC_OFFER_RESPONSE_FILE.read_text(encoding="utf-8").strip().lower()
                MUSIC_OFFER_RESPONSE_FILE.unlink(missing_ok=True)
                if raw in (
                    "yes",
                    "y",
                    "1",
                    "true",
                    "yeah",
                    "yep",
                    "yup",
                    "sure",
                    "ok",
                    "okay",
                    "please",
                ):
                    return "yes"
                if raw in ("no", "n", "0", "false", "nope", "nah", "skip", "pass"):
                    return "no"
            except OSError:
                pass
        time.sleep(0.35)
    return "timeout"


def _run_ask_then_maybe_play() -> None:
    try:
        from friday_vocal_asides import pick_music_scheduler_timeout
    except ImportError:
        pick_music_scheduler_timeout = None  # type: ignore[misc, assignment]

    song = _pick_scheduled_track()
    if not song:
        return
    wait_sec = _ask_wait_sec()
    post_prompt = _ask_post_prompt_sec()
    # response_open_at=-1: listen ignores yes/no until we reopen after TTS + post-prompt gap.
    hold_deadline = time.time() + max(wait_sec, 300.0) + post_prompt + 120.0
    try:
        MUSIC_OFFER_FILE.write_text(
            json.dumps(
                {
                    "deadline": hold_deadline,
                    "song": song,
                    "wait_sec": wait_sec,
                    "response_open_at": -1.0,
                },
                indent=None,
            ),
            encoding="utf-8",
        )
    except OSError as e:
        log.warning("Could not write music offer file: %s", e)
        play_song(song)
        return

    prompt = _offer_prompt(song)
    log.info("Music ask — prompt then %.0fs gap, then up to %.0fs for yes/no: %s", post_prompt, wait_sec, song)
    _speak_ask(prompt)
    if post_prompt > 0:
        time.sleep(post_prompt)
    deadline = time.time() + wait_sec
    try:
        MUSIC_OFFER_FILE.write_text(
            json.dumps(
                {
                    "deadline": deadline,
                    "song": song,
                    "wait_sec": wait_sec,
                    "response_open_at": 0.0,
                },
                indent=None,
            ),
            encoding="utf-8",
        )
    except OSError as e:
        log.warning("Could not reopen music offer file: %s", e)

    result = _wait_for_music_offer_result(deadline)
    if result == "yes":
        log.info("Music ask — yes, playing: %s", song)
        play_song(song)
    elif result == "no":
        # friday-listen already spoke a short ack — do not double-speak.
        log.info("Music ask — no, skipping: %s", song)
    else:
        log.info("Music ask — timeout, skipping: %s", song)
        if pick_music_scheduler_timeout:
            try:
                _speak_ask(pick_music_scheduler_timeout())
            except Exception as e:
                log.warning("Timeout aside speak failed: %s", e)

    MUSIC_OFFER_FILE.unlink(missing_ok=True)
    MUSIC_OFFER_RESPONSE_FILE.unlink(missing_ok=True)


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("friday-music")

if not AUTOPLAY_ENABLED:
    log.info("FRIDAY_AUTOPLAY=false — music scheduler disabled, exiting")
    sys.exit(0)


def _tts_active() -> bool:
    if not TTS_ACTIVE_FILE.exists():
        return False
    try:
        age = time.time() - TTS_ACTIVE_FILE.stat().st_mtime
        return age < 120
    except OSError:
        return False


def _play_running() -> bool:
    if not PLAY_PID_FILE.exists():
        return False
    try:
        pid = int(PLAY_PID_FILE.read_text().strip())
        if sys.platform == "win32":
            import ctypes
            k32 = ctypes.windll.kernel32
            h = k32.OpenProcess(0x1000, False, pid)
            if not h:
                return False
            k32.CloseHandle(h)
            return True
        os.kill(pid, 0)
        return True
    except (ValueError, OSError, ProcessLookupError):
        return False


def _scheduler_play_seconds_str() -> str:
    raw = os.environ.get("FRIDAY_SCHEDULER_PLAY_SECONDS", "").strip().split("#")[0].strip()
    if raw:
        try:
            n = max(5, int(float(raw)))
            return str(n)
        except ValueError:
            pass
    fb = os.environ.get("FRIDAY_PLAY_SECONDS", "45").strip().split("#")[0].strip()
    return fb or "45"


def play_song(song: str | None = None):
    if not song:
        song = _pick_scheduled_track()
        if not song:
            return
    log.info("Playing: %s", song)

    env = {**os.environ, "FRIDAY_PLAY_SECONDS": _scheduler_play_seconds_str()}
    kw = {
        "cwd": str(ROOT),
        "env": env,
        "timeout": 300,
    }
    if sys.platform == "win32":
        kw["creationflags"] = subprocess.CREATE_NO_WINDOW

    try:
        r = subprocess.run(
            [_python_for_friday_play(), str(PLAY_SCRIPT), song],
            **kw,
        )
        if r.returncode == 0:
            log.info("Finished: %s", song)
            _record_played(song)
        else:
            log.warning("friday-play exited %d for %s", r.returncode, song)
    except subprocess.TimeoutExpired:
        log.warning("friday-play timed out for %s", song)
    except Exception as e:
        log.warning("friday-play error: %s", e)


def _first_sleep_sec(interval_sec: float) -> float:
    """
    Legacy loop slept a full interval before the first song — up to 30+ minutes of silence.
    Default: wait at most two minutes (or one full interval if shorter), unless overridden.
    """
    raw = os.environ.get("FRIDAY_MUSIC_FIRST_WAIT_SEC", "").strip().split("#")[0].strip()
    if raw:
        try:
            return max(5.0, float(raw))
        except ValueError:
            pass
    return min(120.0, interval_sec)


def main():
    interval_sec = INTERVAL_MIN * 60
    if WEIGHTED_HINDI_MODE:
        log.info(
            "Maestro (Creative Director) — music scheduler online, every %.0f min, "
            "weighted Hindi %.2f%% (hindi=%d phrases, intl=%d phrases)",
            INTERVAL_MIN,
            HINDI_WEIGHT * 100,
            len(HINDI_POOL),
            len(INTL_POOL),
        )
        log.info("Hindi pool: %s", HINDI_POOL)
        log.info("Intl pool: %s", INTL_POOL)
        if len(HINDI_POOL) < 2 or len(INTL_POOL) < 2:
            log.warning(
                "Small pool — add more trending search lines in .env for variety "
                "(FRIDAY_MUSIC_HINDI_PLAYLIST / FRIDAY_MUSIC_INTL_PLAYLIST or FRIDAY_MUSIC_PLAYLIST)."
            )
    else:
        log.info(
            "Maestro (Creative Director) — music scheduler online, every %.0f min, %d song(s) in playlist",
            INTERVAL_MIN,
            len(LEGACY_PLAYLIST),
        )
        log.info("Playlist: %s", LEGACY_PLAYLIST)
        if len(LEGACY_PLAYLIST) < 2:
            log.warning(
                "Scheduler playlist has only one entry (fallback=FRIDAY_STARTUP_SONG) — "
                "every offer sounds the same. Add comma-separated titles in FRIDAY_MUSIC_PLAYLIST (or FRIDAY_MUSIC_SCHEDULER_PLAYLIST)."
            )
    if _session_no_repeat():
        log.info(
            "FRIDAY_MUSIC_SESSION_NO_REPEAT=true — each track plays at most once per OpenClaw run; "
            "restart the stack to reset."
        )

    first = True
    while True:
        time.sleep(_first_sleep_sec(interval_sec) if first else interval_sec)
        first = False

        if _tts_active():
            log.info("TTS active — skipping this cycle")
            continue

        if _play_running():
            log.info("friday-play already running — skipping")
            continue

        try:
            if _ask_before_play_enabled():
                _run_ask_then_maybe_play()
            else:
                play_song()
        except KeyboardInterrupt:
            break
        except Exception as e:
            log.warning("Unhandled error: %s", e)

    log.info("Music scheduler stopped.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log.info("Stopped.")
