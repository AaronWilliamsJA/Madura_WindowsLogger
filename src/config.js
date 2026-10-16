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

  if (typeof cfg.watchPath !== 'string' || !cfg.watchPath.trim()) {
    throw new ConfigError('"watchPath" is required, e.g. "C:\\\\NomixRoleplay\\\\Data"');
  }
  if (!path.isAbsolute(cfg.watchPath)) {
    throw new ConfigError(`"watchPath" must be an absolute path, got "${cfg.watchPath}"`);
  }
  cfg.watchPath = path.resolve(cfg.watchPath);

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

module.exports = { loadConfig, ConfigError, PROJECT_ROOT };
