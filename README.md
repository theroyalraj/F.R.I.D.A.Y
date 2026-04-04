# OpenClaw — Friday AI Assistant

> **Voice-driven AI on your PC.** Say something to Alexa (or curl a command), and Friday executes it on your machine — opens apps, writes code, searches the web, or just talks back like Jarvis.

---

## What it is

OpenClaw is a personal AI assistant pipeline that connects Alexa → a local skill gateway → n8n → Claude Code → your PC. It also runs a voice daemon (mic listening), an ambient intelligence layer (fills silence with wit), and a web UI for manual commands.

```
You (voice)
    │
    ▼
Amazon Alexa ──► skill-gateway (Node, :3848)
                      │
                      ▼
                  n8n (:5678)  ◄── WhatsApp (Evolution API, optional)
                      │
                      ▼
               pc-agent (Node, :3847)
                      │
                      ▼
              Claude Code CLI  ──► executes task on your PC
                      │
                      ▼
             friday-speak.py  ──► speaks result via Edge TTS (Echo Dot / speakers)
```

**Other always-on components:**

| Component | What it does |
|---|---|
| `friday-listen.py` | Mic daemon — listens for voice commands without Alexa |
| `friday-ambient.py` | Ambient brain — fills silence with Hinglish wit, facts, music |
| `friday-play.py` | Plays music on Echo Dot or local speakers via YouTube |
| `friday-speak.py` | Neural TTS via Edge TTS — speaks anything to any audio device |
| Web UI `/friday` | Browser interface for typing commands manually |

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js 18+** | `node --version` |
| **Python 3.10+** | `python --version` |
| **Docker Desktop** | For n8n + Redis |
| **Claude Code CLI** | `npm install -g @anthropic-ai/claude-code` |
| **edge-tts** | `pip install edge-tts sounddevice numpy` |
| **ffmpeg** | On PATH — needed for audio playback |
| **Alexa Developer account** | For voice trigger (optional if using curl/mic only) |

Python ambient extras (optional, for `friday-ambient.py`):
```bash
pip install redis anthropic psutil py-now-playing
```

---

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/theroyalraj/F.R.I.D.A.Y.git openclaw
cd openclaw
npm install
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env — at minimum set:
#   N8N_WEBHOOK_SECRET=<random>
#   PC_AGENT_SECRET=<random>
#   ANTHROPIC_API_KEY=sk-ant-...   (for AI summaries + ambient)
```

### 3. Start everything

```powershell
npm run restart:local
```

This brings up Docker (n8n + Redis), kills any stale gateway/agent processes, and starts both servers with hot-reload.

### 4. Verify

```
http://127.0.0.1:3848/health   → skill-gateway
http://127.0.0.1:3847/health   → pc-agent
http://127.0.0.1:5678          → n8n UI (import workflows from n8n/)
http://127.0.0.1:3848/friday   → Friday web UI
```

---

## npm Scripts

| Command | What it does |
|---|---|
| `npm run restart:local` | Full restart: Docker → kill old ports → start both servers |
| `npm run restart:skip` | Restart without Docker; skips port kill if servers are healthy |
| `npm run voice:daemon` | Start mic listening daemon (`friday-listen.py`) |
| `npm run start:ambient` | Start ambient intelligence (`friday-ambient.py`) |
| `npm run test:notify` | Smoke-test Alexa proactive notification (gateway must be running) |
| `npm run tunnel:ngrok` | Expose skill-gateway publicly via ngrok |
| `npm run tunnel:friday` | Expose pc-agent publicly via ngrok |
| `npm run tunnel:n8n` | Expose n8n publicly via ngrok |
| `npm run setup:alexa` | One-time Amazon Music cookie setup |
| `npm run play` | Play a song on Echo Dot |

---

## Trigger a Task Manually

```powershell
# POST to skill-gateway (not /alexa — that's Alexa-only)
curl -X POST http://127.0.0.1:3848/openclaw/trigger `
  -H "Content-Type: application/json" `
  -H "X-Openclaw-Secret: <your-secret>" `
  -d '{"commandText": "open notepad and write hello world", "userId": "local"}'
```

See [`scripts/openclaw-trigger-curl.example.ps1`](scripts/openclaw-trigger-curl.example.ps1) for a PowerShell wrapper.

---

## Ambient Intelligence

Friday fills silence with short spoken content — Hinglish wit, cricket commentary, music, news, facts.

```powershell
npm run start:ambient
```

**Content mix (configurable via `.env`):**

| Mode | Default share | Description |
|---|---|---|
| `hindi` | ~30% | Hinglish observations, cricket, tech, Hyderabad life |
| `song_moment` | ~20% | AI picks a song, plays the iconic part |
| `funny` | ~25% | Dad jokes, dry tech humour, one-liners |
| `informational` | ~25% | Google News, Reddit, trending, facts |

Key `.env` knobs:

```bash
FRIDAY_AMBIENT=true
FRIDAY_AMBIENT_HINDI_CHANCE=0.30        # share of turns in Hinglish
FRIDAY_AMBIENT_SONG_CHANCE=0.20         # share of turns that play music
FRIDAY_AMBIENT_HINDI_VOICE=             # optional: hi-IN-SwaraNeural for pure Hindi TTS
FRIDAY_AMBIENT_POST_TTS_GAP=6           # seconds of silence before ambient fires
FRIDAY_AMBIENT_MIN_SILENCE_SEC=4
FRIDAY_AMBIENT_MAX_SILENCE_SEC=25
FRIDAY_USER_NAME=Raj
FRIDAY_USER_CITY=Hyderabad
FRIDAY_USER_INTERESTS=technology,cricket,AI,startups,Bollywood
```

---

## Voice Daemon

Listens on the mic and sends commands directly to the gateway — no Alexa needed.

```powershell
npm run voice:daemon
# or with a specific mic:
python scripts/friday-listen.py --list-mics
```

```bash
LISTEN_DEVICE_INDEX=          # blank = Windows default mic
LISTEN_SILENCE_SEC=1.2        # pause duration to end a phrase
LISTEN_ENERGY_THRESHOLD=100   # lower = more sensitive
LISTEN_DEAF_SEC=15            # ignore mic for N seconds after startup
# FRIDAY_LISTEN_WAKE=friday   # optional wake word
```

---

## TTS (Neural Voice)

All speech goes through `skill-gateway/scripts/friday-speak.py` using Microsoft Edge TTS (free, no API key, requires internet).

```bash
FRIDAY_TTS_VOICE=en-GB-RyanNeural   # Jarvis-style British male
FRIDAY_TTS_RATE=+0%
FRIDAY_TTS_PITCH=+0Hz
FRIDAY_TTS_VOLUME=+20%
FRIDAY_TTS_DEVICE=                  # blank = system default output
```

Good voices: `en-GB-RyanNeural` · `en-AU-WilliamNeural` · `en-IN-NeerjaExpressiveNeural` · `hi-IN-SwaraNeural`

Speak anything from the command line:
```powershell
python skill-gateway/scripts/friday-speak.py "Hello sir."
```

---

## Alexa Setup

Full walkthrough: [docs/setup.md](docs/setup.md)

Short version:
1. Create an Alexa-hosted skill in the [Developer Console](https://developer.amazon.com/alexa/console/ask)
2. Copy `skill/` interaction model JSON → skill builder
3. Set endpoint to your ngrok URL (`npm run tunnel:ngrok`) → `https://<host>/alexa`
4. Import n8n workflows from `n8n/`
5. Configure `.env` with your secrets and URLs

---

## Alexa Proactive Notifications (optional)

After a task completes, Friday can push a notification to your Echo device ("read my notifications").

```bash
ALEXA_PROACTIVE_ENABLED=true
ALEXA_LWA_CLIENT_ID=amzn1.application-oa2-client.<...>
ALEXA_LWA_CLIENT_SECRET=amzn1.oa2-cs.<...>
ALEXA_PROACTIVE_API_HOST=https://api.eu.amazonalexa.com   # or api.amazonalexa.com
```

Test it (gateway must be running):
```powershell
npm run test:notify
```

---

## WhatsApp (optional)

Uses [Evolution API](https://github.com/EvolutionAPI/evolution-api) (self-hosted) to receive and send WhatsApp messages as tasks.

```bash
EVOLUTION_API_KEY=<your-key>
EVOLUTION_INSTANCE=openclaw
EVOLUTION_PORT=8181
WHATSAPP_ALLOWED_NUMBERS=91XXXXXXXXXX   # comma-separated, digits only
WHATSAPP_NOTIFY_NUMBER=91XXXXXXXXXX     # always forward Jarvis replies here
```

---

## Cursor Agent Rules (`.cursor/rules/`)

The repo ships with rules that make any Cursor AI agent behave like Friday when working in this codebase:

| Rule | What it does |
|---|---|
| `acknowledge-before-planning.mdc` | Speaks acknowledgement async in parallel with first work tool calls |
| `friday-narrate.mdc` | Live narration throughout — status, progress, verbose completion summary |
| `completion-read-memory.mdc` | Forces the agent to re-read changed files before the completion speech |
| `wip-safety-commit.mdc` | Commits to `wip` branch before any breaking change |

These rules are portable — clone the repo to any machine with Cursor + `pip install edge-tts`, and the voice narration works out of the box.

---

## Project Structure

```
openclaw/
├── skill-gateway/          Node.js — Alexa endpoint + task queue + TTS API
│   └── scripts/
│       ├── friday-speak.py     Neural TTS via Edge TTS
│       ├── friday-play.py      Music playback (Echo Dot / local)
│       └── pick-session-voice.py
├── pc-agent/               Node.js — receives tasks, calls Claude Code CLI
├── scripts/
│   ├── friday-ambient.py   Ambient intelligence brain
│   ├── friday-listen.py    Mic voice daemon
│   └── restart-local.ps1   Full local restart script
├── skill/                  Alexa skill interaction model
├── alexa-lambda-python/    Optional AWS Lambda bridge
├── n8n/                    n8n workflow exports
├── docs/                   Extended setup + debugging guides
├── .cursor/rules/          Cursor agent behaviour rules
├── docker-compose.yml      n8n + Redis
├── .env.example            All configurable variables (copy → .env)
└── package.json
```

---

## Security Notes

- `.env` is git-ignored. Never commit it.
- `PC_AGENT_BIND=127.0.0.1` (loopback-only) is safer if you don't need LAN access.
- `/friday` and `/voice/*` routes have no auth — use firewall rules or ngrok auth before exposing.
- Rotate `N8N_WEBHOOK_SECRET` and `PC_AGENT_SECRET` — they're shared bearer tokens.

---

## License

[MIT](LICENSE)
