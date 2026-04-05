import test from 'node:test';
import assert from 'node:assert';
import { normalizeOpenRouterApiKey, isOpenRouterConfigured } from '../src/openRouterApi.js';

test('normalizeOpenRouterApiKey trims and strips quotes', () => {
  assert.equal(
    normalizeOpenRouterApiKey('"sk-or-v1-abc"', {}),
    'sk-or-v1-abc',
  );
  assert.equal(
    normalizeOpenRouterApiKey("'sk-or-v1-abc'", {}),
    'sk-or-v1-abc',
  );
});

test('normalizeOpenRouterApiKey strips Bearer prefix', () => {
  assert.equal(
    normalizeOpenRouterApiKey('Bearer sk-or-v1-abc', {}),
    'sk-or-v1-abc',
  );
});

test('isOpenRouterConfigured uses normalized key', () => {
  assert.equal(isOpenRouterConfigured({ OPENROUTER_API_KEY: '  ' }), false);
  assert.equal(isOpenRouterConfigured({ OPENROUTER_API_KEY: '"x"' }), true);
});
