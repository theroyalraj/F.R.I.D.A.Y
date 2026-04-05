import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

function waitFor(cond, ms = 2000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (cond()) return resolve();
        if (Date.now() - t0 > ms) return reject(new Error('timeout waiting for condition'));
        setImmediate(tick);
      } catch (e) {
        reject(e);
      }
    };
    tick();
  });
}

test('scheduleOpenRouterFallback yields then POSTs OpenRouter and emits reply', async () => {
  process.env.OPENROUTER_API_KEY = 'sk-or-test';

  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /openrouter\.ai/);
    assert.equal(init.method, 'POST');
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '  deferred answer  ' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  const { registerDeferredOpenRouterEmitter, scheduleOpenRouterFallback } = await import(
    '../src/deferredOpenRouter.js'
  );

  const events = [];
  registerDeferredOpenRouterEmitter((type, data) => {
    events.push({ type, ...data });
  });

  scheduleOpenRouterFallback({
    prompt: 'user text',
    system: 'system block',
    tier: 'sonnet',
    timeoutMs: 8000,
    log: null,
  });

  await waitFor(() => events.length > 0);
  assert.equal(events[0].type, 'reply');
  assert.equal(events[0].text, 'deferred answer');
});

test('scheduleOpenRouterFallback emits error when OpenRouter fails', async () => {
  process.env.OPENROUTER_API_KEY = 'sk-or-test';

  globalThis.fetch = async () =>
    new Response('nope', { status: 502, statusText: 'Bad Gateway' });

  const { registerDeferredOpenRouterEmitter, scheduleOpenRouterFallback } = await import(
    '../src/deferredOpenRouter.js'
  );

  const events = [];
  registerDeferredOpenRouterEmitter((type, data) => {
    events.push({ type, ...data });
  });

  scheduleOpenRouterFallback({
    prompt: 'x',
    system: 'y',
    tier: 'opus',
    timeoutMs: 5000,
    log: null,
  });

  await waitFor(() => events.length > 0);
  assert.equal(events[0].type, 'error');
  assert.match(events[0].text, /OpenRouter failed/i);
});
