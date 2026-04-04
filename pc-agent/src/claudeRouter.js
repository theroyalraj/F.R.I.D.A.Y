/**
 * When no explicit claudeModel is sent, pick Haiku vs Sonnet from the prompt.
 * Set CLAUDE_AUTO_MODEL=false to always use CLAUDE_MODEL / CLI default only.
 */

const COMPLEX_RE =
  /\b(refactor|implement|debug(?:ging)?|stack\s*trace|stacktrace|typescript|javascript|python|java|rust|golang|kotlin|swift|csharp|c\s*#|function\s*\(|class\s+\w+\s*[{(]|\.tsx?\b|\.jsx?\b|\.py\b|\.rs\b|\.go\b|npm\s|yarn\s|pnpm\s|git\s+(commit|rebase|merge|branch|bisect)|docker|kubernetes|k8s|async\s+await|\.then\s*\(|promise\.|REST\s*API|graphql|sql\b|select\s+.+\s+from|pytest|jest|mocha|vitest|unit\s+test|integration\s+test|recursion|algorithm|big-?o\b|memory\s+leak|race\s+condition|deadlock|profil(e|ing)|heap\b|leetcode|binary\s+search|middleware|websocket|oauth|jwt|csrf|xss|sql\s*injection)\b/i;

const CODING_INTENT_RE =
  /\b(write|create|build|add|generate|fix|patch)\s+(a|an|the|my)?\s*(function|class|component|hook|module|script|cli|api|endpoint|migration|test\s+suite|regex|parser|lexer)\b/i;

/**
 * @param {string} text
 * @returns {'haiku' | 'sonnet' | undefined}
 */
export function inferClaudeModelForTask(text) {
  const t = String(text || '').trim();
  if (!t) return undefined;
  if (t.length > 900) return 'sonnet';
  if ((t.match(/\n/g) || []).length >= 4) return 'sonnet';
  if (/```/.test(t)) return 'sonnet';
  if (COMPLEX_RE.test(t)) return 'sonnet';
  if (CODING_INTENT_RE.test(t)) return 'sonnet';
  return 'haiku';
}

export function isAutoModelEnabled() {
  return String(process.env.CLAUDE_AUTO_MODEL || 'true').toLowerCase() !== 'false';
}
