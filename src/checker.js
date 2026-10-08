import { getArea } from './area.js';
import { AuthError, applyArea, completeLogin, isLoginPage, readSavedLocation } from './browser.js';
import { config, SESSION_COOKIE, SITE_HOST, SITE_ORIGIN, SUPABASE_ORIGIN } from './config.js';
import { decodeItemToken } from './resolve.js';

export class CheckError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

// What the site's statuses mean, in plain words.
const STATUS_ERRORS = {
  403: ['forbidden', 'The site refused this lookup. If it keeps happening, your account may have lost access to the site.'],
  404: ['unavailable', 'This item isn\'t available on the site anymore.'],
  429: ['out_of_credits', 'You\'re out of lookups on the site for now. They come back within about an hour.'],
};

// A check only needs the site's data calls. Skip the deals feed, Google Maps, analytics, and the
// site's own images/fonts/styles (only on the site, so Discord's login page still renders).
const SITE_ASSET_TYPES = new Set(['image', 'media', 'font', 'stylesheet']);
const SITE_HOSTS = /(^|\.)instoreclearance\.com$|\.supabase\.co$/;
const BLOCKED_HOSTS = /googleapis\.com$|gstatic\.com$|google-analytics\.com$|googletagmanager\.com$|doubleclick\.net$/;
const SKIPPED_API = /\/functions\/v1\/(feed|storeproducts)\b/;

const ITEM_API = /\/functions\/v1\/getitem\b/;
const LOCKED_API = /\/api\/getlockeditem\b/;
const STORES_API = /\/functions\/v1\/get-stores\b/;
const AVAILABLE_API = /\/functions\/v1\/get-available-stores\b/;

// How long the fast path (switching an already-open deals page) may take before we give up
// and load the page from scratch.
const WARM_TIMEOUT_MS = 8000;

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
// `retailerStores` must be the item's own retailer's stores only: store numbers are per retailer,
// so Walmart #1234 and Target #1234 are different places. The site's store lists cover the whole
// country, so like the site we keep only stores inside your radius.
//
// When the site hides prices (`hidePrices`: Target when Target isn't on your plan), it: the price
// answer it gets is for unrelated store numbers and the site ignores it. What it does show is which
// nearby stores have the item discounted (yes/no), from the "locked" answer, so that's what we report.
export function summarize(item, retailerStores, locked, location, { radiusMiles = null, hidePrices = false } = {}) {
  const stores = new Map();
  for (const raw of retailerStores) {
    const store = storeFromApi(raw);
    store.distanceMi = location && store.coords ? Math.round(milesBetween(location, store.coords) * 10) / 10 : null;
    stores.set(store.id, store);
  }
  const nearby = (store) => radiusMiles == null || store.distanceMi == null || store.distanceMi <= radiusMiles;
  const msrp = item.highestPrice || null;
  const base = {
    name: item.name,
    sku: item.sku,
    retailer: item.retailer,
    image: item.image || null,
    productLink: item.link || null,
    category: item.category || null,
    msrp,
  };

  if (hidePrices) {
    const flags = locked?.discounted || {};
    const checked = [...stores.values()].filter((s) => nearby(s) && s.id in flags);
    const discountedStores = checked.filter((s) => flags[s.id] === true)
      .sort((a, b) => (a.distanceMi ?? Infinity) - (b.distanceMi ?? Infinity));
    return {
      ...base,
      best: null,
      stores: [],
      fullPriceStores: 0,
      locked: { discountedStores, checkedStores: checked.length },
    };
  }

  const prices = Object.entries(item.priceAtStores || {})
    .filter(([, price]) => typeof price === 'number' && price > 0)
    .filter(([id]) => !stores.size || (stores.has(id) && nearby(stores.get(id))))
    .map(([id, price]) => ({
      ...(stores.get(id) || { id, name: `Store ${id}`, address: null, coords: null, link: null, distanceMi: null }),
      price,
      discountPct: msrp ? Math.max(0, Math.round(((msrp - price) / msrp) * 100)) : null,
    }))
    .sort((a, b) => a.price - b.price || (a.distanceMi ?? Infinity) - (b.distanceMi ?? Infinity));
  // A store at full price (or above) is not a deal, even if it's the cheapest one.
  const deals = prices.filter((s) => !msrp || s.price < msrp);

  return {
    ...base,
    best: deals[0] || null,
    stores: deals,
    fullPriceStores: prices.length - deals.length,
    locked: null,
  };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function tokenOf(url) {
  try {
    return new URL(url).searchParams.get('token') || new URL(url).searchParams.get('featuredItem');
  } catch {
    return null;
  }
}

// ---------- the warm page ----------
// One deals page stays open between checks. The first check loads it normally; later checks switch
// it to the next item with the site's own in-page navigation, so the site's code, your login and the
// store lists don't reload every time. Store lists and the retailers on your plan are remembered.

let warm = null; // { page, context, areaKey, stores: Map(retailer -> Map(no -> store)), available, ready }

async function blockExtras(page) {
  await page.route('**/*', (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (BLOCKED_HOSTS.test(url.hostname) || SKIPPED_API.test(url.pathname)) return route.abort();
    if (SITE_HOSTS.test(url.hostname) && SITE_ASSET_TYPES.has(req.resourceType())) return route.abort();
    return route.fallback();
  });
}

async function warmPage(context, area) {
  const areaKey = JSON.stringify(area);
  if (warm && warm.context === context && warm.areaKey === areaKey && !warm.page.isClosed()) return warm;
  if (warm && !warm.page.isClosed()) await warm.page.close().catch(() => {});

  const page = await context.newPage();
  await applyArea(page, area);
  await blockExtras(page);
  const state = { page, context, areaKey, stores: new Map(), available: null, ready: false };
  page.on('response', async (res) => {
    if (res.request().method() === 'OPTIONS' || !res.ok()) return;
    const url = res.url();
    if (STORES_API.test(url)) {
      const type = new URL(url).searchParams.get('storeType');
      const list = await readJson(res);
      if (!type || !Array.isArray(list)) return;
      if (!state.stores.has(type)) state.stores.set(type, new Map());
      for (const store of list) state.stores.get(type).set(String(store.no), store);
    } else if (AVAILABLE_API.test(url)) {
      const types = await readJson(res);
      if (Array.isArray(types)) state.available = new Set(types);
    }
  });
  page.on('close', () => { if (warm === state) warm = null; });
  warm = state;
  return state;
}

async function routerReady(page) {
  return page.evaluate(() => Boolean(window.next?.router?.push) && window.location.pathname === '/deals').catch(() => false);
}

// Loads the deals page in the background (on app open or Paste & check) so the first check is fast.
export function prewarm(session) {
  return session.run(async (context) => {
    const state = await warmPage(context, getArea());
    if (state.ready) return;
    await state.page.goto(`${SITE_ORIGIN}/deals`, { waitUntil: 'domcontentloaded' });
    await state.page.waitForFunction(() => window.next?.router?.isReady, null, { timeout: 15000 }).catch(() => {});
    // Let the site finish starting up (your plan and nearby stores) so the first check skips it.
    const deadline = Date.now() + 15000;
    while (!state.available && !isLoginPage(state.page) && Date.now() < deadline) await state.page.waitForTimeout(100);
    if (state.available) await state.page.waitForTimeout(300);
    state.ready = await routerReady(state.page);
  });
}

// ---------- watching one item ----------

function watchItem(page, token) {
  const captured = { items: [], locked: null, error: null, pending: 0, lastActivity: 0, firstRequestAt: 0, firstResponseAt: 0, calls: 0 };
  const reads = [];
  const mine = (req) => req.method() !== 'OPTIONS' && (ITEM_API.test(req.url()) || LOCKED_API.test(req.url())) && tokenOf(req.url()) === token;

  const onRequest = (req) => {
    if (!mine(req)) return;
    captured.pending++;
    captured.calls++;
    captured.firstRequestAt ||= Date.now();
  };
  const onFailed = (req) => { if (mine(req)) captured.pending--; };
  const onResponse = (res) => {
    if (!mine(res.request())) return;
    reads.push((async () => {
      const body = res.ok() ? await readJson(res) : null;
      captured.pending--;
      captured.lastActivity = Date.now();
      captured.firstResponseAt ||= Date.now();
      if (!res.ok()) captured.error ??= res.status();
      if (!body) return;
      if (ITEM_API.test(res.url())) captured.items.push(body);
      else captured.locked = body.data ?? body;
    })());
  };
  page.on('request', onRequest);
  page.on('requestfailed', onFailed);
  page.on('response', onResponse);
  const dispose = () => {
    page.off('request', onRequest);
    page.off('requestfailed', onFailed);
    page.off('response', onResponse);
  };
  return { captured, reads, dispose };
}

function hasPrices(item) {
  return Object.values(item?.priceAtStores || {}).some((price) => typeof price === 'number' && price > 0);
}

// Done as soon as the price for this item's retailer is in. Only when the retailer isn't on your
// plan (or we don't know yet) does the page make a follow-up call, so then wait for things to settle.
// The site's three cases (from its deals page code, confirmed with captures):
//  - retailer on your plan: one price answer for that retailer's nearby stores.
//  - Target, not on your plan: prices are hidden; a "locked" answer says which nearby Targets
//    have it discounted.
//  - any other retailer not on your plan: the site loads that retailer's stores, then asks again;
//    only that second answer is priced at the retailer's own stores.
export function pricesHidden(retailer, plan) {
  return retailer === 'target' && Boolean(plan) && !plan.has('target');
}

async function waitForItem(page, captured, { retailer, available, isOwnAnswer, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isLoginPage(page)) return 'login';
    if ((captured.items.length || captured.error) && captured.pending <= 0) {
      const plan = available();
      const quietMs = Date.now() - captured.lastActivity;
      if (captured.error) return 'done';
      if (pricesHidden(retailer, plan)) {
        if (captured.locked || quietMs > 2500) return 'done';
      } else if (plan && !plan.has(retailer)) {
        if (captured.items.some(isOwnAnswer) || quietMs > 2500) return 'done';
      } else if (plan?.has(retailer) || captured.items.some(hasPrices)) {
        return 'done';
      } else if (quietMs > 1200) {
        return 'done';
      }
    }
    await page.waitForTimeout(100);
  }
  return captured.items.length ? 'done' : 'timeout';
}

let lastCheckAt = 0;

async function attempt(context, dealsUrl, timings) {
  const area = getArea();
  const state = await warmPage(context, area);
  const { page } = state;
  const target = new URL(dealsUrl);
  const token = target.searchParams.get('featuredItem');
  const { retailer } = decodeItemToken(token) || {};
  const path = `${target.pathname}${target.search}`;

  const run = async (mode) => {
    const watch = watchItem(page, token);
    const start = Date.now();
    // Record what the site requests before asking for the price, to explain a slow "page" step.
    const trace = [];
    const onTraceRequest = (req) => {
      if (!watch.captured.firstRequestAt && trace.length < 20) {
        const url = new URL(req.url());
        // Skip what blockExtras() throws away; only list requests that actually cost time.
        if (BLOCKED_HOSTS.test(url.hostname) || SKIPPED_API.test(url.pathname)) return;
        if (SITE_HOSTS.test(url.hostname) && SITE_ASSET_TYPES.has(req.resourceType())) return;
        trace.push(`+${((Date.now() - start) / 1000).toFixed(1)}s ${req.method()} ${url.hostname.split('.')[0]}${url.pathname}`);
      }
    };
    page.on('request', onTraceRequest);
    try {
      // shallow: just change the item in the URL; don't make the site re-run its server-side
      // page loading (and login check) for a page that's already showing.
      if (mode === 'warm') await page.evaluate((href) => { window.next.router.push(href, undefined, { shallow: true }); }, path);
      else await page.goto(dealsUrl, { waitUntil: 'domcontentloaded' });
      const result = await waitForItem(page, watch.captured, {
        retailer,
        available: () => state.available, // read live: the site may send it after we start
        // An answer priced at this retailer's own stores (store numbers are per retailer).
        isOwnAnswer: (item) => Object.keys(item?.priceAtStores || {}).some((id) => state.stores.get(retailer)?.has(id)),
        timeoutMs: mode === 'warm' ? WARM_TIMEOUT_MS : 30000,
      });
      await Promise.all(watch.reads);
      const c = watch.captured;
      timings.mode = mode;
      timings.pageMs = (c.firstRequestAt || Date.now()) - start;
      timings.priceMs = c.firstResponseAt && c.firstRequestAt ? c.firstResponseAt - c.firstRequestAt : null;
      timings.settleMs = c.firstResponseAt ? Date.now() - c.firstResponseAt : null;
      timings.calls = c.calls;
      if (timings.pageMs > 1500) timings.trace = trace;
      return { result, captured: c };
    } finally {
      watch.dispose();
      page.off('request', onTraceRequest);
    }
  };

  // Fast path: switch the open deals page to this item. Re-checking the item it's already showing
  // wouldn't ask the site again, so that one always reloads.
  let outcome = null;
  const sameItem = new URL(page.url() === 'about:blank' ? SITE_ORIGIN : page.url()).searchParams.get('featuredItem') === token;
  if (state.ready && !sameItem && await routerReady(page)) {
    outcome = await run('warm');
    if (outcome.result === 'timeout') {
      timings.warmFailedMs = timings.pageMs;
      outcome = null;
    }
  }
  if (!outcome) outcome = await run('fresh');

  if (outcome.result === 'login') {
    state.ready = false;
    // Session expired: log in again through Discord (unattended if Discord is still signed in).
    await completeLogin(page, { interactive: !config.headless });
    return null;
  }
  state.ready = await routerReady(page);

  const { captured } = outcome;
  if (captured.error && !captured.items.length) {
    const [code, message] = STATUS_ERRORS[captured.error] || ['http_error', `The site had a problem with this item (error ${captured.error}). Try it again later.`];
    const extra = code === 'out_of_credits' ? { resetAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() } : {};
    throw new CheckError(code, message, extra);
  }
  const location = await readSavedLocation(page);
  if (outcome.result === 'timeout') {
    throw location
      ? new CheckError('timeout', 'The site didn\'t send prices for this item. There may be no stores that carry it inside your radius.')
      : new CheckError('no_location', 'No search area is set. Set one under "Search area" first.');
  }

  // The page may ask more than once; prefer the latest answer priced at this retailer's own stores.
  const ownStores = state.stores.get(retailer);
  const item = [...captured.items].reverse().find((it) => Object.keys(it.priceAtStores || {}).some((id) => ownStores?.has(id)))
    || captured.items[captured.items.length - 1];
  const itemRetailer = item.retailer || retailer;
  return {
    ...summarize(item, [...(state.stores.get(itemRetailer)?.values() || [])], captured.locked, location,
      { radiusMiles: area.radiusMiles, hidePrices: pricesHidden(itemRetailer, state.available) }),
    // The signed per-item code the site's stock check needs (not a login token).
    stockToken: item.token || null,
    area: { location, radiusMiles: area.radiusMiles },
    checkedAt: new Date().toISOString(),
  };
}

function seconds(ms) {
  return ms == null ? '-' : `${(ms / 1000).toFixed(1)}s`;
}

export function checkDeal(session, dealsUrl) {
  const queuedAt = Date.now();
  const timings = {};
  return session.run(async (context) => {
    timings.startMs = Date.now() - queuedAt; // waiting behind other work + starting Chrome
    const gap = lastCheckAt + config.checkDelayMs - Date.now();
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    timings.gapMs = Math.max(0, gap);
    try {
      for (let tries = 0; tries < 2; tries++) {
        const result = await attempt(context, dealsUrl, timings);
        if (result) {
          timings.totalMs = Date.now() - queuedAt;
          const { sku, retailer } = decodeItemToken(new URL(dealsUrl).searchParams.get('featuredItem')) || {};
          console.log(`[check] ${retailer} ${sku}: ${seconds(timings.totalMs)} total (${timings.mode} page) = `
            + `start ${seconds(timings.startMs)} + gap ${seconds(timings.gapMs)} + page ${seconds(timings.pageMs)} `
            + `+ price ${seconds(timings.priceMs)} + settle ${seconds(timings.settleMs)}`
            + ` [${timings.calls} price call${timings.calls === 1 ? '' : 's'}]`
            + (timings.warmFailedMs ? ` (fast path gave up after ${seconds(timings.warmFailedMs)})` : ''));
          if (timings.trace?.length) console.log(`[check]   before the price call, the site requested:\n[check]     ${timings.trace.join('\n[check]     ')}`);
          return { ...result, timings };
        }
      }
      throw new AuthError('login_loop', 'The site keeps sending the checker back to its login page. Click "Log in with Discord" to log in again.');
    } catch (err) {
      if (err instanceof AuthError || err instanceof CheckError) throw err;
      console.error('[check]', err);
      throw new CheckError('browser_error', 'Something went wrong in the checker\'s browser. Try this item again.');
    } finally {
      lastCheckAt = Date.now();
    }
  });
}

// ---------- stock check ----------
// The same per-store check as the site's "Scan" button: how many the store has, its price, and
// sometimes the aisle. It runs on demand only (one store per click), since it likely uses a lookup.

const RETAILER_RE = /^[a-z]{2,20}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

function sessionToken(cookies) {
  const named = (name) => cookies.find((c) => c.name === name)?.value;
  let raw = named(SESSION_COOKIE);
  if (!raw) {
    const parts = [];
    for (let i = 0; named(`${SESSION_COOKIE}.${i}`) != null; i++) parts.push(named(`${SESSION_COOKIE}.${i}`));
    raw = parts.join('');
  }
  if (!raw) return null;
  try {
    raw = decodeURIComponent(raw);
    if (raw.startsWith('base64-')) raw = Buffer.from(raw.slice(7), 'base64url').toString('utf8');
    const session = JSON.parse(raw);
    return Array.isArray(session) ? session[0] : session.access_token;
  } catch {
    return null;
  }
}

function tokenExpired(jwt) {
  try {
    const { exp } = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    return !exp || exp * 1000 < Date.now() + 30000;
  } catch {
    return true;
  }
}

export function checkStock(session, { retailer, sku, store, token }) {
  if (!RETAILER_RE.test(retailer || '') || !ID_RE.test(sku || '') || !ID_RE.test(store || '') || !token) {
    return Promise.reject(new CheckError('bad_request', 'Missing details for this stock check.'));
  }
  return session.run(async (context) => {
    const state = await warmPage(context, getArea());
    const { page } = state;
    const onSite = () => { try { return new URL(page.url()).hostname === SITE_HOST; } catch { return false; } };

    // The site keeps the login fresh while its page is open; reload it if the token has run out.
    let jwt = sessionToken(await context.cookies(SITE_ORIGIN));
    if (!onSite() || !jwt || tokenExpired(jwt)) {
      await page.goto(`${SITE_ORIGIN}/deals`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      state.ready = await routerReady(page);
      if (isLoginPage(page)) throw new AuthError('needs_login', 'You\'re logged out. Click "Log in with Discord", then try the stock check again.');
      jwt = sessionToken(await context.cookies(SITE_ORIGIN));
      if (!jwt) throw new AuthError('needs_login', 'You\'re logged out. Click "Log in with Discord", then try the stock check again.');
      if (tokenExpired(jwt)) throw new AuthError('needs_login', 'Your login on the site expired. Click "Re-login", then try again.');
    }

    const url = new URL(`${SUPABASE_ORIGIN}/functions/v1/stock-check`);
    url.search = new URLSearchParams({ store, storetype: retailer, sku, token }).toString();
    // Sent from the site's own page, like the site's Scan button.
    const { status, body } = await page.evaluate(async ({ href, bearer }) => {
      const res = await fetch(href, { headers: { Authorization: `Bearer ${bearer}` } });
      let data = null;
      try { data = await res.json(); } catch { /* not JSON */ }
      return { status: res.status, body: data };
    }, { href: url.toString(), bearer: jwt });

    if (status === 429) throw new CheckError('out_of_credits', 'Out of stock checks on the site for now. They come back within about an hour.', { resetAt: new Date(Date.now() + 3600e3).toISOString() });
    if (status === 401) throw new AuthError('needs_login', 'The site didn\'t accept the login. Click "Re-login", then try again.');
    if (status === 403) throw new CheckError('forbidden', 'The site refused this stock check. Your plan may not include it for this store.');
    if (status !== 200 || !body) throw new CheckError('http_error', `The stock check didn't work (error ${status}). Try again later.`);
    return {
      store,
      inStock: typeof body.storeStock === 'number' ? body.storeStock : null,
      price: typeof body.storePrice === 'number' && body.storePrice >= 0 ? body.storePrice : null,
      aisle: body.aisle || null,
      pickup: typeof body.puAvail === 'boolean' ? body.puAvail : null,
      checkedAt: new Date().toISOString(),
    };
  });
}
