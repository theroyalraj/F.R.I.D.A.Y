/**
 * Direct Anthropic API call — bypasses the Claude CLI entirely.
 *
 * Used for voice/mic-daemon commands where CLI startup latency (2-5s) is
 * unacceptable. fetch() is available in Node ≥ 18 with no extra deps.
 *
 * Model mapping (matches claudeRouter.js inference):
 *   'haiku'  → claude-haiku-4-5   (fast, conversational)
 *   'sonnet' → claude-sonnet-4-5  (complex / coding tasks)
 *
 * Env vars:
 *   ANTHROPIC_API_KEY  — required
 *   CLAUDE_API_HAIKU   — override haiku model name
 *   CLAUDE_API_SONNET  — override sonnet model name
 */

const HAIKU_MODEL  = process.env.CLAUDE_API_HAIKU  || 'claude-haiku-4-5';
const SONNET_MODEL = process.env.CLAUDE_API_SONNET || 'claude-sonnet-4-5';

const VOICE_SYSTEM = [
  'You are Friday — a sharp, warm personal tech assistant. You know this PC inside out.',
  'This reply will be spoken aloud by a TTS voice. Respond like a smart friend on a voice call:',
  '1-3 short sentences, plain English, no markdown, no bullet points, no code blocks.',
  "Sound natural: use contractions, be direct. No stiff openers like 'Certainly!' or 'Of course!'.",
  'If the answer involves code or a list, summarise it in words.',
].join(' ');

export function apiModelName(shortName) {
  const s = String(shortName || '').toLowerCase().trim();
  if (s === 'sonnet') return SONNET_MODEL;
  return HAIKU_MODEL;   // default to haiku for speed
}

export function isApiKeyAvailable() {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

/**
 * Call the Anthropic Messages API directly.
 * @param {string} prompt
 * @param {{ model?: string, timeoutMs?: number, log?: import('pino').Logger }} opts
 * @returns {Promise<{ ok: boolean, text: string, model: string, ms: number }>}
 */
export async function callClaudeApi(prompt, opts = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const model     = apiModelName(opts.model);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const t0        = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type':         'application/json',
        'x-api-key':            apiKey,
        'anthropic-version':    '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 256,
        system: VOICE_SYSTEM,
        messages: [{ role: 'user', content: String(prompt) }],
      }),
    });

    const ms = Date.now() - t0;

    if (!resp.ok) {
      const err = await resp.text().catch(() => resp.status);
      throw new Error(`Anthropic API ${resp.status}: ${String(err).slice(0, 200)}`);
    }

    const data = await resp.json();
    const text = data?.content?.[0]?.text?.trim() || '';
    opts.log?.info({ model, ms, chars: text.length }, 'claudeApi: ok');
    return { ok: true, text, model, ms };
  } finally {
    clearTimeout(timer);
  }
}
