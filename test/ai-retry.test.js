import test from 'node:test';
import assert from 'node:assert/strict';

process.env.AI_API_KEY = 'test-key';
process.env.AI_API_BASE_URL = 'https://ai.example.test/v1';
process.env.AI_MODEL = 'test-model';
process.env.AI_MAX_ATTEMPTS = '3';
process.env.AI_RETRY_BACKOFF_MS = '1';
process.env.AI_REQUEST_TIMEOUT_MS = '100';

const { callAiApi } = await import('../src/job-application-service.js');

test('retries transient AI failures before succeeding', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 3) {
      return new Response(JSON.stringify({ error: { message: 'temporary provider failure' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const result = await callAiApi({ model: 'test-model', messages: [] }, { emailId: 'retry-test' });
    assert.equal(calls, 3);
    assert.equal(result.choices[0].message.content, '{"ok":true}');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
