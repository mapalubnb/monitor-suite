import test from 'node:test';
import assert from 'node:assert/strict';
import { aiFailurePolicy } from './ai-client.mjs';
test('AI billing and authentication failures stop retrying while transient failures retry', () => {
  for (const status of [401, 402, 403]) {
    assert.equal(aiFailurePolicy(status).retry, false);
    assert.equal(aiFailurePolicy(status).cooldownMs, 1800000);
  }
  assert.equal(aiFailurePolicy(429, 'insufficient_quota').retry, false);
  assert.equal(aiFailurePolicy(429, 'rate limited').retry, true);
  assert.equal(aiFailurePolicy(503).retry, true);
  assert.equal(aiFailurePolicy(400).retry, false);
});
