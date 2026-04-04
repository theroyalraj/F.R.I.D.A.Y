---
name: openclaw-test-notify
description: >-
  Starts the OpenClaw task-complete notification smoke test asynchronously
  (non-blocking) after finishing implementation work in this repo. Use when
  completing coding tasks, fixes, or refactors in openclaw, after changes that
  could affect notifications or task-complete flows, or when the user asks to
  verify notifications.
---

# OpenClaw: verify task-complete notification

## When to run

After you finish substantive work in this repository (code changes, fixes, refactors, or tasks that touch execution/notification paths), **start the notification test asynchronously**—do not hold your closing message until it finishes.

Skip only when the session was purely informational (no repo changes) or the user explicitly opts out.

## Run asynchronously

1. Use a **background** terminal session (or another fire-and-forget invocation) so the user gets your summary immediately while the HTTP request and notification run.
2. Set **`NOTIFY_TEST_NO_PROMPT=true`** for that run so the script never waits for interactive stdin.
3. **Always** set `NOTIFY_TEST_MESSAGE` to a vivid, specific summary of what you just did — mention the files touched, the bug squashed, the feature shipped, or the refactor landed. Make it punchy and informative so Raj knows exactly what dropped. No generic "task done" placeholders.

Example messages (replace with actual context each time):
- `"Skill updated — openclaw-test-notify now injects cool context on every run. 1 file changed."`
- `"Fixed the race condition in lambda_function.py around the Alexa session timeout. 3 lines changed, all tests green."`
- `"Wired up the new /internal/queue endpoint, hooked into the awaiting-user flow, and dropped a smoke test. Ship it."`

### PowerShell (typical on this machine)

Run from repo root in a **background** shell; set env vars before `npm`:

```powershell
cd d:/code/openclaw
$env:NOTIFY_TEST_NO_PROMPT = 'true'
$env:NOTIFY_TEST_MESSAGE   = '<concise punchy summary of what you just did>'
npm run test:notify
```

(Execute the `npm` line in background mode in the IDE, or use `Start-Process` with `-WorkingDirectory` and the same env if you need a detached process.)

### Unix-style shell

```bash
cd d:/code/openclaw && NOTIFY_TEST_NO_PROMPT=true NOTIFY_TEST_MESSAGE='<concise punchy summary>' npm run test:notify
```

Run that compound command in a **background** terminal.

## After starting it

1. In your reply, briefly say you **started** the notification test in the background (not that it already passed).
2. Note that the user should see the notification if the gateway and deps are up, and can check the background terminal for `POST ... → HTTP` output if something looks wrong.
3. If the user reports a failure or shares logs, fix and start another async run the same way.

## What it does

`npm run test:notify` runs `node scripts/test-task-complete-notify.mjs` (see root `package.json`). It:
1. POSTs to `/internal/last-result` on the skill-gateway → triggers the Alexa notification
2. Hits `/voice/tts` on pc-agent → smoke-tests Edge TTS and plays the audio back on Windows

## Voice (friday-speak.py)

When a task completes, the skill-gateway calls `skill-gateway/scripts/friday-speak.py` via `fridaySpeak.js`. This uses **edge-tts** (free, neural) through your Echo Dot (or default audio device).

- Voice is controlled by `FRIDAY_TTS_VOICE` in `.env` — default `en-US-EmmaMultilingualNeural`. **`FRIDAY_TTS_VOICE_BLOCK`** lists Edge voice ids that must never play; see repo root **`CLAUDE.md`** for assistant policy.
- Device is controlled by `FRIDAY_TTS_DEVICE` — default `Echo Dot`
- To test manually: `python skill-gateway/scripts/friday-speak.py "Task complete, sir."` (uses sticky session + `.env`; override with `$env:FRIDAY_TTS_VOICE="en-US-EmmaMultilingualNeural"` if needed)
- To disable: set `FRIDAY_SPEAK_PY=false` in `.env` (falls back to Windows TTS)

Other good voices: `en-US-AriaNeural`, `en-US-GuyNeural`, `en-GB-SoniaNeural`, `en-IN-NeerjaExpressiveNeural`
