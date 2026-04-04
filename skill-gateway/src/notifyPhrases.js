/**
 * Friday notification phrase pools — one pool per notify type.
 *
 * Rules:
 *  - Max 90 chars each (leaves room for ": <detail>" suffix, total creator ≤ 100).
 *  - Pure printable ASCII (Alexa drops non-ASCII silently).
 *  - Written to sound natural after "You have a message from …"
 *
 * De-duplication per userId uses the same rolling-history trick as launch greetings.
 */

import { pickFridayGreetingIndex } from './memory.js';
import { fridayUserDisplayName } from './fridayUserProfile.js';

export const PHRASES = {
  task_done: [
    'Friday — nailed it, Raj',
    'Friday — done and dusted, boss',
    'Friday — consider it handled',
    'Friday — that one is wrapped up',
    'Friday — mission accomplished',
    'Friday — your wish was my command',
    'Friday — knocked it out cold',
    'Friday — all done on my end',
    'Friday — clean finish, Raj',
    'Friday — finished — what is next?',
    'Friday — smooth run, all clear',
    'Friday — one less thing on your plate',
    'Friday — handled — check last result',
    'Friday — Raj, that is a wrap',
    'Friday — done — sharper than before',
    'Friday — task closed, standing by',
    'Friday — executed to spec, boss',
    'Friday — good to go on my side',
    'Friday — locked, loaded, delivered',
    'Friday — that is off the list',
    'Friday — complete — your move, Raj',
    'Friday — done — no loose ends',
    'Friday — squeaky clean finish',
    'Friday — Raj, your task just landed',
    'Friday — finished ahead of schedule',
    'Friday — task done — I outdid myself',
    'Friday — ready for your review, boss',
    'Friday — delivered — over to you, Raj',
    'Friday — on point and wrapped up',
    'Friday — another one bites the dust',
  ],

  waiting: [
    'Friday — Raj, I need a word',
    'Friday — your call, boss',
    'Friday — waiting on you here',
    'Friday — I am stuck — need your input',
    'Friday — ball is in your court, Raj',
    'Friday — I paused — your move',
    'Friday — one question for you, boss',
    'Friday — need a decision from you',
    'Friday — halted — awaiting your call',
    'Friday — quick check-in needed',
    'Friday — Raj, I hit a fork in the road',
    'Friday — need your green light to go',
    'Friday — cannot proceed without you',
    'Friday — a moment of your time, boss',
    'Friday — Raj, I have a question',
    'Friday — holding position — your call',
    'Friday — standing by for your answer',
    'Friday — need you in the loop, Raj',
    'Friday — input required, boss',
    'Friday — I hit a decision point',
  ],

  alert: [
    'Friday — heads up, Raj',
    'Friday — something needs your eye',
    'Friday — caught something odd, boss',
    'Friday — Raj, you should know this',
    'Friday — flagging an issue for you',
    'Friday — something went sideways',
    'Friday — alert — take a look',
    'Friday — Raj, we have a situation',
    'Friday — did not go as planned',
    'Friday — ran into trouble, boss',
    'Friday — error caught — your review',
    'Friday — system flag for you, Raj',
    'Friday — bumped into a wall here',
    'Friday — worth your attention, boss',
    'Friday — Raj, look at this when you can',
    'Friday — something needs fixing',
    'Friday — not ideal — check last result',
    'Friday — raised a red flag for you',
    'Friday — Raj, small fire to handle',
    'Friday — your expertise needed here',
  ],

  reminder: [
    'Friday — Raj, just a nudge',
    'Friday — gentle reminder, boss',
    'Friday — do not forget this one',
    'Friday — keeping you on track, Raj',
    'Friday — your reminder is here',
    'Friday — tapping your shoulder, boss',
    'Friday — Raj, you asked me to remind you',
    'Friday — this one is waiting on you',
    'Friday — hey boss, check your list',
    'Friday — scheduled reminder, Raj',
    'Friday — did not want you to miss this',
    'Friday — flagging something you planned',
    'Friday — Raj, future-you left a note',
    'Friday — reminder delivered, boss',
    'Friday — on your agenda — check in',
    'Friday — keeping your day on track',
    'Friday — Raj, heads up on this',
    'Friday — time-sensitive, boss',
    'Friday — the clock is ticking, Raj',
    'Friday — your past-self sent a reminder',
  ],

  result: [
    'Friday — your result just landed, Raj',
    'Friday — ready for your eyes, boss',
    'Friday — output is fresh and waiting',
    'Friday — Raj, come see what I got',
    'Friday — results are in, boss',
    'Friday — took a look — here is the verdict',
    'Friday — ran the numbers — check it out',
    'Friday — Raj, the output is ready',
    'Friday — computed — awaiting your eyes',
    'Friday — result is live, boss',
    'Friday — finished the run — take a look',
    'Friday — analysis complete, Raj',
    'Friday — here are the goods, boss',
    'Friday — done computing — your call now',
    'Friday — Raj, I have findings for you',
    'Friday — output ready — interesting stuff',
    'Friday — all crunched — see last result',
    'Friday — verdict is in, boss',
    'Friday — processed — over to you, Raj',
    'Friday — check last result when ready',
  ],

  build: [
    'Friday — build finished, Raj',
    'Friday — pipeline is done, boss',
    'Friday — deploy landed — check logs',
    'Friday — Raj, CI just wrapped',
    'Friday — build complete — your review',
    'Friday — it compiled, boss',
    'Friday — ship cleared the runway',
    'Friday — Raj, the build is waiting',
    'Friday — pipeline wrapped — take a look',
    'Friday — artifacts are ready, boss',
    'Friday — deployed — check the health',
    'Friday — build wrapped — green or red?',
    'Friday — Raj, build report is in',
    'Friday — finished the pipeline run',
    'Friday — release candidate ready, boss',
    'Friday — Raj, I just pushed a build',
    'Friday — CI done — you should verify',
    'Friday — build landed — inspect it',
    'Friday — deploy complete, boss',
    'Friday — compiled and shipped, Raj',
  ],

  message: [
    'Friday — got something for you, Raj',
    'Friday — check in when you can, boss',
    'Friday — Raj, a quick word',
    'Friday — message waiting, boss',
    'Friday — I have something to tell you',
    'Friday — your Friday has an update',
    'Friday — Raj, a note from your system',
    'Friday — your assistant checked in',
    'Friday — brief for you, boss',
    'Friday — all eyes on me for a sec, Raj',
    'Friday — update incoming, boss',
    'Friday — note from base camp, Raj',
    'Friday — your system flagged something',
    'Friday — I have a message for you, boss',
    'Friday — catching you up, Raj',
    'Friday — Friday to Raj — come in',
    'Friday — update from the field, boss',
    'Friday — I have intel for you, Raj',
    'Friday — checking in on your behalf',
    'Friday — boss, a quick update',
  ],
};

/**
 * Pick a notification phrase for the given type with per-user de-duplication.
 * If `aiSummary` is provided it is appended after the base phrase (truncated to fit 100 chars).
 *
 * @param {string} userId
 * @param {string} type   One of the PHRASES keys (defaults to 'message')
 * @param {string} [aiSummary]  Optional short AI-generated summary to append
 * @returns {string}  ≤ 100 ASCII chars — ready for Alexa MessageAlert creator name
 */
export function pickNotifyPhrase(userId, type, aiSummary) {
  const pool = PHRASES[type] || PHRASES.message;
  const ix   = pickFridayGreetingIndex(`notify:${type}:${userId}`, pool.length);
  const name = fridayUserDisplayName();
  const base = pool[ix].replace(/\bRaj\b/g, name);

  if (!aiSummary) return base;

  const snippet = String(aiSummary)
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!snippet) return base;

  const joined = `${base}: ${snippet}`;
  // Alexa truncates silently — cap at 100 chars to keep it clean
  return joined.length <= 100 ? joined : `${joined.slice(0, 99)}\u2026`;
}
