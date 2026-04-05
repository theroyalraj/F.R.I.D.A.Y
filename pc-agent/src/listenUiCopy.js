/**
 * Style-tagged copy for Listen UI + celebration TTS — single server source of truth.
 * Consumed by GET /voice/speak-style (listenUi) and celebration.js (ask + focus digest openers).
 */
import { normalizeSpeakStyle } from './speakStyle.js';

/** Launch overlay line (full-screen first paint). */
function launchLine(style) {
  const s = normalizeSpeakStyle(style);
  if (s.snarky) return '⚡ Friday online — try not to look impressed.';
  if (s.funny) return '⚡ FRIDAY AWAKENING... Cue the orchestra.';
  if (s.bored) return '⚡ Friday loaded. Whatever.';
  if (s.dry) return '⚡ Friday ready.';
  if (s.warm) return '⚡ Welcome back — Friday is here with you.';
  return '⚡ FRIDAY AWAKENING...';
}

/** Speak-confirm modal lead (before “text to speak” preview). Order matches SpeakStylePanel priority. */
function speakConfirmIntro(style) {
  const s = normalizeSpeakStyle(style);
  if (s.bored) return "Ugh, fine, I guess I'll speak... You sure about this? ";
  if (s.snarky) return "Oh, you want ME to speak? How delightful. Proceed? ";
  if (s.dry) return "Speaking now. Confirm if you're ready for this. ";
  if (s.funny) return "Comedy hour incoming. You ready to hear this masterpiece? ";
  if (s.warm) return "Let me share this with you. Sound good? ";
  return 'About to make some noise... ';
}

/**
 * @param {Record<string, unknown>} style
 * @returns {{ launchLine: string, speakConfirmIntro: string }}
 */
export function getListenUiCopy(style) {
  return {
    launchLine: launchLine(style),
    speakConfirmIntro: speakConfirmIntro(style),
  };
}

/**
 * @param {string} song
 * @param {Record<string, unknown>} style
 */
export function buildCelebrationAskText(song, style) {
  const s = normalizeSpeakStyle(style);
  if (s.snarky) {
    return `Right, we're done here. Choose Focus recap for the grown-up status line, or tap Play after this if you want a short clip. Music does not start until you hit Play — the sting would be ${song}. Your call.`;
  }
  if (s.funny) {
    return `Aaand scene. Want a gloriously over the top micro-blast of ${song}? Smash Play — or choose Focus recap if you're pretending spreadsheets are exciting.`;
  }
  if (s.bored) {
    return `Finished. If you care, ${song} is an option — Play — otherwise Focus recap and I'll monotone your status strip.`;
  }
  if (s.dry) {
    return `Done. Optional stinger: ${song}. Play — or Focus recap for a short status line, no guitar.`;
  }
  if (s.warm) {
    return `All sorted. If you'd like a little lift, I can play a snippet of ${song} — tap Play — or Focus recap and I'll give you a soft line on where everyone's voices are.`;
  }
  return `Task complete. Fancy a short burst of ${song}? Tap Play on screen, or Focus recap for a quick channel roundup instead.`;
}

/**
 * Opening sentence for focus-mode digest TTS (before channel list).
 * @param {Record<string, unknown>} style
 */
export function getFocusDigestOpener(style) {
  const s = normalizeSpeakStyle(style);
  if (s.snarky) return "Fine — you're in laser focus, not stadium mode. Skipping the fanfare.";
  if (s.funny) return "Ha — focus recap, bold choice. I'll keep the band on the bench.";
  if (s.bored) return "Sure, no song. Here's the tiny dashboard tick-list.";
  if (s.dry) return 'Skipping music. Status only.';
  if (s.warm) return "Alright, I'll keep things calm — here's a quick catch-up for you.";
  return "Okay — focus recap. I'll skip the victory lap.";
}
