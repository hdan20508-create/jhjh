const $ = (sel) => document.querySelector(sel);

const els = {
  authStatus: $('#auth-status'),
  login: $('#login'),
  loginPanel: $('#login-panel'),
  loginCancel: $('#login-cancel'),
  areaSummary: $('#area-summary'),
  areaText: $('#area-text'),
  areaSaved: $('#area-saved'),
  areaChange: $('#area-change'),
  areaEditor: $('#area-editor'),
  areaForm: $('#area-form'),
  areaStatus: $('#area-status'),
  place: $('#place'),
  radius: $('#radius'),
  radiusValue: $('#radius-value'),
  useLocation: $('#use-location'),
  postSummary: $('#post-summary'),
  postSummaryText: $('#post-summary-text'),
  postEdit: $('#post-edit'),
  postEditor: $('#post-editor'),
  post: $('#post'),
  pasteCheck: $('#paste-check'),
  check: $('#check'),
  stop: $('#stop'),
  keysHint: $('#keys-hint'),
  message: $('#message'),
  resultsSection: $('#results-section'),
  resultsTitle: $('#results-title'),
  checkRemaining: $('#check-remaining'),
  tbody: $('#results tbody'),
};

const APP_TITLE = 'Clearance Checker';
const STORAGE_KEY = 'clearance-checker:last-batch';

// Errors after which every following check would fail the same way, so the batch stops.
const STOP_CODES = new Set([
  'out_of_credits', 'needs_login', 'not_authorized', 'login_timeout', 'login_loop', 'unexpected_oauth_app',
  'no_location', 'browser_missing', 'profile_in_use', 'forbidden', 'offline',
]);
const LOGIN_CODES = new Set(['needs_login', 'not_authorized', 'login_loop', 'unexpected_oauth_app', 'login_timeout']);

let auth = 'unknown';
let area = null;
let editingArea = false;
let batch = null; // { postText, pastedAt, items, states, restored }
let running = false;
let stopRequested = false;

// ---------- helpers ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

function money(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '–';
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
}

function signedMoney(n) {
  return typeof n === 'number' && n > 0 ? `+${money(n)}` : money(n);
}

function clock(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
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
  if (code === 'no_location') return { label: 'Set search area', run: () => openAreaEditor(true) };
  return null;
}

function setMessage(text, tone = '', action = null) {
  els.message.replaceChildren(el('span', {}, text));
  if (action) els.message.append(el('button', { type: 'button', class: 'secondary small', onclick: action.run }, action.label));
  els.message.className = `message ${tone}`;
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
};

function showAuth() {
  const [label, tone] = AUTH_LABELS[auth] || AUTH_LABELS.unknown;
  els.authStatus.textContent = label;
  els.authStatus.className = `pill ${tone}`;
  const loggedIn = auth === 'signed_in' || auth === 'saved';
  els.login.textContent = loggedIn ? 'Re-login' : 'Log in with Discord';
  els.login.className = loggedIn ? 'link' : '';
}

async function refreshStatus(tries = 10) {
  try {
    const status = await api('/api/status');
    if (status.browserError) setMessage(status.browserError, 'bad');
    if (!(running && status.auth === 'unknown')) auth = status.auth;
    showAuth();
    if (status.loggingIn) els.loginPanel.hidden = false;
    // The server takes a moment after starting to look at the saved login.
    if (auth === 'unknown' && tries > 0) setTimeout(() => refreshStatus(tries - 1), 1500);
  } catch (err) {
    els.authStatus.textContent = 'App not running';
    els.authStatus.className = 'pill bad';
    setMessage(err.message, 'bad');
  }
}

async function login() {
  if (running) return;
  els.login.disabled = true;
  els.loginPanel.hidden = false;
  setMessage('Waiting for you to finish logging in in the Chrome window…');
  try {
    await api('/api/login', {});
    auth = 'signed_in';
    const left = batch ? remainingIndexes().length : 0;
    setMessage(left ? `Logged in ✓ ${plural(left, 'item')} still to check.` : 'Logged in ✓', 'good',
      left ? { label: `Check ${left} not checked`, run: () => runChecks(remainingIndexes()) } : null);
  } catch (err) {
    if (LOGIN_CODES.has(err.code)) auth = 'signed_out';
    setMessage(errorText(err), 'bad');
  } finally {
    els.login.disabled = false;
    els.loginPanel.hidden = true;
    showAuth();
  }
}

els.login.addEventListener('click', login);
els.loginCancel.addEventListener('click', () => api('/api/login/cancel', {}).catch(() => {}));

// ---------- search area ----------

function describeArea(a) {
  if (!a?.location) return null;
  return `${a.radiusMiles} mi around ${a.location.address || `${a.location.lat}, ${a.location.lng}`}`;
}

function showArea() {
  const text = describeArea(area);
  els.areaText.textContent = text || '';
  els.areaSummary.hidden = !text || editingArea;
  els.areaEditor.hidden = Boolean(text) && !editingArea;
  els.radius.value = area?.radiusMiles ?? 50;
  els.radiusValue.textContent = `${els.radius.value} mi`;
}

function openAreaEditor(focus) {
  editingArea = true;
  showArea();
  if (focus) els.place.focus();
}

function lockArea(locked) {
  for (const node of [els.areaChange, els.place, els.radius, els.useLocation, $('#area-set')]) node.disabled = locked;
}

async function saveArea(body, { collapse }) {
  els.areaStatus.textContent = 'Saving…';
  els.areaStatus.className = 'sub field-status';
  try {
    ({ area } = await api('/api/area', body));
    els.place.value = '';
    els.areaStatus.textContent = 'Saved ✓';
    els.areaStatus.className = 'sub field-status good';
    if (collapse && area.location) {
      editingArea = false;
      els.areaSaved.hidden = false;
      setTimeout(() => { els.areaSaved.hidden = true; }, 2500);
    }
    showArea();
  } catch (err) {
    els.areaStatus.textContent = err.message;
    els.areaStatus.className = 'sub field-status bad';
  }
}

els.radius.addEventListener('input', () => { els.radiusValue.textContent = `${els.radius.value} mi`; });
els.radius.addEventListener('change', () => saveArea({ radiusMiles: Number(els.radius.value) }, { collapse: false }));

els.areaForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const place = els.place.value.trim();
  if (!place) {
    if (area?.location) { editingArea = false; showArea(); return; }
    els.areaStatus.textContent = 'Type a ZIP code, city, or address first.';
    els.areaStatus.className = 'sub field-status bad';
    return;
  }
  saveArea({ place, radiusMiles: Number(els.radius.value) }, { collapse: true });
});

els.areaChange.addEventListener('click', () => openAreaEditor(true));

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
    }, { collapse: true }),
    () => {
      els.areaStatus.textContent = 'Location wasn\'t shared. Type your ZIP code instead.';
      els.areaStatus.className = 'sub field-status bad';
    },
    { enableHighAccuracy: false, timeout: 10000 },
  );
});

// ---------- post box ----------

function showPostEditor(open) {
  els.postEditor.hidden = !open;
  els.check.hidden = !open;
  els.keysHint.hidden = !open;
  els.postSummary.hidden = open || !batch;
  if (open) els.post.focus();
}

function showPostSummary() {
  if (!batch) return;
  const links = batch.items.length;
  const when = batch.restored ? `from your last visit (${clock(batch.pastedAt)})` : `at ${clock(batch.pastedAt)}`;
  els.postSummaryText.textContent = `Post pasted ${when} · ${plural(links, 'item')}`;
}

els.postEdit.addEventListener('click', () => showPostEditor(true));

els.post.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    startBatch(els.post.value);
  }
});

els.check.addEventListener('click', () => startBatch(els.post.value));

els.pasteCheck.addEventListener('click', async () => {
  let text = null;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    // Clipboard access denied or unsupported.
  }
  if (!text?.trim()) {
    showPostEditor(true);
    setMessage('Couldn\'t read your clipboard. Click in the box, press Ctrl+V (⌘V on a Mac), then Check links.', 'warn');
    return;
  }
  els.post.value = text;
  startBatch(text);
});

els.stop.addEventListener('click', () => {
  stopRequested = true;
  els.stop.disabled = true;
  els.stop.textContent = 'Stopping after this item…';
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
    showPostSummary();
    showPostEditor(false);
    renderAll();
    const left = remainingIndexes().length;
    setMessage(`Showing your last results from ${clock(batch.pastedAt)}.`, '',
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
    showPostEditor(true);
    return setMessage('Paste a post first.', 'bad');
  }
  if (!area?.location) {
    openAreaEditor(true);
    return setMessage('Set where to look first.', 'bad');
  }

  setMessage('Reading links…');
  els.pasteCheck.disabled = true;
  els.check.disabled = true;
  let items;
  try {
    ({ items } = await api('/api/parse', { text }));
  } catch (err) {
    setMessage(err.message, 'bad');
    return;
  } finally {
    els.pasteCheck.disabled = false;
    els.check.disabled = false;
  }
  if (!items.length) {
    showPostEditor(true);
    return setMessage('No instoreclearance.com links in that text. Copy the whole Discord post, including the links.', 'bad');
  }

  batch = {
    postText: text,
    pastedAt: new Date().toISOString(),
    items,
    states: items.map((item) => (item.error ? { status: 'error', error: { code: 'bad_link', message: item.error } } : { status: 'unchecked' })),
  };
  saveBatch();
  showPostSummary();
  showPostEditor(false);
  renderAll();
  runChecks(remainingIndexes());
}

function setState(i, state) {
  batch.states[i] = state;
  saveBatch();
  renderRow(i);
  renderBar();
}

async function runChecks(indexes) {
  if (running || !indexes.length) return;
  if (!area?.location) {
    openAreaEditor(true);
    return setMessage('Set where to look first.', 'bad');
  }
  if (auth === 'signed_out') {
    return setMessage('You\'re logged out. Log in first; a Chrome window will open on this computer.', 'bad', actionFor('needs_login'));
  }

  running = true;
  stopRequested = false;
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
      setState(i, { status: 'done', result });
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
  setRunning(false);
  finish(stopped);
}

function setRunning(on) {
  els.pasteCheck.disabled = on;
  els.check.disabled = on;
  els.login.disabled = on;
  els.stop.hidden = !on;
  els.stop.disabled = false;
  els.stop.textContent = 'Stop after this item';
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
    setMessage(`${errorText(stopped)} (${tally})`, 'bad', actionFor(stopped.code));
  } else if (stopRequested) {
    setMessage(`Stopped. ${tally}.`, 'warn');
  } else {
    setMessage(`Done: ${tally}. Prices are for ${describeArea(area)}.`, counts.done ? 'good' : 'bad');
  }
}

window.addEventListener('focus', () => {
  if (!running && document.title !== APP_TITLE && !document.title.startsWith('(')) document.title = APP_TITLE;
});

// ---------- results table ----------

function renderBar() {
  if (!batch) return;
  const left = remainingIndexes().length;
  const done = batch.states.filter((s) => s.status === 'done').length;
  els.resultsTitle.textContent = `${done} of ${plural(batch.items.length, 'item')} priced`;
  els.checkRemaining.hidden = running || !left;
  els.checkRemaining.textContent = `Check ${left} not checked`;
}

els.checkRemaining.addEventListener('click', () => runChecks(remainingIndexes()));

function renderAll() {
  if (!batch) return;
  els.resultsSection.hidden = false;
  els.tbody.replaceChildren(...batch.items.map(() => el('tr')));
  batch.items.forEach((_, i) => renderRow(i));
  renderBar();
}

function itemCell(item, result) {
  const name = result?.name || item.name || item.url;
  const sub = [item.retailer || result?.retailer, item.sku || result?.sku].filter(Boolean).join(' · ');
  const twice = item.alsoPostedAs?.length ? ` · posted ${item.alsoPostedAs.length + 1}×` : '';
  return el('td', {},
    el('div', { class: 'item' },
      result?.image ? el('img', { src: result.image, alt: '' }) : null,
      el('div', {},
        el('a', { href: item.dealsUrl || item.url, target: '_blank', rel: 'noreferrer' }, name),
        el('div', { class: 'sub' }, sub + twice))));
}

function postedCell(item) {
  const off = item.postedDiscountPct != null ? ` (${item.postedDiscountPct}% off)` : '';
  return el('td', { 'data-label': 'Posted' }, el('span', { class: 'price' }, money(item.postedPrice)), off);
}

function storeLine(s) {
  return [s.name, s.distanceMi != null ? `${s.distanceMi} mi` : null].filter(Boolean).join(' · ');
}

function bestCell(item, result) {
  if (!result.best) {
    const note = result.locked ? 'Locked pricing (not in your plan)'
      : result.fullPriceStores ? `Not on clearance near you (${plural(result.fullPriceStores, 'store')} at full price)`
        : 'No price inside your radius';
    return el('td', { 'data-label': 'Best near you', colspan: 3, class: 'muted' }, note);
  }
  const { best } = result;
  const off = best.discountPct != null && result.msrp ? ` (${best.discountPct}% off ${money(result.msrp)})` : '';
  const overPost = typeof item.postedPrice === 'number' && best.price > item.postedPrice + 0.5
    ? el('div', { class: 'warn sub' }, `${money(best.price - item.postedPrice)} more than the post's price`) : null;
  const others = result.stores.slice(1).map((s) => el('li', {}, `${money(s.price)} – ${storeLine(s)}`));
  return el('td', { 'data-label': 'Best near you' },
    el('span', { class: 'price' }, money(best.price)), off,
    el('div', { class: 'sub' }, storeLine(best)),
    best.address ? el('div', { class: 'sub' }, best.address) : null,
    overPost,
    others.length ? el('details', {}, el('summary', {}, `${plural(others.length, 'more store')}`), el('ul', {}, others)) : null);
}

function statusCell(i, state) {
  const button = (label, run) => el('button', { type: 'button', class: 'secondary small', disabled: running, onclick: run }, label);
  if (state.status === 'queued') return el('td', { colspan: 3, class: 'muted' }, 'Waiting…');
  if (state.status === 'checking') {
    return el('td', { colspan: 3, class: 'muted' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), el('span', { 'data-started': state.startedAt }, 'Checking…'));
  }
  if (state.status === 'unchecked') {
    return el('td', { colspan: 3, class: 'muted' }, 'Not checked ', button('Check', () => runChecks([i])));
  }
  const err = state.error || {};
  const action = actionFor(err.code);
  return el('td', { colspan: 3, class: 'bad' },
    el('span', {}, errorText(err)), ' ',
    action ? button(action.label, action.run) : err.code !== 'bad_link' ? button('Retry', () => runChecks([i])) : null);
}

function renderRow(i) {
  const row = els.tbody.children[i];
  if (!row) return;
  const item = batch.items[i];
  const state = batch.states[i];
  const cells = [itemCell(item, state.result), postedCell(item)];
  if (state.status !== 'done') {
    cells.push(statusCell(i, state));
  } else {
    const { result } = state;
    const best = bestCell(item, result);
    cells.push(best);
    if (result.best) {
      const profit = item.resell ? item.resell.low - result.best.price : null;
      cells.push(
        el('td', { 'data-label': 'Resell' }, item.resell ? item.resell.text : '–'),
        el('td', { 'data-label': 'Est. profit', class: `price ${profit > 0 ? 'good' : profit < 0 ? 'bad' : ''}` }, signedMoney(profit)),
      );
    }
  }
  row.className = state.status;
  row.replaceChildren(...cells);
}

// Live "Checking… 12 s" counter on the active row.
setInterval(() => {
  for (const node of document.querySelectorAll('[data-started]')) {
    const secs = Math.round((Date.now() - Number(node.dataset.started)) / 1000);
    node.textContent = secs >= 20 ? `Still working… ${secs} s (it may be logging you back in)` : `Checking… ${secs} s`;
  }
}, 1000);

// ---------- start ----------

showAuth();
refreshStatus();
api('/api/area')
  .then((data) => { area = data.area; showArea(); })
  .catch((err) => setMessage(err.message, 'bad'));
restoreBatch();
if (!batch) showPostEditor(true);
