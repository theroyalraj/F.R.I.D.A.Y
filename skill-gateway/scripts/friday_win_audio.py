"""
Windows default audio endpoint helpers (pycaw + comtypes).

Shared by friday-speak.py (TTS device) and friday-play.py (optional music device).
"""
from __future__ import annotations

import json
import time


def find_output_device_id(name_sub: str):
    """Return (device_id, friendly_name) for the first output device matching name_sub, or None."""
    try:
        from pycaw.utils import AudioUtilities

        devs = AudioUtilities.GetAllDevices()
        sub = name_sub.lower()
        match = next((d for d in devs if sub in d.FriendlyName.lower()), None)
        return (match.id, match.FriendlyName) if match else None
    except Exception:
        return None


def set_default_endpoint(device_id: str) -> None:
    """Set device_id as default for all three audio roles (console/multimedia/comms)."""
    from pycaw.api.policyconfig import IPolicyConfig
    from comtypes import GUID
    from comtypes.client import CreateObject

    CLSID_PolicyConfigClient = GUID("{870AF99C-171D-4F9E-AF0D-E63DF40C2BC9}")
    policy = CreateObject(CLSID_PolicyConfigClient, interface=IPolicyConfig)
    for role in range(3):
        policy.SetDefaultEndpoint(device_id, role)


def get_default_output_id() -> str | None:
    """Return the current default output device ID."""
    try:
        from pycaw.utils import AudioUtilities

        dev = AudioUtilities.GetSpeakers()
        return dev.id
    except Exception:
        return None


def get_default_output_health() -> dict:
    """
    Default playback device: mute flag plus disabled / unplugged / not-present state.

    Used by Sentinel (cursor-reply-watch), Listen UI, and Redis friday:voice:watcher:output_health.
    ``audioDisabled`` is True when the default output is not Active (disabled in Sound settings,
    unplugged, missing driver, or no default device).
    """
    t0 = time.time()
    base = {
        "ok": True,
        "platform": "win32",
        "muted": False,
        "audioDisabled": False,
        "deviceName": None,
        "state": None,
        "checkedAtMs": int(t0 * 1000),
    }
    try:
        from pycaw.utils import AudioUtilities

        dev = AudioUtilities.GetSpeakers()
    except Exception as e:
        base["ok"] = False
        base["audioDisabled"] = True
        base["state"] = "error"
        base["error"] = str(e)[:200]
        return base

    try:
        from pycaw.constants import AudioDeviceState

        base["deviceName"] = getattr(dev, "FriendlyName", None) or None
        st = getattr(dev, "state", None)
        if st is not None:
            base["state"] = st.name if hasattr(st, "name") else str(st)
            active = st == AudioDeviceState.Active
        else:
            active = True
        if not active:
            base["audioDisabled"] = True
        else:
            try:
                ev = dev.EndpointVolume
                base["muted"] = bool(ev.GetMute())
            except Exception:
                base["muted"] = False
    except Exception as e:
        base["ok"] = False
        base["error"] = str(e)[:200]
        base["audioDisabled"] = True

    return base


def _cli_output_health() -> None:
    """Print one JSON line for pc-agent spawnSync."""
    print(json.dumps(get_default_output_health()), flush=True)


if __name__ == "__main__":
    _cli_output_health()
