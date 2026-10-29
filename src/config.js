'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
  watchPath: null,
  ignore: [],
  ignorePatterns: [],
  logDir: 'logs',
  host: '127.0.0.1',
  port: 4780,
  settleMs: 1000,
  maxWaitMs: 30000,
};

class ConfigError extends Error {}

function loadConfig(configPath) {
  const file = path.resolve(configPath);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new ConfigError(`Cannot read config file ${file}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new ConfigError(`Config file ${file} is not valid JSON: ${err.message}`);
  }

  const cfg = { ...DEFAULTS, ...parsed };
  const baseDir = path.dirname(file);

  // The watched folder is normally chosen in the web UI's Settings; an empty value just means "not set up yet".
  if (cfg.watchPath == null || (typeof cfg.watchPath === 'string' && !cfg.watchPath.trim())) {
    cfg.watchPath = null;
  } else if (typeof cfg.watchPath !== 'string' || !path.isAbsolute(cfg.watchPath)) {
    throw new ConfigError(`"watchPath" must be an absolute path, got ${JSON.stringify(cfg.watchPath)}`);
  } else {
    cfg.watchPath = path.resolve(cfg.watchPath);
  }

  cfg.ignore = stringList(cfg.ignore, 'ignore');
  cfg.ignorePatterns = stringList(cfg.ignorePatterns, 'ignorePatterns');

  if (typeof cfg.logDir !== 'string' || !cfg.logDir.trim()) {
    throw new ConfigError('"logDir" must be a folder path');
  }
  cfg.logDir = path.resolve(baseDir, cfg.logDir);

  if (typeof cfg.host !== 'string' || !cfg.host.trim()) {
    throw new ConfigError('"host" must be a string such as "127.0.0.1"');
  }
  cfg.port = integerIn(cfg.port, 'port', 1, 65535);
  cfg.settleMs = integerIn(cfg.settleMs, 'settleMs', 100, 60000);
  cfg.maxWaitMs = integerIn(cfg.maxWaitMs, 'maxWaitMs', cfg.settleMs, 600000);

  return cfg;
}

function stringList(value, name) {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.trim())) {
    throw new ConfigError(`"${name}" must be a list of non-empty strings`);
  }
  return value.map((v) => v.trim());
}

function integerIn(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`"${name}" must be a whole number between ${min} and ${max}, got ${JSON.stringify(value)}`);
  }
  return value;
}

// ---------- Settings edited from the web UI ----------

const MAX_ENTRIES = 200;
const MAX_TEXT = 1024;

class SettingsError extends Error {
  constructor(message, field) {
    super(message);
    this.field = field;
  }
}

/**
 * Checks what the Settings form sent and returns the cleaned values:
 * { watchPath, ignore: [paths relative to watchPath], ignorePatterns: [names] }.
 * Throws SettingsError with the offending field.
 */
function normalizeSettings(input, { logDir }) {
  if (!input || typeof input !== 'object') throw new SettingsError('Invalid settings', 'watchPath');

  const rawWatch = typeof input.watchPath === 'string' ? input.watchPath.trim().replace(/^"(.*)"$/, '$1') : '';
  if (!rawWatch) throw new SettingsError('Choose the folder to watch.', 'watchPath');
  if (rawWatch.length > MAX_TEXT || !path.isAbsolute(rawWatch)) {
    throw new SettingsError('Use a full folder path, for example C:\\NomixRoleplay\\Data', 'watchPath');
  }
  const watchPath = path.resolve(rawWatch);
  let st;
  try {
    st = fs.statSync(watchPath);
  } catch {
    throw new SettingsError(`Folder not found: ${watchPath}`, 'watchPath');
  }
  if (!st.isDirectory()) throw new SettingsError(`Not a folder: ${watchPath}`, 'watchPath');
  if (path.parse(watchPath).root === watchPath) {
    throw new SettingsError('Watching a whole drive is too broad. Pick the server folder instead.', 'watchPath');
  }
  if (isSameOrInside(watchPath, logDir)) {
    throw new SettingsError('That is the logger\'s own log folder (or inside it). Pick the server folder.', 'watchPath');
  }

  const ignore = [];
  const seen = new Set();
  for (const entry of list(input.ignore, 'ignore')) {
    const abs = path.isAbsolute(entry) ? path.resolve(entry) : path.resolve(watchPath, entry);
    const rel = path.relative(watchPath, abs);
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new SettingsError(`"${entry}" is not inside the watched folder.`, 'ignore');
    }
    const key = rel.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ignore.push(rel);
  }

  const ignorePatterns = [];
  const seenNames = new Set();
  for (const entry of list(input.ignorePatterns, 'ignorePatterns')) {
    if (/[\\/]/.test(entry)) {
      throw new SettingsError(`"${entry}" should be a name like *.tmp, not a path. Add folders under Ignored folders.`, 'ignorePatterns');
    }
    const key = entry.toLowerCase();
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    ignorePatterns.push(entry);
  }

  return { watchPath, ignore, ignorePatterns };
}

function list(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) {
    throw new SettingsError(`Too many entries (max ${MAX_ENTRIES}).`, field);
  }
  const out = [];
  for (const v of value) {
    if (typeof v !== 'string') throw new SettingsError('Entries must be text.', field);
    const t = v.trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '');
    if (!t) continue;
    if (t.length > MAX_TEXT) throw new SettingsError('An entry is too long.', field);
    out.push(t);
  }
  return out;
}

// Writes the three UI-managed keys into config.json, keeping every other key as it is.
function saveSettings(configPath, settings) {
  const file = path.resolve(configPath);
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new ConfigError(`Cannot update ${file}: ${err.message}`);
  }
  const next = { ...current, watchPath: settings.watchPath, ignore: settings.ignore, ignorePatterns: settings.ignorePatterns };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

// Ignore entries as the UI shows them: relative to the watched folder when they are inside it.
function displayIgnores(watchPath, ignore) {
  if (!watchPath) return ignore;
  return ignore.map((entry) => {
    if (!path.isAbsolute(entry)) return entry;
    const rel = path.relative(watchPath, path.resolve(entry));
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : entry;
  });
}

function isSameOrInside(child, parent) {
  const rel = path.relative(parent, child);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

module.exports = {
  loadConfig, ConfigError, PROJECT_ROOT,
  normalizeSettings, saveSettings, displayIgnores, SettingsError,
};
