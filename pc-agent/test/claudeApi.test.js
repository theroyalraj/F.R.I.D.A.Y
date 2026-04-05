import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAnthropicRateLimited,
  apiModelName,
} from '../src/claudeApi.js';
import {
  __setAnthropicCooldownActiveForTest,
  clearAnthropicCooldown,
} from '../src/anthropicCooldown.js';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

afterEach(async () => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  __setAnthropicCooldownActiveForTest(false);
  await clearAnthropicCooldown();
});

test('isAnthropicRateLimited: 429', () => {
  assert.equal(isAnthropicRateLimited(429, '{}'), true);
});

test('isAnthropicRateLimited: rate_limit_error JSON', () => {
  assert.equal(
    isAnthropicRateLimited(400, JSON.stringify({ error: { type: 'rate_limit_error' } })),
    true,
  );
});

test('isAnthropicRateLimited: 200 false', () => {
  assert.equal(isAnthropicRateLimited(200, '{}'), false);
});

test('apiModelName maps tiers', () => {
  assert.match(apiModelName('sonnet'), /sonnet/i);
  assert.match(apiModelName('opus'), /opus/i);
  assert.match(apiModelName('haiku'), /haiku/i);
  assert.match(apiModelName(''), /sonnet/i);
});

test('callClaudeApi returns deferred context on 429 when OpenRouter key set', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  process.env.OPENROUTER_API_KEY = 'sk-or-test';

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { type: 'rate_limit_error' } }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    });

  const { callClaudeApi } = await import('../src/claudeApi.js');
  const r = await callClaudeApi('hello', { model: 'sonnet', timeoutMs: 3000 });

  assert.equal(r.deferred, true);
  assert.equal(r.deferredContext.prompt, 'hello');
  assert.equal(r.deferredContext.tier, 'sonnet');
  assert.ok(r.deferredContext.system.includes('Friday'));
});

test('callClaudeApi skips Anthropic fetch when cooldown active (test flag) + defers OpenRouter', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return new Response('{}', { status: 200 });
  };
  __setAnthropicCooldownActiveForTest(true);
  const { callClaudeApi } = await import('../src/claudeApi.js');
  const r = await callClaudeApi('hello', { model: 'sonnet', timeoutMs: 3000 });
  assert.equal(fetchCalls, 0);
  assert.equal(r.deferred, true);
  assert.equal(r.skippedAnthropicCooldown, true);
  assert.equal(r.deferredContext.prompt, 'hello');
});

test('callClaudeApi needsOpenRouterKey on 429 without OpenRouter', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  delete process.env.OPENROUTER_API_KEY;

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { type: 'rate_limit_error' } }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    });

  const { callClaudeApi } = await import('../src/claudeApi.js');
  const r = await callClaudeApi('hello', { timeoutMs: 3000 });

  assert.equal(r.needsOpenRouterKey, true);
  assert.equal(r.text, '');
});
