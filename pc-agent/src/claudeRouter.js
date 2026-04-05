/**
 * When no explicit claudeModel is sent, pick Sonnet (default), Opus (critical
 * reasoning), or Sonnet (heavy coding) from the prompt.
 * Set CLAUDE_AUTO_MODEL=false to always use CLAUDE_MODEL / CLI default only.
 */

const CRITICAL_THINKING_RE =
  /\b(deep\s+(?:think(?:ing)?|analysis|dive|reasoning)|think\s+(?:deeply|hard|carefully)|step[\s-]by[\s-]step|critical\s+thinking|reason\s+(?:through|carefully)|first\s+principles|root\s+cause|strategic\s+(?:thinking|analysis|plan)|trade[\s-]?offs?|philosoph(?:y|ical)|ethic(?:al)?\s+dilemma|prove\s+(?:formally|that)|formal\s+logic|rigorous(?:ly)?|socratic|epistemolog|counterargument|steel[\s-]?man|devil'?s\s+advocate|worst[\s-]case|cost[\s-]benefit)\b/i;

const COMPLEX_RE =
  /\b(refactor|implement|debug(?:ging)?|stack\s*trace|stacktrace|typescript|javascript|python|java|rust|golang|kotlin|swift|csharp|c\s*#|function\s*\(|class\s+\w+\s*[{(]|\.tsx?\b|\.jsx?\b|\.py\b|\.rs\b|\.go\b|npm\s|yarn\s|pnpm\s|git\s+(commit|rebase|merge|branch|bisect)|docker|kubernetes|k8s|async\s+await|\.then\s*\(|promise\.|REST\s*API|graphql|sql\b|select\s+.+\s+from|pytest|jest|mocha|vitest|unit\s+test|integration\s+test|recursion|algorithm|big-?o\b|memory\s+leak|race\s+condition|deadlock|profil(e|ing)|heap\b|leetcode|binary\s+search|middleware|websocket|oauth|jwt|csrf|xss|sql\s*injection)\b/i;

const CODING_INTENT_RE =
  /\b(write|create|build|add|generate|fix|patch)\s+(a|an|the|my)?\s*(function|class|component|hook|module|script|cli|api|endpoint|migration|test\s+suite|regex|parser|lexer)\b/i;

/**
 * @param {string} text
 * @returns {'haiku' | 'sonnet' | 'opus' | undefined}
 */
export function inferClaudeModelForTask(text) {
  const t = String(text || '').trim();
  if (!t) return undefined;
  if (CRITICAL_THINKING_RE.test(t)) return 'opus';
  if (t.length > 900) return 'sonnet';
  if ((t.match(/\n/g) || []).length >= 4) return 'sonnet';
  if (/```/.test(t)) return 'sonnet';
  if (COMPLEX_RE.test(t)) return 'sonnet';
  if (CODING_INTENT_RE.test(t)) return 'sonnet';
  return 'sonnet';
}

export function isAutoModelEnabled() {
  return String(process.env.CLAUDE_AUTO_MODEL || 'true').toLowerCase() !== 'false';
}
