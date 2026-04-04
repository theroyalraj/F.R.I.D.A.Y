/** In-memory last spoken ack per Alexa user (resets on process restart). */
const lastByUser = new Map();
const MAX_LEN = 400;

/** PC / workflow is waiting for the user to do something (replies on Launch + last result). */
const awaitingByUser = new Map();
const MAX_AWAIT = 500;

export function rememberLastSpoken(userId, text) {
  const u = String(userId || 'anon');
  const t = String(text || '').slice(0, MAX_LEN);
  lastByUser.set(u, t);
}

export function getLastSpoken(userId) {
  return lastByUser.get(String(userId || 'anon')) || '';
}

export function setAwaitingUserReply(userId, { prompt, correlationId } = {}) {
  const u = String(userId || 'anon');
  const p = String(prompt || '').trim().slice(0, MAX_AWAIT);
  if (!p) {
    awaitingByUser.delete(u);
    return;
  }
  awaitingByUser.set(u, {
    prompt: p,
    correlationId: correlationId != null ? String(correlationId).slice(0, 120) : undefined,
    at: new Date().toISOString(),
  });
}

export function getAwaitingUserReply(userId) {
  return awaitingByUser.get(String(userId || 'anon')) || null;
}

export function clearAwaitingUserReply(userId) {
  awaitingByUser.delete(String(userId || 'anon'));
}

/** Rolling Friday launch-greeting indices per Alexa user (in-memory; resets on restart). */
const fridayGreetHistoryByUser = new Map();

/**
 * Pick a greeting index avoiding the last `avoidLast` choices for this user when possible.
 * @param {string} userId
 * @param {number} poolSize
 * @returns {number}
 */
export function pickFridayGreetingIndex(userId, poolSize) {
  const n = Math.max(1, Math.floor(poolSize));
  const u = String(userId || 'anon');
  const hist = fridayGreetHistoryByUser.get(u) || [];
  const avoid = new Set(hist.slice(-12));
  let choices = [];
  for (let i = 0; i < n; i += 1) {
    if (!avoid.has(i)) choices.push(i);
  }
  if (!choices.length) choices = Array.from({ length: n }, (_, i) => i);
  const ix = choices[Math.floor(Math.random() * choices.length)];
  fridayGreetHistoryByUser.set(u, [...hist, ix].slice(-20));
  return ix;
}
