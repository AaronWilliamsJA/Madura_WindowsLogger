'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const TICK_MS = 200;
const RETRY_MS = 5000;
const RESCAN_GAP_MS = 5000;
const ROOT_CHECK_MS = 3000;
const STAT_CONCURRENCY = 32;
const MAX_STAT_RETRIES = 3;

/**
 * Watches a folder tree and reports one clean change per real add, edit or delete.
 *
 * Windows sends several raw notifications per save, plus temp files and folder
 * timestamp bumps. Raw paths are queued and only examined once they have been
 * quiet for `settleMs`. The path's current state on disk is then compared with
 * an in-memory list of known paths (name, size, modified time) to decide what
 * happened. File contents are never read or stored.
 *
 * Events:
 *   'changes' -> Array<{ type: 'added'|'modified'|'deleted', path, isDir, at }>
 *   'state'   -> { state: 'scanning'|'watching'|'missing'|'error'|'stopped', message }
 *   'warn'    -> string
 */
class FolderWatcher extends EventEmitter {
  constructor({ root, ignore = [], ignorePatterns = [], settleMs = 1000, maxWaitMs = 30000 }) {
    super();
    this.root = path.resolve(root);
    this.settleMs = settleMs;
    this.maxWaitMs = maxWaitMs;

    this.ignored = [];
    this.rejectedIgnores = [];
    for (const entry of ignore) {
      const key = this._ignoreKey(entry);
      if (key) this.ignored.push(key);
      else this.rejectedIgnores.push(entry);
    }
    this.ignoredNames = ignorePatterns.map(globToRegExp);

    this.known = new Map(); // lower-case rel path -> { rel, isDir, size, mtimeMs }
    this.queue = new Map(); // lower-case rel path -> { rel, firstAt, lastAt, retryAt, tries }
    this.rescanWanted = false;
    this.lastRescanAt = 0;
    this.lastRootCheckAt = 0;
    this.current = null;

    this.fsWatcher = null;
    this.tickTimer = null;
    this.retryTimer = null;
    this.running = false;
    this.generation = 0;
    this.status = { state: 'stopped', message: '' };
  }

  get counts() {
    let files = 0;
    let folders = 0;
    for (const entry of this.known.values()) {
      if (entry.isDir) folders++;
      else files++;
    }
    return { files, folders };
  }

  async start() {
    if (this.running) return;
    this.running = true;
    await this._boot();
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    this.generation++;
    clearTimeout(this.retryTimer);
    this._stopTicking();
    this._closeFsWatcher();
    if (this.current) await this.current;

    // Report whatever was still settling instead of dropping it.
    if (this.status.state === 'watching' && this.queue.size) {
      const items = [...this.queue.values()];
      this.queue.clear();
      await this._settle(items).catch((err) => this.emit('warn', `Final flush failed: ${err.message}`));
    }
    this._setStatus('stopped', '');
  }

  async _boot() {
    clearTimeout(this.retryTimer);
    if (!this.running) return;
    const gen = ++this.generation;

    try {
      const st = await fsp.stat(this.root);
      if (!st.isDirectory()) throw Object.assign(new Error('not a folder'), { code: 'ENOTDIR' });
    } catch (err) {
      if (gen !== this.generation) return;
      const missing = err.code === 'ENOENT' || err.code === 'ENOTDIR';
      this._setStatus(missing ? 'missing' : 'error',
        missing ? `Folder not found: ${this.root}` : `Cannot open ${this.root}: ${err.message}`);
      this._retryLater();
      return;
    }

    try {
      this._setStatus('scanning', 'Reading folder');
      // Watch first so nothing changed during the scan slips through.
      this._openFsWatcher();
      const entries = await this._scan('');
      if (gen !== this.generation) return;
      this.known = new Map(entries.map((e) => [e.rel.toLowerCase(), e]));
      this.tickTimer = setInterval(() => this._tick(), TICK_MS);
      const { files, folders } = this.counts;
      this._setStatus('watching', `${files.toLocaleString('en-US')} files in ${folders.toLocaleString('en-US')} folders`);
    } catch (err) {
      if (gen === this.generation) this._fail(err);
    }
  }

  _fail(err) {
    if (!this.running) return;
    this.generation++;
    this._stopTicking();
    this._closeFsWatcher();
    this.queue.clear();
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      this._setStatus('missing', `Folder not found: ${this.root}`);
    } else {
      this._setStatus('error', `Watcher stopped (${err.code || err.message}). Retrying in ${RETRY_MS / 1000}s`);
    }
    this._retryLater();
  }

  _retryLater() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this._boot(), RETRY_MS);
  }

  _openFsWatcher() {
    this._closeFsWatcher();
    const watcher = fs.watch(this.root, { recursive: true, persistent: true });
    watcher.on('change', (_type, name) => this._onRaw(name));
    watcher.on('error', (err) => this._fail(err));
    this.fsWatcher = watcher;
  }

  _closeFsWatcher() {
    if (!this.fsWatcher) return;
    this.fsWatcher.removeAllListeners();
    this.fsWatcher.on('error', () => {});
    this.fsWatcher.close();
    this.fsWatcher = null;
  }

  _stopTicking() {
    clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  _onRaw(name) {
    // No name means Windows' notification buffer overflowed: compare the whole tree instead.
    if (name == null || name === '') {
      this.rescanWanted = true;
      return;
    }
    const rel = normalizeRel(String(name));
    if (!rel || this._isIgnored(rel)) return;

    const key = rel.toLowerCase();
    const now = Date.now();
    const item = this.queue.get(key);
    if (item) {
      item.rel = rel;
      item.lastAt = now;
      item.retryAt = 0;
    } else {
      this.queue.set(key, { rel, firstAt: now, lastAt: now, retryAt: 0, tries: 0 });
    }
  }

  _tick() {
    if (!this.running) return;
    const now = Date.now();

    // Windows keeps watching a folder that was renamed or moved away, so check the path itself.
    if (now - this.lastRootCheckAt >= ROOT_CHECK_MS) {
      this.lastRootCheckAt = now;
      const gen = this.generation;
      fsp.stat(this.root).then(
        (st) => { if (!st.isDirectory() && gen === this.generation) this._fail(Object.assign(new Error('not a folder'), { code: 'ENOTDIR' })); },
        (err) => { if (gen === this.generation) this._fail(err); },
      );
    }

    if (this.current) return;

    if (this.rescanWanted && now - this.lastRescanAt >= RESCAN_GAP_MS) {
      this.rescanWanted = false;
      this.lastRescanAt = now;
      this._run(() => this._reconcile());
      return;
    }

    const ready = [];
    for (const [key, item] of this.queue) {
      const due = item.retryAt
        ? now >= item.retryAt
        : now - item.lastAt >= this.settleMs || now - item.firstAt >= this.maxWaitMs;
      if (due && !this._waitsForNewParent(key)) {
        ready.push(item);
        this.queue.delete(key);
      }
    }
    if (ready.length) this._run(() => this._settle(ready));
  }

  // While a brand-new folder is still being filled, hold its contents back so the folder is logged first.
  _waitsForNewParent(key) {
    let slash = key.lastIndexOf('/');
    while (slash > 0) {
      const parent = key.slice(0, slash);
      if (this.queue.has(parent) && !this.known.has(parent)) return true;
      slash = key.lastIndexOf('/', slash - 1);
    }
    return false;
  }

  _run(task) {
    const gen = this.generation;
    this.current = task()
      .catch((err) => {
        if (gen !== this.generation) return;
        if (err.code === 'ENOENT' && err.path && path.resolve(err.path) === this.root) this._fail(err);
        else this.emit('warn', `Change check failed: ${err.message}`);
      })
      .finally(() => {
        this.current = null;
      });
    return this.current;
  }

  async _settle(items) {
    // Parents before children, so a folder that appeared or vanished accounts for its contents.
    items.sort((a, b) => depth(a.rel) - depth(b.rel) || compareRel(a.rel, b.rel));
    const changes = [];
    for (const item of items) await this._settleOne(item, changes);
    this._emit(changes);
  }

  async _settleOne(item, out) {
    const { rel, lastAt: at } = item;
    const key = rel.toLowerCase();
    let prev = this.known.get(key);

    let st;
    try {
      st = await lstatOrNull(this._abs(rel));
    } catch (err) {
      // Locked or pending-delete files: look again shortly rather than guess.
      if (item.tries < MAX_STAT_RETRIES && !this.queue.has(key)) {
        this.queue.set(key, { ...item, tries: item.tries + 1, retryAt: Date.now() + this.settleMs });
      } else if (item.tries >= MAX_STAT_RETRIES) {
        this.emit('warn', `Cannot read ${rel}: ${err.code || err.message}`);
      }
      return;
    }

    if (!st) {
      // Gone. If it was never known, it was a temp file created and removed in one go.
      if (prev) this._forget(prev, at, out);
      return;
    }

    const isDir = st.isDirectory();
    if (prev && prev.isDir !== isDir) {
      this._forget(prev, at, out);
      prev = undefined;
    }

    if (!prev) {
      this.known.set(key, { rel, isDir, size: isDir ? 0 : st.size, mtimeMs: isDir ? 0 : st.mtimeMs });
      out.push(change('added', rel, isDir, at));
      if (isDir) await this._learnContents(rel, at, out);
      return;
    }

    // A folder's own timestamp moves whenever its contents change; the contents report themselves.
    if (isDir) return;

    if (st.size !== prev.size || st.mtimeMs !== prev.mtimeMs) {
      prev.size = st.size;
      prev.mtimeMs = st.mtimeMs;
      out.push(change('modified', prev.rel, false, at));
    }
  }

  // A folder moved or copied in: Windows may only report the folder, so list what it holds.
  async _learnContents(dirRel, at, out) {
    const skipQueued = (rel) => this.queue.has(rel.toLowerCase());
    const entries = await this._scan(dirRel, skipQueued);
    entries.sort((a, b) => compareRel(a.rel, b.rel));
    for (const entry of entries) {
      const key = entry.rel.toLowerCase();
      if (this.known.has(key)) continue;
      this.known.set(key, entry);
      out.push(change('added', entry.rel, entry.isDir, at));
    }
  }

  _forget(entry, at, out) {
    const key = entry.rel.toLowerCase();
    this.known.delete(key);
    out.push(change('deleted', entry.rel, entry.isDir, at));
    if (!entry.isDir) return;

    const prefix = `${key}/`;
    const inside = [];
    for (const [k, e] of this.known) {
      if (k.startsWith(prefix)) inside.push(e);
    }
    inside.sort((a, b) => compareRel(a.rel, b.rel));
    for (const e of inside) {
      this.known.delete(e.rel.toLowerCase());
      out.push(change('deleted', e.rel, e.isDir, at));
    }
  }

  async _reconcile() {
    const at = Date.now();
    const entries = await this._scan('');
    const next = new Map(entries.map((e) => [e.rel.toLowerCase(), e]));
    const changes = [];

    for (const [key, prev] of this.known) {
      const cur = next.get(key);
      if (!cur || cur.isDir !== prev.isDir) changes.push(change('deleted', prev.rel, prev.isDir, at));
      else if (!cur.isDir && (cur.size !== prev.size || cur.mtimeMs !== prev.mtimeMs)) {
        changes.push(change('modified', cur.rel, false, at));
      }
    }
    for (const [key, cur] of next) {
      const prev = this.known.get(key);
      if (!prev || prev.isDir !== cur.isDir) changes.push(change('added', cur.rel, cur.isDir, at));
    }

    // Queued raw events are compared against this fresh list when they settle, so nothing doubles up.
    this.known = next;
    changes.sort((a, b) => depth(a.path) - depth(b.path) || compareRel(a.path, b.path));
    this._emit(changes);
  }

  async _scan(baseRel, skip) {
    const found = [];
    const dirs = [baseRel];
    while (dirs.length) {
      const dirRel = dirs.pop();
      let dirents;
      try {
        dirents = await fsp.readdir(this._abs(dirRel), { withFileTypes: true });
      } catch (err) {
        if (dirRel === '') throw err;
        continue; // a subfolder vanished or is unreadable mid-scan
      }

      const files = [];
      for (const d of dirents) {
        const rel = dirRel ? `${dirRel}/${d.name}` : d.name;
        if (this._isIgnored(rel) || (skip && skip(rel))) continue;
        // Junctions and symlinks are recorded but never followed, so loops are impossible.
        if (d.isDirectory()) {
          found.push({ rel, isDir: true, size: 0, mtimeMs: 0 });
          dirs.push(rel);
        } else {
          files.push(rel);
        }
      }

      await forEachLimit(files, STAT_CONCURRENCY, async (rel) => {
        try {
          const st = await fsp.lstat(this._abs(rel));
          found.push({ rel, isDir: false, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          // removed between listing and stat
        }
      });
    }
    return found;
  }

  _isIgnored(rel) {
    const key = rel.toLowerCase();
    for (const ignored of this.ignored) {
      if (key === ignored || key.startsWith(`${ignored}/`)) return true;
    }
    if (this.ignoredNames.length) {
      for (const segment of rel.split('/')) {
        if (this.ignoredNames.some((re) => re.test(segment))) return true;
      }
    }
    return false;
  }

  _ignoreKey(entry) {
    const abs = path.isAbsolute(entry) ? path.resolve(entry) : path.resolve(this.root, entry);
    const rel = path.relative(this.root, abs);
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
    return normalizeRel(rel).toLowerCase();
  }

  _abs(rel) {
    return rel ? path.join(this.root, rel) : this.root;
  }

  _emit(changes) {
    if (changes.length) this.emit('changes', changes);
  }

  _setStatus(state, message) {
    if (this.status.state === state && this.status.message === message) return;
    this.status = { state, message };
    this.emit('state', this.status);
  }
}

function change(type, rel, isDir, at) {
  return { type, path: rel, isDir, at };
}

function normalizeRel(p) {
  return p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function depth(rel) {
  let n = 0;
  for (let i = 0; i < rel.length; i++) if (rel.charCodeAt(i) === 47) n++;
  return n;
}

function compareRel(a, b) {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

async function lstatOrNull(abs) {
  try {
    return await fsp.lstat(abs);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

async function forEachLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

function globToRegExp(glob) {
  const source = glob
    .split('')
    .map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${source}$`, 'i');
}

module.exports = { FolderWatcher };
