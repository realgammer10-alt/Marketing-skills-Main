'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { test } = require('node:test');
const { HealthMonitor } = require('../monitor');
const { createServer, loadTargets, readPositiveInteger } = require('../server');

async function withServer(server, run) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
}

test('serves health, status, dashboard assets, and safe errors', async () => {
  const monitor = new HealthMonitor([{ name: 'Demo API', url: 'https://demo.example/health' }]);
  const server = createServer({ monitor });

  await withServer(server, async (baseUrl) => {
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok', targetCount: 1 });
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff');

    const status = await fetch(`${baseUrl}/api/status`);
    const snapshot = await status.json();
    assert.equal(status.status, 200);
    assert.equal(snapshot.targets[0].status, 'unknown');
    assert.equal(status.headers.get('cache-control'), 'no-store');

    const dashboard = await fetch(baseUrl);
    assert.equal(dashboard.status, 200);
    assert.match(await dashboard.text(), /Endpoint status/);

    const asset = await fetch(`${baseUrl}/app.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /javascript/);

    const missing = await fetch(`${baseUrl}/private`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'Not found.' });

    const method = await fetch(`${baseUrl}/api/status`, { method: 'POST' });
    assert.equal(method.status, 405);
    assert.equal(method.headers.get('allow'), 'GET');
  });
});

test('streams initial and subsequent status updates over server-sent events', async () => {
  const monitor = new HealthMonitor([]);
  const server = createServer({ monitor });

  await withServer(server, async (baseUrl) => {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /"targets":\[\]/);

    const updatePromise = reader.read();
    await monitor.runChecks();
    const update = await updatePromise;
    assert.match(new TextDecoder().decode(update.value), /"generatedAt"/);
    controller.abort();
    await reader.cancel().catch(() => {});
  });
});

test('loads and validates JSON configuration and numeric settings', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-monitor-'));
  const configPath = path.join(directory, 'targets.json');
  try {
    fs.writeFileSync(configPath, JSON.stringify({
      targets: [{ name: 'Example', url: 'https://example.test/health' }],
    }));
    assert.equal(loadTargets(configPath)[0].id, 'example');
    assert.throws(() => readPositiveInteger('0', 'PORT', 3000, 1, 65_535), /between 1 and 65535/);
    assert.throws(() => readPositiveInteger('invalid', 'PORT', 3000, 1, 65_535), /between 1 and 65535/);
    fs.writeFileSync(configPath, '{invalid');
    assert.throws(() => loadTargets(configPath), /not valid JSON/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('enforces the live connection limit', async () => {
  const monitor = new HealthMonitor([]);
  const server = createServer({ monitor, maxSseClients: 1 });

  await withServer(server, async (baseUrl) => {
    const controller = new AbortController();
    const first = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
    assert.equal(first.status, 200);

    const second = await fetch(`${baseUrl}/api/events`);
    assert.equal(second.status, 503);
    assert.deepEqual(await second.json(), { error: 'Live update capacity has been reached.' });
    controller.abort();
    await first.body.cancel().catch(() => {});
  });
});
