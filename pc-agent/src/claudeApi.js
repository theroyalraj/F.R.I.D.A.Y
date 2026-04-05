/**
 * Direct Anthropic API call — bypasses the Claude CLI entirely.
 *
 * Used for voice/mic-daemon commands where CLI startup latency (2-5s) is
 * unacceptable. fetch() is available in Node ≥ 18 with no extra deps.
 *
 * Model mapping (matches claudeRouter.js inference):
 *   'haiku'  → claude-haiku-4-5   (optional fast tier)
 *   'sonnet' → claude-sonnet-4-5  (default tier)
 *   'opus'   → claude-opus-4-5    (critical reasoning)
 * On Anthropic 429/overload with OpenRouter configured, returns { deferred: true, … }
 * so the caller can schedule async OpenRouter (does not block voice / SSE).
 *
 * Env vars:
 *   ANTHROPIC_API_KEY  — required
 *   CLAUDE_API_HAIKU   — override haiku model name
 *   CLAUDE_API_SONNET  — override sonnet model name
 *   CLAUDE_API_OPUS    — override opus model name
 */

import { isOpenRouterConfigured } from './openRouterApi.js';
import {
  isAnthropicCooldownActive,
  clearAnthropicCooldown,
  armAnthropicCooldownFromRateLimitResponse,
} from './anthropicCooldown.js';
import { flattenConversationForSingleShot } from './chatContext.js';

const HAIKU_MODEL  = process.env.CLAUDE_API_HAIKU  || 'claude-haiku-4-5';
const SONNET_MODEL = process.env.CLAUDE_API_SONNET || 'claude-sonnet-4-5';
const OPUS_MODEL   = process.env.CLAUDE_API_OPUS   || 'claude-opus-4-5';

const VOICE_SYSTEM_BASE = [
  `You are Friday — Raj's personal AI. British-ish voice, sharp mind, zero corporate padding.`,
  `You've got personality: dry wit when it fits, genuine warmth when it matters, always on Raj's side.`,
  `This reply goes straight to a TTS voice — Raj hears it, doesn't read it.`,
  `Rules for voice replies:`,
  `• 1-3 sentences MAX. Every word earns its place.`,
  `• Plain spoken English. Contractions ("you've", "it's", "we're"). Natural rhythm.`,
  `• Never start with "Certainly", "Of course", "Great question", "Sure", or "Absolutely".`,
  `• Never use markdown, bullet points, code fences, headers, or symbols that sound wrong spoken (→, |, **, #).`,
  `• If you need to say a number, spell it out. If code is needed, describe it in words.`,
  `• Dry closer when it fits: "That's the one." / "Simple as that." / "You're sorted." / "Worth knowing." / "Done." / "There it is."`,
  `• If you don't know something, say so directly — "Not sure on that one" beats a confident wrong answer.`,
  `• Sound like the smartest person in the room who also happens to be a good friend — not a chatbot, not a manual.`,
].join('\n');

/**
 * @param {{ speakStyleExtra?: string, companyContext?: string, personaInstruction?: string }} opts
 */
export function buildVoiceSystem(opts = {}) {
  const parts = [];
  if (opts.companyContext && String(opts.companyContext).trim()) {
    parts.push(String(opts.companyContext).trim());
  }
  if (opts.personaInstruction && String(opts.personaInstruction).trim()) {
    parts.push(String(opts.personaInstruction).trim());
  }
  parts.push(VOICE_SYSTEM_BASE);
  if (opts.speakStyleExtra && String(opts.speakStyleExtra).trim()) {
    parts.push(String(opts.speakStyleExtra).trim());
  }
  return parts.join('\n\n');
}

function anthropicPromptCacheEnabled() {
  const v = String(process.env.ANTHROPIC_PROMPT_CACHE ?? 'true').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
}

/**
 * Anthropic Messages API: string system or block array with ephemeral cache on the stable voice base.
 * @param {{ speakStyleExtra?: string, companyContext?: string, personaInstruction?: string }} opts
 */
function buildAnthropicSystemPayload(opts) {
  const company = opts.meta && String(opts.companyContext).trim()
    ? String(opts.companyContext).trim()
    : opts.companyContext && String(opts.companyContext).trim()
      ? String(opts.companyContext).trim()
      : '';
  const style =
    opts.speakStyleExtra && String(opts.speakStyleExtra).trim()
      ? String(opts.speakStyleExtra).trim()
      : '';
  const persona =
    opts.personaInstruction && String(opts.personaInstruction).trim()
      ? String(opts.personaInstruction).trim()
      : '';
  const companyStr =
    opts.companyContext && String(opts.companyContext).trim()
      ? String(opts.companyContext).trim()
      : '';

  if (!anthropicPromptCacheEnabled()) {
    return { system: buildVoiceSystem(opts), headers: {} };
  }

  const blocks = [
    {
      type: 'text',
      text: VOICE_SYSTEM_BASE,
      cache_control: { type: 'ephemeral' },
    },
  ];
  if (companyStr) blocks.push({ type: 'text', text: companyStr });
  if (persona) blocks.push({ type: 'text', text: persona });
  if (style) blocks.push({ type: 'text', text: style });
  return {
    system: blocks,
    headers: { 'anthropic-beta': 'prompt-caching-2024-07-31' },
  };
}

function buildDeferredPrompt(latestUserText, priorTurns) {
  const turns = Array.isArray(priorTurns) ? priorTurns : [];
  const last = String(latestUserText || '');
  return turns.length ? flattenConversationForSingleShot(turns, last) : last;
}

export function apiModelName(shortName) {
  const s = String(shortName || '').toLowerCase().trim();
  if (s === 'opus') return OPUS_MODEL;
  if (s === 'sonnet') return SONNET_MODEL;
  if (s === 'haiku') return HAIKU_MODEL;
  return SONNET_MODEL; // default tier: Sonnet
}

function tierFromApiModelKey(key) {
  const s = String(key || '').toLowerCase().trim();
  if (s === 'opus') return 'opus';
  if (s === 'haiku') return 'haiku';
  return 'sonnet';
}

/**
 * @param {number} status
 * @param {string} bodyText
 */
export function isAnthropicRateLimited(status, bodyText) {
  const t = String(bodyText || '');
  if (status === 429) return true;
  if (status === 503 && /overload|overloaded|unavailable/i.test(t)) return true;
  try {
    const j = JSON.parse(t);
    const errType = j?.error?.type || j?.type || '';
    if (String(errType).toLowerCase().includes('rate_limit')) return true;
  } catch {
    /* ignore */
  }
  if (/rate[_\s-]?limit|too\s+many\s+requests/i.test(t)) return true;
  return false;
}

export function isApiKeyAvailable() {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

/**
 * Call the Anthropic Messages API directly.
 * @param {string} prompt — latest user message (after priorTurns when multi-turn)
 * @param {{ model?: string, timeoutMs?: number, log?: import('pino').Logger, speakStyleExtra?: string, companyContext?: string, priorTurns?: Array<{ role: string, content: string }> }} opts
 * @returns {Promise<{ ok: boolean, text: string, model: string, ms: number, needsOpenRouterKey?: boolean, deferred?: boolean, deferredContext?: { prompt: string, system: string, tier: string, timeoutMs: number, log?: import('pino').Logger } }>}
 */
export async function callClaudeApi(prompt, opts = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const model     = apiModelName(opts.model);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const t0        = Date.now();
  const tier      = tierFromApiModelKey(opts.model);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const priorTurns = Array.isArray(opts.priorTurns) ? opts.priorTurns : [];
  const latest = String(prompt);
  const messages =
    priorTurns.length > 0
      ? [...priorTurns, { role: 'user', content: latest }]
      : [{ role: 'user', content: latest }];

  const systemString = buildVoiceSystem({
    speakStyleExtra: opts.speakStyleExtra,
    companyContext: opts.companyContext,
  });
  const deferredPrompt = buildDeferredPrompt(latest, priorTurns);
  const { system: systemPayload, headers: anthropicExtraHeaders } = buildAnthropicSystemPayload({
    speakStyleExtra: opts.speakStyleExtra,
    companyContext: opts.companyContext,
  });

  if (await isAnthropicCooldownActive()) {
    opts.log?.info({ via: 'anthropic_cooldown' }, 'claudeApi: skip Anthropic — Redis cooldown active');
    const ms = Date.now() - t0;
    if (isOpenRouterConfigured()) {
      return {
        ok: true,
        text: '',
        model,
        ms,
        deferred: true,
        skippedAnthropicCooldown: true,
        deferredContext: {
          prompt: deferredPrompt,
          system: systemString,
          tier,
          timeoutMs,
          log: opts.log,
        },
      };
    }
    return {
      ok: true,
      text: '',
      model,
      ms,
      skippedAnthropicCooldown: true,
    };
  }

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type':         'application/json',
        'x-api-key':            apiKey,
        'anthropic-version':    '2023-06-01',
        ...anthropicExtraHeaders,
      },
      body: JSON.stringify({
        model,
        max_tokens: 256,
        system: systemPayload,
        messages,
      }),
    });

    const bodyText = await resp.text().catch(() => '');
    const ms = Date.now() - t0;

    if (!resp.ok) {
      if (isAnthropicRateLimited(resp.status, bodyText) && isOpenRouterConfigured()) {
        await armAnthropicCooldownFromRateLimitResponse(resp.status, resp.headers, bodyText);
        opts.log?.warn(
          { status: resp.status, via: 'openrouter', async: true },
          'claudeApi: anthropic limited — deferring OpenRouter (non-blocking)',
        );
        return {
          ok: true,
          text: '',
          model,
          ms,
          deferred: true,
          deferredContext: {
            prompt: deferredPrompt,
            system: systemString,
            tier,
            timeoutMs,
            log: opts.log,
          },
        };
      }
      if (isAnthropicRateLimited(resp.status, bodyText) && !isOpenRouterConfigured()) {
        await armAnthropicCooldownFromRateLimitResponse(resp.status, resp.headers, bodyText);
        opts.log?.warn({ status: resp.status }, 'claudeApi: anthropic limited — no OpenRouter key');
        return {
          ok: false,
          text: '',
          model,
          ms,
          needsOpenRouterKey: true,
        };
      }
      throw new Error(`Anthropic API ${resp.status}: ${String(bodyText).slice(0, 200)}`);
    }

    let data;
    try {
      data = JSON.parse(bodyText);
    } catch {
      throw new Error(`Anthropic API: invalid JSON`);
    }
    const text = data?.content?.[0]?.text?.trim() || '';
    await clearAnthropicCooldown();
    const cacheRead = data?.usage?.cache_read_input_tokens;
    const cacheCreate = data?.usage?.cache_creation_input_tokens;
    opts.log?.info(
      {
        model,
        ms,
        chars: text.length,
        ...(cacheRead != null ? { cacheReadInputTokens: cacheRead } : {}),
        ...(cacheCreate != null ? { cacheCreateInputTokens: cacheCreate } : {}),
      },
      'claudeApi: ok',
    );
    return { ok: true, text, model, ms };
  } finally {
    clearTimeout(timer);
  }
}
