# OpenClaw — notes for Claude (Code / CLI)

## TTS voice blocklist (non-negotiable for this project)

The maintainer uses **`FRIDAY_TTS_VOICE_BLOCK`** in `.env`: a comma-separated list of **Microsoft Edge TTS voice ids** that must **never** be selected, documented, or written into config.

- **Always read the current value** from `.env` before suggesting or editing voice-related variables.
- **Do not** set `FRIDAY_TTS_VOICE`, `FRIDAY_EDGE_TTS_VOICE`, `FRIDAY_WIN_TTS_VOICE`, sticky session files, or any example in docs to a blocked id.
- **Default assistant Edge voice** for this repo is **`en-US-AvaMultilingualNeural`** unless `.env` says otherwise (and that choice must not be blocked).
- **House defaults** always block **`en-GB-RyanNeural`**, **`en-GB-ThomasNeural`**, **`en-AU-WilliamNeural`**, and **`en-AU-WilliamMultilingualNeural`** in code even if `.env` omits them (`pick-session-voice.py`, `friday-speak.py`, `edgeTts.js`). Extend the list with **`FRIDAY_TTS_VOICE_BLOCK`** for additional voices.

Runtime enforcement: **`friday-speak.py`** clamps any sticky-session or env voice against the blocklist; **`POST /voice/set-voice`** rejects blocked ids; **`GET /voice/voices`** only lists allowed voices.

When helping with voice issues, prefer Emma multilingual or another voice from the **non-blocked** catalogue returned by the running agent’s **`GET /voice/voices`**.
