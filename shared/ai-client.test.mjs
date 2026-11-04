import test from 'node:test';
import assert from 'node:assert/strict';
import { aiFailurePolicy, chatCompletion, listAllProviders } from './ai-client.mjs';
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

test('explicit AI provider pins credentials/model and never mutates or falls back to global selection', async () => {
  const original = globalThis.fetch, before = listAllProviders(); let request;
  try {
    globalThis.fetch = async (url, options) => { request = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"summary":"拟升级。"}' } }] })); };
    const provider = { name: 'isolated-test', apiUrl: 'https://api.deepseek.com/chat/completions',
      model: 'deepseek-flash', apiKey: 'test-only', format: 'openai' };
    const reply = await chatCompletion({ provider, systemPrompt: 'JSON only', userMessage: 'public proposal',
      thinking: { type: 'enabled' }, reasoningEffort: 'low', responseFormat: { type: 'json_object' }, retries: 0 });
    assert.match(reply, /拟升级/); assert.equal(request.body.model, 'deepseek-flash');
    assert.equal(request.options.headers.Authorization, 'Bearer test-only');
    assert.equal(request.body.reasoning_effort, 'low'); assert.equal(request.body.response_format.type, 'json_object');
    request = null; assert.equal(await chatCompletion({ provider: { ...provider, apiKey: '' } }), null);
    assert.equal(request, null); assert.deepEqual(listAllProviders(), before);
  } finally { globalThis.fetch = original; }
});
