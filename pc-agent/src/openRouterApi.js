/**
 * OpenRouter — OpenAI-compatible chat completions for Claude models when Anthropic
 * direct API hits rate limits. https://openrouter.ai/docs
 *
 * Env:
 *   OPENROUTER_API_KEY       — Bearer token (required for fallback)
 *   OPENROUTER_SONNET_MODEL  — default anthropic/claude-sonnet-4
 *   OPENROUTER_OPUS_MODEL    — default anthropic/claude-opus-4
 *   OPENROUTER_HTTP_REFERER  — optional site URL (OpenRouter ranking)
 *   OPENROUTER_APP_NAME      — optional app title header
 *   OPENROUTER_FREE_MODEL    — slug for Listen/UI "OpenRouter free" (default openrouter/free — Free Models Router)
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Normalize key from env (quotes, accidental "Bearer " prefix, whitespace).
 * OpenRouter returns 401 {"message":"User not found."} for unknown/revoked keys.
 */
export function normalizeOpenRouterApiKey(raw, env = process.env) {
  let k = String(raw ?? env.OPENROUTER_API_KEY ?? '').trim();
  if (
    (k.startsWith('"') && k.endsWith('"')) ||
    (k.startsWith("'") && k.endsWith("'"))
  ) {
    k = k.slice(1, -1).trim();
  }
  if (/^bearer\s+/i.test(k)) k = k.replace(/^bearer\s+/i, '').trim();
  return k;
}

const DEFAULT_SONNET = process.env.OPENROUTER_SONNET_MODEL || 'anthropic/claude-sonnet-4';
const DEFAULT_OPUS = process.env.OPENROUTER_OPUS_MODEL || 'anthropic/claude-opus-4';

export const OPENROUTER_SETUP_MESSAGE = [
  'Anthropic hit a rate limit (or overload) and OpenRouter fallback is not configured.',
  '',
  'To enable fallback:',
  '1. Open https://openrouter.ai and sign in.',
  '2. Go to Keys → Create key. Copy the sk-or-v1-… value.',
  '3. In your OpenClaw .env add: OPENROUTER_API_KEY=your_key_here',
  '4. Optional: OPENROUTER_SONNET_MODEL and OPENROUTER_OPUS_MODEL if you want specific OpenRouter slugs.',
  '5. Restart the PC agent so the new env loads.',
  '',
  'Until then, wait for your Anthropic limit to reset or use Cursor slash Claude with a different subscription tier.',
].join('\n');

export function isOpenRouterConfigured(env = process.env) {
  return Boolean(normalizeOpenRouterApiKey(null, env));
}

/** Model slug for direct OpenRouter completions when UI sends claudeModel=openrouter-free */
export function openRouterFreeModel(env = process.env) {
  const v = env.OPENROUTER_FREE_MODEL?.trim();
  if (v) return v;
  return 'openrouter/free';
}

/**
 * @param {'sonnet' | 'opus' | 'haiku'} tier
 */
export function openRouterModelForTier(tier, env = process.env) {
  const t = String(tier || 'sonnet').toLowerCase();
  if (t === 'opus') return env.OPENROUTER_OPUS_MODEL?.trim() || DEFAULT_OPUS;
  if (t === 'haiku') return env.OPENROUTER_HAIKU_MODEL?.trim() || 'anthropic/claude-3-5-haiku';
  return env.OPENROUTER_SONNET_MODEL?.trim() || DEFAULT_SONNET;
}

/**
 * @param {{ prompt: string, system: string, model: string, maxTokens?: number, timeoutMs?: number, log?: import('pino').Logger }} opts
 * @returns {Promise<{ ok: boolean, text: string, model: string, ms: number }>}
 */
export async function callOpenRouterChat(opts) {
  const apiKey = normalizeOpenRouterApiKey();
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');

  const model = opts.model;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxTokens = opts.maxTokens ?? 256;
  const t0 = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(OPENROUTER_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(process.env.OPENROUTER_HTTP_REFERER?.trim()
          ? { 'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER.trim() }
          : {}),
        ...(process.env.OPENROUTER_APP_NAME?.trim()
          ? { 'X-Title': process.env.OPENROUTER_APP_NAME.trim() }
          : { 'X-Title': 'OpenClaw Friday' }),
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: String(opts.system || '') },
          { role: 'user', content: String(opts.prompt || '') },
        ],
      }),
    });

    const ms = Date.now() - t0;
    const raw = await resp.text().catch(() => '');
    if (!resp.ok) {
      const snippet = String(raw).slice(0, 220);
      const hint401 =
        resp.status === 401
          ? ' Invalid or revoked key — open https://openrouter.ai/keys, create a fresh sk-or-v1 key, paste into OPENROUTER_API_KEY in dot env (no quotes), restart pc-agent.'
          : '';
      const hint404 =
        resp.status === 404 && /no endpoints found|not found/i.test(snippet)
          ? ' Model slug retired or wrong — set OPENROUTER_FREE_MODEL=openrouter/free (or pick a model from https://openrouter.ai/models?pricing=free), restart pc-agent.'
          : '';
      throw new Error(`OpenRouter API ${resp.status}: ${snippet}${hint401}${hint404}`);
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`OpenRouter: invalid JSON response`);
    }

    const text = data?.choices?.[0]?.message?.content?.trim() || '';
    opts.log?.info({ model, ms, chars: text.length, via: 'openrouter' }, 'openRouter: ok');
    return { ok: true, text, model, ms };
  } finally {
    clearTimeout(timer);
  }
}
