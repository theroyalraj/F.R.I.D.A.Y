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
"""

import hashlib
import os
import platform
import signal
import subprocess
import sys
import tempfile
from pathlib import Path

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
EARLY_STOP_SEC = 2   # stop this many seconds before the natural end

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
    if duration and duration > EARLY_STOP_SEC + 1:
        # Stop 2 s before the natural end; also respect MAX_SEC cap if set
        target = duration - EARLY_STOP_SEC
        play_sec = min(MAX_SEC, target) if MAX_SEC else target
        print(f"[friday-play] duration={duration:.1f}s -> playing {play_sec:.1f}s (stopping {EARLY_STOP_SEC}s early)", flush=True)
    else:
        play_sec = MAX_SEC
        print(f"[friday-play] playing {'full' if not play_sec else f'{play_sec}s'} -> {SEARCH!r}", flush=True)

    cmd = ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet"]
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

    proc = subprocess.Popen(cmd, **kwargs)
    # Write PID so friday-listen.py (and --stop flag) can kill us mid-song
    try:
        PID_FILE.write_text(str(proc.pid))
    except Exception:
        pass

    proc.wait()
    PID_FILE.unlink(missing_ok=True)

    if proc.returncode not in (0, -15, 255):   # -15=SIGTERM(stopped early), 255=ffplay EOF
        print(f"[friday-play] ffplay exited {proc.returncode}", file=sys.stderr)
    else:
        print("[friday-play] done", flush=True)

# ── Main ───────────────────────────────────────────────────────────────────────
mp3 = get_audio_file(SEARCH)
play(mp3)
