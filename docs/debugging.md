# Debugging & logging

## Where logs go

| Output | When |
|--------|------|
| **Terminal** (stdout) | Always. In development, lines are **colorized** via `pino-pretty`. In production (`NODE_ENV=production`), one **JSON object per line** (good for log aggregators). |
| **Files** | If `OPENCLAW_LOG_DIR` is set (e.g. `logs`), each service appends **JSON** lines to `logs/skill-gateway.log` and `logs/pc-agent.log` (stdout is JSON too in that mode). Pipe through `pino-pretty` for colors. |

## Environment variables

| Variable | Purpose |
|----------|---------|
| `LOG_LEVEL` | `trace` · `debug` · `info` · `warn` · `error` · `fatal`. Default: `debug` in dev, `info` when `NODE_ENV=production`. |
| `NODE_ENV` | Set to `production` for JSON-only stdout (no pretty colors). |
| `OPENCLAW_LOG_DIR` | e.g. `logs` — enables rotating-style append logs per service. Directory is created automatically. |

Add these to [`.env`](../.env) at the repo root (both services load `../../.env`).

After pulling changes, reinstall from the repo root (**npm workspaces** install both services):

```powershell
cd d:\code\openclaw
npm install
```

## Auto-reload while coding

Node **20+** watches `src/` and shared [`lib/`](../lib/) when you use:

```powershell
cd d:\code\openclaw
npm run dev:gateway
```

```powershell
npm run dev:agent
```

Or open **two terminals** at once:

```powershell
powershell -File d:\code\openclaw\scripts\dev-both.ps1
```

Saving any `.js` file under `skill-gateway/src`, `pc-agent/src`, or `lib/` restarts that process.

## What gets logged (high signal)

- **HTTP**: method, URL, status, duration; `/health` is **not** auto-logged (reduces noise).
- **Alexa** (gateway): `requestType`, `requestId`, `locale`, `applicationId`, `intent`, short `slotPreview`, **EU/NA/FE** region hint — **not** raw `apiAccessToken` or full user ids.
- **Amazon verify**: failures include reason (`signature-verify`, `amazon-cert-fetch`, etc.).
- **N8N enqueue**: HTTP status and latency for the webhook call.
- **PC agent**: task mode (`open_app` / `claude`), timings, exit code, output lengths — not full Claude transcripts at `info` (use `LOG_LEVEL=debug` if you add more later).

## Tail a log file with pretty colors

```powershell
powershell -File d:\code\openclaw\scripts\tail-gateway.ps1
```

Requires `OPENCLAW_LOG_DIR=logs` and a running gateway so the file exists.

## Production checklist

1. `NODE_ENV=production`
2. `LOG_LEVEL=info` (or `warn` if very quiet)
3. `ALEXA_VERIFY_SIGNATURE=true`
4. Point a log shipper at **stdout** JSON lines, or set `OPENCLAW_LOG_DIR` and ship files.

## Process signals

Both services log on **SIGINT** / **SIGTERM** and exit. Unhandled rejections are logged; uncaught exceptions log **fatal** and exit `1`.
