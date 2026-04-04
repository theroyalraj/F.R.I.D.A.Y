# Openclaw

Alexa (or Lambda) → skill-gateway / n8n → pc-agent: voice-driven tasks on your PC.

Full setup: [docs/setup.md](docs/setup.md). **Curl a task:** `POST …/openclaw/trigger` + `X-Openclaw-Secret` + `{ "commandText": "…", "userId": "…" }` — not `/alexa` (that path is Alexa-only). After tasks, the gateway can send an Alexa **proactive** ping when LWA is configured; dry-run with **`npm run test:notify`** (gateway must be running). The test script prompts after each run until you reply **otherwise** / **stop asking** (see `.env.example`).

## Restart local dev (Windows)

`npm run restart:local` does everything in order:

1. **Docker** — `docker compose up -d` then `docker compose restart` for **Redis** and **n8n** (from [docker-compose.yml](docker-compose.yml) in the repo root). Ensures the stack is up after a cold start, then recycles containers.
2. **Node** — stops whatever is listening on **3848** (skill-gateway) and **3847** (pc-agent), then opens two new terminals with `npm run dev`.

```powershell
npm run restart:local
```

Or directly:

```powershell
pwsh -ExecutionPolicy Bypass -File scripts/restart-local.ps1
```

- **Skill-gateway**: `http://127.0.0.1:3848` (`POST /alexa`, `POST /webhook/friday-intake` proxy)
- **PC agent**: `http://127.0.0.1:3847`

**`npm run restart:skip`** — **`-SkipDocker -NoKill`**: skips Docker, skips killing node watchers and freeing **3847**/**3848**. If both services already respond on **`/health`**, it exits; otherwise it runs **`node scripts/start.mjs`** with **`OPENCLAW_NO_FREE_PORTS`** (no port pre-kill).

**Hard recycle** (kill listeners + watchers, free ports) — **`npm run restart:local`**, or Docker-less:

```powershell
pwsh -ExecutionPolicy Bypass -File scripts/restart-local.ps1 -SkipDocker
```

**ngrok** (or other tunnels) is not managed here—restart those separately if you use them (`npm run tunnel:ngrok`, `npm run tunnel:n8n`).
