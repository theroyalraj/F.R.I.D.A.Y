/**
 * friday-speak.py bridge — neural edge-tts voice via Python script.
 *
 * Calls  skill-gateway/scripts/friday-speak.py  fire-and-forget.
 * Uses FRIDAY_TTS_VOICE (edge-tts short-name) and FRIDAY_TTS_DEVICE (audio device substring).
 *
 * Env vars:
 *   FRIDAY_SPEAK_PY=false          — disable entirely (enabled by default when script is present)
 *   FRIDAY_TTS_VOICE               — edge-tts voice (default: en-US-EmmaMultilingualNeural)
 *   FRIDAY_TTS_DEVICE              — audio device substring (default: Echo Dot)
 *   FRIDAY_TTS_RATE                — speed e.g. "+7.5%" (default: ~1.075×)
 *   FRIDAY_TTS_PITCH               — pitch e.g. "+2Hz" (default: +2Hz)
 *
 * Good voices (honour FRIDAY_TTS_VOICE_BLOCK in .env — see CLAUDE.md):
 *   en-US-EmmaMultilingualNeural — US female multilingual (repo default)
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
import { fridayUserDisplayName } from './fridayUserProfile.js';

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
 * @param {{ bypassCursorDefer?: boolean, interruptMusic?: boolean, onClose?: () => void }} [opts]  bypassCursorDefer: greetings while Cursor focused; interruptMusic: FRIDAY_TTS_INTERRUPT_MUSIC=ui so friday-speak may duck friday-play; onClose: after friday-speak.py exits (playback finished) or if speak skipped
 */
export function speakFridayPy(text, log, opts = {}) {
  const { onClose, bypassCursorDefer, interruptMusic } = opts;

  if (!fridaySpeakEnabled()) {
    try {
      onClose?.();
    } catch (e) {
      log?.warn({ err: String(e?.message || e) }, 'fridaySpeak: onClose threw');
    }
    return;
  }

  const safeText = String(text || '').replace(/["`]/g, "'").trim().slice(0, 300);
  if (!safeText) {
    try {
      onClose?.();
    } catch (e) {
      log?.warn({ err: String(e?.message || e) }, 'fridaySpeak: onClose threw');
    }
    return;
  }

  // Stop Alexa cloud music before speaking (no fade API for Alexa, just stop)
  if (alexaMusicConfigured()) {
    alexaStopMusic(log).catch(() => {});
  }

  // Local song fade-out is handled inside friday-speak.py via pycaw (PID-targeted)
  log?.info({ text: safeText.slice(0, 80) }, 'fridaySpeak: spawning');
  const child = spawn('python', [SPEAK_SCRIPT, safeText], {
    env: {
      ...process.env,
      FRIDAY_TTS_VOICE:  process.env.FRIDAY_TTS_VOICE  || 'en-US-EmmaMultilingualNeural',
      FRIDAY_TTS_RATE:   process.env.FRIDAY_TTS_RATE   || '+7.5%',
      FRIDAY_TTS_PITCH:  process.env.FRIDAY_TTS_PITCH  || '+2Hz',
      ...(bypassCursorDefer ? { FRIDAY_TTS_BYPASS_CURSOR_DEFER: 'true' } : {}),
      ...(interruptMusic ? { FRIDAY_TTS_INTERRUPT_MUSIC: 'ui' } : {}),
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
    try {
      onClose?.();
    } catch (e) {
      log?.warn({ err: String(e?.message || e) }, 'fridaySpeak: onClose threw');
    }
  });

  child.on('error', (e) => {
    log?.warn({ err: String(e.message) }, 'fridaySpeak: python spawn failed');
    try {
      onClose?.();
    } catch (err) {
      log?.warn({ err: String(err?.message || err) }, 'fridaySpeak: onClose threw');
    }
  });

  child.unref();
}

// ── Phrase pools — use fridayUserDisplayName() at speak time (after dotenv) ───

function gatewayStartupPool() {
  const n = fridayUserDisplayName();
  return [
    `Back online, ${n}. Missed you.`,
    "Right, I'm up. What are we getting into today?",
    "I'm here. Everything checked out on the way up — we're good.",
    `Morning, ${n}. Coffee in hand, I hope — we've got work to do.`,
    "All good on my end. Whenever you're ready.",
    "Up and running. World still standing, I assume.",
    "Hey — I'm back. Give me something to do.",
    "Online. Full power. Let's not waste it.",
    "I've run the checks. Nothing's on fire. You're welcome.",
    "Startup complete. You know, one day I'll come up and something will actually be broken.",
    `I'm here, ${n}. Try not to be too impressed by how fast that was.`,
    "Systems up. All the boring stuff worked. The fun part's on you.",
    `FRIDAY online. Ready to do something impressive, ${n}.`,
    "All systems nominal. Standing by for whatever chaos you've planned.",
    "I've got eyes on everything. Nothing to worry about — yet.",
    `Back in the game, ${n}. What's the first move?`,
    "Ready.",
    "I'm up.",
    "Online. Talk to me.",
    `Here, ${n}. Go ahead.`,
  ];
}

function pcAgentStartupPool() {
  const n = fridayUserDisplayName();
  return [
    `I can hear you, ${n}. Go ahead.`,
    "Listening. What do you need?",
    "Claude's up and I'm wired in. What are we building?",
    "Right here. Ready when you are.",
    "Voice interface live. I'm all ears.",
    "Yeah, I'm here. What's up?",
    "Tuned in. Hit me.",
    `Connected, ${n}. Let's get into it.`,
  ];
}

function taskDonePhrases() {
  const n = fridayUserDisplayName();
  return [
    `Done, ${n}.`,
    "Finished. What's next?",
    "That's handled.",
    "Sorted.",
    "Got it done.",
    `Wrapped up, ${n}.`,
    "All done. Anything else on the list?",
    `That's sorted, ${n}. What are we tackling next?`,
    "Done and dusted. You've got more, I know it.",
    "Nailed it. Ready for the next one.",
    `Done. You're welcome, ${n}.`,
    `Consider it handled, ${n}.`,
    "As requested — done.",
    "Easy. What's next?",
    "That one's off the board. Keep them coming.",
    `Finished, ${n}. I actually enjoyed that one.`,
  ];
}

function alexaLaunchPhrases() {
  const n = fridayUserDisplayName();
  return [
    "I'm here.",
    "Yeah, what do you need?",
    `Right here, ${n}.`,
    "Go ahead.",
    "Listening.",
    "Talk to me.",
    "What's up?",
    "Here — go.",
  ];
}

function alexaCommandPhrases() {
  const n = fridayUserDisplayName();
  return [
    "On it.",
    "Right away.",
    "Got it.",
    "Yep.",
    "Working on it.",
    "Copy that.",
    `Already on it, ${n}.`,
    "Leave it with me.",
    "Sure.",
    "Done — well, almost.",
  ];
}

/** Pick a random element from an array. */
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Speak a random startup greeting (gateway or pc-agent).
 * @param {'gateway'|'agent'} [which]
 * @param {import('pino').Logger} [log]
 * @param {{ onClose?: () => void }} [chainOpts]  e.g. start startup song after welcome TTS exits
 */
export function speakGatewayStartup(log, which = 'gateway', chainOpts = {}) {
  speakFridayPy(pick(which === 'agent' ? pcAgentStartupPool() : gatewayStartupPool()), log, {
    bypassCursorDefer: true,
    onClose: chainOpts.onClose,
  });
}

/**
 * Speak a task-done phrase, optionally with a short summary appended.
 * @param {string} [summary]  Short task summary (first 100 chars used)
 * @param {import('pino').Logger} [log]
 */
export function speakTaskDone(summary, log) {
  const base  = pick(taskDonePhrases());
  const extra = summary ? ` ${String(summary).slice(0, 100).trim()}` : '';
  // Always bypass Cursor/IDE defer — task-complete is the “done” cue; startup already bypasses.
  speakFridayPy(base + extra, log, { bypassCursorDefer: true });
}

/**
 * Speak a welcome phrase when the Alexa skill is launched (LaunchRequest).
 * @param {import('pino').Logger} [log]
 */
export function speakAlexaLaunch(log) {
  speakFridayPy(pick(alexaLaunchPhrases()), log, { bypassCursorDefer: true });
}

/**
 * Speak a quick acknowledgement when a voice command is received.
 * @param {import('pino').Logger} [log]
 */
export function speakAlexaCommand(log) {
  speakFridayPy(pick(alexaCommandPhrases()), log, { bypassCursorDefer: true });
}
