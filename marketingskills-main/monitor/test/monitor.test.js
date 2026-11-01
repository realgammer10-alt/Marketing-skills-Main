'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { HealthMonitor, checkTarget, normalizeTargets } = require('../monitor');

const sampleTargets = [{ name: 'Example API', url: 'https://api.example.test/health' }];

test('normalizes valid target configuration', () => {
  assert.deepEqual(normalizeTargets(sampleTargets), [{
    id: 'example-api',
    name: 'Example API',
    url: 'https://api.example.test/health',
    expectedStatus: 200,
  }]);
});

test('rejects invalid URLs, credentials, duplicate names, and status codes', () => {
  assert.throws(() => normalizeTargets([{ name: 'bad', url: 'file:///etc/passwd' }]), /HTTP\(S\) URL/);
  assert.throws(() => normalizeTargets([{ name: 'bad', url: 'https://user:pass@example.test' }]), /without credentials/);
  assert.throws(() => normalizeTargets([
    { name: 'Service', url: 'https://one.example' },
    { name: 'service', url: 'https://two.example' },
  ]), /unique/);
  assert.throws(() => normalizeTargets([{ name: 'bad', url: 'https://example.test', expectedStatus: 99 }]), /expectedStatus/);
  assert.throws(() => normalizeTargets(Array.from({ length: 51 }, (_, index) => ({
    name: `Target ${index}`,
    url: `https://${index}.example.test`,
  }))), /cannot exceed 50/);
});

test('reports matching and unexpected HTTP responses', async () => {
  const fetchImpl = async () => ({
    status: 204,
    body: { cancel: async () => {} },
  });
  const target = normalizeTargets([{ name: 'No Content', url: 'https://example.test', expectedStatus: 204 }])[0];
  const healthy = await checkTarget(target, { fetchImpl });
  assert.equal(healthy.status, 'up');
  assert.equal(healthy.statusCode, 204);
  assert.equal(healthy.error, null);
  assert.equal(typeof healthy.checkedAt, 'string');

  const unhealthy = await checkTarget({ ...target, expectedStatus: 200 }, { fetchImpl });
  assert.equal(unhealthy.status, 'down');
  assert.match(unhealthy.error, /Expected HTTP 200; received HTTP 204/);
});

test('reports request failures and timeouts with a bounded request', async () => {
  const failing = normalizeTargets(sampleTargets)[0];
  const unavailable = await checkTarget(failing, {
    fetchImpl: async () => { throw new Error('connection refused'); },
  });
  assert.equal(unavailable.status, 'down');
  assert.equal(unavailable.error, 'connection refused');

  let receivedSignal;
  const timedOut = await checkTarget(failing, {
    timeoutMs: 250,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      receivedSignal = options.signal;
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  assert.equal(receivedSignal.aborted, true);
  assert.match(timedOut.error, /timed out after 250 ms/);
});

test('runs checks immediately, emits updates, and prevents overlapping cycles', async () => {
  let resolveCheck;
  let checkCount = 0;
  const monitor = new HealthMonitor(sampleTargets, {
    intervalMs: 60_000,
    checker: async (target) => {
      checkCount += 1;
      return new Promise((resolve) => {
        resolveCheck = () => resolve({
          id: target.id,
          name: target.name,
          url: target.url,
          status: 'up',
          statusCode: 200,
          responseTimeMs: 8,
          checkedAt: new Date().toISOString(),
          error: null,
        });
      });
    },
  });
  let emitted;
  monitor.once('update', (snapshot) => { emitted = snapshot; });

  const first = monitor.runChecks();
  const second = monitor.runChecks();
  assert.equal(first, second);
  assert.equal(checkCount, 1);
  resolveCheck();
  const snapshot = await first;
  assert.equal(snapshot.targets[0].status, 'up');
  assert.equal(emitted.targets[0].status, 'up');
  assert.equal(monitor.snapshot().targets[0].status, 'up');
  monitor.stop();
});
