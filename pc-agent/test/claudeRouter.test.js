import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferClaudeModelForTask } from '../src/claudeRouter.js';

test('inferClaudeModelForTask defaults to sonnet', () => {
  assert.equal(inferClaudeModelForTask('What is the weather?'), 'sonnet');
});

test('inferClaudeModelForTask picks opus for critical phrasing', () => {
  assert.equal(inferClaudeModelForTask('Think step by step about this ethics dilemma'), 'opus');
  assert.equal(inferClaudeModelForTask('I need a rigorous analysis of trade-offs'), 'opus');
});

test('inferClaudeModelForTask sonnet for code without critical cue', () => {
  assert.equal(inferClaudeModelForTask('fix this TypeScript function'), 'sonnet');
});
