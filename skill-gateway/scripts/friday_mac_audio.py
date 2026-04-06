"""macOS audio device management via osascript and optional SwitchAudioSource CLI."""

from __future__ import annotations

import subprocess
import time


def _run(cmd: list[str], **kwargs):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=5, **kwargs)
        return r.stdout.strip() if r.returncode == 0 else None
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return None


def find_output_device_id(name_substring: str):
    """Find output device whose name contains name_substring (case-insensitive)."""
    devices = _run(["SwitchAudioSource", "-a", "-t", "output"])
    if not devices:
        return None
    needle = name_substring.lower()
    for line in devices.splitlines():
        if needle in line.strip().lower():
            return line.strip()
    return None


def get_default_output_id() -> str | None:
    return _run(["SwitchAudioSource", "-c", "-t", "output"])


def set_default_endpoint(device_name: str) -> None:
    if not device_name:
        return
    _run(["SwitchAudioSource", "-s", device_name, "-t", "output"])


def get_default_output_health():
    """Mute and volume via osascript; device name via SwitchAudioSource when available."""
    health = {
        "ok": True,
        "platform": "darwin",
        "muted": False,
        "audioDisabled": False,
        "deviceName": None,
        "state": None,
        "volume": 100,
        "checkedAtMs": int(time.time() * 1000),
    }
    dev = get_default_output_id()
    if dev:
        health["deviceName"] = dev
    vol_info = _run(
        [
            "osascript",
            "-e",
            "set v to get volume settings\n"
            'return (output volume of v as string) & "," & (output muted of v as string)',
        ]
    )
    if vol_info:
        parts = vol_info.split(",", 1)
        if len(parts) == 2:
            try:
                health["volume"] = int(parts[0].strip())
            except ValueError:
                pass
            health["muted"] = parts[1].strip().lower() == "true"
    return health
