# One assistant: Friday · Jarvis · Openclaw

These are **names for the same system** in this repo:

| Name | Where it shows up |
|------|-------------------|
| **Openclaw** | Repo, services (`skill-gateway`, `pc-agent`), N8N workflow |
| **Friday** | Default Alexa **invocation** (`skill/interaction-model.json`) — e.g. “Alexa, open Friday.” |
| **Friday (browser)** | Voice UI: [http://127.0.0.1:3847/friday](http://127.0.0.1:3847/friday) — listen → **spoken reply** → listen again (`/jarvis` redirects). Same engine as Alexa→N8N→PC. |

You can change the Alexa invocation to `jarvis` in the developer console / JSON (subject to [Alexa invocation name rules](https://developer.amazon.com/en-US/docs/alexa/custom-skills/choose-the-invocation-name-for-a-custom-skill.html)); only **one** invocation name applies per custom skill.

## Where commands run (unified backend)

1. **Alexa** → `POST /alexa` (skill-gateway) → N8N webhook → `POST /task` (pc-agent, Bearer `PC_AGENT_SECRET`).
2. **Friday web UI** → `GET /friday`, `POST /voice/command` on pc-agent (**no Bearer/login** on `/voice/*` — treat like an open console if you expose the port or ngrok it).

Both paths end in the same **`runTask`** logic: allowlisted **open …** apps, otherwise **Claude Code** on `PC_AGENT_WORKSPACE`.

The browser uses **Web Speech API** (recognition + synthesis) for two-way voice. Chrome or Edge on the same PC works best.

## “Always listening” on Alexa

Consumer Echo devices are **not** an open microphone to the cloud. In practice:

- You use the **wake word** (“Alexa”) for each **conversation turn** (with gaps).
- **Follow-Up Mode** (Alexa app → Device settings) keeps the device attentive for **a short time** after a response so you can speak again **without** repeating the wake word; it is **not** unlimited always-on dictation.
- **Routines** can trigger actions from fixed phrases.

For **continuous voice control at your desk**, use the **Friday** page: **Begin session** starts a loop (speak → reply is read aloud → mic opens again). Tap the **orb** while it speaks to interrupt. **End session** stops the loop.

## Security notes

- **Default:** pc-agent listens on **`0.0.0.0`** (all interfaces). Set **`PC_AGENT_BIND=127.0.0.1`** for loopback-only.
- **`/voice/command` and `/friday` are unauthenticated** by design for now. **ngrok / public URL = anyone can run your allowlist + Claude** on that PC until you add auth (or ngrok’s verify / IP allowlist) yourself.
- **`POST /task`** still requires **`Bearer PC_AGENT_SECRET`** (N8N / trusted callers only).
- **Cursor “Open Jarvis”** is **not** wired here unless you add **MCP** or similar.

## See also

- [setup.md](setup.md) — Alexa, ngrok, N8N, regional endpoints.
- [debugging.md](debugging.md) — logs and dev scripts.
