import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { parseAnthropicCooldownSeconds, __setAnthropicCooldownActiveForTest } from '../src/anthropicCooldown.js';

afterEach(() => {
  __setAnthropicCooldownActiveForTest(false);
  delete process.env.ANTHROPIC_RATE_LIMIT_COOLDOWN_SEC;
});

test('parseAnthropicCooldownSeconds: Retry-After header', () => {
  const h = new Headers({ 'retry-after': '120' });
  assert.equal(parseAnthropicCooldownSeconds(429, h, '{}'), 120);
});

test('parseAnthropicCooldownSeconds: caps at 3600', () => {
  const h = new Headers({ 'retry-after': '99999' });
  assert.equal(parseAnthropicCooldownSeconds(429, h, '{}'), 3600);
});

test('parseAnthropicCooldownSeconds: JSON retry_after', () => {
  const body = JSON.stringify({ error: { type: 'rate_limit_error', retry_after: 45 } });
  assert.equal(parseAnthropicCooldownSeconds(429, new Headers(), body), 45);
});

test('parseAnthropicCooldownSeconds: default when empty', () => {
  process.env.ANTHROPIC_RATE_LIMIT_COOLDOWN_SEC = '90';
  assert.equal(parseAnthropicCooldownSeconds(429, new Headers(), '{}'), 90);
});
