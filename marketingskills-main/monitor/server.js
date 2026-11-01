'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { HealthMonitor, normalizeTargets, DEFAULT_INTERVAL_MS, DEFAULT_TIMEOUT_MS } = require('./monitor');

const PUBLIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);
const PUBLIC_DIR = path.join(__dirname, 'public');

function loadTargets(configPath = path.join(__dirname, 'targets.json')) {
  let contents;
  try {
    contents = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw new Error(`Unable to read monitor configuration: ${error.message}`);
  }

  let config;
  try {
    config = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Monitor configuration is not valid JSON: ${error.message}`);
  }
  if (!config || typeof config !== 'object' || !Array.isArray(config.targets)) {
    throw new TypeError('Monitor configuration must contain a targets array.');
  }
  return normalizeTargets(config.targets);
}

function readPositiveInteger(value, name, fallback, min, max) {
  if (value === undefined || value === '') {
    return fallback;
  }
  if (!/^\d+$/.test(value)) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function setCommonHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function createServer({ monitor, maxSseClients = 100, publicDir = PUBLIC_DIR }) {
  if (!monitor || typeof monitor.snapshot !== 'function' || typeof monitor.on !== 'function') {
    throw new TypeError('createServer requires a health monitor.');
  }
  if (!Number.isInteger(maxSseClients) || maxSseClients < 1 || maxSseClients > 10_000) {
    throw new RangeError('maxSseClients must be an integer between 1 and 10000.');
  }

  const clients = new Set();
  return http.createServer((request, response) => {
    setCommonHeaders(response);
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      sendJson(response, 405, { error: 'Method not allowed.' });
      return;
    }

    let pathname;
    try {
      pathname = new URL(request.url, 'http://localhost').pathname;
    } catch {
      sendJson(response, 400, { error: 'Invalid request URL.' });
      return;
    }

    if (pathname === '/api/health') {
      sendJson(response, 200, { status: 'ok', targetCount: monitor.targets.length });
      return;
    }
    if (pathname === '/api/status') {
      sendJson(response, 200, monitor.snapshot());
      return;
    }
    if (pathname === '/api/events') {
      if (clients.size >= maxSseClients) {
        sendJson(response, 503, { error: 'Live update capacity has been reached.' });
        return;
      }

      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      response.flushHeaders();
      clients.add(response);

      const sendSnapshot = (snapshot) => {
        if (!response.write(`data: ${JSON.stringify(snapshot)}\n\n`)) {
          response.end();
        }
      };
      const heartbeat = setInterval(() => {
        if (!response.write(': keep-alive\n\n')) {
          response.end();
        }
      }, 20_000);
      heartbeat.unref();

      const cleanup = () => {
        clearInterval(heartbeat);
        clients.delete(response);
        monitor.off('update', sendSnapshot);
      };
      monitor.on('update', sendSnapshot);
      response.on('close', cleanup);
      sendSnapshot(monitor.snapshot());
      return;
    }

    const publicFile = PUBLIC_FILES.get(pathname);
    if (publicFile) {
      let contents;
      try {
        contents = fs.readFileSync(path.join(publicDir, publicFile[0]));
      } catch (error) {
        sendJson(response, 500, { error: `Unable to load dashboard asset: ${error.message}` });
        return;
      }
      response.writeHead(200, {
        'Content-Type': publicFile[1],
        'Cache-Control': 'no-cache',
      });
      response.end(contents);
      return;
    }

    sendJson(response, 404, { error: 'Not found.' });
  });
}

async function startServer(options = {}) {
  const host = options.host ?? process.env.MONITOR_HOST ?? '127.0.0.1';
  const port = options.port ?? readPositiveInteger(process.env.PORT, 'PORT', 3000, 1, 65_535);
  const intervalMs = options.intervalMs ?? readPositiveInteger(
    process.env.MONITOR_INTERVAL_MS,
    'MONITOR_INTERVAL_MS',
    DEFAULT_INTERVAL_MS,
    250,
    300_000,
  );
  const timeoutMs = options.timeoutMs ?? readPositiveInteger(
    process.env.MONITOR_TIMEOUT_MS,
    'MONITOR_TIMEOUT_MS',
    DEFAULT_TIMEOUT_MS,
    250,
    300_000,
  );
  const targets = options.targets ?? loadTargets(options.configPath);
  const monitor = new HealthMonitor(targets, { intervalMs, timeoutMs });
  const server = createServer({ monitor });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  void monitor.start();

  const address = server.address();
  console.log(`Marketing Skills Monitor listening on http://${host}:${address.port}`);
  console.log(`${targets.length} target(s) configured; checks run every ${intervalMs} ms.`);

  const shutdown = () => {
    monitor.stop();
    server.close();
    server.closeAllConnections();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  server.once('close', () => {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
  });

  return { server, monitor };
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error(`Unable to start monitor: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  createServer,
  loadTargets,
  readPositiveInteger,
  startServer,
};
