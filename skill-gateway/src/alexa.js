import crypto from 'node:crypto';
import { rootLogger } from './log.js';
import { pickFridayGreetingIndex } from './memory.js';

/**
 * Send Progressive Response (must complete before final skill response).
 * @see https://developer.amazon.com/en-US/docs/alexa/custom-skills/send-the-user-a-progressive-response.html
 */
export async function sendProgressiveSpeak({ apiEndpoint, apiAccessToken, requestId, ssml }) {
  if (!apiAccessToken || !requestId || !apiEndpoint) return;
  const url = `${apiEndpoint.replace(/\/$/, '')}/v1/directives`;
  const body = {
    header: {
      namespace: 'Speech',
      name: 'Speak',
      payloadVersion: '3',
      messageId: crypto.randomUUID(),
      correlationToken: requestId,
    },
    directive: {
      type: 'VoicePlayer.Speak',
      speech: ssml,
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiAccessToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    rootLogger.warn(
      { status: res.status, detail: t.slice(0, 400), requestId },
      'progressive response failed',
    );
  } else {
    rootLogger.debug({ requestId }, 'progressive response ok');
  }
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Tech / brand tokens: wrap in <lang xml:lang="en-US"> when skill locale is not en-US (bilingual TTS). */
const EN_US_BRAND_TERMS = [
  'Visual Studio Code',
  'JavaScript',
  'TypeScript',
  'Stack Overflow',
  'PostgreSQL',
  'Kubernetes',
  'MongoDB',
  'GraphQL',
  'OpenAI',
  'MacBook',
  'PowerShell',
  'Bluetooth',
  'WhatsApp',
  'Instagram',
  'Facebook',
  'LinkedIn',
  'Dropbox',
  'OneDrive',
  'iCloud',
  'YouTube',
  'Netflix',
  'Spotify',
  'GitHub',
  'Notion',
  'Slack',
  'Zoom',
  'Figma',
  'Docker',
  'Windows',
  'Android',
  'Ubuntu',
  'Firefox',
  'Chrome',
  'Google',
  'Azure',
  'Claude',
  'Wi-Fi',
  'iPhone',
  'iPad',
  'iOS',
  'Linux',
  'Redis',
  'REST API',
  'npm',
  'npx',
  'SQL',
  'API',
  'AWS',
  'GCP',
  'JWT',
  'OAuth',
  'XSS',
  'CSRF',
  'CORS',
].sort((a, b) => b.length - a.length);

function termToPattern(term) {
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (/\s/.test(term)) return esc;
  return `(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`;
}

const LOANWORD_PATTERN_SOURCE = EN_US_BRAND_TERMS.map(termToPattern).join('|');

function localeWantsEnUsLoanwords(locale) {
  const loc = String(locale || 'en-US')
    .toLowerCase()
    .replace(/_/g, '-');
  return !loc.startsWith('en-us');
}

function injectEnUsLoanwords(plain, locale) {
  if (!localeWantsEnUsLoanwords(locale)) {
    return escapeXml(plain);
  }
  const re = new RegExp(LOANWORD_PATTERN_SOURCE, 'gi');
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(plain)) !== null) {
    out += escapeXml(plain.slice(last, m.index));
    out += `<lang xml:lang="en-US">${escapeXml(m[0])}</lang>`;
    last = m.index + m[0].length;
  }
  out += escapeXml(plain.slice(last));
  return out;
}

/**
 * Plain text → SSML; for non–en-US locales, common English product names use en-US pronunciation.
 * @param {string} text
 * @param {string} [locale]
 */
export function buildSsmlSpeak(text, locale = 'en-US') {
  const inner = injectEnUsLoanwords(String(text), locale);
  return `<speak>${inner}</speak>`;
}

export function skillResponse({ ssml, shouldEndSession = true, repromptSsml }) {
  const out = {
    version: '1.0',
    response: {
      outputSpeech: { type: 'SSML', ssml },
      shouldEndSession,
    },
  };
  if (repromptSsml) {
    out.response.reprompt = {
      outputSpeech: { type: 'SSML', ssml: repromptSsml },
    };
  }
  return out;
}

/** SearchQuery / newer envelopes: spoken text may live only in slot.slotValue, not slot.value. */
function slotSpokenText(slot) {
  if (!slot) return '';
  if (slot.value) return String(slot.value).trim();
  if (slot.interpretedValue) return String(slot.interpretedValue).trim();
  const sv = slot.slotValue;
  if (sv?.value) return String(sv.value).trim();
  if (sv?.interpretedValue) return String(sv.interpretedValue).trim();
  if (sv?.type === 'List' && Array.isArray(sv.values) && sv.values.length) {
    const first = sv.values[0];
    if (first?.value) return String(first.value).trim();
  }
  return '';
}

export function extractUserCommand(body) {
  const type = body?.request?.type;
  if (type === 'LaunchRequest') return null;
  if (type === 'IntentRequest') {
    const intent = body.request.intent;
    const name = intent?.name;
    if (
      name === 'AMAZON.StopIntent' ||
      name === 'AMAZON.CancelIntent' ||
      name === 'AMAZON.NavigateHomeIntent'
    ) {
      return { kind: 'stop' };
    }
    if (name === 'AMAZON.HelpIntent') {
      return { kind: 'help' };
    }
    if (name === 'FridayLastResultIntent') {
      return { kind: 'last_result' };
    }
    if (name === 'FridayAckPendingIntent') {
      return { kind: 'ack_pending' };
    }
    const slots = intent?.slots || {};
    const raw =
      slotSpokenText(slots.command) ||
      slotSpokenText(slots.Command) ||
      slotSpokenText(slots.query) ||
      slotSpokenText(slots.Query) ||
      slotSpokenText(slots.phrase);
    if (raw) return { kind: 'command', text: raw };
    if (name === 'AMAZON.FallbackIntent') {
      return { kind: 'command', text: '' };
    }
    return { kind: 'command', text: '' };
  }
  return { kind: 'unknown' };
}

/** Varied Friday-style openers; combined with per-user rotation in nextFridayGreetingSsml. */
export const FRIDAY_GREETINGS = [
  'Hey — what are we tackling on the PC?',
  'Hi there. I am here and ready; what do you need?',
  'Good to see you. Where do you want to start?',
  'Okay, I am listening. Technical stuff, quick tasks, whatever.',
  'What can I help you sort out?',
  'Friday online. Hit me with the messy bit.',
  'Morning, afternoon, or midnight hack — I am in. What is up?',
  'You summoned the nerdy one. What should we break or fix?',
  'PC duty. Apps, files, Claude, chaos — pick your flavor.',
  'I have got bandwidth. What is the mission?',
  'Alright, operator. What are we doing on the machine?',
  'Fresh session. What is the first move?',
  'I am caffeinated and curious. What do you need?',
  'Lay it on me — quick win or deep rabbit hole?',
  'Friday reporting. What is the ticket?',
  'Your bench tech is here. What is broken, boring, or brilliant?',
  'Let us make the PC behave. Where do we start?',
  'No judgment zone. What should I handle?',
  'I am wired in. Command me.',
  'Ready when you are — dumb question or hard problem, both welcome.',
  'What is eating your cycles today?',
  'Skip the small talk if you want — what is the task?',
  'I have seen worse stacks than yours. Probably. What is the ask?',
  'Let us ship something or untangle something. You choose.',
  'PC whisperer mode. What needs whispering?',
  'Friday at your service — sharp, fast, slightly cheeky. What is next?',
  'Got a minute and a goal? Tell me both.',
  'I am the friend who actually likes reading logs. What is up?',
  'We can go surgical or scrappy — what is the vibe?',
  'Your stack, your rules. What are we doing?',
  'I am here for the shortcut and the long fix. Pick one.',
  'What should I poke at on your desktop?',
  'Give me the headline — what do you want done?',
  'I have got tools and opinions. What is the job?',
  'Let us turn intent into clicks. What is the intent?',
  'Friday check-in. What needs doing?',
  'Say the thing you do not want to do manually.',
  'I am listening — bugs, builds, or both?',
  'Your copilot for the boring and the brainy. Which is it?',
  'What is on the plate — fire drill or nice-to-have?',
  'I can nag the PC so you do not have to. What first?',
  'Ready to route power to the right app. What is the target?',
  'Let us keep it moving — what is step one?',
  'I am the easy button with better jokes. What do you need?',
  'Spill the task — I will keep up.',
  'Friday here. Make it weird or make it clean — your call.',
  'What should we automate, open, or explain?',
  'I am tuned for your machine. What is the play?',
];

/**
 * Launch greeting SSML with per-user de-duplication (avoids repeating recent lines).
 * @param {string} userId
 * @param {string} [locale]
 */
export function nextFridayGreetingSsml(userId, locale = 'en-US') {
  const ix = pickFridayGreetingIndex(userId, FRIDAY_GREETINGS.length);
  return buildSsmlSpeak(FRIDAY_GREETINGS[ix], locale);
}

/** @deprecated Prefer nextFridayGreetingSsml(userId, locale) */
export function randomGreetingSsml() {
  return nextFridayGreetingSsml('anonymous', 'en-US');
}

export function randomProgressiveSsml(locale = 'en-US') {
  const lines = [
    'One sec — on it.',
    'Got you; working on that now.',
    'Okay, give me a moment.',
    'Hang tight, I have got this.',
    'On it — back in a blink.',
    'Routing that to the PC now.',
  ];
  return buildSsmlSpeak(lines[Math.floor(Math.random() * lines.length)], locale);
}

export function randomAckText() {
  const lines = [
    'On it. I will ping you when there is something worth hearing — or ask for my last result anytime.',
    'Okay, I am on that. When you are ready, ask for the last result and I will walk you through what I found.',
    'Working on it. Grab me for the last result when you want the full story.',
  ];
  return lines[Math.floor(Math.random() * lines.length)];
}

export function randomStopSsml(locale = 'en-US') {
  const lines = [
    'Okay, talk soon.',
    'Later — I am here when you need me.',
    'All right, bye for now.',
    'Signing off — ping me when you are back.',
  ];
  return buildSsmlSpeak(lines[Math.floor(Math.random() * lines.length)], locale);
}
