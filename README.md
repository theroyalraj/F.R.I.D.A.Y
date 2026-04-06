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

## macOS setup

Run OpenClaw locally on Apple Silicon or Intel with Homebrew dependencies, Redis, and Cursor rules that trigger TTS through **pc-agent** (`POST /voice/speak-async`) instead of calling Python directly.

1. **System packages**
   ```bash
   brew install ffmpeg portaudio redis
   # Optional: audio device switching for FRIDAY_TTS_DEVICE-style routing
   brew install switchaudio-osx
   ```
2. **Redis**
   ```bash
   brew services start redis
   ```
3. **Playback binary** — `friday-speak.py` prefers `friday-player` and falls back to `ffplay` on PATH. Symlink if you want the legacy name:
   ```bash
   ln -sf "$(which ffplay)" /usr/local/bin/friday-player
   ```
4. **Environment** — copy the template and edit secrets (especially `PC_AGENT_SECRET` to match `.env` used by pc-agent):
   ```bash
   cp .env.macos.example .env
   ```
   Set `CURSOR_TRANSCRIPTS_DIR` to your real Cursor project path under `~/.cursor/projects/…` if it differs.
5. **Python packages** (typical; add others from `docs/setup.md` as needed):
   ```bash
   pip install edge-tts aiohttp redis sounddevice SpeechRecognition numpy psutil watchdog
   ```
6. **Start the stack** — use `node scripts/start.mjs` (or your usual client or server mode) after `npm install`. On macOS, `start.mjs` frees stuck ports with `lsof` + `kill` instead of Windows-only APIs.
7. **Cursor narration** — from the repo root, agents use `scripts/oc-speak.sh`, which POSTs to `PC_AGENT_URL` with `Authorization: Bearer PC_AGENT_SECRET`. Try:
   ```bash
   npm run speak -- "Hello from macOS" 1
   ```
8. **Sync rules to other workspaces** — OpenClaw is the source of truth for `.cursor/rules/`. Targets are listed in `OPENCLAW_SYNC_RULE_TARGETS` (colon-separated paths):
   ```bash
   npm run sync:rules
   ```
   Or pass a project root: `bash scripts/sync-cursor-rules.sh /path/to/project`.

Edge TTS still needs network access; if it fails, playback falls back to macOS `say` (persona voices from `scripts/openclaw_company.py` when `FRIDAY_TTS_SPEAK_PERSONA` is set by the server).

---

## Quick Start

### 1. Clone or update the repo

```bash
git clone https://github.com/theroyalraj/F.R.I.D.A.Y.git openclaw
cd openclaw
```

Already cloned:

```bash
cd openclaw
git pull --ff-only
```

### 2. Set up the project (Node, Cursor rules, Python)

From the repo root, install Node workspaces, regenerate **`.cursor/rules/openclaw-company.mdc`** from the Python registry, and install Python deps used by **`cursor-reply-watch`** and related scripts:

**macOS / Linux / Git Bash**

```bash
npm ci
python3 scripts/openclaw_company.py --generate-rule
python3 -m pip install -r scripts/requirements-cursor-reply-watch.txt
```

**Windows (PowerShell)**

```powershell
npm ci
python scripts/openclaw_company.py --generate-rule
python -m pip install -r scripts/requirements-cursor-reply-watch.txt
```

Use `npm install` instead of `npm ci` if you do not have a lockfile workflow. For a **remote client machine** (split stack / mic + Cursor TTS only), if the repo includes `scripts/requirements-openclaw-client.txt`, also run:

```bash
python3 -m pip install -r scripts/requirements-openclaw-client.txt
```

**One-liner (after `cd` into the repo):**

```bash
npm ci && python3 scripts/openclaw_company.py --generate-rule && python3 -m pip install -r scripts/requirements-cursor-reply-watch.txt
```

**Same “rules + deps” flow via the published Gist** (syncs git, regenerates `.cursor/rules`, installs Node and pip — optional open Cursor on the repo folder):

```bash
curl -fsSL 'https://gist.githubusercontent.com/theroyalraj/d4ddf7b05d156271f9f3205e2cb101cb/raw/openclaw-client-bootstrap.sh' | bash -s -- --setup-only --home "$(pwd)" --open-cursor
```

Omit `--open-cursor` if you only want install. If bash reports **pipefail** / **invalid option**, insert `| tr -d '\r' |` before `bash`.

Optional **Gist bootstrap** (full interactive menus): **`scripts/openclaw-client-bootstrap.sh`** — run `curl -fsSL 'https://gist.githubusercontent.com/theroyalraj/d4ddf7b05d156271f9f3205e2cb101cb/raw/openclaw-client-bootstrap.sh' | bash -s -- --interactive` (if you see a **pipefail** error, pipe through `tr -d '\r'` before `bash`). See [docs/setup.md](docs/setup.md) §10b. **Locked-down Mac (no install):** use the browser to your home server only — [docs/setup.md](docs/setup.md) §10c.

### 3. Configure

```bash
cp .env.example .env
# Edit .env — at minimum set:
#   N8N_WEBHOOK_SECRET=<random>
#   PC_AGENT_SECRET=<random>
#   ANTHROPIC_API_KEY=sk-ant-...   (for AI summaries + ambient)
```

### 4. Start everything

```powershell
npm run restart:local
```

This reconciles Docker (n8n + Redis Insight), does **not** start or restart the Redis container, and starts the stack in one terminal. **By default it does not kill** anything on 3847/3848; if pc-agent and skill-gateway already pass `/health`, it exits. To **replace** a stuck stack, use `npm run restart:force`. Start Redis once with `docker compose up -d redis` if it is not already running.

### 5. Verify

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
| `npm run restart:local` | Safe start: Docker (optional) → **no port kills** → `start.mjs` if ports free or stack unhealthy |
| `npm run restart:skip` | Same as `restart:local` but skips Docker compose |
| `npm run restart:force` | **Explicit kill:** frees 3847/3848, stops auxiliary Python daemons, then starts stack |
| `npm run restart:force:skip-docker` | `restart:force` without Docker compose |
| `npm run voice:daemon` | Start mic listening daemon (`friday-listen.py`) |
| `npm run start:ambient` | Start ambient intelligence (`friday-ambient.py`) |
| `npm run test:notify` | Smoke-test Alexa proactive notification (gateway must be running) |
| `npm run tunnel:ngrok` | Expose skill-gateway publicly via ngrok |
| `npm run tunnel:friday` | Expose pc-agent publicly via ngrok |
| `npm run tunnel:n8n` | Expose n8n publicly via ngrok |
| `npm run setup:alexa` | One-time Amazon Music cookie setup |
| `npm run play` | Play a song on Echo Dot |
| `npm run speak` | Fire-and-forget TTS via `scripts/oc-speak.sh` → pc-agent `/voice/speak-async` |
| `npm run sync:rules` | Rsync `.cursor/rules/` to projects in `OPENCLAW_SYNC_RULE_TARGETS` |

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
WHATSAPP_ALLOWED_NUMBERS=91XXXXXXXXXX   # comma-separated, digits only — who may command
WHATSAPP_ALWAYS_REPLY_NUMBERS=91...,91...  # optional — send every reply to ALL these numbers
WHATSAPP_NOTIFY_NUMBER=91XXXXXXXXXX     # other workflows (e.g. reminders); intake uses ALWAYS_REPLY when set
```

---

## Cursor Agent Rules (`.cursor/rules/`)

The repo ships with rules that make any Cursor AI agent behave like Friday when working in this codebase. Spoken lines go through **`scripts/oc-speak.sh`**, which POSTs to **pc-agent** `/voice/speak-async` (Bearer `PC_AGENT_SECRET`) so TTS runs on the machine where the agent listens.

| Rule | What it does |
|---|---|
| `acknowledge-before-planning.mdc` | Speaks acknowledgement async in parallel with first work tool calls |
| `friday-narrate.mdc` | Live narration throughout — status, progress, verbose completion summary |
| `completion-read-memory.mdc` | Forces the agent to re-read changed files before the completion speech |
| `wip-safety-commit.mdc` | Commits to `wip` branch before any breaking change |

Use **`npm run sync:rules`** to copy rules into other repos (see `.env.macos.example` / `OPENCLAW_SYNC_RULE_TARGETS`). For narration to play, pc-agent must be running and `.env` must define `PC_AGENT_URL` and `PC_AGENT_SECRET` for the wrapper.

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
│   └── restart-local.ps1   Local stack launcher (safe by default; `-ForceKill` for full replace)
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
