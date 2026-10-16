'use strict';

(() => {
  const PAGE_SIZE = 150;
  const MAX_CHILD_ROWS = 1000;
  const GROUP_WINDOW_MS = 2 * 60 * 1000;
  const FRESH_MS = 2600;
  const THEME_KEY = 'madura-logger-theme';
  const TYPES = ['added', 'modified', 'deleted'];
  const TYPE_LABEL = { added: 'Added', modified: 'Modified', deleted: 'Deleted' };
  const TYPE_ICON = { added: 'plus', modified: 'pencil', deleted: 'trash' };
  const STATUS_LABEL = {
    watching: 'Live',
    scanning: 'Scanning',
    missing: 'Folder not found',
    error: 'Watcher error',
    stopped: 'Stopped',
  };
  const FILE_KINDS = {
    lua: 'Lua script', js: 'JavaScript', ts: 'TypeScript', json: 'JSON data', cfg: 'Config file',
    html: 'HTML page', css: 'Stylesheet', sql: 'SQL script', txt: 'Text file', md: 'Markdown',
    xml: 'XML data', meta: 'Game metadata', yml: 'YAML config', yaml: 'YAML config', ini: 'Config file',
    yft: 'Vehicle / model', ytd: 'Texture dictionary', ydr: 'Model', ybn: 'Collision',
    ymap: 'Map placement', ytyp: 'Archetype definitions', ycd: 'Animation', awc: 'Audio',
    png: 'PNG image', jpg: 'JPEG image', jpeg: 'JPEG image', webp: 'WebP image', gif: 'GIF image',
    svg: 'SVG image', ogg: 'Audio', mp3: 'Audio', wav: 'Audio', zip: 'ZIP archive', rar: 'RAR archive',
    dll: 'Library', exe: 'Program', log: 'Log file', bat: 'Batch script', ps1: 'PowerShell script',
  };

  const ICONS = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    pencil: '<path d="M15.5 4.5l4 4L9 19H5v-4L15.5 4.5z"/><path d="M13 7l4 4"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V4.5h6V7"/><path d="M6.5 7l1 12.5h9l1-12.5"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    'chevron-left': '<path d="M15 6l-6 6 6 6"/>',
    'chevron-right': '<path d="M9 6l6 6-6 6"/>',
    'chevron-down': '<path d="M6 9l6 6 6-6"/>',
    x: '<path d="M18 6L6 18M6 6l12 12"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6L6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    'arrow-up': '<path d="M12 19V5M5.5 11.5L12 5l6.5 6.5"/>',
    alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
    ban: '<circle cx="12" cy="12" r="8"/><path d="M6.5 6.5l11 11"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v4h-4"/>',
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    live: $('live'),
    liveLabel: $('live-label'),
    liveSub: $('live-sub'),
    themeToggle: $('theme-toggle'),
    watchPath: $('watch-path'),
    ignoredGroup: $('ignored-group'),
    ignoredChips: $('ignored-chips'),
    eyebrow: $('day-eyebrow'),
    heading: $('day-heading'),
    summary: $('day-summary'),
    dayPrev: $('day-prev'),
    dayNext: $('day-next'),
    daySelect: $('day-select'),
    search: $('search'),
    segs: [...document.querySelectorAll('.seg__btn')],
    counts: {
      all: $('count-all'),
      added: $('count-added'),
      modified: $('count-modified'),
      deleted: $('count-deleted'),
    },
    banner: $('banner'),
    bannerTitle: $('banner-title'),
    bannerText: $('banner-text'),
    bannerAction: $('banner-action'),
    feed: $('feed'),
    newPill: $('new-pill'),
    newPillText: $('new-pill-text'),
  };

  const state = {
    status: null,
    connected: false,
    today: dayKey(new Date()),
    requestedDay: null,
    days: [],
    day: null,
    events: [],
    byId: new Map(),
    loading: true,
    loadError: null,
    filter: 'all',
    query: '',
    items: [],
    visibleTotal: 0,
    shown: PAGE_SIZE,
    openId: null,
    expanded: new Set(),
    history: new Map(),
    fresh: new Map(),
    unseen: 0,
    loadToken: 0,
  };

  const nf = new Intl.NumberFormat();
  const thisYear = new Date().getFullYear();
  const headingFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const headingYearFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const optionFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const optionYearFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const exactFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const shortFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  // ---------- DOM helpers ----------

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value == null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value === true ? '' : value);
      }
    }
    for (const child of children.flat(Infinity)) {
      if (child == null || child === false) continue;
      node.append(child instanceof Node ? child : String(child));
    }
    return node;
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = ICONS[name]; // fixed markup from ICONS only, never data
    return svg;
  }

  function chip(type, size) {
    return h('span', { class: `chip${size ? ` chip--${size}` : ''}`, 'aria-hidden': 'true' }, icon(TYPE_ICON[type]));
  }

  // ---------- Formatting ----------

  function dayKey(date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
  }

  function parseDay(day) {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function shiftDay(day, delta) {
    const date = parseDay(day);
    date.setDate(date.getDate() + delta);
    return dayKey(date);
  }

  function daysBetween(a, b) {
    return Math.round((parseDay(b) - parseDay(a)) / 86400000);
  }

  function relativeDay(day) {
    if (day === state.today) return 'Today';
    if (day === shiftDay(state.today, -1)) return 'Yesterday';
    const text = rtf.format(-daysBetween(day, state.today), 'day');
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function optionLabel(d) {
    const date = parseDay(d.day);
    let name = (date.getFullYear() === thisYear ? optionFmt : optionYearFmt).format(date);
    if (d.day === state.today) name = 'Today';
    else if (d.day === shiftDay(state.today, -1)) name = 'Yesterday';
    return `${name} · ${plural(d.count, 'change')}`;
  }

  function historyDay(day) {
    if (day === state.today) return 'Today';
    if (day === shiftDay(state.today, -1)) return 'Yesterday';
    return shortFmt.format(parseDay(day));
  }

  function relative(ts) {
    const seconds = (ts - Date.now()) / 1000;
    const abs = Math.abs(seconds);
    if (abs < 45) return 'just now';
    if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(seconds / 3600), 'hour');
    return rtf.format(Math.round(seconds / 86400), 'day');
  }

  function plural(n, word) {
    return `${nf.format(n)} ${n === 1 ? word : `${word}s`}`;
  }

  const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
  const dirName = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const toWindows = (p) => p.replace(/\//g, '\\');

  function extension(p) {
    const name = baseName(p);
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  }

  function fileKind(ext) {
    if (!ext) return 'No extension';
    return Object.prototype.hasOwnProperty.call(FILE_KINDS, ext) ? FILE_KINDS[ext] : 'File';
  }

  function fullPath(rel) {
    const root = state.status ? state.status.watchPath.replace(/[\\/]+$/, '') : '';
    return root ? `${root}\\${toWindows(rel)}` : toWindows(rel);
  }

  function friendlyError(err) {
    return err instanceof TypeError
      ? 'The logger service is not reachable. Check that it is running.'
      : err.message;
  }

  // ---------- Theme ----------

  function effectiveTheme() {
    return document.documentElement.dataset.theme || (darkQuery.matches ? 'dark' : 'light');
  }

  function renderThemeButton() {
    const dark = effectiveTheme() === 'dark';
    const label = dark ? 'Switch to light theme' : 'Switch to dark theme';
    el.themeToggle.replaceChildren(icon(dark ? 'sun' : 'moon'));
    el.themeToggle.setAttribute('aria-label', label);
    el.themeToggle.title = label;
  }

  function toggleTheme() {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // not saved; still applies for this visit
    }
    renderThemeButton();
  }

  // ---------- Data ----------

  async function api(url) {
    const res = await fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`The server answered ${res.status}.`);
    return res.json();
  }

  async function loadDays() {
    const data = await api('/api/days');
    state.today = data.today;
    state.days = data.days;
    ensureDay(state.today);
    if (state.day) ensureDay(state.day);
    renderDays();
  }

  function ensureDay(day) {
    if (state.days.some((d) => d.day === day)) return;
    state.days.push({ day, count: 0 });
    state.days.sort((a, b) => (a.day < b.day ? 1 : -1));
  }

  function selectDay(day) {
    if (day === state.day) return;
    state.day = day;
    state.events = [];
    state.byId.clear();
    state.fresh.clear();
    state.expanded.clear();
    state.openId = null;
    state.unseen = 0;
    state.shown = PAGE_SIZE;
    ensureDay(day);
    renderDays();
    syncUrl();
    window.scrollTo({ top: 0 });
    loadEvents();
  }

  async function loadEvents() {
    const token = ++state.loadToken;
    const day = state.day;
    state.loading = true;
    state.loadError = null;
    renderAll();
    try {
      const data = await api(`/api/events?day=${encodeURIComponent(day)}`);
      if (token !== state.loadToken) return;
      for (const event of data.events) addEvent(event);
      sortEvents();
      state.loading = false;
      renderAll();
    } catch (err) {
      if (token !== state.loadToken) return;
      state.loading = false;
      state.loadError = friendlyError(err);
      renderAll();
    }
  }

  async function refreshAll() {
    state.history.clear();
    try {
      await loadDays();
    } catch (err) {
      state.loadError = friendlyError(err);
      renderBanner();
      return;
    }
    await loadEvents();
  }

  function addEvent(event) {
    if (state.byId.has(event.id)) return false;
    event.lowerPath = event.path.toLowerCase();
    state.byId.set(event.id, event);
    state.events.push(event);
    return true;
  }

  function sortEvents() {
    state.events.sort((a, b) => b.ts - a.ts || b.line - a.line);
  }

  async function loadHistory(path) {
    const key = path.toLowerCase();
    const cached = state.history.get(key);
    if (cached && cached.status !== 'error') return;
    state.history.set(key, { status: 'loading' });
    try {
      const data = await api(`/api/history?path=${encodeURIComponent(path)}`);
      state.history.set(key, { status: 'ready', events: data.events });
    } catch (err) {
      state.history.set(key, { status: 'error', message: friendlyError(err) });
    }
    renderHistoryInto(path);
  }

  // ---------- Live stream ----------

  function connectStream(resync = false) {
    const source = new EventSource('/api/stream');
    let dropped = resync;

    source.addEventListener('open', () => {
      state.connected = true;
      renderStatus();
      if (dropped) {
        dropped = false;
        refreshAll(); // fill in anything that happened while disconnected
      }
    });

    source.addEventListener('error', () => {
      dropped = true;
      if (state.connected) {
        state.connected = false;
        renderStatus();
      }
      if (source.readyState === EventSource.CLOSED) {
        source.close();
        setTimeout(() => connectStream(true), 5000);
      }
    });

    source.addEventListener('status', (msg) => {
      state.status = JSON.parse(msg.data);
      renderStatus();
    });

    source.addEventListener('changes', (msg) => onLiveChanges(JSON.parse(msg.data)));
  }

  function onLiveChanges(entries) {
    let added = 0;
    for (const entry of entries) {
      if (entry.day > state.today) rollDay(entry.day);
      state.history.delete(entry.path.toLowerCase());
      const day = state.days.find((d) => d.day === entry.day);
      if (day) day.count++;
      else {
        state.days.push({ day: entry.day, count: 1 });
        state.days.sort((a, b) => (a.day < b.day ? 1 : -1));
      }
      if (entry.day === state.day && addEvent(entry)) {
        state.fresh.set(entry.id, performance.now());
        added++;
      }
    }
    renderDays();
    if (!added) return;
    sortEvents();
    if (state.openId) {
      const open = state.byId.get(state.openId);
      if (open) loadHistory(open.path);
    }
    scheduleLiveRender();
  }

  function rollDay(newToday) {
    const wasOnToday = state.day === state.today;
    state.today = newToday;
    ensureDay(newToday);
    if (wasOnToday) selectDay(newToday);
  }

  let liveRenderQueued = false;
  function scheduleLiveRender() {
    if (liveRenderQueued) return;
    liveRenderQueued = true;
    requestAnimationFrame(() => {
      liveRenderQueued = false;
      // Grow the page only by the cards that actually became visible, so filters and folder groups don't skew it.
      const before = state.items.length;
      const grew = Math.max(0, computeView().items.length - before);
      state.shown += grew;
      if (grew && window.scrollY > 240) state.unseen += grew;
      renderAll({ anchor: true });
    });
  }

  // ---------- View model ----------

  function computeView() {
    const q = state.query.replace(/\\/g, '/');
    const matching = q ? state.events.filter((e) => e.lowerPath.includes(q)) : state.events;
    const counts = { all: matching.length, added: 0, modified: 0, deleted: 0 };
    for (const e of matching) counts[e.type]++;
    const visible = state.filter === 'all' ? matching : matching.filter((e) => e.type === state.filter);
    return { counts, visible, items: groupFolders(visible) };
  }

  // A folder moved, copied or deleted shows as one card, with what was inside it tucked underneath.
  function groupFolders(events) {
    const folders = new Map();
    for (const e of events) {
      if (!e.isDir || e.type === 'modified') continue;
      const key = `${e.type}|${e.lowerPath}`;
      if (!folders.has(key)) folders.set(key, []);
      folders.get(key).push(e);
    }
    if (!folders.size) return events.map((event) => ({ event, children: null }));

    const parentOf = new Map();
    for (const e of events) {
      let slash = e.lowerPath.indexOf('/');
      while (slash > 0) {
        const candidates = folders.get(`${e.type}|${e.lowerPath.slice(0, slash)}`);
        const match = candidates && closestInTime(candidates, e.ts);
        if (match) {
          parentOf.set(e.id, match); // shortest prefix first, so this is the outermost folder
          break;
        }
        slash = e.lowerPath.indexOf('/', slash + 1);
      }
    }

    const children = new Map();
    for (const e of events) {
      let parent = parentOf.get(e.id);
      if (!parent) continue;
      while (parentOf.has(parent.id)) parent = parentOf.get(parent.id);
      if (!children.has(parent.id)) children.set(parent.id, []);
      children.get(parent.id).push(e);
    }

    const items = [];
    for (const e of events) {
      if (parentOf.has(e.id)) continue;
      const inside = children.get(e.id);
      items.push({ event: e, children: inside ? inside.sort((a, b) => (a.lowerPath < b.lowerPath ? -1 : 1)) : null });
    }
    return items;
  }

  function closestInTime(candidates, ts) {
    let best = null;
    for (const c of candidates) {
      const gap = Math.abs(c.ts - ts);
      if (gap <= GROUP_WINDOW_MS && (!best || gap < Math.abs(best.ts - ts))) best = c;
    }
    return best;
  }

  function itemSize(item) {
    return 1 + (item.children ? item.children.length : 0);
  }

  // ---------- Rendering: page ----------

  function renderAll({ anchor = false, focusId = null } = {}) {
    // A rebuild replaces every node: remember what the reader had focused and how far folder lists were scrolled.
    const active = document.activeElement;
    if (!focusId && active && el.feed.contains(active)) {
      const holder = active.closest('[data-focus]');
      if (holder) focusId = holder.dataset.focus;
    }
    const kidScroll = new Map();
    for (const list of el.feed.querySelectorAll('.kids')) {
      if (list.scrollTop) kidScroll.set(list.closest('.card').dataset.id, list.scrollTop);
    }
    const mark = anchor ? captureAnchor(focusId) : null;
    const view = computeView();

    for (const key of Object.keys(el.counts)) el.counts[key].textContent = nf.format(view.counts[key]);
    for (const btn of el.segs) btn.setAttribute('aria-checked', String(btn.dataset.filter === state.filter));

    state.items = view.items;
    state.visibleTotal = view.visible.length;
    renderHero();
    renderFeed();
    for (const [id, top] of kidScroll) {
      const list = el.feed.querySelector(`.card[data-id="${CSS.escape(id)}"] .kids`);
      if (list) list.scrollTop = top;
    }
    for (const btn of el.segs) btn.tabIndex = btn.dataset.filter === state.filter ? 0 : -1;
    if (mark) restoreAnchor(mark);
    if (focusId) {
      const head = el.feed.querySelector(`[data-focus="${CSS.escape(focusId)}"]`);
      if (head) head.focus({ preventScroll: true });
    }
    renderStatus();
    renderNewPill();
  }

  function renderHero() {
    if (!state.day) return;
    const date = parseDay(state.day);
    el.eyebrow.textContent = relativeDay(state.day);
    el.heading.textContent = (date.getFullYear() === thisYear ? headingFmt : headingYearFmt).format(date);

    const totals = { added: 0, modified: 0, deleted: 0 };
    for (const e of state.events) totals[e.type]++;
    const n = state.events.length;
    const isToday = state.day === state.today;

    if (state.loading && !n) {
      el.summary.replaceChildren('Loading changes…');
    } else if (!n) {
      el.summary.replaceChildren(isToday ? 'Nothing has changed yet today.' : 'Nothing changed on this day.');
    } else {
      const strong = (text) => h('strong', null, text);
      el.summary.replaceChildren(
        strong(plural(n, 'change')),
        isToday ? ' so far — ' : ' — ',
        strong(nf.format(totals.added)), ' added, ',
        strong(nf.format(totals.modified)), ' modified and ',
        strong(nf.format(totals.deleted)), ' deleted.');
    }
    document.title = isToday ? 'Madura Logger' : `${optionFmt.format(date)} · Madura Logger`;
  }

  function renderDays() {
    el.daySelect.replaceChildren(...state.days.map((d) => h('option', { value: d.day }, optionLabel(d))));
    if (state.day) el.daySelect.value = state.day;
    const i = state.days.findIndex((d) => d.day === state.day);
    el.dayPrev.disabled = i < 0 || i >= state.days.length - 1;
    el.dayNext.disabled = i <= 0;
    if (!el.dayPrev.disabled) el.dayPrev.setAttribute('aria-label', `Previous day, ${optionFmt.format(parseDay(state.days[i + 1].day))}`);
    else el.dayPrev.setAttribute('aria-label', 'Previous day');
    if (!el.dayNext.disabled) el.dayNext.setAttribute('aria-label', `Next day, ${optionFmt.format(parseDay(state.days[i - 1].day))}`);
    else el.dayNext.setAttribute('aria-label', 'Next day');
  }

  function renderStatus() {
    let key;
    let label;
    let sub = '';
    let title = '';
    if (!state.connected) {
      key = state.status ? 'offline' : 'connecting';
      label = state.status ? 'Reconnecting' : 'Connecting';
    } else if (state.status) {
      key = state.status.state;
      label = STATUS_LABEL[key] || key;
      title = state.status.message || '';
      if (key === 'watching') {
        const last = state.events.length && state.day === state.today ? state.events[0].time : '';
        sub = last ? `last change ${last}` : '';
      }
    } else {
      key = 'connecting';
      label = 'Connecting';
    }
    el.live.dataset.state = key;
    el.liveLabel.textContent = label;
    el.liveSub.textContent = sub;
    el.live.title = title;

    if (state.status) {
      el.watchPath.textContent = state.status.watchPath;
      const ignored = state.status.ignored || [];
      el.ignoredGroup.hidden = !ignored.length;
      el.ignoredChips.replaceChildren(...ignored.map((p) => h('span', { class: 'ignored-chip' }, p)));
    }
    renderBanner();
    if (el.feed.querySelector('.tl-row--now')) renderNowRow();
  }

  function renderBanner() {
    const s = state.status;
    if (state.loadError) return showBanner('error', 'Could not load changes', state.loadError, refreshAll);
    if (!state.connected && s) {
      return showBanner('warn', 'Connection lost', 'Reconnecting to the logger service. Changes made meanwhile are still being recorded.');
    }
    if (s && s.state === 'missing') {
      return showBanner('error', 'Watched folder not found',
        `${s.watchPath} does not exist on this machine. Watching starts by itself as soon as it does.`);
    }
    if (s && s.state === 'error') return showBanner('error', 'The watcher stopped', s.message);
    el.banner.hidden = true;
    return undefined;
  }

  function showBanner(kind, title, text, retry) {
    el.banner.hidden = false;
    el.banner.classList.toggle('banner--warn', kind === 'warn');
    el.bannerTitle.textContent = title;
    el.bannerText.textContent = text;
    el.bannerAction.hidden = !retry;
    el.bannerAction.onclick = retry || null;
  }

  function renderNewPill() {
    if (window.scrollY < 120) state.unseen = 0;
    el.newPill.hidden = state.unseen === 0;
    el.newPillText.textContent = plural(state.unseen, 'new change');
  }

  // Keep what the reader is looking at still while the feed is rebuilt: the clicked control when
  // there is one, otherwise the first card on screen. At the top of the page new cards simply push in.
  function captureAnchor(focusId) {
    if (focusId) {
      const target = el.feed.querySelector(`[data-focus="${CSS.escape(focusId)}"]`);
      if (target) return { selector: `[data-focus="${CSS.escape(focusId)}"]`, top: target.getBoundingClientRect().top };
    }
    if (window.scrollY < 120) return null;
    for (const card of el.feed.querySelectorAll('.card')) {
      const rect = card.getBoundingClientRect();
      if (rect.bottom > 24) return { selector: `.card[data-id="${CSS.escape(card.dataset.id)}"]`, top: rect.top };
    }
    return null;
  }

  function restoreAnchor(anchor) {
    const node = el.feed.querySelector(anchor.selector);
    if (node) window.scrollBy(0, node.getBoundingClientRect().top - anchor.top);
  }

  // ---------- Rendering: timeline ----------

  function renderFeed() {
    const parts = [];
    const isToday = state.day === state.today;
    if (isToday && !state.loadError) parts.push(nowRow());

    if (state.loading && !state.events.length) {
      parts.push(h('div', { class: 'tl-list', 'aria-busy': 'true', 'aria-label': 'Loading changes' },
        Array.from({ length: 5 }, () => row(h('div', { class: 'tl-time' }), rail(), h('div', { class: 'tl-body' }, h('div', { class: 'skeleton' }))))));
      el.feed.replaceChildren(...parts);
      return;
    }

    if (!state.items.length) {
      if (!(state.loadError && !state.events.length)) {
        parts.push(row(h('div', { class: 'tl-time' }), rail(), h('div', { class: 'tl-body' }, emptyState())));
      }
      el.feed.replaceChildren(...parts);
      return;
    }

    const slice = state.items.slice(0, Math.min(state.shown, state.items.length));
    let shownCount = 0;
    let hour = null;
    let list = null;
    for (const item of slice) {
      const itemHour = item.event.time.slice(0, 2);
      if (itemHour !== hour) {
        hour = itemHour;
        list = h('ol', { class: 'tl-list' });
        const first = !parts.some((p) => p.tagName === 'SECTION');
        parts.push(h('section', { 'aria-labelledby': `hour-${hour}` },
          h('div', { class: `tl-row tl-row--hour${first ? ' tl-row--first' : ''}` },
            h('div', { class: 'tl-time tl-time--hour' }, h('h2', { id: `hour-${hour}`, class: 'visually-hidden' }, `${hour}:00`), h('span', { 'aria-hidden': 'true' }, `${hour}:00`)),
            rail(h('span', { class: 'tl-dot tl-dot--hour' })),
            h('div', { class: 'tl-body tl-body--hour', 'aria-hidden': 'true' })),
          list));
      }
      list.append(itemRow(item));
      shownCount += itemSize(item);
    }

    const more = slice.length < state.items.length;
    parts.push(row(h('div', { class: 'tl-time' }),
      h('div', { class: 'tl-rail tl-rail--end', 'aria-hidden': 'true' }, h('span', { class: 'tl-dot tl-dot--end' })),
      h('div', { class: 'tl-body tl-body--end' },
        more ? h('button', { class: 'btn', type: 'button', onclick: showMore }, icon('chevron-down'), 'Show earlier changes') : null,
        h('p', null, `Showing ${nf.format(shownCount)} of ${plural(state.visibleTotal, 'change')}${isToday ? ' from today' : ''}`))));

    el.feed.replaceChildren(...parts);
  }

  function row(...cells) {
    return h('div', { class: 'tl-row' }, cells);
  }

  function rail(...dots) {
    return h('div', { class: 'tl-rail', 'aria-hidden': 'true' }, dots);
  }

  function nowRow() {
    const node = h('div', { class: 'tl-row tl-row--now' });
    fillNowRow(node);
    return node;
  }

  function renderNowRow() {
    const node = el.feed.querySelector('.tl-row--now');
    if (node) fillNowRow(node);
  }

  function fillNowRow(node) {
    const live = state.connected && state.status && state.status.state === 'watching';
    const label = live ? 'Live' : state.connected && state.status ? STATUS_LABEL[state.status.state] || 'Paused' : 'Reconnecting';
    node.replaceChildren(
      h('div', { class: 'tl-time tl-time--now' }, 'Now'),
      h('div', { class: 'tl-rail tl-rail--now', 'aria-hidden': 'true' }, h('span', { class: `tl-dot tl-dot--now${live ? '' : ' is-off'}` })),
      h('p', { class: `tl-body tl-body--now${live ? '' : ' is-off'}` }, h('strong', null, label),
        live ? ' · new changes appear here as they happen' : ' · changes will appear once the watcher is back'));
  }

  function showMore() {
    state.shown += PAGE_SIZE;
    renderAll({ anchor: true });
  }

  function itemRow(item) {
    const e = item.event;
    const open = state.openId === e.id || (item.children && state.expanded.has(e.id));
    return h('li', { class: 'tl-row' },
      h('div', { class: `tl-time${open ? ' is-strong' : ''}` }, h('time', { datetime: `${e.day}T${e.time}` }, e.time)),
      rail(h('span', { class: `tl-dot tl-dot--event t-${e.type}${open ? ' is-open' : ''}` })),
      h('div', { class: 'tl-body' }, renderCard(item)));
  }

  function renderCard(item) {
    const { event: e, children } = item;
    const isGroup = Boolean(children);
    const open = isGroup ? state.expanded.has(e.id) : state.openId === e.id;
    const childOpen = isGroup && open ? children.find((c) => c.id === state.openId) : null;
    const panelId = `panel-${e.id.replace(/[^a-z0-9]/gi, '-')}`;
    const dir = dirName(e.path);
    const name = e.isDir ? `${baseName(e.path)}/` : baseName(e.path);

    const card = h('article', {
      class: `card t-${e.type}${open ? ' is-open' : ''}`,
      dataset: { id: e.id },
    });

    const born = state.fresh.get(e.id);
    if (born != null) {
      const age = performance.now() - born;
      if (age < FRESH_MS) {
        card.classList.add('is-new');
        card.style.animationDelay = `-${Math.round(age)}ms, -${Math.round(age)}ms`;
      } else {
        state.fresh.delete(e.id);
      }
    }

    card.append(h('button', {
      class: 'card__head',
      type: 'button',
      'aria-expanded': String(open),
      'aria-controls': open ? panelId : null,
      dataset: { focus: e.id },
      onclick: () => (isGroup ? toggleFolder(e, children) : toggleOpen(e)),
    },
      h('span', { class: 'card__type' }, chip(e.type), h('span', { class: 'card__label' }, TYPE_LABEL[e.type])),
      h('span', { class: 'card__path' },
        e.isDir ? h('span', { class: 'card__folder' }, icon('folder')) : null,
        h('span', { class: 'card__pathtext', title: e.path },
          dir ? h('span', { class: 'card__dir' }, `${dir}/`) : null,
          h('span', { class: `card__name${e.type === 'deleted' ? ' is-deleted' : ''}` }, name)),
        dir ? null : h('span', { class: 'card__top' }, 'top level')),
      isGroup ? h('span', { class: 'card__count' }, `${plural(children.length, 'item')} inside`) : null,
      h('span', { class: `card__chev${open ? ' is-up' : ''}` }, icon('chevron-down'))));

    if (isGroup && open) {
      card.append(childList(e, children, panelId));
      if (childOpen) card.append(details(childOpen, `${panelId}-detail`));
    } else if (open) {
      card.append(details(e, panelId));
    }
    return card;
  }

  function childList(folder, children, id) {
    const rows = children.slice(0, MAX_CHILD_ROWS).map((c) => {
      const rel = c.path.slice(folder.path.length + 1);
      const inner = dirName(rel);
      const open = state.openId === c.id;
      return h('li', null, h('button', {
        class: `kid${open ? ' is-open' : ''}`,
        type: 'button',
        'aria-expanded': String(open),
        'aria-controls': open ? `${id}-detail` : null,
        dataset: { focus: c.id },
        onclick: () => toggleOpen(c, folder.id),
      },
        h('span', { class: 'kid__icon' }, icon(c.isDir ? 'folder' : 'file')),
        h('span', { class: 'kid__path' }, inner ? h('span', null, `${inner}/`) : null, baseName(rel) + (c.isDir ? '/' : '')),
        c.time !== folder.time ? h('span', { class: 'kid__time' }, c.time) : null,
        h('span', { class: 'kid__type' }, TYPE_LABEL[c.type])));
    });
    if (children.length > MAX_CHILD_ROWS) {
      rows.push(h('li', { class: 'kids__more' }, `and ${plural(children.length - MAX_CHILD_ROWS, 'more item')}`));
    }
    return h('ul', { class: 'kids', id, 'aria-label': `Items inside ${baseName(folder.path)}/` }, rows);
  }

  function details(e, id) {
    const dir = dirName(e.path);
    const ext = extension(e.path);
    const name = e.isDir ? `${baseName(e.path)}/` : baseName(e.path);
    const where = fullPath(e.path) + (e.isDir ? '\\' : '');
    const kind = e.isDir ? 'Folder' : 'File';
    const fact = (label, ...value) => h('div', null, h('dt', null, label), h('dd', null, value));

    const panel = h('div', { class: `details t-${e.type}`, id, role: 'region', 'aria-label': `Details for ${name}` },
      h('h3', { class: 'details__name' }, name),
      h('p', { class: 'details__sub' }, h('strong', null, TYPE_LABEL[e.type]), ' · ', h('span', { dataset: { rel: e.ts } }, relative(e.ts))),
      h('div', { class: 'details__label' }, 'Full path'),
      h('div', { class: 'pathrow' }, h('code', { class: 'pathbox' }, where), copyButton(where)),
      h('div', { class: 'details__cols' },
        h('dl', { class: 'facts' },
          fact('Change type', chip(e.type, 'xs'), TYPE_LABEL[e.type]),
          fact('Kind', kind),
          fact('Exact time', h('span', { class: 'mono' }, e.time), ' · ', exactFmt.format(parseDay(e.day))),
          fact('Relative time', h('span', { dataset: { rel: e.ts } }, relative(e.ts))),
          fact('Parent folder', h('span', { class: 'mono' }, dir ? `${dir}/` : 'Top level')),
          e.isDir ? null : fact('File type', fileKind(ext), ext ? h('span', { class: 'mono note' }, `.${ext}`) : null)),
        h('div', { class: 'history' },
          h('h4', null, 'History of this path'),
          h('ol', { dataset: { history: e.path.toLowerCase(), current: e.id } }))));

    fillHistory(panel.querySelector('ol'), e);
    loadHistory(e.path);
    return panel;
  }

  function renderHistoryInto(path) {
    const key = path.toLowerCase();
    for (const list of el.feed.querySelectorAll('ol[data-history]')) {
      if (list.dataset.history !== key) continue;
      const current = state.byId.get(list.dataset.current);
      if (current) fillHistory(list, current);
    }
  }

  function fillHistory(list, current) {
    const entry = state.history.get(current.path.toLowerCase());
    if (!entry || entry.status === 'loading') {
      list.replaceChildren(h('li', { class: 'hist-note' }, 'Loading…'));
      return;
    }
    if (entry.status === 'error') {
      list.replaceChildren(h('li', { class: 'hist-note' }, `Could not load history. ${entry.message}`));
      return;
    }
    const solo = entry.events.length === 1;
    const rows = entry.events.map((ev) => {
      const isCurrent = ev.id === current.id;
      return h('li', { class: `hist t-${ev.type}${isCurrent ? ' is-current' : ''}${solo ? ' is-solo' : ''}` },
        h('span', { class: 'hist__dot', 'aria-hidden': 'true' }),
        h('span', { class: 'hist__day' }, historyDay(ev.day)),
        h('time', { class: 'hist__time', datetime: `${ev.day}T${ev.time}` }, ev.time),
        h('span', { class: 'hist__type' }, `${TYPE_LABEL[ev.type]}${ev.isDir ? ' folder' : ''}`),
        isCurrent ? h('span', { class: 'hist__tag' }, 'Selected') : null);
    });
    if (entry.events.length <= 1) rows.push(h('li', { class: 'hist-note' }, 'No other changes recorded for this path.'));
    list.replaceChildren(...rows);
  }

  function toggleOpen(e, keepFolderId) {
    state.openId = state.openId === e.id ? null : e.id;
    if (keepFolderId) state.expanded.add(keepFolderId);
    renderAll({ anchor: true, focusId: e.id });
  }

  function toggleFolder(e, children) {
    if (state.expanded.has(e.id)) {
      state.expanded.delete(e.id);
      if (children.some((c) => c.id === state.openId)) state.openId = null;
    } else {
      state.expanded.add(e.id);
    }
    renderAll({ anchor: true, focusId: e.id });
  }

  function emptyState() {
    const filtered = Boolean(state.query) || state.filter !== 'all';
    if (filtered && state.events.length) {
      const type = state.filter === 'all' ? '' : `${TYPE_LABEL[state.filter].toLowerCase()} `;
      const text = state.query
        ? `No ${type}changes matching “${el.search.value.trim()}” on this day.`
        : `No ${type}files or folders on this day.`;
      return h('div', { class: 'empty' },
        h('div', { class: 'empty__icon' }, icon('search')),
        h('p', { class: 'empty__title' }, 'Nothing matches'),
        h('p', { class: 'empty__text' }, text),
        h('button', { class: 'btn', type: 'button', onclick: clearFilters }, 'Clear filters'));
    }
    const isToday = state.day === state.today;
    const folder = state.status ? state.status.watchPath : 'the watched folder';
    return h('div', { class: 'empty' },
      h('div', { class: 'empty__icon' }, icon('file')),
      h('p', { class: 'empty__title' }, isToday ? 'No changes yet today' : 'No changes on this day'),
      h('p', { class: 'empty__text' }, isToday
        ? `Files added, edited or deleted in ${folder} show up here the moment they change.`
        : 'Nothing was added, edited or deleted.'));
  }

  function copyButton(text) {
    const content = (name, label) => [icon(name), label];
    const btn = h('button', { class: 'btn', type: 'button' }, content('copy', 'Copy path'));
    let timer = 0;
    btn.addEventListener('click', async () => {
      const ok = await copyText(text);
      btn.replaceChildren(...content(ok ? 'check' : 'x', ok ? 'Copied' : 'Copy failed'));
      clearTimeout(timer);
      timer = setTimeout(() => btn.replaceChildren(...content('copy', 'Copy path')), 1600);
    });
    return btn;
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // fall through to the legacy path
    }
    const area = h('textarea', { readonly: true, 'aria-hidden': 'true' });
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }

  // ---------- Filters & URL ----------

  function setFilter(filter) {
    state.filter = filter;
    state.shown = PAGE_SIZE;
    syncUrl();
    renderAll();
  }

  function clearFilters() {
    el.search.value = '';
    state.query = '';
    state.filter = 'all';
    state.shown = PAGE_SIZE;
    syncUrl();
    renderAll();
  }

  let searchTimer = 0;
  function onSearchInput() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = el.search.value.trim().toLowerCase();
      state.shown = PAGE_SIZE;
      syncUrl();
      renderAll();
    }, 120);
  }

  function readUrl() {
    const params = new URLSearchParams(window.location.search);
    const day = params.get('day');
    if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) state.requestedDay = day;
    const type = params.get('type');
    if (TYPES.includes(type)) state.filter = type;
    const q = params.get('q');
    if (q) {
      el.search.value = q;
      state.query = q.trim().toLowerCase();
    }
  }

  function syncUrl() {
    const params = new URLSearchParams();
    if (state.day && state.day !== state.today) params.set('day', state.day);
    if (state.filter !== 'all') params.set('type', state.filter);
    const q = el.search.value.trim();
    if (q) params.set('q', q);
    const query = params.toString();
    history.replaceState(null, '', query ? `?${query}` : window.location.pathname);
  }

  // ---------- Wiring ----------

  function isTyping(target) {
    return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
  }

  function moveFilter(step) {
    const order = ['all', ...TYPES];
    const next = order[(order.indexOf(state.filter) + step + order.length) % order.length];
    setFilter(next);
    const btn = el.segs.find((b) => b.dataset.filter === next);
    if (btn) btn.focus();
  }

  function bindEvents() {
    el.themeToggle.addEventListener('click', toggleTheme);
    darkQuery.addEventListener('change', renderThemeButton);

    el.daySelect.addEventListener('change', () => selectDay(el.daySelect.value));
    el.dayPrev.addEventListener('click', () => {
      const i = state.days.findIndex((d) => d.day === state.day);
      if (i >= 0 && i < state.days.length - 1) selectDay(state.days[i + 1].day);
    });
    el.dayNext.addEventListener('click', () => {
      const i = state.days.findIndex((d) => d.day === state.day);
      if (i > 0) selectDay(state.days[i - 1].day);
    });

    el.search.addEventListener('input', onSearchInput);
    for (const btn of el.segs) {
      btn.addEventListener('click', () => setFilter(btn.dataset.filter));
      btn.addEventListener('keydown', (ev) => {
        if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') { ev.preventDefault(); moveFilter(1); }
        if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') { ev.preventDefault(); moveFilter(-1); }
      });
    }

    el.newPill.addEventListener('click', () => {
      state.unseen = 0;
      renderNewPill();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    window.addEventListener('scroll', () => {
      if (state.unseen && window.scrollY < 120) renderNewPill();
    }, { passive: true });

    document.addEventListener('keydown', (ev) => {
      if (ev.key === '/' && !isTyping(ev.target) && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        ev.preventDefault();
        el.search.focus();
        el.search.select();
      } else if (ev.key === 'Escape') {
        if (document.activeElement === el.search && el.search.value) {
          el.search.value = '';
          onSearchInput();
        } else if (state.openId) {
          const id = state.openId;
          state.openId = null;
          renderAll({ anchor: true, focusId: id });
        }
      }
    });

    // Relative times tick; the day rolls over by the server's clock, not the viewer's.
    setInterval(async () => {
      for (const node of el.feed.querySelectorAll('[data-rel]')) node.textContent = relative(Number(node.dataset.rel));
      try {
        const s = await api('/api/status');
        if (s.today > state.today) {
          rollDay(s.today);
          renderDays();
          renderAll();
        }
      } catch {
        // offline: the stream's reconnect handles recovery
      }
    }, 30000);
  }

  async function init() {
    for (const node of document.querySelectorAll('[data-icon]')) node.append(icon(node.dataset.icon));
    renderThemeButton();
    readUrl();
    bindEvents();
    renderStatus();

    try {
      const [status] = await Promise.all([api('/api/status'), loadDays()]);
      if (!state.status) state.status = status;
      renderStatus();
    } catch (err) {
      state.loadError = friendlyError(err);
    }

    selectDay(state.requestedDay || state.today);
    connectStream();
  }

  init();
})();
