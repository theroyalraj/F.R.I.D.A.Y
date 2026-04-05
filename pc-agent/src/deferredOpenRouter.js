/**
 * OpenRouter fallback after Anthropic rate limits — runs off the request hot path
 * so the voice stack and event loop get a turn before the outbound call.
 *
 * Results are pushed via SSE: "speak" + "reply" (+ delayed "listening" for UIs with no
 * local TTS). The HTTP ack sets speakAsync false so server speak-async is not fired
 * for the rate-limit status line; the Friday web orb speaks the SSE text locally.
 */

import { callOpenRouterChat, openRouterModelForTier } from './openRouterApi.js';

/** @type {null | ((type: string, data: Record<string, unknown>) => void)} */
let emitSse = null;

/**
 * Called once from server bootstrap with the real SSE broadcaster.
 * @param {(type: string, data: Record<string, unknown>) => void} fn
 */
export function registerDeferredOpenRouterEmitter(fn) {
  emitSse = typeof fn === 'function' ? fn : null;
}

/** Yield one event-loop turn so timers / I/O (voice daemon, Redis) can run. */
export function yieldEventLoopTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Optional metadata for AI cache + Postgres log after deferred completion.
 * @typedef {{ modelKey: string, mode?: string, source?: string, orgId?: string|null, userId?: string|null }} DeferredAiCacheMeta
 */

/**
 * @param {{ prompt: string, system: string, tier: string, timeoutMs: number, log?: import('pino').Logger }} ctx
 * @param {DeferredAiCacheMeta | null | undefined} cacheMeta
 */
export function scheduleOpenRouterFallback(ctx, cacheMeta = undefined) {
  setImmediate(() => {
    void (async () => {
      await yieldEventLoopTurn();
      const model = openRouterModelForTier(ctx.tier);
      const t0 = Date.now();
      try {
        ctx.log?.info({ model, via: 'openrouter', async: true }, 'deferred OpenRouter start');
        const result = await callOpenRouterChat({
          prompt: ctx.prompt,
          system: ctx.system,
          model,
          maxTokens: 256,
          timeoutMs: ctx.timeoutMs,
          log: ctx.log,
        });
        const text = (result.text || '').trim();
        if (text && emitSse) {
          emitSse('speak', { text });
          emitSse('reply', { text });
          setTimeout(() => emitSse('listening', {}), 120);
        } else if (emitSse) {
          emitSse('error', { text: 'OpenRouter returned an empty reply.' });
          setTimeout(() => emitSse('listening', {}), 120);
        }

        if (cacheMeta?.modelKey && text) {
          try {
            const { persistAiGeneration } = await import('./aiTaskCache.js');
            await persistAiGeneration({
              prompt: ctx.prompt,
              system: ctx.system,
              modelKey: cacheMeta.modelKey,
              responseText: text,
              model: result.model || model,
              mode: cacheMeta.mode || 'api',
              provider: 'openrouter',
              source: cacheMeta.source || '',
              latencyMs: Date.now() - t0,
              orgId: cacheMeta.orgId,
              userId: cacheMeta.userId,
              log: ctx.log,
            });
          } catch (e) {
            ctx.log?.warn({ err: String(e?.message || e).slice(0, 200) }, 'deferred OpenRouter: cache persist failed');
          }
        }
      } catch (e) {
        const msg = String(e?.message || e).slice(0, 500);
        ctx.log?.warn({ err: msg }, 'deferred OpenRouter failed');
        if (emitSse) {
          emitSse('error', { text: `OpenRouter failed: ${msg}` });
          setTimeout(() => emitSse('listening', {}), 120);
        }
      }
    })();
  });
}
