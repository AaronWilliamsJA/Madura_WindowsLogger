'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 5 * 1024 * 1024;

// The logger's own messages (startup, warnings, crashes), separate from the change log.
// Written to a file too, because under Task Scheduler there is no console to read.
function createDiagnostics(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.old`);
  } catch {
    // no file yet
  }

  function write(level, message) {
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${message}`;
    (level === 'ERROR' || level === 'WARN' ? console.error : console.log)(line);
    try {
      fs.appendFileSync(file, `${line}\n`);
    } catch {
      // never let diagnostics take the service down
    }
  }

  return {
    info: (msg) => write('INFO', msg),
    warn: (msg) => write('WARN', msg),
    error: (msg) => write('ERROR', msg),
  };
}

module.exports = { createDiagnostics };
