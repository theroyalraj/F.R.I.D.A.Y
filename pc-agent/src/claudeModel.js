/**
 * Optional JSON body field `claudeModel` (Friday voice UI). Invalid values are ignored.
 */
const ALIASES = new Set(['haiku', 'sonnet', 'opus', 'inherit', 'openrouter-free', 'auto']);

export function sanitizeClaudeModel(value) {
  if (value == null) return undefined;
  const s = String(value).trim();
  if (!s) return undefined;
  const low = s.toLowerCase();
  if (ALIASES.has(low)) return low;
  if (/^claude-[\w.-]+$/i.test(s) && s.length <= 96) return s;
  if (/^[\w.-]+$/i.test(s) && s.length <= 48) return s;
  return undefined;
}
