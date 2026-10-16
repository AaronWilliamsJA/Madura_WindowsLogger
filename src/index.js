'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadConfig, ConfigError, PROJECT_ROOT } = require('./config');
const { createDiagnostics } = require('./diagnostics');
const { FolderWatcher } = require('./watcher');
const { ChangeLog } = require('./changelog');
const { createServer } = require('./server');

const diag = createDiagnostics(path.join(PROJECT_ROOT, 'logs', 'service.log'));

async function main() {
  const args = process.argv.slice(2);
  const configPath = optionValue(args, '--config') || path.join(PROJECT_ROOT, 'config.json');
  const config = loadConfig(configPath);

  if (samePath(config.logDir, config.watchPath)) {
    throw new ConfigError('"logDir" cannot be the watched folder itself');
  }
  // Never watch our own log files, or every write would log itself.
  const ignore = [...config.ignore];
  if (isInside(config.logDir, config.watchPath)) ignore.push(config.logDir);

  const changelog = new ChangeLog({ dir: config.logDir });
  await changelog.init();

  const watcher = new FolderWatcher({
    root: config.watchPath,
    ignore,
    ignorePatterns: config.ignorePatterns,
    settleMs: config.settleMs,
    maxWaitMs: config.maxWaitMs,
  });
  for (const entry of watcher.rejectedIgnores) {
    diag.warn(`Ignore entry "${entry}" is not inside ${config.watchPath}; skipped`);
  }

  const server = createServer({
    host: config.host,
    port: config.port,
    watcher,
    changelog,
    ignored: config.ignore,
    startedAt: Date.now(),
    log: diag,
  });

  watcher.on('changes', (changes) => changelog.append(changes));
  watcher.on('state', ({ state, message }) => {
    (state === 'error' || state === 'missing' ? diag.warn : diag.info)(`Watcher ${state}${message ? `: ${message}` : ''}`);
    server.broadcast('status', server.status());
  });
  watcher.on('warn', (msg) => diag.warn(msg));
  changelog.on('entries', (entries) => server.broadcast('changes', entries));
  changelog.on('warn', (err) => diag.error(`Could not write the change log: ${err.message}`));

  try {
    await server.listen();
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      throw new ConfigError(`Port ${config.port} is already in use. Madura Logger may already be running.`);
    }
    throw err;
  }

  const shownHost = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
  const url = `http://${shownHost.includes(':') ? `[${shownHost}]` : shownHost}:${config.port}`;
  diag.info(`Madura Logger ${require('../package.json').version} started`);
  diag.info(`Watching ${config.watchPath}${config.ignore.length ? ` (ignoring ${config.ignore.join(', ')})` : ''}`);
  diag.info(`Change logs in ${config.logDir}`);
  diag.info(`UI at ${url}`);

  if (args.includes('--open')) {
    spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  }

  let stopping = false;
  async function shutdown(reason) {
    if (stopping) return;
    stopping = true;
    diag.info(`Stopping (${reason})`);
    await watcher.stop();
    await changelog.flush();
    await server.close();
    process.exit(0);
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
    process.on(signal, () => shutdown(signal));
  }

  await watcher.start();
}

function optionValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function samePath(a, b) {
  return path.relative(a, b) === '';
}

process.on('uncaughtException', (err) => {
  diag.error(`Crashed: ${err.stack || err.message}`);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  diag.error(`Crashed: ${(err && err.stack) || err}`);
  process.exit(1);
});

main().catch((err) => {
  diag.error(err instanceof ConfigError ? err.message : `Failed to start: ${err.stack || err.message}`);
  process.exit(1);
});
