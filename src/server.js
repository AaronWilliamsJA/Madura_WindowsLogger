'use strict';

const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { localDay, DAY_RE } = require('./changelog');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
  '/favicon.png': ['favicon.png', 'image/png'],
  '/logo.png': ['logo.png', 'image/png'],
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1']);
const HEARTBEAT_MS = 20000;
const MAX_PATH_QUERY = 2048;

function createServer({ host, port, watcher, changelog, ignored, startedAt, log }) {
  const clients = new Set();
  // Bound to this machine only: also refuse other Host names, which blocks DNS-rebinding pages.
  const loopbackOnly = LOOPBACK_NAMES.has(host);

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.error(`Request ${req.method} ${req.url} failed: ${err.stack || err.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
      else res.end();
    });
  });

  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref();

  function status() {
    return {
      watchPath: watcher.root,
      ignored,
      state: watcher.status.state,
      message: watcher.status.message,
      startedAt,
      today: localDay(),
    };
  }

  async function handle(req, res) {
    if (loopbackOnly && !isLoopbackHost(req.headers.host)) {
      return sendJson(res, 403, { error: 'Forbidden host' });
    }
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return sendJson(res, 405, { error: 'Method not allowed' });
    }

    const url = new URL(req.url, 'http://localhost');
    const asset = STATIC[url.pathname];
    if (asset) return sendStatic(res, asset[0], asset[1]);

    switch (url.pathname) {
      case '/api/status':
        return sendJson(res, 200, status());

      case '/api/days':
        return sendJson(res, 200, { today: localDay(), days: await changelog.listDays() });

      case '/api/events': {
        const day = url.searchParams.get('day') || localDay();
        if (!DAY_RE.test(day)) return sendJson(res, 400, { error: 'day must look like YYYY-MM-DD' });
        return sendJson(res, 200, { day, events: await changelog.readDay(day) });
      }

      case '/api/history': {
        const rel = url.searchParams.get('path');
        if (!rel || rel.length > MAX_PATH_QUERY) return sendJson(res, 400, { error: 'path is required' });
        return sendJson(res, 200, { path: rel, events: await changelog.history(rel) });
      }

      case '/api/stream':
        return openStream(req, res);

      default:
        return sendJson(res, 404, { error: 'Not found' });
    }
  }

  function openStream(req, res) {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    res.write(sseMessage('status', status()));
    clients.add(res);
    req.on('close', () => clients.delete(res));
  }

  function broadcast(event, data) {
    if (!clients.size) return;
    const message = sseMessage(event, data);
    for (const res of clients) res.write(message);
  }

  function listen() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  }

  function close() {
    clearInterval(heartbeat);
    for (const res of clients) res.end();
    clients.clear();
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  return { listen, close, broadcast, status };
}

async function sendStatic(res, file, type) {
  const body = await fsp.readFile(path.join(PUBLIC_DIR, file));
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': type,
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function sendJson(res, code, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(code, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sseMessage(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function isLoopbackHost(header) {
  if (!header) return false;
  const name = header.startsWith('[') ? header.slice(1, header.indexOf(']')) : header.split(':')[0];
  return LOOPBACK_NAMES.has(name.toLowerCase());
}

module.exports = { createServer };
