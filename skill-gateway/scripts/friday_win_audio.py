"""
Windows default audio endpoint helpers (pycaw + comtypes).

Shared by friday-speak.py (TTS device) and friday-play.py (optional music device).
"""
from __future__ import annotations


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
