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

test('exposes recruitment endpoints in API documentation', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, resolve));

  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.ok(payload.endpoints.some(endpoint => endpoint.path === '/job-applications'));
    assert.ok(payload.endpoints.some(endpoint => endpoint.path === '/hod-departments'));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
