'use strict';

const { EventEmitter } = require('node:events');

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TARGETS = 50;

function normalizeTargets(targets) {
  if (!Array.isArray(targets)) {
    throw new TypeError('Monitor targets must be an array.');
  }
  if (targets.length > MAX_TARGETS) {
    throw new RangeError(`Monitor targets cannot exceed ${MAX_TARGETS}.`);
  }

  const ids = new Set();
  return targets.map((target, index) => {
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
      throw new TypeError(`Target ${index + 1} must be an object.`);
    }

    const name = typeof target.name === 'string' ? target.name.trim() : '';
    if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new TypeError(`Target ${index + 1} must have a name of 1-80 printable characters.`);
    }
    if (typeof target.url !== 'string' || target.url.length > 2048) {
      throw new TypeError(`Target "${name}" must have a URL of at most 2048 characters.`);
    }

    let url;
    try {
      url = new URL(target.url);
    } catch {
      throw new TypeError(`Target "${name}" has an invalid URL.`);
    }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) {
      throw new TypeError(`Target "${name}" must use an HTTP(S) URL without credentials or a fragment.`);
    }

    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `target-${index + 1}`;
    if (ids.has(id)) {
      throw new TypeError(`Target names must be unique: "${name}".`);
    }
    ids.add(id);

    const expectedStatus = target.expectedStatus === undefined ? 200 : target.expectedStatus;
    if (!Number.isInteger(expectedStatus) || expectedStatus < 100 || expectedStatus > 599) {
      throw new TypeError(`Target "${name}" must have an expectedStatus from 100 to 599.`);
    }

    return { id, name, url: url.href, expectedStatus };
  });
}

function validateDuration(value, name) {
  if (!Number.isInteger(value) || value < 250 || value > 300_000) {
    throw new RangeError(`${name} must be an integer between 250 and 300000 milliseconds.`);
  }
  return value;
}

async function checkTarget(target, options = {}) {
  const timeoutMs = validateDuration(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('A Fetch API implementation is required.');
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchImpl(target.url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });
    await response.body?.cancel();
    const healthy = response.status === target.expectedStatus;
    return {
      id: target.id,
      name: target.name,
      url: target.url,
      status: healthy ? 'up' : 'down',
      statusCode: response.status,
      responseTimeMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
      error: healthy ? null : `Expected HTTP ${target.expectedStatus}; received HTTP ${response.status}.`,
    };
  } catch (error) {
    return {
      id: target.id,
      name: target.name,
      url: target.url,
      status: 'down',
      statusCode: null,
      responseTimeMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
      error: timedOut ? `Request timed out after ${timeoutMs} ms.` : error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

class HealthMonitor extends EventEmitter {
  constructor(targets, options = {}) {
    super();
    this.targets = normalizeTargets(targets);
    this.intervalMs = validateDuration(options.intervalMs ?? DEFAULT_INTERVAL_MS, 'intervalMs');
    this.timeoutMs = validateDuration(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs');
    this.checker = options.checker ?? checkTarget;
    if (typeof this.checker !== 'function') {
      throw new TypeError('checker must be a function.');
    }

    this.results = this.targets.map((target) => ({
      id: target.id,
      name: target.name,
      url: target.url,
      status: 'unknown',
      statusCode: null,
      responseTimeMs: null,
      checkedAt: null,
      error: null,
    }));
    this.inFlight = null;
    this.timer = null;
  }

  snapshot() {
    return {
      generatedAt: new Date().toISOString(),
      refreshIntervalMs: this.intervalMs,
      targets: this.results.map((result) => ({ ...result })),
    };
  }

  runChecks() {
    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = Promise.all(this.targets.map(async (target) => {
      try {
        return await this.checker(target, { timeoutMs: this.timeoutMs });
      } catch (error) {
        return {
          id: target.id,
          name: target.name,
          url: target.url,
          status: 'down',
          statusCode: null,
          responseTimeMs: null,
          checkedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : 'Health check failed.',
        };
      }
    })).then((results) => {
      this.results = results;
      const snapshot = this.snapshot();
      this.emit('update', snapshot);
      return snapshot;
    }).finally(() => {
      this.inFlight = null;
    });

    return this.inFlight;
  }

  start() {
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.runChecks();
      }, this.intervalMs);
      this.timer.unref();
    }
    return this.runChecks();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  HealthMonitor,
  checkTarget,
  normalizeTargets,
  validateDuration,
};
