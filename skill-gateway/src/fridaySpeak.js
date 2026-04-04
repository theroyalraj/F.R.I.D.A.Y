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

// ── Phrase pools — all Jarvis / FRIDAY style, human not technical ─────────────

const GATEWAY_STARTUP = [
  "Good morning, sir. I've run the startup checks — everything looks good.",
  "I'm back online, sir. Missed me?",
  "All systems are running. Ready when you are, sir.",
  "Good to be back, sir. What are we doing today?",
  "I'm up, sir. All good on my end.",
  "Welcome back. I'm fully operational, sir.",
  "Good evening, sir. Shall we get to work?",
  "I've completed the startup sequence, sir. Standing by.",
];

const PC_AGENT_STARTUP = [
  "Voice interface online, sir. I can hear you.",
  "Ready to take your commands, sir.",
  "I'm listening, sir. What do you need?",
  "Claude is armed and ready, sir. Let's get to it.",
  "Good to go, sir. Talk to me.",
  "Everything's up on my end, sir. What shall we build?",
];

const TASK_DONE_PHRASES = [
  "Done, sir.",
  "As you wish, sir. All finished.",
  "Consider it done, sir.",
  "That's sorted, sir. Anything else?",
  "All done. What's next, sir?",
  "Completed, sir. Ready for the next one.",
  "Very well, sir — finished.",
];

const ALEXA_LAUNCH_PHRASES = [
  "I'm here, sir.",
  "Good to hear from you, sir.",
  "Yes, sir. What do you need?",
  "Ready, sir.",
  "Right here, sir. Go ahead.",
];

const ALEXA_COMMAND_PHRASES = [
  "On it, sir.",
  "Right away, sir.",
  "Understood, sir.",
  "Yes sir.",
  "Copy that, sir.",
  "Working on it, sir.",
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
