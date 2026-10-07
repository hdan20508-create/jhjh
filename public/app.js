const $ = (sel) => document.querySelector(sel);
const authStatus = $('#auth-status');
const loginButton = $('#login');
const checkButton = $('#check');
const message = $('#message');
const tbody = $('#results tbody');
const areaForm = $('#area-form');
const areaCurrent = $('#area-current');
const placeInput = $('#place');
const radiusInput = $('#radius');
const radiusValue = $('#radius-value');
const useLocationButton = $('#use-location');
let currentArea = null;

// Errors after which further checks would fail the same way.
const STOP_CODES = new Set(['out_of_credits', 'needs_login', 'not_authorized', 'login_timeout', 'no_location']);

function money(n) {
  return typeof n === 'number' ? `$${n.toFixed(2)}` : '–';
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child != null) node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

async function api(path, body) {
  const res = await fetch(path, body ? {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error?.message || `HTTP ${res.status}`), { code: data.error?.code });
  return data;
}

function setMessage(text, bad = false) {
  message.textContent = text;
  message.className = bad ? 'bad' : '';
}

async function refreshStatus() {
  try {
    const { signedIn } = await api('/api/status');
    authStatus.textContent = signedIn ? 'Site session saved' : 'Not logged in';
    authStatus.className = `pill ${signedIn ? 'ok' : 'bad'}`;
  } catch (err) {
    authStatus.textContent = 'Status unavailable';
    authStatus.className = 'pill bad';
  }
}

function describeArea(area) {
  if (!area?.location) return null;
  return `within ${area.radiusMiles} mi of ${area.location.address || `${area.location.lat}, ${area.location.lng}`}`;
}

function showArea(area) {
  currentArea = area;
  const text = describeArea(area);
  areaCurrent.textContent = text ? `Checking ${text}` : 'Not set. Enter a location to start checking.';
  areaCurrent.classList.toggle('unset', !text);
  radiusInput.value = area.radiusMiles;
  radiusValue.textContent = `${area.radiusMiles} mi`;
}

async function saveArea(body) {
  areaForm.querySelectorAll('button, input').forEach((n) => { n.disabled = true; });
  try {
    const { area } = await api('/api/area', body);
    showArea(area);
    placeInput.value = '';
    setMessage(`Search area saved: ${describeArea(area) || `${area.radiusMiles} mi radius (no location yet)`}.`);
  } catch (err) {
    setMessage(err.message, true);
  } finally {
    areaForm.querySelectorAll('button, input').forEach((n) => { n.disabled = false; });
  }
}

radiusInput.addEventListener('input', () => {
  radiusValue.textContent = `${radiusInput.value} mi`;
});

areaForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const place = placeInput.value.trim();
  saveArea({ ...(place ? { place } : {}), radiusMiles: Number(radiusInput.value) });
});

useLocationButton.addEventListener('click', () => {
  if (!navigator.geolocation) return setMessage('This browser cannot share its location. Type a ZIP or city instead.', true);
  setMessage('Getting your location…');
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => saveArea({
      location: { lat: coords.latitude, lng: coords.longitude, address: 'My location' },
      radiusMiles: Number(radiusInput.value),
    }),
    () => setMessage('Location permission was denied. Type a ZIP or city instead.', true),
    { enableHighAccuracy: false, timeout: 10000 },
  );
});

loginButton.addEventListener('click', async () => {
  loginButton.disabled = true;
  setMessage('A Chrome window opened on this computer. Sign in to Discord and approve the site.');
  try {
    await api('/api/login', {});
    setMessage(currentArea?.location ? 'Logged in.' : 'Logged in. Now set your search area above.');
  } catch (err) {
    setMessage(err.message, true);
  } finally {
    loginButton.disabled = false;
    refreshStatus();
  }
});

function itemCell(item, result) {
  const name = result?.name || item.name || item.url;
  const sub = [item.retailer || result?.retailer, item.sku || result?.sku].filter(Boolean).join(' · ');
  return el('td', {},
    el('div', { class: 'item' },
      result?.image ? el('img', { src: result.image, alt: '' }) : null,
      el('div', {},
        el('a', { href: item.dealsUrl || item.url, target: '_blank', rel: 'noreferrer' }, name),
        el('div', { class: 'sub' }, sub))));
}

function postedCell(item) {
  const off = item.postedDiscountPct != null ? ` (${item.postedDiscountPct}% off)` : '';
  return el('td', { 'data-label': 'Posted' }, el('span', { class: 'price' }, money(item.postedPrice)), off);
}

function bestCell(result) {
  if (!result.best) {
    const note = result.locked ? 'Locked pricing (not in your plan)' : 'No discounted price in your radius';
    return el('td', { 'data-label': 'Best near you', class: 'warn' }, note);
  }
  const { best } = result;
  const where = [best.name, best.distanceMi != null ? `${best.distanceMi} mi` : null].filter(Boolean).join(' · ');
  const others = result.stores.slice(1, 15).map((s) => el('li', {},
    `${money(s.price)} – ${s.name}${s.distanceMi != null ? ` (${s.distanceMi} mi)` : ''}`));
  return el('td', { 'data-label': 'Best near you' },
    el('span', { class: 'price good' }, money(best.price)),
    ` (${best.discountPct}% off ${money(result.msrp)})`,
    el('div', { class: 'sub' }, where),
    others.length ? el('details', {}, el('summary', {}, `${result.stores.length - 1} more store(s)`), el('ul', {}, others)) : null);
}

function renderRow(row, item, state) {
  const cells = [itemCell(item, state.result), postedCell(item)];
  if (state.error) {
    cells.push(el('td', { colspan: 3, class: 'bad' }, state.error));
  } else if (!state.result) {
    cells.push(el('td', { colspan: 3, class: 'sub' }, state.pending || 'Waiting…'));
  } else {
    const { result } = state;
    const resell = item.resell;
    const profit = resell && result.best ? resell.low - result.best.price : null;
    cells.push(
      bestCell(result),
      el('td', { 'data-label': 'Resell' }, resell ? resell.text : '–'),
      el('td', { 'data-label': 'Est. profit', class: `price ${profit > 0 ? 'good' : profit < 0 ? 'bad' : ''}` }, money(profit)),
    );
  }
  row.replaceChildren(...cells);
}

checkButton.addEventListener('click', async () => {
  const text = $('#post').value.trim();
  if (!text) return setMessage('Paste a post first.', true);
  if (!currentArea?.location) {
    placeInput.focus();
    return setMessage('Set a search area first.', true);
  }

  checkButton.disabled = true;
  setMessage('Reading links…');
  tbody.replaceChildren();
  try {
    const { items } = await api('/api/parse', { text });
    if (!items.length) return setMessage('No instoreclearance.com links found in that text.', true);
    $('#results').hidden = false;

    const rows = items.map((item) => {
      const row = el('tr');
      renderRow(row, item, item.error ? { error: item.error } : {});
      tbody.append(row);
      return row;
    });

    let stopped = null;
    for (const [i, item] of items.entries()) {
      if (item.error) continue;
      if (stopped) {
        renderRow(rows[i], item, { error: 'Skipped' });
        continue;
      }
      setMessage(`Checking ${i + 1} of ${items.length}…`);
      renderRow(rows[i], item, { pending: 'Checking…' });
      try {
        const { result } = await api('/api/check', { dealsUrl: item.dealsUrl });
        renderRow(rows[i], item, { result });
      } catch (err) {
        renderRow(rows[i], item, { error: err.message });
        if (STOP_CODES.has(err.code)) stopped = err;
      }
    }
    setMessage(stopped ? `Stopped: ${stopped.message}` : `Done. Prices ${describeArea(currentArea)}.`, Boolean(stopped));
  } catch (err) {
    setMessage(err.message, true);
  } finally {
    checkButton.disabled = false;
    refreshStatus();
  }
});

refreshStatus();
api('/api/area').then(({ area }) => showArea(area)).catch((err) => setMessage(err.message, true));
