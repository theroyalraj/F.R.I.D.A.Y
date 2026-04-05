/**
 * OPENCLAW_LEARNING_* toggles for conversation-tracked learning (Postgres).
 */

/** @returns {boolean} */
export function isLearningEnabled() {
  const v = String(process.env.OPENCLAW_LEARNING_ENABLED || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(v);
}

/** Expose generationLogId on task JSON for feedback correlation. */
export function exposeGenerationIdInResponses() {
  return isLearningEnabled();
}

/** Weighted RAG-style injection from past scored generations. */
export function isLearningRetrievalEnabled() {
  if (!isLearningEnabled()) return false;
  const v = String(process.env.OPENCLAW_LEARNING_RETRIEVAL || 'true').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(v);
}

export function learningMaxInjectChars() {
  const n = Number(process.env.OPENCLAW_LEARNING_INJECT_MAX_CHARS);
  return Number.isFinite(n) ? Math.min(8000, Math.max(200, n)) : 1200;
}

export function learningMinSimilarity() {
  const n = Number(process.env.OPENCLAW_LEARNING_MIN_SIMILARITY);
  return Number.isFinite(n) ? Math.min(0.99, Math.max(0.5, n)) : 0.72;
}

export function learningMaxAgeDays() {
  const n = Number(process.env.OPENCLAW_LEARNING_MAX_AGE_DAYS);
  return Number.isFinite(n) ? Math.min(365, Math.max(1, n)) : 30;
}

export function learningNeighbourPool() {
  const n = Number(process.env.OPENCLAW_LEARNING_NEIGHBOUR_POOL);
  return Number.isFinite(n) ? Math.min(80, Math.max(10, n)) : 30;
}

/** @returns {Set<string>} */
export function learningRetrievalSourcesDenied() {
  const raw = (process.env.OPENCLAW_LEARNING_RETRIEVAL_DENY_SOURCES || '').trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function learningFeedbackScoreWeight() {
  const n = Number(process.env.OPENCLAW_LEARNING_SCORE_WEIGHT);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.25;
}
