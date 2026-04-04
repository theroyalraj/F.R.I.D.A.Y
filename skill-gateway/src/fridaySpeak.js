/**
 * friday-speak.py bridge — neural edge-tts voice via Python script.
 *
 * Calls  skill-gateway/scripts/friday-speak.py  fire-and-forget.
 * Uses FRIDAY_TTS_VOICE (edge-tts short-name) and FRIDAY_TTS_DEVICE (audio device substring).
 *
 * Env vars:
 *   FRIDAY_SPEAK_PY=false          — disable entirely (enabled by default when script is present)
 *   FRIDAY_TTS_VOICE               — edge-tts voice (default: en-GB-RyanNeural)
 *   FRIDAY_TTS_DEVICE              — audio device substring (default: Echo Dot)
 *   FRIDAY_TTS_RATE                — speed e.g. "+5%" (default: +0%)
 *   FRIDAY_TTS_PITCH               — pitch e.g. "+0Hz" (default: +0Hz)
 *
 * Good voices:
 *   en-GB-RyanNeural      — British male    ← default (Jarvis / FRIDAY feel)
 *   en-US-AriaNeural      — US female neural
 *   en-US-GuyNeural       — US male neural
 *   en-GB-SoniaNeural     — British female
 *   en-IN-NeerjaExpressiveNeural  — Indian English female
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { alexaMusicConfigured, alexaStopMusic } from './alexaMusic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPEAK_SCRIPT = path.resolve(__dirname, '../scripts/friday-speak.py');

export function fridaySpeakAvailable() {
  return existsSync(SPEAK_SCRIPT);
}

export function fridaySpeakEnabled(env = process.env) {
  if (env.FRIDAY_SPEAK_PY === 'false' || env.FRIDAY_SPEAK_PY === '0') return false;
  return fridaySpeakAvailable();
}

/**
 * Speak text via friday-speak.py — fire-and-forget.
 * @param {string} text
 * @param {import('pino').Logger} [log]
 */
export function speakFridayPy(text, log) {
  if (!fridaySpeakEnabled()) return;

  const safeText = String(text || '').replace(/["`]/g, "'").trim().slice(0, 300);
  if (!safeText) return;

  // Fade out Alexa music before speaking, then wait 600ms for it to stop
  const fadeDelay = alexaMusicConfigured() ? 600 : 0;
  if (alexaMusicConfigured()) {
    alexaStopMusic(log).catch(() => {});
  }

  setTimeout(() => {
  log?.info({ text: safeText.slice(0, 80) }, 'fridaySpeak: spawning');
  const child = spawn('python', [SPEAK_SCRIPT, safeText], {
    env: {
      ...process.env,
      FRIDAY_TTS_VOICE:  process.env.FRIDAY_TTS_VOICE  || 'en-GB-RyanNeural',
      FRIDAY_TTS_RATE:   process.env.FRIDAY_TTS_RATE   || '+0%',
      FRIDAY_TTS_PITCH:  process.env.FRIDAY_TTS_PITCH  || '+0Hz',
    },
    // detached + unref lets the speech outlive a node --watch restart.
    // Pipe stderr so failures are visible in the terminal instead of silently swallowed.
    detached:    true,
    stdio:       ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });

  child.stderr?.on('data', (buf) => {
    const line = buf.toString().trim();
    if (line) log?.warn({ fridaySpeak: line }, 'fridaySpeak stderr');
  });

  child.on('close', (code) => {
    if (code !== 0) log?.warn({ exitCode: code }, 'fridaySpeak: process exited non-zero');
    else log?.info({ text: safeText.slice(0, 60) }, 'fridaySpeak: done');
  });

  child.on('error', (e) => {
    log?.warn({ err: String(e.message) }, 'fridaySpeak: python spawn failed');
  });

  child.unref();
  }, fadeDelay);
}

// ── Phrase pools — conversational, varied, human feel ─────────────────────────

const GATEWAY_STARTUP = [
  // casual / warm
  "Back online, sir. Missed you.",
  "Right, I'm up. What are we getting into today?",
  "I'm here. Everything checked out on the way up — we're good.",
  "Morning, sir. Coffee in hand, I hope — we've got work to do.",
  "All good on my end. Whenever you're ready.",
  "Up and running. World still standing, I assume.",
  "Hey — I'm back. Give me something to do.",
  "Online. Full power. Let's not waste it.",
  // slightly wry
  "I've run the checks. Nothing's on fire. You're welcome.",
  "Startup complete. You know, one day I'll come up and something will actually be broken.",
  "I'm here, sir. Try not to be too impressed by how fast that was.",
  "Systems up. All the boring stuff worked. The fun part's on you.",
  // dramatic / Jarvis-ish
  "FRIDAY online. Ready to do something impressive, sir.",
  "All systems nominal. Standing by for whatever chaos you've planned.",
  "I've got eyes on everything. Nothing to worry about — yet.",
  "Back in the game, sir. What's the first move?",
  // concise
  "Ready.",
  "I'm up.",
  "Online. Talk to me.",
  "Here, sir. Go ahead.",
];

const PC_AGENT_STARTUP = [
  "I can hear you, sir. Go ahead.",
  "Listening. What do you need?",
  "Claude's up and I'm wired in. What are we building?",
  "Right here. Ready when you are.",
  "Voice interface live. I'm all ears.",
  "Yeah, I'm here. What's up?",
  "Tuned in. Hit me.",
  "Connected, sir. Let's get into it.",
];

const TASK_DONE_PHRASES = [
  // short punchy
  "Done, sir.",
  "Finished. What's next?",
  "That's handled.",
  "Sorted.",
  "Got it done.",
  "Wrapped up, sir.",
  // with follow-up hook
  "All done. Anything else on the list?",
  "That's sorted, sir. What are we tackling next?",
  "Done and dusted. You've got more, I know it.",
  "Nailed it. Ready for the next one.",
  "Done. You're welcome, sir.",
  // slightly characterful
  "Consider it handled, sir.",
  "As requested — done.",
  "Easy. What's next?",
  "That one's off the board. Keep them coming.",
  "Finished, sir. I actually enjoyed that one.",
];

const ALEXA_LAUNCH_PHRASES = [
  "I'm here.",
  "Yeah, what do you need?",
  "Right here, sir.",
  "Go ahead.",
  "Listening.",
  "Talk to me.",
  "What's up?",
  "Here — go.",
];

const ALEXA_COMMAND_PHRASES = [
  "On it.",
  "Right away.",
  "Got it.",
  "Yep.",
  "Working on it.",
  "Copy that.",
  "Already on it, sir.",
  "Leave it with me.",
  "Sure.",
  "Done — well, almost.",
];

/** Pick a random element from an array. */
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Speak a random startup greeting (gateway or pc-agent).
 * @param {'gateway'|'agent'} [which]
 * @param {import('pino').Logger} [log]
 */
export function speakGatewayStartup(log, which = 'gateway') {
  speakFridayPy(pick(which === 'agent' ? PC_AGENT_STARTUP : GATEWAY_STARTUP), log);
}

/**
 * Speak a task-done phrase, optionally with a short summary appended.
 * @param {string} [summary]  Short task summary (first 100 chars used)
 * @param {import('pino').Logger} [log]
 */
export function speakTaskDone(summary, log) {
  const base  = pick(TASK_DONE_PHRASES);
  const extra = summary ? ` ${String(summary).slice(0, 100).trim()}` : '';
  speakFridayPy(base + extra, log);
}

/**
 * Speak a welcome phrase when the Alexa skill is launched (LaunchRequest).
 * @param {import('pino').Logger} [log]
 */
export function speakAlexaLaunch(log) {
  speakFridayPy(pick(ALEXA_LAUNCH_PHRASES), log);
}

/**
 * Speak a quick acknowledgement when a voice command is received.
 * @param {import('pino').Logger} [log]
 */
export function speakAlexaCommand(log) {
  speakFridayPy(pick(ALEXA_COMMAND_PHRASES), log);
}
