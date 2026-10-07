import { getArea } from './area.js';
import { AuthError, applyArea, completeLogin, isLoginPage, readSavedLocation } from './browser.js';
import { config } from './config.js';

export class CheckError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Messages the site itself shows for these statuses.
const STATUS_ERRORS = {
  403: ['forbidden', 'The site refused the request. Try logging in again.'],
  404: ['unavailable', 'This item is no longer available.'],
  429: ['out_of_credits', 'Out of site credits. The site allows more in about an hour.'],
};

// The deals page also loads the full feed and images, which a link check doesn't need.
const SKIPPED_RESOURCES = new Set(['image', 'media', 'font']);
const SKIPPED_API = /\/functions\/v1\/(feed|storeproducts)\b/;

const ITEM_API = /\/functions\/v1\/getitem\b/;
const LOCKED_API = /\/api\/getlockeditem\b/;
const STORES_API = /\/functions\/v1\/get-stores\b/;

function milesBetween(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function storeFromApi(s) {
  const [lng, lat] = s.coordinates || [];
  return {
    id: String(s.no),
    name: s.name,
    address: [s.streetAddress, s.city, [s.stateProvCode, s.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    coords: Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null,
    link: s.storeLink || null,
  };
}

// Combines the site's getitem response with the store list it fetched for the same page.
export function summarize(item, storeLists, locked, location) {
  const stores = new Map();
  for (const list of storeLists) for (const s of list) stores.set(String(s.no), storeFromApi(s));

  const msrp = item.highestPrice || null;
  const prices = Object.entries(item.priceAtStores || {})
    .filter(([, price]) => typeof price === 'number' && price > 0)
    .map(([id, price]) => {
      const store = stores.get(id) || { id, name: `Store ${id}`, address: null, coords: null, link: null };
      return {
        ...store,
        price,
        discountPct: msrp && price < msrp ? Math.round(((msrp - price) / msrp) * 100) : 0,
        distanceMi: location && store.coords ? Math.round(milesBetween(location, store.coords) * 10) / 10 : null,
      };
    })
    .sort((a, b) => a.price - b.price || (a.distanceMi ?? Infinity) - (b.distanceMi ?? Infinity));

  return {
    name: item.name,
    sku: item.sku,
    retailer: item.retailer,
    image: item.image || null,
    productLink: item.link || null,
    category: item.category || null,
    msrp,
    best: prices[0] || null,
    stores: prices,
    // Target items outside your plan come back as "locked" pricing instead.
    locked: locked ? { available: Boolean(locked.available), stores: Object.keys(locked.discounted || {}).length } : null,
  };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function captureItem(page, dealsUrl) {
  const captured = { items: [], storeLists: [], locked: null, error: null, pending: 0, lastActivity: 0 };
  const reads = [];

  page.on('request', (req) => {
    if (req.method() === 'OPTIONS') return;
    if (ITEM_API.test(req.url()) || LOCKED_API.test(req.url())) captured.pending++;
  });
  page.on('requestfailed', (req) => {
    if (req.method() === 'OPTIONS') return;
    if (ITEM_API.test(req.url()) || LOCKED_API.test(req.url())) captured.pending--;
  });
  page.on('response', (res) => {
    const url = res.url();
    const isItem = ITEM_API.test(url);
    const isLocked = LOCKED_API.test(url);
    if (!isItem && !isLocked && !STORES_API.test(url)) return;
    if (res.request().method() === 'OPTIONS') return;
    reads.push((async () => {
      const body = res.ok() ? await readJson(res) : null;
      if (isItem || isLocked) {
        captured.pending--;
        captured.lastActivity = Date.now();
        if (!res.ok()) captured.error ??= res.status();
      }
      if (!body) return;
      if (isItem) captured.items.push(body);
      else if (isLocked) captured.locked = body.data ?? body;
      else if (Array.isArray(body)) captured.storeLists.push(body);
    })());
  });

  await page.goto(dealsUrl, { waitUntil: 'domcontentloaded' });
  return { captured, reads };
}

async function waitForItem(page, captured, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isLoginPage(page)) return 'login';
    const settled = captured.pending <= 0 && Date.now() - captured.lastActivity > 1500;
    if ((captured.items.length || captured.error) && settled) return 'done';
    await page.waitForTimeout(250);
  }
  return captured.items.length ? 'done' : 'timeout';
}

let lastCheckAt = 0;

async function attempt(context, dealsUrl) {
  const page = await context.newPage();
  try {
    const area = getArea();
    await applyArea(page, area);
    await page.route('**/*', (route) => {
      const req = route.request();
      if (SKIPPED_RESOURCES.has(req.resourceType()) || SKIPPED_API.test(req.url())) return route.abort();
      return route.continue();
    });

    const { captured, reads } = await captureItem(page, dealsUrl);
    const state = await waitForItem(page, captured);
    if (state === 'login') {
      // Session expired: log in again through Discord (unattended if Discord is still signed in).
      await completeLogin(page, { interactive: !config.headless });
      return null;
    }
    await Promise.all(reads);

    if (captured.error && !captured.items.length) {
      const [code, message] = STATUS_ERRORS[captured.error] || ['http_error', `The site returned HTTP ${captured.error}.`];
      throw new CheckError(code, message);
    }
    const location = await readSavedLocation(page);
    if (state === 'timeout') {
      throw location
        ? new CheckError('timeout', 'The site did not return prices for this item. There may be no stores in your search radius.')
        : new CheckError('no_location', 'No search area is set. Set one under "Search area" first.');
    }

    // The page may ask twice (all stores, then the item's own retailer); the later answer is more specific.
    const item = captured.items[captured.items.length - 1];
    return {
      ...summarize(item, captured.storeLists, captured.locked, location),
      area: { location, radiusMiles: area.radiusMiles },
      checkedAt: new Date().toISOString(),
    };
  } finally {
    await page.close().catch(() => {});
  }
}

export function checkDeal(session, dealsUrl) {
  return session.run(async (context) => {
    const wait = lastCheckAt + config.checkDelayMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      for (let tries = 0; tries < 2; tries++) {
        const result = await attempt(context, dealsUrl);
        if (result) return result;
      }
      throw new AuthError('login_loop', 'Logged in, but the site sent us back to the login page.');
    } catch (err) {
      if (err instanceof AuthError || err instanceof CheckError) throw err;
      throw new CheckError('browser_error', err.message);
    } finally {
      lastCheckAt = Date.now();
    }
  });
}
