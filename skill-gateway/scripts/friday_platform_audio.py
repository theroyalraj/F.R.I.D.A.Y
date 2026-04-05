"""
Cross-platform audio endpoint helpers.

Windows: pycaw/COM via friday_win_audio.
macOS/Linux: no device switching — FRIDAY_TTS_DEVICE is ignored; playback uses the system default output.
"""
from __future__ import annotations

import sys
import time

if sys.platform == "win32":
    from friday_win_audio import (  # type: ignore
        find_output_device_id,
        get_default_output_health,
        get_default_output_id,
        set_default_endpoint,
    )
else:

    def find_output_device_id(name_sub: str):
        """Named-device routing is Windows-only today."""
        return None

    def get_default_output_id() -> str | None:
        return None

    def set_default_endpoint(device_id: str) -> None:
        pass

    def get_default_output_health():
        """Non-Windows: no MMDevice mute or disable probe."""
        return {
            "ok": True,
            "platform": sys.platform,
            "muted": False,
            "audioDisabled": False,
            "deviceName": None,
            "state": None,
            "checkedAtMs": int(time.time() * 1000),
        }
