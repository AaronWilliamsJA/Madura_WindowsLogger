'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadConfig, ConfigError, PROJECT_ROOT, normalizeSettings, saveSettings } = require('./config');
const { createDiagnostics } = require('./diagnostics');
const { FolderWatcher } = require('./watcher');
const { ChangeLog } = require('./changelog');
const { createServer } = require('./server');

const diag = createDiagnostics(path.join(PROJECT_ROOT, 'logs', 'service.log'));

async function main() {
  const args = process.argv.slice(2);
  const configPath = optionValue(args, '--config') || path.join(PROJECT_ROOT, 'config.json');
  const config = loadConfig(configPath);

  if (config.watchPath && samePath(config.logDir, config.watchPath)) {
    throw new ConfigError('"logDir" cannot be the watched folder itself');
  }

  const changelog = new ChangeLog({ dir: config.logDir });
  await changelog.init();

  let watcher = null;
  let server = null;

  function createWatcher() {
    // Never watch our own log files, or every write would log itself.
    const ignore = [...config.ignore];
    if (isInside(config.logDir, config.watchPath)) ignore.push(config.logDir);

    const w = new FolderWatcher({
      root: config.watchPath,
      ignore,
      ignorePatterns: config.ignorePatterns,
      settleMs: config.settleMs,
      maxWaitMs: config.maxWaitMs,
    });
    for (const entry of w.rejectedIgnores) {
      diag.warn(`Ignore entry "${entry}" is not inside ${config.watchPath}; skipped`);
    }
    w.on('changes', (changes) => changelog.append(changes));
    w.on('state', ({ state, message }) => {
      if (w !== watcher) return; // a replaced watcher shutting down
      (state === 'error' || state === 'missing' ? diag.warn : diag.info)(`Watcher ${state}${message ? `: ${message}` : ''}`);
      server.broadcast('status', server.status());
    });
    w.on('warn', (msg) => diag.warn(msg));
    return w;
  }

  function describeWatch() {
    if (!config.watchPath) return 'No folder set yet: choose one in Settings';
    const skipped = [...config.ignore, ...config.ignorePatterns];
    return `Watching ${config.watchPath}${skipped.length ? ` (ignoring ${skipped.join(', ')})` : ''}`;
  }

  // Settings saved from the web UI: write config.json, then swap the watcher without restarting the service.
  let settingsQueue = Promise.resolve();
  function applySettings(input) {
    const run = settingsQueue.then(async () => {
      const next = normalizeSettings(input, { logDir: config.logDir });
      saveSettings(configPath, next);
      Object.assign(config, next);
      diag.info(`Settings changed from the web UI. ${describeWatch()}`);

      const old = watcher;
      watcher = null;
      if (old) {
        await old.stop();
        old.removeAllListeners();
      }
      watcher = createWatcher();
      watcher.start().catch((err) => diag.error(`Watcher failed to start: ${err.message}`));
      server.broadcast('status', server.status());
      return server.status();
    });
    settingsQueue = run.catch(() => {});
    return run;
  }

  server = createServer({
    host: config.host,
    port: config.port,
    config,
    getWatcher: () => watcher,
    applySettings,
    changelog,
    startedAt: Date.now(),
    log: diag,
  });

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
  diag.info(describeWatch());
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
    if (watcher) await watcher.stop();
    await changelog.flush();
    await server.close();
    process.exit(0);
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
    process.on(signal, () => shutdown(signal));
  }

  if (config.watchPath) {
    watcher = createWatcher();
    await watcher.start();
  }
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
