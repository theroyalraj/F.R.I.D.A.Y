/**
 * OpenRouter fallback after Anthropic rate limits — runs off the request hot path
 * so the voice stack and event loop get a turn before the outbound call.
 *
 * Results are pushed via SSE (type "reply"). The HTTP ack sets speakAsync false so
 * server speak-async is not fired for the rate-limit status line; UIs show or speak
 * the real answer when they handle the SSE event.
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
 * @param {{ prompt: string, system: string, tier: string, timeoutMs: number, log?: import('pino').Logger }} ctx
 */
export function scheduleOpenRouterFallback(ctx) {
  setImmediate(() => {
    void (async () => {
      await yieldEventLoopTurn();
      const model = openRouterModelForTier(ctx.tier);
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
          emitSse('reply', { text });
        } else if (emitSse) {
          emitSse('error', { text: 'OpenRouter returned an empty reply.' });
        }
      } catch (e) {
        const msg = String(e?.message || e).slice(0, 500);
        ctx.log?.warn({ err: msg }, 'deferred OpenRouter failed');
        if (emitSse) emitSse('error', { text: `OpenRouter failed: ${msg}` });
      }
    })();
  });
}
