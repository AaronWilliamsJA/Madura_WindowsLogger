'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');

// One plain-text file per day, one line per change:
//   [2026-10-16 14:32:05] MODIFIED  garage/config.lua
//   [2026-10-16 14:35:40] DELETED   garage/old/          <- trailing slash marks a folder
const LABELS = { added: 'ADDED', modified: 'MODIFIED', deleted: 'DELETED' };
const TYPES = { ADDED: 'added', MODIFIED: 'modified', DELETED: 'deleted' };
const HEAD_RE = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})\] (ADDED   |MODIFIED|DELETED ) {2}/;
const PATH_COLUMN = 32;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.log$/;
const HISTORY_MAX_DAYS = 180;

/**
 * Appends changes to daily log files and reads them back for the UI.
 * All file access goes through one queue so line numbers (used as ids) stay exact.
 *
 * Events: 'entries' -> parsed entries just written, 'warn' -> Error
 */
class ChangeLog extends EventEmitter {
  constructor({ dir }) {
    super();
    this.dir = dir;
    this.lineCounts = new Map();
    this.countCache = new Map();
    this.queue = Promise.resolve();
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
  }

  append(changes) {
    return this._serial(() => this._write(changes)).catch((err) => this.emit('warn', err));
  }

  flush() {
    return this._serial(() => {});
  }

  readDay(day) {
    if (!DAY_RE.test(day)) return Promise.reject(new RangeError(`Invalid day "${day}"`));
    return this._serial(() => this._readDay(day));
  }

  async listDays() {
    const days = await this._dayNames();
    return Promise.all(days.map(async (day) => ({ day, count: await this._countEntries(day) })));
  }

  async history(rel, limit = 200) {
    const target = rel.toLowerCase();
    const days = (await this._dayNames()).slice(0, HISTORY_MAX_DAYS);
    const out = [];
    for (const day of days) {
      const entries = await this.readDay(day);
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].path.toLowerCase() !== target) continue;
        out.push(entries[i]);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  _serial(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  async _write(changes) {
    const byDay = new Map();
    for (const c of changes) {
      const line = formatLine(c);
      const day = line.slice(1, 11);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(line);
    }

    const written = [];
    for (const [day, lines] of byDay) {
      let lineNo = await this._prepareDay(day);
      await fsp.appendFile(this._file(day), `${lines.join('\n')}\n`, 'utf8');
      for (const line of lines) written.push(parseLine(line, lineNo++));
      this.lineCounts.set(day, lineNo);
    }
    if (written.length) this.emit('entries', written);
  }

  // Returns the next line number for `day`, repairing a last line cut short by a crash.
  async _prepareDay(day) {
    if (this.lineCounts.has(day)) return this.lineCounts.get(day);
    let text = '';
    try {
      text = await fsp.readFile(this._file(day), 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (text && !text.endsWith('\n')) {
      await fsp.appendFile(this._file(day), '\n', 'utf8');
      text += '\n';
    }
    const count = splitLines(text).length;
    this.lineCounts.set(day, count);
    return count;
  }

  async _readDay(day) {
    let text;
    try {
      text = await fsp.readFile(this._file(day), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const entries = [];
    splitLines(text).forEach((line, i) => {
      const entry = parseLine(line, i);
      if (entry) entries.push(entry);
    });
    return entries;
  }

  async _countEntries(day) {
    const file = this._file(day);
    let st;
    try {
      st = await fsp.stat(file);
    } catch {
      return 0;
    }
    const stamp = `${st.size}:${st.mtimeMs}`;
    const cached = this.countCache.get(day);
    if (cached && cached.stamp === stamp) return cached.count;
    const count = (await this.readDay(day)).length;
    this.countCache.set(day, { stamp, count });
    return count;
  }

  async _dayNames() {
    let names;
    try {
      names = await fsp.readdir(this.dir);
    } catch {
      return [];
    }
    return names
      .map((n) => DAY_FILE_RE.exec(n))
      .filter(Boolean)
      .map((m) => m[1])
      .sort()
      .reverse();
  }

  _file(day) {
    return path.join(this.dir, `${day}.log`);
  }
}

function formatLine({ at, type, path: rel, isDir }) {
  const { day, time } = localStamp(at);
  return `[${day} ${time}] ${LABELS[type].padEnd(8)}  ${rel}${isDir ? '/' : ''}`;
}

function parseLine(line, lineNo) {
  const m = HEAD_RE.exec(line);
  if (!m) return null;
  let rel = line.slice(PATH_COLUMN);
  const isDir = rel.endsWith('/');
  if (isDir) rel = rel.slice(0, -1);
  if (!rel) return null;

  const [, day, hh, mm, ss, label] = m;
  const [y, mo, d] = day.split('-').map(Number);
  return {
    id: `${day}:${lineNo}`,
    line: lineNo,
    day,
    time: `${hh}:${mm}:${ss}`,
    ts: new Date(y, mo - 1, d, Number(hh), Number(mm), Number(ss)).getTime(),
    type: TYPES[label.trim()],
    path: rel,
    isDir,
  };
}

function splitLines(text) {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function localStamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return {
    day: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
  };
}

function localDay(ms = Date.now()) {
  return localStamp(ms).day;
}

module.exports = { ChangeLog, formatLine, parseLine, localDay, DAY_RE };
