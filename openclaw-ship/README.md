# OpenClaw ship bundle

Split **server** (always-on backend) from **client** (mic, Jarvis TTS, Cursor narration) so you can run pc-agent and skill-gateway on a box or VPS, and keep speech daemons on a Mac (or second PC) pointed at `PC_AGENT_URL`.

## Roles

| Role | npm | What runs |
|------|-----|-----------|
| **Server** | `npm run start:server-stack` | skill-gateway, pc-agent, DEXTER action tracker (if enabled), optional Gmail watch when `FRIDAY_EMAIL_WATCH=true` |
| **Client** | `npm run start:client-stack` | friday-listen, ambient, Cursor reply / SAGE / ARGUS / music scheduler (per `.env`) |
| **All-in-one** | `npm run start:all` | Same as before: server + client in one terminal |

Set **`OPENCLAW_ALEXA_ENABLED=false`** in `.env` to drop the Alexa skill bridge (POST `/alexa` and related internals). Triggers and direct intake still work.

## Setup

From repo root:

```bash
chmod +x openclaw-ship/setup.sh
./openclaw-ship/setup.sh
```

The script appends missing keys to `.env` (OpenRouter, webhook secret, Alexa off, direct intake). On Windows, use `openclaw-ship/setup.ps1`.

## OpenRouter CLI (client-side summaries)

```bash
export OPENROUTER_API_KEY=sk-or-...
echo "Long text..." | node openclaw-ship/client/openrouter-summarize.mjs
node openclaw-ship/client/openrouter-summarize.mjs --file ./notes.txt
```

Uses `OPENROUTER_SONNET_MODEL` or defaults to `openai/gpt-4o-mini`.

## Portable Friday UI (React + extension)

The **shippable** chat UI lives in **`extension-ui/`** (Vite + React). It talks to **any pc-agent** via configurable base URL + Bearer (`PC_AGENT_SECRET` or JWT). Same core API as `/friday/listen` (command + SSE), without the full Listen auth/signup stack.

```bash
# one-shot build (+ optional zip)
./openclaw-ship/setup-extension.sh    # macOS / Linux
powershell -File openclaw-ship/setup-extension.ps1   # Windows
```

Or manually: `cd openclaw-ship/extension-ui && npm install && npm run build` → load **`extension-ui/dist`** as **Chrome → Load unpacked**. The toolbar icon opens a **full tab** (not a tiny popup).

Docs: **`extension-ui/README.md`**.

**Safari / macOS:** wrap the built **`dist/`** folder in Xcode’s **Safari Web Extension** template (Apple requires an `.appex` wrapper). The older **`macos-safari-extension/Extension/`** stub is optional; prefer **`extension-ui/dist`** after `npm run build`.

Safari may restrict cross-origin `fetch`; use **HTTPS** + `host_permissions` in `manifest.json` for remote agents.

## Environment quick reference

- `PC_AGENT_URL` — client only; default `http://127.0.0.1:3847`
- `OPENCLAW_DIRECT_INTAKE=true` — gateway forwards webhook intake straight to pc-agent (no N8N)
- `OPENCLAW_ALEXA_ENABLED=false` — no Alexa routes
- `OPENROUTER_API_KEY` — summarizer CLI + existing pc-agent OpenRouter paths
