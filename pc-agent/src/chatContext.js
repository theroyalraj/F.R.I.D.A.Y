/**
 * Sanitize UI-supplied conversation tail for Claude / OpenRouter.
 * @param {object} body — req.body from /voice/command or /task
 * @param {{ maxMessages?: number }} [opts]
 * @returns {Array<{ role: 'user' | 'assistant', content: string }>}
 */
export function sanitizeConversationTail(body, opts = {}) {
  const envMax = Number(process.env.FRIDAY_CONVERSATION_TAIL_MAX || 14);
  const max = Math.min(24, Math.max(0, Number(opts.maxMessages ?? envMax) || 14));
  const raw = body?.conversationTail;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(-max)) {
    const role =
      item?.role === 'assistant' ? 'assistant' : item?.role === 'user' ? 'user' : null;
    let content = typeof item?.content === 'string' ? item.content.trim() : '';
    if (content.length > 4000) content = content.slice(0, 4000);
    if (!role || !content) continue;
    out.push({ role, content });
  }
  return out;
}

/**
 * Single user blob for OpenRouter / CLI (no native multi-turn in older paths).
 * @param {Array<{ role: 'user' | 'assistant', content: string }>} tail
 * @param {string} currentUserMessage
 */
export function flattenConversationForSingleShot(tail, currentUserMessage) {
  const cur = String(currentUserMessage || '').trim();
  if (!tail?.length) return cur;
  const lines = tail.map((t) =>
    t.role === 'user' ? `User: ${t.content}` : `Assistant: ${t.content}`,
  );
  return `Previous conversation (most recent last):\n${lines.join('\n')}\n\nUser: ${cur}`;
}
