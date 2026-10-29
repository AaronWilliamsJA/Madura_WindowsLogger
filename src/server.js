'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { localDay, DAY_RE } = require('./changelog');
const { displayIgnores, SettingsError } = require('./config');

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
const MAX_BODY = 64 * 1024;
const MAX_FOLDERS = 1000;
// Sent only by our own page. A cross-site page cannot add it without a CORS preflight, which we never approve.
const WRITE_HEADER = 'x-madura-request';

function createServer({ host, port, config, getWatcher, applySettings, changelog, startedAt, log }) {
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
    const watcher = getWatcher();
    return {
      configured: Boolean(config.watchPath),
      watchPath: config.watchPath,
      ignored: displayIgnores(config.watchPath, config.ignore),
      ignorePatterns: config.ignorePatterns,
      state: watcher ? watcher.status.state : config.watchPath ? 'starting' : 'unconfigured',
      message: watcher ? watcher.status.message : config.watchPath ? 'Starting' : 'Choose a folder to watch in Settings',
      startedAt,
      today: localDay(),
    };
  }

  async function handle(req, res) {
    if (loopbackOnly && !isLoopbackHost(req.headers.host)) {
      return sendJson(res, 403, { error: 'Forbidden host' });
    }
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'POST' && url.pathname === '/api/settings') return saveSettingsRoute(req, res);
    if (req.method !== 'GET') {
      res.setHeader('Allow', url.pathname === '/api/settings' ? 'GET, POST' : 'GET');
      return sendJson(res, 405, { error: 'Method not allowed' });
    }

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

      case '/api/settings':
        return sendJson(res, 200, settingsView());

      case '/api/browse':
        return browseRoute(res, url.searchParams.get('path') || '');

      default:
        return sendJson(res, 404, { error: 'Not found' });
    }
  }

  function settingsView() {
    return {
      watchPath: config.watchPath || '',
      ignore: displayIgnores(config.watchPath, config.ignore),
      ignorePatterns: config.ignorePatterns,
    };
  }

  async function saveSettingsRoute(req, res) {
    if (req.headers[WRITE_HEADER] !== '1' || !/^application\/json\b/i.test(req.headers['content-type'] || '')) {
      return sendJson(res, 403, { error: 'Settings can only be changed from the Madura Logger page.' });
    }
    let input;
    try {
      input = JSON.parse(await readBody(req));
    } catch (err) {
      return sendJson(res, 400, { error: err.code === 'TOO_LARGE' ? 'Request too large' : 'Invalid JSON' });
    }
    try {
      const result = await applySettings(input);
      return sendJson(res, 200, { ok: true, status: result, settings: settingsView() });
    } catch (err) {
      if (err instanceof SettingsError) return sendJson(res, 400, { error: err.message, field: err.field });
      throw err;
    }
  }

  // Lists sub-folders for the Settings folder picker. Empty path lists the drives.
  async function browseRoute(res, requested) {
    if (requested.length > MAX_PATH_QUERY) return sendJson(res, 400, { error: 'Path too long' });
    if (!requested) return sendJson(res, 200, { path: '', parent: null, folders: listDrives() });
    if (!path.isAbsolute(requested)) return sendJson(res, 400, { error: 'Use a full folder path' });

    const dir = path.resolve(requested);
    let dirents;
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      const code = err.code === 'ENOENT' || err.code === 'ENOTDIR' ? 404 : err.code === 'EPERM' || err.code === 'EACCES' ? 403 : 500;
      return sendJson(res, code, { error: code === 404 ? `Folder not found: ${dir}` : `Cannot open ${dir}` });
    }
    const folders = dirents
      .filter((d) => d.isDirectory() && !d.name.startsWith('$'))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
    const parentDir = path.dirname(dir);
    return sendJson(res, 200, {
      path: dir,
      parent: parentDir === dir ? '' : parentDir,
      folders: folders.slice(0, MAX_FOLDERS),
      truncated: folders.length > MAX_FOLDERS,
    });
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('too large'), { code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function listDrives() {
  if (process.platform !== 'win32') return ['/'];
  const drives = [];
  for (let c = 65; c <= 90; c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    try {
      if (fs.statSync(root).isDirectory()) drives.push(root);
    } catch {
      // no such drive
    }
  }
  return drives;
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
