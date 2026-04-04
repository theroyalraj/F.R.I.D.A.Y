#!/usr/bin/env python3
"""
friday-play.py — play a song through the default Windows audio device (Echo Dot).

Downloads audio via yt-dlp, caches it, then plays via ffplay — same pipeline as
friday-speak.py, no sounddevice / PortAudio needed.

Usage:
  python friday-play.py "Back in Black AC DC"
  python friday-play.py "Back in Black AC DC" --seconds=30
  python friday-play.py "Back in Black AC DC" --full

Env vars (all optional):
  FRIDAY_PLAY_CACHE    cache dir  (default: %TEMP%/friday-play)
  FRIDAY_PLAY_SECONDS  max play seconds (default: 45; --full ignores this)
  FRIDAY_PLAY_EARLY_STOP_SEC  trim this many seconds before natural end when duration metadata looks reliable (default: 2)
  FRIDAY_PLAY_MIN_TRUSTED_DURATION_SEC  if ffprobe duration is below this, metadata is treated as unreliable — no early trim, cap by FRIDAY_PLAY_SECONDS only (default: 30)
  FRIDAY_PLAY_VOLUME     ffplay startup volume 0–100 (default: 100). Use ~10–20 for quiet background so TTS stays clear.
  FRIDAY_MUSIC_DEVICE  Windows: friendly-name substring for output (e.g. Speakers).
                       Briefly sets default endpoint so ffplay opens on that device,
                       then restores your previous default so TTS can stay on another output.
"""

import hashlib
import os
import platform
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from friday_music_lock import (
    SESSION_START_FILE,
    clear_music_active,
    music_redis_ttl_for_play_seconds,
    set_music_active_ttl,
)

_SG = Path(__file__).resolve().parent
if str(_SG) not in sys.path:
    sys.path.insert(0, str(_SG))

# ── Args ───────────────────────────────────────────────────────────────────────
args     = [a for a in sys.argv[1:] if not a.startswith("--")]
flags    = [a for a in sys.argv[1:] if a.startswith("--")]
SEARCH   = " ".join(args).strip()
FULL     = "--full" in flags
SEC_FLAG = next((f.split("=")[1] for f in flags if f.startswith("--seconds=")), None)
MAX_SEC  = None if FULL else int(SEC_FLAG or os.environ.get("FRIDAY_PLAY_SECONDS", "45"))

CACHE_DIR = Path(os.environ.get("FRIDAY_PLAY_CACHE",
              os.path.join(tempfile.gettempdir(), "friday-play")))
CACHE_DIR.mkdir(parents=True, exist_ok=True)

MUSIC_DEVICE_HINT = os.environ.get("FRIDAY_MUSIC_DEVICE", "").strip()

# PID file so other processes (friday-listen.py) can stop playback
PID_FILE  = Path(tempfile.gettempdir()) / "friday-play.pid"

if not SEARCH:
    # Called with --stop: kill any running playback
    if "--stop" in flags:
        if PID_FILE.exists():
            try:
                pid = int(PID_FILE.read_text().strip())
                os.kill(pid, signal.SIGTERM)
                PID_FILE.unlink(missing_ok=True)
                print(f"[friday-play] stopped PID {pid}", flush=True)
            except Exception as e:
                print(f"[friday-play] stop failed: {e}", file=sys.stderr)
        clear_music_active()
        SESSION_START_FILE.unlink(missing_ok=True)
        sys.exit(0)
    print("friday-play: no search phrase provided", file=sys.stderr)
    sys.exit(1)

# ── Download via yt-dlp (cached) ───────────────────────────────────────────────
def get_audio_file(search: str) -> Path:
    key  = hashlib.md5(search.lower().encode()).hexdigest()[:12]
    dest = CACHE_DIR / f"{key}.mp3"

    if dest.exists() and dest.stat().st_size > 10_000:
        print(f"[friday-play] cached: {dest.name}", flush=True)
        return dest

    print(f"[friday-play] downloading: {search!r} ...", flush=True)
    result = subprocess.run(
        [
            sys.executable, "-m", "yt_dlp",
            f"ytsearch1:{search}",
            "--extract-audio", "--audio-format", "mp3", "--audio-quality", "5",
            "--output", str(CACHE_DIR / f"{key}.%(ext)s"),
            "--no-playlist", "--quiet", "--no-warnings",
        ],
        capture_output=True, timeout=90,
    )

    if result.returncode != 0 or not dest.exists():
        err = result.stderr.decode(errors="replace").strip()
        print(f"[friday-play] yt-dlp failed: {err[:300]}", file=sys.stderr)
        sys.exit(1)

    print(f"[friday-play] downloaded: {dest.stat().st_size // 1024} KB", flush=True)
    return dest

# ── Get audio duration via ffprobe ─────────────────────────────────────────────
def _env_float(key: str, default: str) -> float:
    try:
        return float(os.environ.get(key, default).split("#")[0].strip())
    except ValueError:
        return float(default)


# Stop this many seconds before natural end only when ffprobe duration is trusted (see below).
EARLY_STOP_SEC = _env_float("FRIDAY_PLAY_EARLY_STOP_SEC", "2")
# If probed duration is below this, it is often wrong for VBR/cached MP3s — do not use (duration - early_stop) or you get ~2 s clips.
MIN_TRUSTED_DURATION_SEC = _env_float("FRIDAY_PLAY_MIN_TRUSTED_DURATION_SEC", "30")


def _play_volume_percent() -> int:
    """ffplay -volume is 0 (silent) through 100 (full)."""
    raw = os.environ.get("FRIDAY_PLAY_VOLUME", "100").split("#")[0].strip()
    try:
        v = int(float(raw))
    except ValueError:
        v = 100
    return max(0, min(100, v))


def get_duration(mp3_path: Path) -> float | None:
    """Return audio duration in seconds using ffprobe, or None on failure."""
    try:
        r = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(mp3_path),
            ],
            capture_output=True, text=True, timeout=10,
        )
        return float(r.stdout.strip())
    except Exception:
        return None

# ── Play via ffplay (same as friday-speak.py) ──────────────────────────────────
def play(mp3_path: Path):
    # Decide how many seconds to actually play
    duration = get_duration(mp3_path)
    early = max(0.0, EARLY_STOP_SEC)
    if duration and duration > early + 1 and duration >= MIN_TRUSTED_DURATION_SEC:
        # Trusted length: stop slightly before natural end (TTS alignment); respect MAX_SEC cap if set
        target = duration - early
        play_sec = min(MAX_SEC, target) if MAX_SEC else target
        print(
            f"[friday-play] duration={duration:.1f}s -> playing {play_sec:.1f}s "
            f"(stopping {early:.1f}s early)",
            flush=True,
        )
    elif duration and duration > early + 1 and duration < MIN_TRUSTED_DURATION_SEC:
        # Short probed duration is often bogus for real tracks — cap by MAX_SEC only, no early trim
        play_sec = MAX_SEC
        print(
            f"[friday-play] duration={duration:.1f}s below trusted threshold "
            f"({MIN_TRUSTED_DURATION_SEC:.0f}s) — playing {'full' if not play_sec else f'{play_sec}s'} cap -> {SEARCH!r}",
            flush=True,
        )
    else:
        play_sec = MAX_SEC
        print(f"[friday-play] playing {'full' if not play_sec else f'{play_sec}s'} -> {SEARCH!r}", flush=True)

    vol = _play_volume_percent()
    cmd = ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", "-volume", str(vol)]
    if play_sec:
        cmd += ["-t", f"{play_sec:.2f}"]
    cmd.append(str(mp3_path))

    kwargs: dict = {
        "stdin":  subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
    }
    if platform.system() == "Windows":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW

    original_default_id = None
    switched_for_music = False
    proc = None
    try:
        if MUSIC_DEVICE_HINT and platform.system() == "Windows":
            try:
                from friday_win_audio import (
                    find_output_device_id,
                    get_default_output_id,
                    set_default_endpoint,
                )

                res = find_output_device_id(MUSIC_DEVICE_HINT)
                if res:
                    target_id, friendly = res
                    original_default_id = get_default_output_id()
                    if original_default_id and original_default_id != target_id:
                        set_default_endpoint(target_id)
                        switched_for_music = True
                        time.sleep(0.18)
                        print(f"[friday-play] routing startup to {friendly!r}", flush=True)
                else:
                    print(
                        f"[friday-play] FRIDAY_MUSIC_DEVICE={MUSIC_DEVICE_HINT!r} not found — using default",
                        flush=True,
                    )
            except Exception as exc:
                print(f"[friday-play] music device routing skipped: {exc}", file=sys.stderr, flush=True)

        proc = subprocess.Popen(cmd, **kwargs)
        try:
            PID_FILE.write_text(str(proc.pid))
        except Exception:
            pass
        try:
            SESSION_START_FILE.write_text(str(time.time()), encoding="ascii")
        except OSError:
            pass
        set_music_active_ttl(music_redis_ttl_for_play_seconds(play_sec))

        if switched_for_music and original_default_id:
            time.sleep(0.22)
            try:
                from friday_win_audio import set_default_endpoint

                set_default_endpoint(original_default_id)
                print("[friday-play] restored default output for TTS / other apps", flush=True)
                switched_for_music = False
            except Exception as exc:
                print(f"[friday-play] could not restore default output: {exc}", file=sys.stderr, flush=True)

        proc.wait()
    finally:
        if switched_for_music and original_default_id:
            try:
                from friday_win_audio import set_default_endpoint

                set_default_endpoint(original_default_id)
            except Exception:
                pass

    try:
        PID_FILE.unlink(missing_ok=True)
        SESSION_START_FILE.unlink(missing_ok=True)
        clear_music_active()
    except OSError:
        pass

    if proc is None:
        print("[friday-play] ffplay did not start", file=sys.stderr)
        sys.exit(1)
    if proc.returncode not in (0, -15, 255):   # -15=SIGTERM(stopped early), 255=ffplay EOF
        print(f"[friday-play] ffplay exited {proc.returncode}", file=sys.stderr)
    else:
        print("[friday-play] done", flush=True)

# ── Main ───────────────────────────────────────────────────────────────────────
mp3 = get_audio_file(SEARCH)
play(mp3)
