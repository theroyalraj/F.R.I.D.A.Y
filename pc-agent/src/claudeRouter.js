/**
 * Smart model routing — classifies prompts into three tiers when model is "auto":
 *   opus           → research, deep reasoning, analysis, strategy
 *   sonnet         → coding, technical, multi-step implementation
 *   openrouter-free → simple chat, greetings, quick factual lookups
 *
 * Set CLAUDE_AUTO_MODEL=false to always use CLAUDE_MODEL / CLI default only.
 */

// ── Tier 1: Research / deep reasoning → Opus ────────────────────────────────
const CRITICAL_THINKING_RE =
  /\b(deep\s+(?:think(?:ing)?|analysis|dive|reasoning)|think\s+(?:deeply|hard|carefully)|step[\s-]by[\s-]step|critical\s+thinking|reason\s+(?:through|carefully)|first\s+principles|root\s+cause|strategic\s+(?:thinking|analysis|plan)|trade[\s-]?offs?|philosoph(?:y|ical)|ethic(?:al)?\s+dilemma|prove\s+(?:formally|that)|formal\s+logic|rigorous(?:ly)?|socratic|epistemolog|counterargument|steel[\s-]?man|devil'?s\s+advocate|worst[\s-]case|cost[\s-]benefit)\b/i;

const RESEARCH_RE =
  /\b(research|investigate|analyse|analyze|comprehensive(?:ly)?|in[\s-]depth|literature\s+review|case\s+study|white\s*paper|compare\s+and\s+contrast|evaluate\s+(?:the|whether|if)|assess(?:ment)?|implications?\s+of|pros?\s+(?:and|&)\s+cons?|advantages?\s+(?:and|&)\s+disadvantages?|long[\s-]term\s+(?:impact|effect|consequence)|academic|scholarly|scientific\s+(?:method|evidence|study)|hypothesis|correlat(?:ion|e)|causation|statistical(?:ly)?|peer[\s-]review|meta[\s-]analysis|synthesis\s+of|critique|deconstruct|dissect|nuanc(?:e|ed)|multifaceted|geopolitical|macroeconomic|societal\s+impact|policy\s+analysis|legal\s+(?:analysis|implications?|framework)|architectural\s+(?:decision|review|comparison)|system\s+design|design\s+document)\b/i;

// ── Tier 2: Coding / technical → Sonnet ─────────────────────────────────────
const COMPLEX_RE =
  /\b(refactor|implement|debug(?:ging)?|stack\s*trace|stacktrace|typescript|javascript|python|java|rust|golang|kotlin|swift|csharp|c\s*#|function\s*\(|class\s+\w+\s*[{(]|\.tsx?\b|\.jsx?\b|\.py\b|\.rs\b|\.go\b|npm\s|yarn\s|pnpm\s|git\s+(commit|rebase|merge|branch|bisect)|docker|kubernetes|k8s|async\s+await|\.then\s*\(|promise\.|REST\s*API|graphql|sql\b|select\s+.+\s+from|pytest|jest|mocha|vitest|unit\s+test|integration\s+test|recursion|algorithm|big-?o\b|memory\s+leak|race\s+condition|deadlock|profil(e|ing)|heap\b|leetcode|binary\s+search|middleware|websocket|oauth|jwt|csrf|xss|sql\s*injection)\b/i;

const CODING_INTENT_RE =
  /\b(write|create|build|add|generate|fix|patch|refactor|migrate|port|convert)\s+(?:(?:a|an|the|my)\s+)?(?:\w+\s+)?(function|class|component|hook|module|script|cli|api|endpoint|migration|test\s+suite|regex|parser|lexer|schema|query|route|controller|service|model|interface|type)\b/i;

const CODE_ARTEFACT_RE =
  /\b(code\s+review|pull\s+request|PR\s+review|design\s+pattern|architecture\s+(?:for|of)|database\s+schema|data\s+model|ERD|UML|sequence\s+diagram|state\s+machine|config(?:uration)?\s+(?:file|for)|deploy(?:ment)?\s+(?:script|pipeline|config)|CI\s*\/?\s*CD|terraform|pulumi|ansible|webpack|vite|rollup|esbuild|tsconfig|eslint|prettier|dockerfile)\b/i;

// ── Classification ──────────────────────────────────────────────────────────

/**
 * @param {string} text
 * @returns {'openrouter-free' | 'sonnet' | 'opus' | undefined}
 */
export function inferClaudeModelForTask(text) {
  const t = String(text || '').trim();
  if (!t) return undefined;

  // Opus: deep reasoning or research
  if (CRITICAL_THINKING_RE.test(t)) return 'opus';
  if (RESEARCH_RE.test(t)) return 'opus';

  // Sonnet: coding, technical, or long/structured prompts
  if (t.length > 900) return 'sonnet';
  if ((t.match(/\n/g) || []).length >= 4) return 'sonnet';
  if (/```/.test(t)) return 'sonnet';
  if (COMPLEX_RE.test(t)) return 'sonnet';
  if (CODING_INTENT_RE.test(t)) return 'sonnet';
  if (CODE_ARTEFACT_RE.test(t)) return 'sonnet';

  // Default: small/simple tasks → OpenRouter free
  return 'openrouter-free';
}

export function isAutoModelEnabled() {
  return String(process.env.CLAUDE_AUTO_MODEL || 'true').toLowerCase() !== 'false';
}
