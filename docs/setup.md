# Openclaw — setup (Alexa + N8N + Claude Code)

## What you get

- **skill-gateway** — Alexa HTTPS endpoint: verifies Amazon signatures, optional progressive “Working on it”, returns within the ~8s limit, forwards jobs to N8N.
- **pc-agent** — Allowlisted “open …” + **Claude Code** on Windows. **Friday voice UI**: [http://127.0.0.1:3847/friday](http://127.0.0.1:3847/friday) (`/jarvis` redirects). **`/voice/*` has no login** — fine on loopback; if you use **ngrok** on **3847** (`npm run tunnel:friday`), anyone with the URL can run tasks until you add auth / ngrok OAuth / firewall rules.
- **Naming** — Treat **Friday** (Alexa), **Jarvis** (browser UI), and **Openclaw** (this repo) as the same assistant; see **[docs/unified-assistant.md](unified-assistant.md)**.
- **N8N + Redis (Docker)** — Orchestration, webhook intake, optional Evolution API profile for WhatsApp.
- **Workflow** — Import [`n8n/workflows/friday-intake.json`](../n8n/workflows/friday-intake.json): validates `X-Openclaw-Secret`, calls PC agent, pushes summary to **`/internal/last-result`** with **`notify: true`** so each finished Alexa task can trigger a **Proactive** notification (when LWA credentials are set on the gateway). Re-import after pulling repo updates.

## Logs, auto-reload, production

See **[docs/debugging.md](debugging.md)** for `LOG_LEVEL`, `OPENCLAW_LOG_DIR`, `npm run dev:gateway` / `dev:agent`, and the `scripts/dev-both.ps1` helper.

## 0) How this matches Amazon’s web-service rules

Your skill endpoint must follow [Host a Custom Skill as a Web Service](https://developer.amazon.com/en-US/docs/alexa/custom-skills/host-a-custom-skill-as-a-web-service.html): **HTTPS on 443** with an **Amazon-trusted certificate** (**ngrok**, Cloudflare Tunnel, or your own domain all qualify), **verify every request is from Alexa** (signature + timestamp), and return valid **ASK JSON** responses. The **skill-gateway** verifies **`Signature-256` + SHA-256** when Amazon sends that header, falls back to legacy **`Signature` + SHA-1**, and rejects requests whose **`request.timestamp`** is more than **150 seconds** from server time. Failed verification returns **HTTP 400** as in Amazon’s guide.

## 1) Prerequisites

- Windows 10/11, **Node.js 18+**, **Docker Desktop**.
- **Amazon developer account** — [Alexa developer console](https://developer.amazon.com/alexa/console/ask).
- **[ngrok](https://ngrok.com)** (free tier works) **or** Cloudflare Tunnel / your own HTTPS reverse proxy with a valid public URL.
- **Claude Code** installed and working in a terminal (`claude` on PATH). The pc-agent defaults to **`--model haiku`** for faster replies; override with **`CLAUDE_MODEL`** (e.g. `sonnet`) or put **`--model …`** in **`CLAUDE_CLI_ARGS`**. Set **`CLAUDE_MODEL=inherit`** to skip injecting a model flag.
- (Optional) **Google Cloud** OAuth for Gmail/Sheets in N8N; **Evolution API** for WhatsApp (`docker compose --profile whatsapp up -d`).

## 2a) Optional: no N8N / embedded SQLite (macOS app style)

- Set **`OPENCLAW_DIRECT_INTAKE=true`** on **skill-gateway** — Alexa and `/openclaw/trigger` call **pc-agent** `/task` directly, then POST **`/internal/last-result`** (same as the sample N8N workflow). Still set **`PC_AGENT_SECRET`** and **`N8N_WEBHOOK_SECRET`** to the **same** value for internal routes.
- Set **`OPENCLAW_SQLITE_PATH`** on **pc-agent** (e.g. `~/.openclaw/openclaw.db`) to use embedded **SQLite** for perception + `openclaw_settings` instead of Docker Postgres.
- Optional: **`~/.openclaw/config.json`** is merged into **`process.env`** after `.env` (wizard / portable installs).

### OpenClaw Postgres (`openclaw-postgres`, port **5433**)

- **`npm run restart:local`** (safe default: no port kills) brings up **`openclaw-postgres`** with **n8n** and **redis-insight** (Redis itself stays under your control per script policy). Use **`npm run restart:force`** when you need to replace listeners on **3847**/**3848**.
- Set **`OPENCLAW_DATABASE_URL`** (e.g. `postgresql://openclaw:openclaw@127.0.0.1:5433/openclaw`) for **perception**, **runtime settings**, **todos / reminders**, and **action tracker** tables.
- Init scripts under **`docker/postgres/init/`** run on **first** container create. If your volume already existed, apply new SQL manually, e.g.  
  `Get-Content docker/postgres/init/03-action-tracker.sql | docker compose exec -T openclaw-postgres psql -U openclaw -d openclaw`
- **Conversation learning** (optional): tables **`conversation_session`** and **`learning_feedback`** in **`docker/postgres/init/08-learning-feedback.sql`**. On an existing volume:  
  `Get-Content docker/postgres/init/08-learning-feedback.sql | docker compose exec -T openclaw-postgres psql -U openclaw -d openclaw`  
  Set **`OPENCLAW_LEARNING_ENABLED=true`** in `.env`. pc-agent auto-applies the same script at startup if the tables are missing (when **`OPENCLAW_DATABASE_URL`** points at Postgres). Task responses include **`generationLogId`** when learning is enabled (for feedback correlation). Submit scores with **`POST /learning/feedback`** (same **`Authorization: Bearer`** as **`/task`**: user JWT or **`PC_AGENT_SECRET`**). Inspect a row: **`GET /learning/generation/:id`**. Export JSONL for offline training: `pip install -r scripts/requirements-learning-export.txt` then **`python scripts/export-learning-dataset.py --format sft --out training.jsonl`**. Send **`clientSessionId`** (or **`conversationSessionId`**) on **`/task`** / **`/voice/command`** bodies to group turns into **`conversation_session`**.
- **Action tracker**: `pip install -r scripts/requirements-action-tracker.txt`, then **`npm run start:action-tracker`** or enable **`FRIDAY_TRACKER_ENABLED`** with **`npm run start:all`** (starts after the agent). Uses **`ANTHROPIC_API_KEY`**, Gmail + Evolution env vars, and **`WHATSAPP_NOTIFY_NUMBER`** for optional text summaries. On each poll it **speaks a check-in** asking if you want today’s plan, **listens** for yes or no (mic + Google STT; timeout or failure defaults to **yes**), then reads pending **action items** and open **todos** from Postgres (or says you are clear). Tune **`FRIDAY_TRACKER_LISTEN_SEC`** and optional **`FRIDAY_TRACKER_CHECKIN_PROMPT`** in `.env`. Same mic env as listen notify: **`LISTEN_DEVICE_INDEX`**, **`LISTEN_ENERGY_THRESHOLD`**, etc.

## 2) Configure environment

```powershell
cd d:\code\openclaw
copy .env.example .env
```

Edit `.env`:

- Set **`N8N_WEBHOOK_SECRET`** and **`PC_AGENT_SECRET`** to long random strings (gateway → N8N header must match; N8N → pc-agent uses `Bearer PC_AGENT_SECRET`).
- Set **`PC_AGENT_WORKSPACE`** to a folder Claude should treat as the main workspace.

## 3) Install Node services

The repo uses **npm workspaces** so `pino` and other deps hoist to a single `node_modules` (avoids a `pino-http` crash from duplicate `pino` copies).

```powershell
cd d:\code\openclaw
npm install
```

(Equivalent: `npm run install:all` from the repo root.)

## 4) Start Docker (N8N + Redis + Redis Insight)

```powershell
docker compose up -d
```

- **N8N** — `http://127.0.0.1:5678`
- **Redis** — `127.0.0.1:6379` (from Windows / `friday-ambient.py`)
- **Redis Insight** — `http://127.0.0.1:5540` — **Add Redis database**: host **`redis`**, port **6379**, no TLS (same Docker Compose network as this stack).

Open `http://127.0.0.1:5678`, complete N8N setup, then **Import** `n8n/workflows/friday-intake.json` and **Activate** the workflow. The **PCAgent** node must send **`source: $json.source`** in the JSON body (included in the repo file) so Alexa jobs get spoken-friendly replies from Claude.

Confirm the webhook path is **Production URL** `http://localhost:5678/webhook/friday-intake` (or your public base if you changed `WEBHOOK_URL`).

## 5) Run gateways (every boot / use NSSM or Task Scheduler)

`.env` is read from the **repo root** (`d:\code\openclaw\.env`) automatically. Two terminals:

```powershell
cd d:\code\openclaw\skill-gateway
node src/server.js
```

```powershell
cd d:\code\openclaw\pc-agent
node src/server.js
```

Health checks: `http://127.0.0.1:3848/health` and `http://127.0.0.1:3847/health`.

**Curl / Postman (not Alexa):** enqueue a task with **`POST /openclaw/trigger`** on the same host as `/alexa`. Header **`X-Openclaw-Secret`** = **`N8N_WEBHOOK_SECRET`**. JSON body at minimum **`{ "commandText": "open notepad", "userId": "amzn1.ask.account.…" }`**. **`POST /alexa`** is only for real Alexa envelopes ( `version`, `session`, `context`, `request` ) plus Amazon signature headers — posting Lambda-style intake JSON there will not work. Example: [`scripts/openclaw-trigger-curl.example.ps1`](../scripts/openclaw-trigger-curl.example.ps1).

## 6) ngrok (public HTTPS for Alexa)

Alexa requires **HTTPS**. Expose **skill-gateway** only (port **3848**), not N8N.

### One-time: install + sign in

**ngrok** is installed via WinGet (`Ngrok.Ngrok`). Link your account:

```powershell
powershell -ExecutionPolicy Bypass -File d:\code\openclaw\scripts\ngrok-login.ps1
```

That opens [your ngrok authtoken page](https://dashboard.ngrok.com/get-started/your-authtoken). After you sign in, run (paste your token):

```powershell
ngrok config add-authtoken YOUR_TOKEN_HERE
```

### Every session: start tunnel

1. Start **skill-gateway** (`node skill-gateway/src/server.js` or `npm run dev:gateway`).
2. In another terminal:

```powershell
cd d:\code\openclaw
npm run tunnel:ngrok
```

Or:

```powershell
powershell -ExecutionPolicy Bypass -File d:\code\openclaw\scripts\ngrok-tunnel.ps1
```

3. Copy the **Forwarding** HTTPS URL (e.g. `https://abcd-12-34-56-78.ngrok-free.app`).
4. In the Alexa developer console → **Endpoint** → HTTPS default region:

`https://YOUR-SUBDOMAIN.ngrok-free.app/alexa`

5. SSL: choose **My development endpoint has a certificate from a trusted certificate authority** (ngrok presents a normal public cert).

**Note:** Free URLs change when you restart ngrok unless you use a [reserved domain](https://ngrok.com/docs/guides/how-to-set-up-a-custom-domain/) on a paid plan. Update the Alexa endpoint whenever the hostname changes.

### Optional: Cloudflare Tunnel instead

If you prefer Cloudflare, use `cloudflared` to `http://127.0.0.1:3848` and set the skill URL to `https://your-host/alexa` as before.

### Friday voice UI over ngrok (separate tunnel)

Alexa uses port **3848**; Friday pc-agent uses **3847**. For a public **https://….ngrok-free.app/friday** link:

1. Start **pc-agent** (`npm run start:agent` or `node pc-agent/src/server.js`).
2. Run **`npm run tunnel:friday`** (same idea as `ngrok http 3847`).
3. Open the ngrok **HTTPS** URL with path **`/friday`**.

The page sends **`ngrok-skip-browser-warning`** so API calls get JSON, not the free-tier browser interstitial. The **Claude model** dropdown under the title (stored in `localStorage`) sets the model for this browser; leave **Server default** to use **`CLAUDE_MODEL`** / server Haiku default.

### Friday voice: text-to-speech (TTS)

- **Default (no setup):** the page uses the browser’s **Web Speech API**. On **Microsoft Edge**, you often get **natural-sounding** English voices at no cost. Chrome may sound more robotic depending on OS.
- **Free, offline, neural (recommended if you want Jarvis-like speech without API bills):** run **[Piper](https://github.com/rhasspy/piper)** on the same machine as pc-agent. Download a release for your OS, pick a voice (e.g. `en_US-lessac-medium`), and set in `.env`:
  - `PIPER_PATH` — path to the `piper` executable (on Windows, `piper.exe`).
  - `PIPER_MODEL` — path to the voice `.onnx` file (the matching `.onnx.json` should sit beside it).
  The Friday page will then call **`POST /voice/tts`** and play WAV from Piper.
- **Optional paid:** OpenAI TTS is **disabled by default**. To use it, set `FRIDAY_TTS_OPENAI=true` and `OPENAI_API_KEY` (or `FRIDAY_OPENAI_API_KEY`). You can tune `FRIDAY_TTS_VOICE` and `FRIDAY_TTS_MODEL`.

### Jarvis ambient intelligence (optional)

Proactive **Friday** chatter when nobody has spoken for a while: filler TTS + short Haiku lines, **now-playing** logging (Windows + **py-now-playing**), **Redis** cache/queue, **SQLite** at `data/friday.db`.

1. **`docker compose up -d`** (Redis on `127.0.0.1:6379`) — optional; without Redis the daemon uses an in-memory fallback.
2. **`pip install -r scripts/requirements-ambient.txt`** (or install `redis`, `anthropic`, `aiohttp`, `py-now-playing` yourself).
3. In **`.env`**: set **`FRIDAY_AMBIENT=true`**, tune **`FRIDAY_AMBIENT_*`** and **`FRIDAY_USER_*`** (see **`.env.example`**). **`ANTHROPIC_API_KEY`** enables Haiku lines; without it, witty fallbacks still run.
4. Run **`npm run start:ambient`** or **`npm run start:all`** (starts ambient automatically when **`FRIDAY_AMBIENT=true`** in `.env`).

`friday-speak.py` updates **`%TEMP%\friday-tts-ts`** after each playback so the ambient loop respects real TTS silence.

## 7) Alexa custom skill

1. Create a **Custom** skill, **HTTPS** endpoint (not Alexa-hosted).
2. Under **Interaction Model**, paste JSON from [`skill/interaction-model.json`](../skill/interaction-model.json) (JSON editor), or recreate intents manually. After updating that file from the repo, **Save** and **Build Model** again so in-skill follow-ups (e.g. “and open Chrome”) map to `FridayCommandIntent` with a filled `command` slot.
3. **Endpoint**: **HTTPS** default region URL `https://YOUR-NGROK-HOST.ngrok-free.app/alexa` (or your stable HTTPS URL). If the console offers **multiple geographic endpoints** and you turn that on, put the **same** URL in **each** enabled region; otherwise leave a **single** default only.
4. **Invocation name** is `friday` (change in JSON if you pick another allowed name).
5. Enable the skill on your account and on the Echo (“Dev” skills appear after account linking in test).

For local testing only, you can set `ALEXA_VERIFY_SIGNATURE=false` in `.env` and use the Alexa developer **Skill Testing** tools; **turn verification back on** before any publication.

### Push notifications (optional — Proactive Events)

When a long PC job finishes, you can ping the user’s Alexa account with a **notification** (they hear a chime and can say *“Alexa, read my notifications”*). Openclaw uses Amazon’s **Proactive Events** schema **`AMAZON.MessageAlert.Activated`** (“You have a message from …”), not arbitrary free text.

1. **Alexa developer console** — In your skill’s **JSON editor** / manifest, add [proactive events](https://developer.amazon.com/en-US/docs/alexa/smapi/proactive-events-api.html): permission **`alexa::devices:all:notifications:write`** and under **`events.publications`** include **`AMAZON.MessageAlert.Activated`**. You also need an **events endpoint** (can be the same Lambda ARN or HTTPS URL as the skill). Save and redeploy the skill.
2. **Security profile** — In the same developer console area as your skill, create or reuse a **Login with Amazon** security profile and note **Client ID** and **Client Secret**. Ensure the profile allows **`alexa::proactive_events`** for client-credentials token requests (see Amazon’s *Get access token with skill credentials* / LWA docs).
3. **`.env`** on the machine running **skill-gateway** — Set **`ALEXA_LWA_CLIENT_ID`** and **`ALEXA_LWA_CLIENT_SECRET`**. For **EU** skills, set **`ALEXA_PROACTIVE_API_HOST=https://api.eu.amazonalexa.com`**. While developing, keep **`ALEXA_PROACTIVE_USE_DEVELOPMENT=true`** (default) so events go to the [development proactive endpoint](https://developer.amazon.com/en-US/docs/alexa/smapi/proactive-events-api-reference.html); switch to production after certification.
4. **Alexa app** — The user must enable **Notifications** for your skill under *Skills & Games → your skill*.
5. **Call from N8N (or any backend)** after **`POST /task`** succeeds — HTTP **POST** to the gateway:

   - URL: `http://host.docker.internal:3848/internal/alexa-notify` (from N8N on Docker Desktop) or your public tunnel host if the caller is remote.
   - Header: **`X-Openclaw-Secret`**: same value as **`N8N_WEBHOOK_SECRET`**.
   - JSON body: **`{ "userId": "<from friday-intake payload>", "creatorName": "Openclaw", "count": 1 }`**. Optional: **`referenceId`** (idempotency; defaults to a random UUID).

If LWA or manifest setup is missing, the endpoint returns **503** with a short hint. Amazon enforces per-user rate limits on notifications.

**Default task path:** [`friday-intake.json`](../n8n/workflows/friday-intake.json) already POSTs **`/internal/last-result`** with **`notify: true`**, **`message`** (Claude summary), and **`correlationId`**. The gateway stores the summary and sends **MessageAlert** when LWA is configured; otherwise it returns **`notification.skipped: lwa_not_configured`** and still **200 OK**. Optional **`notifyLabel`** in the body overrides the short “from …” line (else it is derived from the summary). Local check: **`npm run test:notify`** from the repo root (gateway running).

### “Waiting on you” + optional notification (skill-gateway)

When the PC or N8N needs **the user to do something** (approve a prompt, type a code, etc.), you can:

1. **POST** `http://host.docker.internal:3848/internal/awaiting-user` (or your public gateway URL) with header **`X-Openclaw-Secret`**, JSON:
   - **`userId`** — same Alexa id as in the friday-intake payload.
   - **`prompt`** — short plain-text reminder (e.g. “Confirm the merge in VS Code”).
   - **`correlationId`** (optional) — ties to your workflow run.
   - **`notify`: true** (optional) — also sends the **Proactive** MessageAlert chime if LWA is configured (see above).

2. On **“Alexa, open Friday”**, the skill **speaks that prompt first** and asks them to say **“I took care of it”** when done (intent **`FridayAckPendingIntent`** — rebuild the interaction model after pulling the repo JSON).

3. **“Alexa, ask Friday what was the last result”** also prepends the pending prompt if it is still set.

4. When the user has actually responded on the PC, your workflow should **POST** `…/internal/awaiting-user/clear` with **`{ "userId" }`** so Alexa stops reminding.

**AWS Lambda** can use the same gateway over HTTPS: set **`last_result_url`** to `https://<gateway-ngrok>/internal/last-result/fetch`, and optionally **`awaiting_user_peek_url`** / **`awaiting_user_clear_url`** to `…/internal/awaiting-user/peek` and `…/internal/awaiting-user/clear` (same **`openclaw_webhook_secret`** header).

## 8) Phrases

Wake word stays **Alexa** (or another Amazon wake word). Examples:

- “Alexa, open Friday.”
- “Alexa, ask Friday to open Spotify.”
- “Alexa, ask Friday what was the last result.”
- “Alexa, tell Friday I took care of it.” (clears the “waiting on you” reminder)

After changing [`skill/interaction-model.json`](../skill/interaction-model.json), **Save** and **Build Model** in the Alexa console. If the skill replies *“I didn’t catch that…”*, the `command` slot was empty: use **“Alexa, ask Friday to open Notepad”** (invocation + intent), or say **“open Notepad”** once the repo samples include **`open {command}`** (they do in the current JSON). In the developer **Test** panel, type full-sentence utterances that match your samples, not a bare keyword, unless the model includes that pattern.

## 9) Optional: WhatsApp (Evolution API + N8N)

This path is **not** enabled by default. You run **Evolution API** in Docker, link WhatsApp Web (QR), point Evolution’s **webhook** at N8N, and import a second workflow that calls **pc-agent** and sends the reply back on WhatsApp.

### 9.1 Prerequisites

- Same stack as the rest of Openclaw: **Docker**, **N8N** running, **pc-agent** reachable from N8N (`host.docker.internal:3847` on Windows).
- A **phone number** you can pair with **WhatsApp Web** via Evolution (personal use risks violating WhatsApp ToS; prefer the **WhatsApp Business API** for production).

### 9.2 Configure `.env`

Set a strong API key and an **instance name** you will create in Evolution (they must match).

```env
EVOLUTION_API_KEY=your-long-random-secret
EVOLUTION_INSTANCE=openclaw
```

Optional: require a shared secret header on the N8N webhook (leave empty to skip while testing on loopback only):

```env
WHATSAPP_WEBHOOK_SECRET=optional-matching-secret
```

**Allowlist + broadcast replies:** `WHATSAPP_ALLOWED_NUMBERS` (digits only, comma-separated) controls who may trigger commands. Set **`WHATSAPP_ALWAYS_REPLY_NUMBERS`** to the same list (or a superset) if every reply should go to **all** of those handsets — the workflow fans out one Evolution `sendText` per number. If `WHATSAPP_ALWAYS_REPLY_NUMBERS` is empty, only the sender gets the reply.

Inbound WhatsApp tasks use **`source: whatsapp`** on `POST /task` so pc-agent uses the **Claude API fast path** (up to three minutes) instead of waiting on the CLI first.

Restart compose after edits so N8N picks up env vars.

### 9.3 Start Redis + N8N + Evolution

From the repo root:

```powershell
cd d:\code\openclaw
docker compose --profile whatsapp up -d
```

- **N8N:** [http://127.0.0.1:5678](http://127.0.0.1:5678)  
- **Evolution API:** [http://127.0.0.1:8080](http://127.0.0.1:8080) (manager / docs depend on image version; see [Evolution API docs](https://doc.evolution-api.com/))

`AUTHENTICATION_API_KEY` on the Evolution container is set from **`EVOLUTION_API_KEY`** in `docker-compose.yml`.

### 9.4 Create instance and pair WhatsApp

In Evolution’s UI or API, **create an instance** named exactly **`EVOLUTION_INSTANCE`** (e.g. `openclaw`). Complete **QR** linking for that instance. Until the instance shows **connected**, inbound webhooks will not carry real chats.

### 9.5 Import the WhatsApp workflow in N8N

1. In N8N: **Workflows → Import from file** → [`n8n/workflows/whatsapp-evolution-intake.json`](../n8n/workflows/whatsapp-evolution-intake.json).  
2. **Activate** the workflow.  
3. Copy the **Production** webhook URL for path **`whatsapp-intake`** (shown on the Webhook node). For containers on the **same Docker network** as Evolution, the URL Evolution should call is:

   `http://n8n:5678/webhook/whatsapp-intake`

   (Use the **test** URL only while clicking “Listen” in N8N; Evolution needs the **production** URL.)

### 9.6 Point Evolution at N8N

Register a **webhook** on that instance so Evolution POSTs incoming-message events to N8N. Set the URL to the production URL above. Subscribe at least to **`MESSAGES_UPSERT`** (and optionally other events you need). See [Evolution — Webhooks](https://doc.evolution-api.com/v1/en/configuration/webhooks) (`/webhook/instance` or your image’s equivalent).

If you set **`WHATSAPP_WEBHOOK_SECRET`**, configure Evolution (or a reverse proxy) to send header **`X-Openclaw-WhatsApp-Secret`** with that value on each POST, or leave the secret empty for local-only testing.

### 9.6a WhatsApp group → Jira (skill-gateway)

**skill-gateway** can turn **allowlisted group** messages into **Jira issues** using Claude for triage and Evolution `sendText` for an in-thread confirmation. It runs on the existing route **`POST /webhook/evolution`** when the event is **`MESSAGES_UPSERT`** (same handler as call notifications).

**Delivering events to the gateway:** Many setups point Evolution’s webhook only at N8N. The Jira pipeline must receive the same payloads. Pick one:

1. **Mirror from N8N (recommended):** Right after the **Webhook** node in [`n8n/workflows/whatsapp-evolution-intake.json`](../n8n/workflows/whatsapp-evolution-intake.json), add an **HTTP Request** node: **POST** `http://host.docker.internal:3848/webhook/evolution`, **Body** = raw JSON from the Evolution webhook (same object N8N received), headers **`Content-Type: application/json`** and, if used, **`X-Openclaw-WhatsApp-Secret`** matching **`WHATSAPP_WEBHOOK_SECRET`**. Run this path in parallel with your existing parse/PCAgent flow (do not replace the N8N URL Evolution already calls unless you also forward to N8N from the gateway).
2. **Direct to gateway only:** Point Evolution at **`http://host.docker.internal:3848/webhook/evolution`** — you then lose stock **`whatsapp-intake`** unless you add forwarding (not included).

**Configuration (`.env`):** enable **`WHATSAPP_JIRA_ENABLED=true`**, set **`WHATSAPP_JIRA_GROUPS`** (comma-separated group JIDs such as `120363…@g.us` from Evolution “fetch groups” / logs), **`WHATSAPP_JIRA_PROJECT`**, **`JIRA_BASE_URL`**, **`JIRA_EMAIL`**, **`JIRA_API_TOKEN`**, and **`ANTHROPIC_API_KEY`**. Optional: **`WHATSAPP_JIRA_TRIGGER`** (e.g. `/ticket`) so only lines with that prefix become tickets; **`WHATSAPP_JIRA_USERS`** JSON map of name → Jira **accountId**; **`WHATSAPP_JIRA_DRY_RUN=true`** to classify without creating issues. See commented block in `.env`.

**Smoke test:** `npm run test:whatsapp-jira` (expects **skill-gateway** listening on **3848**).

### 9.7 End-to-end check

1. **pc-agent** running on the host (`node pc-agent/src/server.js` or your usual command).  
2. Send a **text** WhatsApp message to the linked number. N8N should run **ParseEvolution → PCAgent → FanoutWhatsApp → SendWhatsApp** (one send per entry in `WHATSAPP_ALWAYS_REPLY_NUMBERS`, or one to the sender if unset); you get a reply with **`summary`** from Claude.  
3. **Groups:** the stock N8N workflow targets 1:1 chats. **Group → Jira** uses **`WHATSAPP_JIRA_*`** on **`/webhook/evolution`** (see §9.6a).  
4. Do **not** expose N8N or Evolution to the public internet without TLS, auth, and rate limits.

### 9.7a Friday Listen — Mail and WhatsApp rail

After you sign in, the dashboard at **`http://127.0.0.1:3847/friday/listen`** shows a **right-hand rail**: **Mail** (unread + recent from Gmail via **`GET /integrations/gmail`**) above **WhatsApp** (Evolution connection status, recent inbound messages, and compose). Outbound sends use **`POST /integrations/whatsapp/send`** on pc-agent; the **recipient must be in** **`WHATSAPP_ALLOWED_NUMBERS`** when that list is non-empty, and **`EVOLUTION_API_KEY`** must be a real secret (not `change-me`). **Inbound handling is unchanged:** Evolution → N8N **`whatsapp-intake`** → **`POST /task`** — the rail is for monitoring and manual sends, not a replacement for the webhook.

Gmail in the rail needs **`GMAIL_ADDRESS`** and **`GMAIL_APP_PWD`** in `.env` (same as [`scripts/gmail.py`](../scripts/gmail.py)). On **narrow** windows (&lt;1100px), tap the **envelope** icon in the top bar to open the rail over the chat.

### 9.8 Alexa vs WhatsApp

- **Alexa** still uses **`friday-intake`** and the skill-gateway.  
- **WhatsApp** uses **`whatsapp-intake`** only. They share **pc-agent** and optional **PushSummary** to the gateway.

## 10) Extending (email, Sheets)

- Add N8N branches after **Normalize** (Alexa) or extend the WhatsApp flow: Gmail / Google Sheets nodes (OAuth in N8N).
- Keep **long** work out of the Alexa request path; the gateway already ACKs fast.

## 10b) Split-stack: home server + remote clients (ngrok)

Run **Docker, Postgres, Redis, skill-gateway, and pc-agent** on one always-on machine. On laptops (macOS or Windows), run **only** the client stack so mic, **friday-speak**, Cursor reply TTS, and ambient talk to the house over HTTPS.

- **Home:** `npm run start:server-stack` (or `OPENCLAW_START_MODE=server` with `npm run start:all`). Keep `OPENCLAW_SKILL_GATEWAY_URL=http://127.0.0.1:3848` on the server. Tunnel pc-agent: `npm run tunnel:friday` → `ngrok http 3847`. Optionally tunnel the gateway: `npm run tunnel:ngrok` → `ngrok http 3848`.
- **Remote:** Copy `.env` secrets (`PC_AGENT_SECRET`, etc.) from the server; set `PC_AGENT_URL` and `FRIDAY_PC_AGENT_URL` to the **public** pc-agent base (no trailing slash). Set `OPENCLAW_START_MODE=client` or run `npm run start:client-stack`. Turn off server-only daemons on the laptop (e.g. `FRIDAY_EMAIL_WATCH=false` if Gmail watch runs on the server).
- **Redis:** For shared TTS locks and ambient coherence, use the **same** `OPENCLAW_REDIS_URL` on server and clients (Tailscale/VPN IP, or managed Redis). Plain `127.0.0.1` on a remote machine is **local-only** and will diverge from the house.
- **Bootstrap:** [`scripts/openclaw-client-bootstrap.sh`](../scripts/openclaw-client-bootstrap.sh) — optional one-liner via public Gist raw (maintainer copy: `https://gist.githubusercontent.com/theroyalraj/d4ddf7b05d156271f9f3205e2cb101cb/raw/openclaw-client-bootstrap.sh`; pin a revision in production). **Interactive:** `curl -fsSL …/raw/openclaw-client-bootstrap.sh | bash -s -- --interactive` — colorized steps, numbered choices, **live `GET /voice/ping`** after you paste the ngrok URL, optional **spoken line** (`friday-speak` or macOS `say`) once the tunnel passes. Menus read from `/dev/tty` (works when the script is piped). With **no arguments** from a real terminal, the same wizard runs. **Flags:** `--pull-only`, `--setup-only`, full client with `--ngrok-url`, `--no-setup`, `--no-voice-check`, `OPENCLAW_BOOTSTRAP_VOICE_CHECK=0` (honoured when not using the interactive wizard). See `bash …/openclaw-client-bootstrap.sh --help`.
- **macOS:** Listen UI opens via `open`. Offline TTS uses **`say`** with optional `FRIDAY_MACOS_SAY_VOICE` and `FRIDAY_MACOS_SAY_RATE`. List voices: `scripts/list-macos-voices.sh` or `python scripts/pick-macos-say-voice.py --list`. Optional Notification Center bridge: `FRIDAY_MAC_NOTIFY_WATCH=true` (subscribes to `/voice/stream` and forwards `win_notify` SSE events).
- **Smoke:** `npm run smoke:ngrok-split -- https://YOUR.ngrok-free.app` checks health and voice ping (pass ngrok URL as first argument or set `PC_AGENT_TEST_URL`).

## 11) Security checklist

- Do **not** expose N8N (5678) or Postgres **5433** to the internet without auth.
- **pc-agent on 3847** is powerful: if you use **ngrok** on 3847, treat the URL as a secret, prefer **ngrok OAuth** or IP allowlists, and keep `PC_AGENT_SECRET` long and unguessable.
- Prefer **Tailscale or VPN** for `OPENCLAW_REDIS_URL` instead of exposing Redis on a public port.
- Rotate `N8N_WEBHOOK_SECRET` and `PC_AGENT_SECRET` if leaked.
- Review allowlisted apps in `pc-agent/src/open.js` before widening.

## 12) Skill works in the console but Echo says it can’t find / open Friday

**Development skills do not show up in the public skill search.** You must enable them on the same Amazon account your Echo uses.

1. **Alexa app (phone)** → **More** → **Skills & Games** → **Your skills** (not the search box).
2. Open the filter / tabs and choose **Dev** or **Development** (wording varies by app version).
3. Find your skill and tap **Enable to use**.

If there is no Dev section, the Alexa app account may not match your **developer.amazon.com** login. Use the **same Amazon account** on both, or in the developer console add your Alexa account under **Distribution** (availability / beta testers) as allowed to test.

**Phrasing:** Wake word is still **Alexa** (or Computer, etc.). Your *skill name* is the invocation name, e.g. **“Alexa, open Friday.”** (not “Alexa Friday” without “open/ask/tell”.)

**Locale:** This repo’s sample model uses **English (US)** and `AMAZON.SearchQuery`. Set the Echo (or the skill) to **English (United States)** for the most reliable match, or add another language in the skill console and rebuild the model.

**Backend reachability:** If Alexa says the skill closed, had a problem, or is unavailable, confirm **ngrok** (or your tunnel) **is running**, `https://YOUR-HOST/health` loads, and the skill endpoint URL in the console still matches (free **ngrok** URLs **change** when you restart the agent unless you use a reserved domain).

**Signature errors:** If the **Test** tab in the developer console works but the device fails, watch the **skill-gateway** terminal for `[alexa] verify failed`. As a last resort for local debugging only, you can set `ALEXA_VERIFY_SIGNATURE=false` in `.env` and restart the gateway (turn verification back on before any public release).

### “There was a problem communicating with the requested skill” (empty JSON Output)

Usually Alexa never got a valid **200** + skill JSON in time. Check in order:

1. **Tunnel + gateway** — **ngrok** `http 3848` running; `node skill-gateway/src/server.js` running; browser can load `https://YOUR-HOST/health`.
2. **Console endpoint** — HTTPS URL ends with **`/alexa`**, **SSL** = trusted CA (correct for **ngrok**), and if you use **Europe** testing, the **same URL** is set on the **Default** endpoint (or duplicated under **Europe** if you use regional overrides).
3. **Signature / cert download** — Verification must download Amazon’s chain from `https://s3.amazonaws.com/echo.api/...`. If that is blocked on your network, you’ll see `amazon verify failed` / `cert fetch` in the gateway log. Temporarily set `ALEXA_VERIFY_SIGNATURE=false` to confirm; fix network or keep verify off **only** for dev.
4. After a successful request, the gateway logs something like **`alexa request accepted`** and **`request completed`** with **statusCode 200**.

### Test tab shows JSON (e.g. `LaunchRequest`) but ngrok shows **no** request

The JSON you see in the **Test** tab is the **simulated request body**; it is **not** proof that Amazon called your server. In particular, `context.System.apiEndpoint` (e.g. `https://api.eu.amazonalexa.com` for EU accounts) is only where **your skill** may **call Alexa** (progressive response, etc.). Your **webhook** is whatever you entered under **Build → Endpoint**.

If **http://127.0.0.1:4040** (ngrok inspector) stays empty when you run a test utterance, Amazon is **not** hitting your tunnel. Fix:

1. **Endpoint type** — **HTTPS**, not **AWS Lambda ARN**.
2. **Default region URL** — Exactly `https://YOUR-SUBDOMAIN.ngrok-free.app/alexa` (update every time the free ngrok hostname changes). **Save endpoints** after editing.
3. **Geographic regions** — If you enabled **multiple geographic endpoints**, every enabled region (e.g. **Europe** and **North America**) must list the **same** HTTPS `/alexa` URL. If **Europe** is empty or still an old host while your test routes via EU, you can get “problem communicating” and **no** line in ngrok. For dev, prefer **one** default endpoint and **do not** enable extra regional URLs unless you fill them all.
4. Confirm **ngrok** is running and **Forwarding** to `http://localhost:3848` (or `127.0.0.1:3848`), then retry the test and watch the inspector for `POST /alexa`.

**Privacy:** Do not paste `apiAccessToken` or other JWTs from test JSON into chats or logs; treat them as secrets.
