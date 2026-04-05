# OpenClaw Friday — portable UI (extension + static)

Self-contained **React + Vite** chat shell for **pc-agent**: same flow as the full Listen page (`/voice/command`, `/voice/stream`, optional `/voice/speak-async`), but **no Postgres signup** — you only configure:

- **Agent base URL** (e.g. `http://127.0.0.1:3847` or `https://your-tunnel.example`)
- **Bearer token** — `PC_AGENT_SECRET` from `.env`, or a valid Listen UI **JWT**

## Run locally (dev)

Requires pc-agent listening (default port 3847). Vite proxies `/voice`, `/health`, `/openclaw` to the agent.

```bash
cd openclaw-ship/extension-ui
npm install
npm run dev
```

Optional: `VITE_DEV_AGENT_TARGET=http://other-host:3847 npm run dev`

## Build static site (host anywhere)

```bash
npm run build
```

Output: **`dist/`** — upload to any static host, S3, nginx, or `npx serve dist`.  
Open `index.html` over **http(s)** (not `file://`) so `fetch`/`EventSource` work, unless you relax browser rules.

CORS: pc-agent **`/voice/*`** already sends `Access-Control-Allow-Origin: *` for browser calls.

## Load as Chrome / Edge extension (unpacked)

1. `npm run build`
2. Chrome → **Extensions** → **Load unpacked** → choose **`extension-ui/dist`**
3. Click the toolbar icon — opens a **full tab** with the UI (the popup is intentionally unused; the app needs space).

Safari: use **Safari Web Extension** packaging in Xcode; point the extension’s resource folder at the built **`dist`** contents and adjust `manifest.json` / APIs per [Apple’s docs](https://developer.apple.com/documentation/safariservices/safari_web_extensions).

## Security

- Tokens live in **chrome.storage.local** (extension) or **localStorage** (static).
- Use **HTTPS** for the agent when exposed beyond loopback; pair with tunnel or reverse proxy auth as you prefer.

## Relation to `pc-agent` Listen SPA

The full Listen experience (`FridayListenApp.tsx`, auth, personas, integrations rail) stays in **`pc-agent`**. This package is the **shippable subset**: settings + chat + SSE feed, for extension and “run anywhere” installs.
