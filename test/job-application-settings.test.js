import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';

test('serves the HOD WhatsApp settings page', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, resolve));

  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/admin-hod-settings.html`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /HOD WhatsApp Settings/);
    assert.match(html, /hod-departments/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('exposes recruitment and AI health endpoints in API documentation', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, resolve));

  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.ok(payload.endpoints.some(endpoint => endpoint.path === '/job-applications'));
    assert.ok(payload.endpoints.some(endpoint => endpoint.path === '/hod-departments'));
    assert.ok(payload.endpoints.some(endpoint => endpoint.path === '/health/ai'));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('exposes queryable pipeline events without leaking request bodies', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, resolve));

  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/pipeline-events?email_id=test-email&limit=10`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.ok(Array.isArray(payload.data));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('returns a structured AI health response when provider config is unavailable', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, resolve));

  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/health/ai`);
    const payload = await response.json();

    assert.ok([200, 503, 504].includes(response.status));
    assert.equal(payload.service, 'ai');
    assert.ok(['ok', 'error'].includes(payload.status));
    if (response.status !== 200) {
      assert.equal(typeof payload.code, 'string');
      assert.equal(typeof payload.error, 'string');
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
