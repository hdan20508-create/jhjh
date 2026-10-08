const $ = (sel) => document.querySelector(sel);

const els = {
  authStatus: $('#auth-status'),
  login: $('#login'),
  loginDialog: $('#login-dialog'),
  loginCancel: $('#login-cancel'),
  areaChip: $('#area-chip'),
  areaChipText: $('#area-chip-text'),
  areaPanel: $('#area-panel'),
  areaClose: $('#area-close'),
  areaForm: $('#area-form'),
  areaSet: $('#area-set'),
  areaStatus: $('#area-status'),
  place: $('#place'),
  radius: $('#radius'),
  radiusValue: $('#radius-value'),
  useLocation: $('#use-location'),
  composer: $('.composer'),
  composerFull: $('#composer-full'),
  composerCompact: $('#composer-compact'),
  typeToggle: $('#type-toggle'),
  postEditor: $('#post-editor'),
  post: $('#post'),
  check: $('#check'),
  postSummaryText: $('#post-summary-text'),
  postEdit: $('#post-edit'),
  stop: $('#stop'),
  message: $('#message'),
  onboarding: $('#onboarding'),
  resultsSection: $('#results-section'),
  resultsSub: $('#results-sub'),
  stats: $('#stats'),
  progress: $('#progress'),
  checkRemaining: $('#check-remaining'),
  cards: $('#cards'),
};

const APP_TITLE = 'Clearance Checker';
const STORAGE_KEY = 'clearance-checker:last-batch';

// Errors after which every following check would fail the same way, so the batch stops.
const STOP_CODES = new Set([
  'out_of_credits', 'needs_login', 'not_authorized', 'login_timeout', 'login_loop', 'unexpected_oauth_app',
  'no_location', 'browser_missing', 'profile_in_use', 'forbidden', 'offline',
]);
const LOGIN_CODES = new Set(['needs_login', 'not_authorized', 'login_loop', 'unexpected_oauth_app', 'login_timeout']);

const RETAILERS = {
  target: ['Target', '#cc0000'],
  walmart: ['Walmart', '#0071dc'],
  homedepot: ['Home Depot', '#f96302'],
  lowes: ["Lowe's", '#004990'],
  bestbuy: ['Best Buy', '#0046be'],
  costco: ['Costco', '#e31837'],
  samsclub: ["Sam's Club", '#0067a0'],
};

let auth = 'unknown';
let area = null;
let batch = null; // { postText, pastedAt, items, states, restored }
let running = false;
let stopRequested = false;
let editingPost = false;
let runProgress = null; // { done, total }

// ---------- icons ----------

const ICONS = {
  pin: '<path d="M12 21s-7-6.1-7-11.2A7 7 0 0 1 19 9.8C19 14.9 12 21 12 21z"/><circle cx="12" cy="10" r="2.6"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  locate: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  clipboard: '<rect x="5" y="5" width="14" height="16" rx="2.5"/><path d="M9 5V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/><path d="M9 11h6M9 15h4"/>',
  message: '<path d="M4 5h16v11H9l-5 4z"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
  login: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M9 16l4-4-4-4M13 12H3"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  alert: '<path d="M10.3 4L2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  refresh: '<path d="M20 11A8 8 0 0 0 5.6 6.4L3 9M3 4v5h5M4 13a8 8 0 0 0 14.4 4.6L21 15M21 20v-5h-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  store: '<path d="M4 9l1.5-5h13L20 9M4 9v11h16V9M4 9h16M10 20v-5h4v5"/>',
  play: '<path d="M8 5v14l11-7z"/>',
};

function icon(name) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return span;
}

for (const node of document.querySelectorAll('[data-icon]')) node.replaceWith(Object.assign(icon(node.dataset.icon), { className: node.className }));

// ---------- helpers ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'style') node.setAttribute('style', value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

function money(n, digits = 2) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '–';
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(digits)}`;
}

function signedMoney(n, digits = 2) {
  return typeof n === 'number' && n > 0 ? `+${money(n, digits)}` : money(n, digits);
}

function clock(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function shortPlace(a) {
  const address = a?.location?.address || '';
  // "78701, Austin, Travis County, Texas" -> "78701, Austin"
  return address.split(',').slice(0, 2).join(',').trim() || `${a.location.lat.toFixed(2)}, ${a.location.lng.toFixed(2)}`;
}

function describeArea(a) {
  if (!a?.location) return null;
  return `${a.radiusMiles} mi around ${a.location.address || shortPlace(a)}`;
}

async function api(path, body) {
  let res;
  try {
    res = await fetch(path, body ? {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    } : undefined);
  } catch {
    throw Object.assign(new Error('The checker app isn\'t running. Make sure its window is still open (or start it again), then reload this page.'), { code: 'offline' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = data.error || {};
    throw Object.assign(new Error(error.message || `Something went wrong (error ${res.status}).`), { code: error.code, resetAt: error.resetAt });
  }
  return data;
}

// A message with an optional action button, e.g. "You're logged out. [Log in with Discord]".
function actionFor(code) {
  if (LOGIN_CODES.has(code)) return { label: 'Log in with Discord', run: login };
  if (code === 'no_location') return { label: 'Set search area', run: () => openArea(true) };
  return null;
}

const TONE_ICONS = { good: 'check', bad: 'alert', warn: 'alert', '': 'info' };

function setMessage(text, tone = '', action = null) {
  if (!text) {
    els.message.hidden = true;
    return;
  }
  els.message.hidden = false;
  els.message.className = `toast ${tone}`;
  els.message.replaceChildren(icon(TONE_ICONS[tone] || 'info'), el('span', { class: 'text' }, text));
  if (action) {
    els.message.append(el('button', { type: 'button', class: `btn btn-sm ${LOGIN_CODES.has(action.code) ? 'btn-discord' : 'btn-ink'}`, onclick: action.run }, action.label));
  }
}

function errorText(err) {
  if (err.code === 'out_of_credits' && err.resetAt) {
    return `You're out of lookups on the site. They should be back around ${clock(err.resetAt)}.`;
  }
  return err.message;
}

// ---------- login status ----------

const AUTH_LABELS = {
  signed_in: ['Logged in', 'ok'],
  saved: ['Login saved', 'ok'],
  signed_out: ['Logged out', 'bad'],
  unknown: ['Checking login…', ''],
  offline: ['App not running', 'bad'],
};

function showAuth() {
  const [label, tone] = AUTH_LABELS[auth] || AUTH_LABELS.unknown;
  els.authStatus.className = `status-chip ${tone}`;
  els.authStatus.querySelector('.label').textContent = label;
  const loggedIn = auth === 'signed_in' || auth === 'saved';
  els.login.textContent = loggedIn ? 'Re-login' : 'Log in with Discord';
  els.login.className = loggedIn ? 'btn btn-quiet btn-sm' : 'btn btn-discord';
  showOnboarding();
}

async function refreshStatus(tries = 10) {
  try {
    const status = await api('/api/status');
    if (status.browserError) setMessage(status.browserError, 'bad');
    if (!(running && status.auth === 'unknown')) auth = status.auth;
    showAuth();
    if (status.loggingIn && !els.loginDialog.open) els.loginDialog.showModal();
    // The server takes a moment after starting to look at the saved login.
    if (auth === 'unknown' && tries > 0) setTimeout(() => refreshStatus(tries - 1), 1500);
  } catch (err) {
    auth = 'offline';
    showAuth();
    setMessage(err.message, 'bad');
  }
}

async function login() {
  if (running) return;
  els.login.disabled = true;
  if (!els.loginDialog.open) els.loginDialog.showModal();
  try {
    await api('/api/login', {});
    auth = 'signed_in';
    const left = batch ? remainingIndexes().length : 0;
    setMessage(left ? `You're logged in. ${plural(left, 'item')} still to check.` : 'You\'re logged in.', 'good',
      left ? { label: `Check ${left} now`, run: () => runChecks(remainingIndexes()) } : null);
  } catch (err) {
    if (LOGIN_CODES.has(err.code)) auth = 'signed_out';
    setMessage(errorText(err), 'bad');
  } finally {
    els.login.disabled = false;
    if (els.loginDialog.open) els.loginDialog.close();
    showAuth();
  }
}

els.login.addEventListener('click', login);
els.loginCancel.addEventListener('click', () => api('/api/login/cancel', {}).catch(() => {}));
// Esc would hide the dialog while Chrome is still open; cancel the login properly instead.
els.loginDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  api('/api/login/cancel', {}).catch(() => {});
});

// ---------- search area ----------

function showArea() {
  const set = Boolean(area?.location);
  els.areaChipText.textContent = set ? `${area.radiusMiles} mi · ${shortPlace(area)}` : 'Set search area';
  els.areaChip.classList.toggle('unset', !set);
  els.areaChip.title = set ? describeArea(area) : '';
  els.radius.value = area?.radiusMiles ?? 50;
  els.radiusValue.textContent = `${els.radius.value} mi`;
  showOnboarding();
}

function openArea(focus) {
  els.areaPanel.hidden = false;
  els.areaChip.setAttribute('aria-expanded', 'true');
  els.areaStatus.textContent = area?.location ? `Now: ${describeArea(area)}` : '';
  els.areaStatus.className = 'field-status';
  if (focus) els.place.focus();
}

function closeArea() {
  els.areaPanel.hidden = true;
  els.areaChip.setAttribute('aria-expanded', 'false');
}

els.areaChip.addEventListener('click', () => (els.areaPanel.hidden ? openArea(true) : closeArea()));
els.areaClose.addEventListener('click', closeArea);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !els.areaPanel.hidden) {
    closeArea();
    els.areaChip.focus();
  }
});
document.addEventListener('pointerdown', (event) => {
  if (!els.areaPanel.hidden && !event.target.closest('.area-anchor')) closeArea();
});

function lockArea(locked) {
  for (const node of [els.areaChip, els.place, els.radius, els.useLocation, els.areaSet]) node.disabled = locked;
  if (locked) closeArea();
}

async function saveArea(body, { close }) {
  els.areaStatus.textContent = 'Saving…';
  els.areaStatus.className = 'field-status';
  try {
    ({ area } = await api('/api/area', body));
    els.place.value = '';
    els.areaStatus.textContent = `Saved ✓ ${describeArea(area) || ''}`;
    els.areaStatus.className = 'field-status good';
    showArea();
    if (close && area.location) setTimeout(closeArea, 700);
  } catch (err) {
    els.areaStatus.textContent = err.message;
    els.areaStatus.className = 'field-status bad';
  }
}

els.radius.addEventListener('input', () => { els.radiusValue.textContent = `${els.radius.value} mi`; });
els.radius.addEventListener('change', () => saveArea({ radiusMiles: Number(els.radius.value) }, { close: false }));

els.areaForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const place = els.place.value.trim();
  if (!place) {
    els.areaStatus.textContent = 'Type a ZIP code, city, or address first.';
    els.areaStatus.className = 'field-status bad';
    return;
  }
  saveArea({ place, radiusMiles: Number(els.radius.value) }, { close: true });
});

els.useLocation.addEventListener('click', () => {
  if (!navigator.geolocation) {
    els.areaStatus.textContent = 'This browser can\'t share your location here. Type your ZIP code instead.';
    return;
  }
  els.areaStatus.textContent = 'Getting your location…';
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => saveArea({
      location: { lat: coords.latitude, lng: coords.longitude, address: 'My location' },
      radiusMiles: Number(els.radius.value),
    }, { close: true }),
    () => {
      els.areaStatus.textContent = 'Location wasn\'t shared. Type your ZIP code instead.';
      els.areaStatus.className = 'field-status bad';
    },
    { enableHighAccuracy: false, timeout: 10000 },
  );
});

// ---------- onboarding ----------

function showOnboarding() {
  els.onboarding.hidden = Boolean(batch);
  const steps = els.onboarding.querySelectorAll('li');
  steps[0].classList.toggle('done', auth === 'signed_in' || auth === 'saved');
  steps[1].classList.toggle('done', Boolean(area?.location));
}

// ---------- composer ----------

function showComposer() {
  const compact = Boolean(batch) && !editingPost;
  els.composerFull.hidden = compact;
  els.composerCompact.hidden = !compact;
  els.composer.classList.toggle('compact', compact);
  if (batch) {
    const when = batch.restored ? `from your last visit, ${clock(batch.pastedAt)}` : `pasted ${clock(batch.pastedAt)}`;
    els.postSummaryText.textContent = `${plural(batch.items.length, 'item')} · ${when}`;
  }
}

function openEditor() {
  editingPost = true;
  showComposer();
  els.postEditor.hidden = false;
  els.post.focus();
}

els.typeToggle.addEventListener('click', () => {
  els.postEditor.hidden = !els.postEditor.hidden;
  if (!els.postEditor.hidden) els.post.focus();
});
els.postEdit.addEventListener('click', openEditor);
els.check.addEventListener('click', () => startBatch(els.post.value));
els.post.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    startBatch(els.post.value);
  }
});

function warmUp() {
  if (area?.location && auth !== 'signed_out') api('/api/warm', {}).catch(() => {});
}

async function pasteAndCheck() {
  if (running) return;
  warmUp(); // start Chrome and the site while the links are being read
  let text = null;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    // Clipboard access denied or unsupported.
  }
  if (!text?.trim()) {
    openEditor();
    setMessage('Couldn\'t read your clipboard. Click in the box, press Ctrl+V (⌘V on a Mac), then Check links.', 'warn');
    return;
  }
  els.post.value = text;
  startBatch(text);
}

for (const button of document.querySelectorAll('.js-paste')) button.addEventListener('click', pasteAndCheck);

els.stop.addEventListener('click', () => {
  stopRequested = true;
  els.stop.disabled = true;
  els.stop.querySelector('.label').textContent = 'Stopping after this one…';
});

// ---------- batch ----------

function saveBatch() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(batch));
  } catch {
    // Storage full or blocked: results just won't survive a reload.
  }
}

function restoreBatch() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved?.items?.length) return;
    // Anything that was mid-check when the page closed was never finished.
    saved.states = saved.states.map((s) => (s.status === 'checking' || s.status === 'queued' ? { status: 'unchecked' } : s));
    batch = { ...saved, restored: true };
    els.post.value = batch.postText;
    renderAll();
    const left = remainingIndexes().length;
    setMessage(`Here are your last results from ${clock(batch.pastedAt)}.`, '',
      left ? { label: `Check ${left} not checked`, run: () => runChecks(remainingIndexes()) } : null);
  } catch {
    // Nothing usable saved.
  }
}

function remainingIndexes() {
  return batch ? batch.states.map((s, i) => (s.status === 'unchecked' ? i : -1)).filter((i) => i >= 0) : [];
}

async function startBatch(text) {
  if (running) return;
  if (!text.trim()) {
    openEditor();
    return setMessage('Paste a post first.', 'bad');
  }
  if (!area?.location) {
    openArea(true);
    return setMessage('Set where you shop first, then try again.', 'bad', { label: 'Set search area', run: () => openArea(true) });
  }

  setMessage('Reading the links in that post…');
  for (const b of document.querySelectorAll('.js-paste')) b.disabled = true;
  els.check.disabled = true;
  let items;
  try {
    ({ items } = await api('/api/parse', { text }));
  } catch (err) {
    setMessage(err.message, 'bad');
    return;
  } finally {
    for (const b of document.querySelectorAll('.js-paste')) b.disabled = false;
    els.check.disabled = false;
  }
  if (!items.length) {
    openEditor();
    return setMessage('No instoreclearance.com links in that text. Copy the whole Discord post, including the links.', 'bad');
  }

  batch = {
    postText: text,
    pastedAt: new Date().toISOString(),
    items,
    states: items.map((item) => (item.error ? { status: 'error', error: { code: 'bad_link', message: item.error } } : { status: 'unchecked' })),
  };
  editingPost = false;
  els.postEditor.hidden = true;
  saveBatch();
  renderAll();
  runChecks(remainingIndexes());
}

function setState(i, state, { animate = false } = {}) {
  batch.states[i] = state;
  saveBatch();
  renderCard(i, animate);
  renderSummary();
}

async function runChecks(indexes) {
  if (running || !indexes.length) return;
  if (!area?.location) {
    openArea(true);
    return setMessage('Set where you shop first.', 'bad');
  }
  if (auth === 'signed_out') {
    return setMessage('You\'re logged out. Log in first; a Chrome window will open on this computer.', 'bad', { ...actionFor('needs_login'), code: 'needs_login' });
  }

  running = true;
  stopRequested = false;
  runProgress = { done: 0, total: indexes.length };
  setRunning(true);
  for (const i of indexes) setState(i, { status: 'queued' });

  let stopped = null;
  let lastCode = null;
  let scrolled = false;
  for (const [n, i] of indexes.entries()) {
    if (stopRequested || stopped) {
      setState(i, { status: 'unchecked' });
      continue;
    }
    document.title = `(${n + 1}/${indexes.length}) Checking… – ${APP_TITLE}`;
    setMessage(`Checking ${n + 1} of ${indexes.length}…`);
    setState(i, { status: 'checking', startedAt: Date.now() });
    try {
      const { result } = await api('/api/check', { dealsUrl: batch.items[i].dealsUrl });
      runProgress.done = n + 1;
      setState(i, { status: 'done', result }, { animate: true });
      auth = 'signed_in';
      showAuth();
      lastCode = null;
      if (!scrolled) {
        scrolled = true;
        const top = els.resultsSection.getBoundingClientRect().top;
        if (top > window.innerHeight * 0.6) {
          const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          els.resultsSection.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
        }
      }
    } catch (err) {
      runProgress.done = n + 1;
      setState(i, { status: 'error', error: { code: err.code, message: err.message, resetAt: err.resetAt } });
      if (LOGIN_CODES.has(err.code)) { auth = 'signed_out'; showAuth(); }
      if (STOP_CODES.has(err.code)) stopped = err;
      // Two of the same problem in a row usually means something general is wrong, except for
      // "item no longer available", which is about each item itself.
      else if (err.code && err.code !== 'unavailable' && err.code === lastCode) {
        stopped = Object.assign(new Error(`Paused: the same problem happened twice in a row. ${err.message}`), { code: 'repeated' });
      }
      lastCode = err.code;
    }
  }

  running = false;
  runProgress = null;
  setRunning(false);
  finish(stopped);
}

function setRunning(on) {
  for (const b of document.querySelectorAll('.js-paste')) b.disabled = on;
  els.check.disabled = on;
  els.login.disabled = on;
  els.postEdit.disabled = on;
  els.stop.hidden = !on;
  els.stop.disabled = false;
  els.stop.querySelector('.label').textContent = 'Stop after this item';
  lockArea(on);
  renderAll();
}

function finish(stopped) {
  const counts = { done: 0, error: 0, unchecked: 0 };
  for (const s of batch.states) counts[s.status] = (counts[s.status] || 0) + 1;
  const parts = [`${counts.done} priced`];
  if (counts.error) parts.push(`${counts.error} failed`);
  if (counts.unchecked) parts.push(`${counts.unchecked} not checked`);
  const tally = parts.join(' · ');

  document.title = `${counts.done ? '✓' : '✗'} ${tally} – ${APP_TITLE}`;
  if (stopped) {
    const action = actionFor(stopped.code);
    setMessage(`${errorText(stopped)} (${tally})`, 'bad', action && { ...action, code: stopped.code });
  } else if (stopRequested) {
    setMessage(`Stopped. ${tally}.`, 'warn');
  } else {
    setMessage(`Done: ${tally}.`, counts.done ? 'good' : 'bad');
  }
}

window.addEventListener('focus', () => {
  if (!running && document.title !== APP_TITLE && !document.title.startsWith('(')) document.title = APP_TITLE;
});

// ---------- results ----------

// What you'd pay: the best local price, or for items whose prices the site hides (retailer not on
// your plan) the post's price, but only if a nearby store has it on clearance.
function buyPrice(item, result) {
  if (result?.best) return result.best.price;
  if (result?.locked?.discountedStores?.length && typeof item.postedPrice === 'number') return item.postedPrice;
  return null;
}

function profitOf(i) {
  const item = batch.items[i];
  const state = batch.states[i];
  const price = state.status === 'done' ? buyPrice(item, state.result) : null;
  if (price == null || !item.resell) return null;
  return item.resell.low - price;
}

function stat(label, value, note, hero = false) {
  return el('div', { class: `stat${hero ? ' hero' : ''}` },
    el('div', { class: 'stat-label' }, label),
    el('div', { class: 'stat-value' }, value),
    note ? el('div', { class: 'stat-note' }, note) : null);
}

function renderSummary() {
  if (!batch) return;
  const total = batch.items.length;
  const done = batch.states.filter((s) => s.status === 'done').length;
  const profits = batch.items.map((_, i) => ({ i, p: profitOf(i) })).filter((x) => x.p != null);
  const winners = profits.filter((x) => x.p > 0);
  const upside = winners.reduce((sum, x) => sum + x.p, 0);
  const best = profits.sort((a, b) => b.p - a.p)[0];
  const bestItem = best && batch.items[best.i];

  els.stats.replaceChildren(
    stat('Potential profit', winners.length ? signedMoney(upside, 0) : '$0',
      winners.length ? `${plural(winners.length, 'item')} worth flipping` : done ? 'Nothing profitable yet' : 'Waiting for prices', true),
    stat('Best find', best ? signedMoney(best.p, 0) : '–',
      bestItem ? (bestItem.name || batch.states[best.i].result.name) : 'No priced items yet'),
    stat('Priced', el('span', {}, `${done}`, el('small', {}, ` / ${total}`)),
      area?.location ? `within ${area.radiusMiles} mi of ${shortPlace(area)}` : null),
  );

  const left = remainingIndexes().length;
  els.checkRemaining.hidden = running || !left;
  els.checkRemaining.replaceChildren(icon('play'), `Check ${left} not checked`);
  els.resultsSub.textContent = running ? 'Checking one at a time to go easy on your lookups.'
    : `From the post ${batch.restored ? 'you pasted' : 'pasted'} at ${clock(batch.pastedAt)}`;

  els.progress.hidden = !runProgress;
  if (runProgress) els.progress.firstElementChild.style.width = `${Math.max(4, (runProgress.done / runProgress.total) * 100)}%`;
}

els.checkRemaining.addEventListener('click', () => runChecks(remainingIndexes()));

function renderAll() {
  showComposer();
  showOnboarding();
  if (!batch) return;
  els.resultsSection.hidden = false;
  els.cards.replaceChildren(...batch.items.map(() => el('li', { class: 'card' })));
  batch.items.forEach((_, i) => renderCard(i));
  renderSummary();
}

function thumb(item, result) {
  if (result?.image) return el('div', { class: 'thumb' }, el('img', { src: result.image, alt: '', loading: 'lazy' }));
  const [label, color] = RETAILERS[item.retailer] || [item.retailer || '?', 'var(--ink-2)'];
  return el('div', { class: 'thumb monogram', style: `background:${color}` }, label[0].toUpperCase());
}

function infoBlock(item, result) {
  const name = result?.name || item.name || 'Unnamed item';
  const [label, color] = RETAILERS[item.retailer] || [item.retailer, 'var(--ink-2)'];
  const off = item.postedDiscountPct != null ? ` · ${item.postedDiscountPct}% off` : '';
  return el('div', { class: 'info' },
    el('h3', {}, el('a', { href: item.dealsUrl || item.url, target: '_blank', rel: 'noreferrer', title: 'Open on instoreclearance.com' }, name)),
    el('div', { class: 'meta' },
      label ? el('span', { class: 'retailer', style: `background:${color}` }, label) : null,
      item.sku ? el('span', { class: 'sku' }, `SKU ${item.sku}`) : null,
      item.alsoPostedAs?.length ? el('span', { class: 'tagline' }, `· posted ${item.alsoPostedAs.length + 1}×`) : null,
      result?.timings?.totalMs ? el('span', { class: 'tagline', title: 'How long this check took' }, `· ${(result.timings.totalMs / 1000).toFixed(1)}s`) : null),
    typeof item.postedPrice === 'number'
      ? el('div', { class: 'posted' }, 'Posted', el('strong', {}, money(item.postedPrice)), off) : null);
}

function storeText(s) {
  return [s.name, s.distanceMi != null ? `${s.distanceMi} mi` : null].filter(Boolean).join(' · ');
}

// ---------- stock (on demand, one store per click, like the site's Scan button) ----------

const stockPending = new Set();
const openDetails = new Set(); // keep "more stores" open while its stock results come in

async function checkStoreStock(i, storeId) {
  const item = batch.items[i];
  const { result } = batch.states[i];
  const key = `${i}:${storeId}`;
  if (stockPending.has(key)) return;
  if (!result.stockToken) {
    return setMessage('This result is from before stock checks existed. Re-check the item, then try again.', 'warn');
  }
  stockPending.add(key);
  renderCard(i);
  try {
    const { stock } = await api('/api/stock', {
      retailer: result.retailer || item.retailer, sku: result.sku || item.sku, store: storeId, token: result.stockToken,
    });
    result.stock = { ...result.stock, [storeId]: stock };
    saveBatch();
  } catch (err) {
    if (LOGIN_CODES.has(err.code)) { auth = 'signed_out'; showAuth(); }
    const action = actionFor(err.code);
    setMessage(errorText(err), 'bad', action && { ...action, code: err.code });
  } finally {
    stockPending.delete(key);
    renderCard(i);
  }
}

function stockControl(i, result, store) {
  const stock = result.stock?.[store.id];
  if (stockPending.has(`${i}:${store.id}`)) {
    return el('span', { class: 'stock-chip' }, el('span', { class: 'spinner' }), ' Checking…');
  }
  if (stock) {
    const parts = [stock.inStock == null ? 'Stock unknown' : stock.inStock > 0 ? `${stock.inStock} in stock` : 'Out of stock'];
    if (stock.aisle) parts.push(`Aisle ${stock.aisle}`);
    if (stock.price != null && Math.abs(stock.price - store.price) > 0.01) parts.push(`now ${money(stock.price)}`);
    const tone = stock.inStock > 0 ? 'in' : stock.inStock === 0 ? 'out' : '';
    return el('span', {
      class: `stock-chip ${tone}`,
      title: `Checked ${clock(stock.checkedAt)}. This is the store's own count, which can be off; call ahead before a long drive.`,
    }, parts.join(' · '));
  }
  return el('button', {
    type: 'button', class: 'stock-btn', disabled: running,
    title: 'Ask the site how many this store has (likely uses one lookup)',
    onclick: () => checkStoreStock(i, store.id),
  }, 'Check stock');
}

function priceBlock(i, item, result) {
  const { best } = result;
  const overPost = typeof item.postedPrice === 'number' && best.price > item.postedPrice + 0.5
    ? el('span', { class: 'note-warn' }, `${money(best.price - item.postedPrice)} more than the post's price`) : null;
  const others = result.stores.slice(1);
  return el('div', { class: 'price-block' },
    el('div', { class: 'price-row' },
      el('span', { class: 'price' }, money(best.price)),
      result.msrp ? el('span', { class: 'msrp' }, money(result.msrp)) : null,
      best.discountPct ? el('span', { class: 'sticker' }, `-${best.discountPct}%`) : null),
    el('div', { class: 'where' }, icon('pin'),
      el('div', {}, storeText(best), best.address ? el('small', {}, best.address) : null,
        el('div', { class: 'stock-row' }, stockControl(i, result, best)))),
    overPost,
    others.length ? el('details', { class: 'more', open: openDetails.has(i) ? true : null, ontoggle: (e) => (e.target.open ? openDetails.add(i) : openDetails.delete(i)) },
      el('summary', {}, `${plural(others.length, 'more store')}`, icon('chevron')),
      el('ul', {}, others.map((s) => el('li', {},
        el('span', {}, storeText(s)),
        el('span', { class: 'li-right' }, stockControl(i, result, s), el('b', {}, money(s.price))))))) : null);
}

function profitBlock(item, result) {
  const price = buyPrice(item, result);
  const profit = item.resell && price != null ? item.resell.low - price : null;
  const tone = profit > 0 ? 'gain' : profit < 0 ? 'loss' : '';
  const atPosted = !result.best;
  return el('div', { class: `profit ${tone}` },
    el('div', { class: 'profit-label' }, atPosted ? 'Est. profit at post\'s price' : 'Est. profit'),
    el('div', { class: 'profit-value' }, profit == null ? '–' : signedMoney(profit)),
    el('div', { class: 'profit-note' }, item.resell ? `Resell ${item.resell.text}` : 'No resell price in the post'));
}

function retailerName(item) {
  return (RETAILERS[item.retailer] || [item.retailer || 'this store'])[0];
}

// Retailer not on your plan: the site hides prices and only says which nearby stores have it on clearance.
function lockedBlock(item, result) {
  const { discountedStores, checkedStores } = result.locked;
  const name = retailerName(item);
  const [closest, ...others] = discountedStores;
  return el('div', { class: 'price-block' },
    el('div', { class: 'price-row' },
      el('span', { class: 'price' }, String(discountedStores.length)),
      el('span', { class: 'locked-of' }, `of ${plural(checkedStores, `${name} store`)} near you ${discountedStores.length === 1 ? 'has' : 'have'} it on clearance`)),
    el('div', { class: 'where' }, icon('pin'),
      el('div', {}, `Closest: ${storeText(closest)}`, closest.address ? el('small', {}, closest.address) : null)),
    el('span', { class: 'note-warn' }, `${name} isn't on your plan, so the site hides the price${typeof item.postedPrice === 'number' ? `. The post says ${money(item.postedPrice)}.` : '.'}`),
    others.length ? el('details', { class: 'more' },
      el('summary', {}, `${plural(others.length, 'more store')}`, icon('chevron')),
      el('ul', {}, others.map((s) => el('li', {}, el('span', {}, storeText(s)), el('b', {}, 'on clearance'))))) : null);
}

function stateBlock(i, state) {
  const button = (label, run, cls = 'btn-ghost') => el('button', { type: 'button', class: `btn btn-sm ${cls}`, disabled: running, onclick: run }, label);
  if (state.status === 'queued') return el('div', { class: 'state' }, icon('clock'), el('span', { class: 'text' }, 'In line…'));
  if (state.status === 'checking') {
    return el('div', { class: 'skeleton', 'aria-label': 'Checking' },
      el('div', { class: 'sk-lines' }, el('div', { class: 'sk' }), el('div', { class: 'sk' }), el('div', { class: 'sk' }),
        el('div', { class: 'timer' }, el('span', { class: 'spinner' }), el('span', { 'data-started': state.startedAt }, 'Checking stores near you…'))),
      el('div', { class: 'sk sk-box' }));
  }
  if (state.status === 'unchecked') {
    return el('div', { class: 'state' }, icon('clock'), el('span', { class: 'text' }, 'Not checked yet'), button('Check', () => runChecks([i]), 'btn-ink'));
  }
  const err = state.error || {};
  const action = actionFor(err.code);
  return el('div', { class: 'state bad' }, icon('alert'), el('span', { class: 'text' }, errorText(err)),
    action ? button(action.label, action.run, LOGIN_CODES.has(err.code) ? 'btn-discord' : 'btn-ink')
      : err.code !== 'bad_link' ? button('Retry', () => runChecks([i])) : null);
}

function noDealBlock(item, result) {
  const name = retailerName(item);
  const text = result.locked
    ? (result.locked.checkedStores
      ? `Not on clearance at any of the ${plural(result.locked.checkedStores, `${name} store`)} near you. (${name} isn't on your plan, so the site hides prices.)`
      : `${name} isn't on your plan, so the site hides prices for this item, and it didn't report any ${name} stores near you.`)
    : result.fullPriceStores ? `Not on clearance near you. ${plural(result.fullPriceStores, 'store')} nearby ${result.fullPriceStores === 1 ? 'has' : 'have'} it at full price.`
      : 'No store inside your radius has a price for this.';
  return el('div', { class: 'state neutral' }, icon('store'), el('span', { class: 'text' }, text));
}

function renderCard(i, animate = false) {
  const card = els.cards.children[i];
  if (!card) return;
  const item = batch.items[i];
  const state = batch.states[i];
  const result = state.result;
  const children = [thumb(item, result), infoBlock(item, result)];
  let kind = state.status;
  if (state.status === 'done') {
    if (result.best) children.push(priceBlock(i, item, result), profitBlock(item, result));
    else if (result.locked?.discountedStores?.length) children.push(lockedBlock(item, result), profitBlock(item, result));
    else {
      kind = 'done nodeal';
      children.push(noDealBlock(item, result));
    }
  } else {
    children.push(stateBlock(i, state));
  }
  card.className = `card ${kind}${animate ? ' enter' : ''}`;
  card.replaceChildren(...children);
}

// Live "Checking… 12 s" counter on the active card.
setInterval(() => {
  for (const node of document.querySelectorAll('[data-started]')) {
    const secs = Math.round((Date.now() - Number(node.dataset.started)) / 1000);
    node.textContent = secs >= 20 ? `Still working… ${secs}s (it may be logging you back in)`
      : secs >= 2 ? `Checking stores near you… ${secs}s` : 'Checking stores near you…';
  }
}, 1000);

// ---------- start ----------

showAuth();
refreshStatus();
api('/api/area')
  .then((data) => {
    area = data.area;
    showArea();
    warmUp();
    if (!area.location && !batch) openArea(false);
  })
  .catch((err) => setMessage(err.message, 'bad'));
restoreBatch();
renderAll();
