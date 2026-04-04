/**
 * prepareTextForTts — normalise any text into clean, human-speakable English.
 *
 * Called before every TTS synthesis (Edge, OpenAI, Piper).
 * Strips markdown, code, symbols, URLs and converts technical patterns to
 * words so the synthesiser never reads raw punctuation, variable names or
 * markup out loud.
 */

const SMALL_NUMBERS = [
  'zero','one','two','three','four','five','six','seven','eight','nine','ten',
  'eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen',
  'eighteen','nineteen','twenty',
];

function _numToWords(n) {
  const i = parseInt(n, 10);
  if (!isNaN(i) && i >= 0 && i <= 20) return SMALL_NUMBERS[i];
  return String(n);
}

function _stripRedacted(s) {
  if (!s) return s;
  return s
    .replace(/\*+\s*redacted\s*\*+/gi, ' ')
    .replace(/`\s*redacted\s*`/gi, ' ')
    .replace(/<\s*redacted[^>]*>/gi, ' ')
    .replace(/\[\s*redacted\s*\]/gi, ' ')
    .replace(/\{\s*redacted\s*\}/gi, ' ')
    .replace(/\(\s*redacted\s*\)/gi, ' ')
    .replace(/\bredacted\s*[:;.,!?…]+\s*/gi, ' ')
    .replace(/\bredacted\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function prepareTextForTts(raw) {
  if (!raw || typeof raw !== 'string') return 'Done.';
  let t = _stripRedacted(raw);

  // ── Code blocks / inline code ─────────────────────────────────────────────
  t = t.replace(/```[\s\S]*?```/g, ' ');
  t = t.replace(/`[^`]+`/g, ' ');

  // ── Markdown headings ──────────────────────────────────────────────────────
  t = t.replace(/^#{1,6}\s+/gm, '');

  // ── Markdown bold / italic ─────────────────────────────────────────────────
  t = t.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1');
  t = t.replace(/_{1,2}([^_]+)_{1,2}/g, '$1');

  // ── Markdown links  [label](url) → label ──────────────────────────────────
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // ── Bare URLs → silent drop ────────────────────────────────────────────────
  t = t.replace(/https?:\/\/\S+/g, '');

  // ── Bullet / list leaders ─────────────────────────────────────────────────
  t = t.replace(/^[ \t]*[-*•◦▸▶]+[ \t]+/gm, '');
  // Numbered lists: "1. " "2) "
  t = t.replace(/^\s*\d+[.)]\s+/gm, '');

  // ── Markdown horizontal rules ─────────────────────────────────────────────
  t = t.replace(/^[-*_]{3,}\s*$/gm, '');

  // ── HTML entities ─────────────────────────────────────────────────────────
  t = t.replace(/&amp;/gi,  ' and ')
       .replace(/&lt;/gi,   ' less than ')
       .replace(/&gt;/gi,   ' greater than ')
       .replace(/&rarr;/gi, ' to ')
       .replace(/&larr;/gi, ' from ')
       .replace(/&nbsp;/gi, ' ')
       .replace(/&#\d+;/g,  ' ');

  // ── Emoji strip (Unicode ranges) ──────────────────────────────────────────
  t = t.replace(/[\u{1F000}-\u{1FFFF}]/gu, ' ');
  t = t.replace(/[\u{2600}-\u{27BF}]/gu, ' ');

  // ── Technical patterns → spoken form ──────────────────────────────────────
  // KEY=VALUE env vars  e.g.  FRIDAY_TTS_DEVICE=Echo Dot
  t = t.replace(/\b([A-Z][A-Z0-9_]{2,})=([^\s,]+)/g, (_m, k, v) => {
    const key = k.toLowerCase().replace(/_/g, ' ');
    return `${key} set to ${v}`;
  });
  // Camel/snake/kebab identifiers inside sentences  e.g. friday-speak.py, ttsPrep
  t = t.replace(/\b([a-z][a-zA-Z0-9]*[-_][a-zA-Z0-9._-]+)\b/g, (m) =>
    m.replace(/[-_.]/g, ' '),
  );
  // ALL_CAPS identifiers  e.g. POST_TTS_GAP → post tts gap
  t = t.replace(/\b([A-Z]{2,}[_][A-Z0-9_]+)\b/g, (m) =>
    m.toLowerCase().replace(/_/g, ' '),
  );
  // Slash-separated paths  /voice/set-voice → voice set voice
  t = t.replace(/\/([a-z][-a-z0-9/]*)/g, (_m, p) =>
    ' ' + p.replace(/\//g, ' ').replace(/-/g, ' '),
  );

  // ── Units & symbols → words ───────────────────────────────────────────────
  // Percentages  100% → 100 percent
  t = t.replace(/(\d+(?:\.\d+)?)\s*%/g, (_m, n) => `${n} percent`);
  // Milliseconds  500ms  →  500 milliseconds
  t = t.replace(/(\d+(?:\.\d+)?)\s*ms\b/gi, (_m, n) => `${n} milliseconds`);
  // Seconds  12s / 12.0s  →  12 seconds
  t = t.replace(/(\d+(?:\.\d+)?)\s*s\b/g, (_m, n) => `${_numToWords(n)} seconds`);
  // kilobytes / megabytes
  t = t.replace(/(\d+(?:\.\d+)?)\s*kb\b/gi, (_m, n) => `${n} kilobytes`);
  t = t.replace(/(\d+(?:\.\d+)?)\s*mb\b/gi, (_m, n) => `${n} megabytes`);
  // Temperatures  25°C / 98°F
  t = t.replace(/(\d+(?:\.\d+)?)\s*°\s*([CF])/g, (_m, n, u) =>
    `${n} degrees ${u === 'C' ? 'celsius' : 'fahrenheit'}`,
  );
  // Currency approximations  $100 → 100 dollars
  t = t.replace(/\$(\d[\d,]*)/g, (_m, n) => `${n.replace(/,/g, '')} dollars`);

  // ── Punctuation / symbols → spoken form ───────────────────────────────────
  // Em dash / en dash → natural pause comma
  t = t.replace(/\s*[—–]\s*/g, ', ');
  // Pipe  |  →  or
  t = t.replace(/\s\|\s/g, ', ');
  // Greater-than / less-than in isolation  → drop
  t = t.replace(/\s[><]\s/g, ' ');
  // Arrow  ->  or  =>  → " to "
  t = t.replace(/\s*[-=]>\s*/g, ' to ');
  // Slash in inline context  a/b  →  a or b
  t = t.replace(/(\w)\/(\w)/g, '$1 or $2');
  // Ellipsis → pause (keep as comma for flow)
  t = t.replace(/\.{3}|…/g, ', ');
  // Double newlines → sentence break
  t = t.replace(/\n{2,}/g, '. ');
  // Single newlines → space
  t = t.replace(/\n/g, ' ');

  // ── Collapse whitespace ───────────────────────────────────────────────────
  t = t.replace(/\s{2,}/g, ' ').trim();

  // ── Length cap (OpenAI 4096 / Edge practical ~3800) ───────────────────────
  if (t.length > 3800) t = t.slice(0, 3800) + '.';

  t = _stripRedacted(t);
  return t || 'Done.';
}
