import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { AreaError, geocode, getArea, RADIUS_MAX, RADIUS_MIN, setArea } from './area.js';
import { AuthError, BrowserSession } from './browser.js';
import { CheckError, checkDeal, checkStock, prewarm } from './checker.js';
import { config } from './config.js';
import { parsePost } from './parse.js';
import { resolveAll } from './resolve.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const appUrl = `http://localhost:${config.port}`;
const session = new BrowserSession();
const app = express();

// This server drives a browser that is logged in as you, so only this app's own page may use it.
// Checking Host blocks DNS-rebinding pages; requiring JSON plus a matching Origin blocks other
// sites' forms and scripts from starting a login or spending lookups.
const allowedHosts = new Set([`localhost:${config.port}`, `127.0.0.1:${config.port}`, ...config.allowedHosts]);
app.use((req, res, next) => {
  const host = String(req.headers.host || '').toLowerCase();
  if (!allowedHosts.has(host) && !allowedHosts.has(host.replace(/:\d+$/, ''))) {
    return res.status(403).send('This address is not allowed to use the checker.');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}` && origin !== `https://${host}`) {
      return res.status(403).json({ error: { code: 'forbidden_origin', message: 'Requests from other websites are blocked.' } });
    }
    if (!req.is('application/json')) {
      return res.status(415).json({ error: { code: 'bad_request', message: 'Expected JSON.' } });
    }
  }
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.static(publicDir));

// What the login light shows, kept in memory so it never waits behind a running check.
// 'signed_in' = a login or check just worked; 'saved' = a login cookie exists but hasn't been used
// yet; 'signed_out' = we know you need to log in; 'unknown' = not looked yet.
const auth = { state: 'unknown', browserError: null, loggingIn: false };

const SIGNED_OUT_CODES = new Set(['needs_login', 'not_authorized', 'login_loop', 'unexpected_oauth_app']);

function noteError(err) {
  if (SIGNED_OUT_CODES.has(err.code)) auth.state = 'signed_out';
  if (err.code === 'browser_missing' || err.code === 'profile_in_use') auth.browserError = err.message;
}

function sendError(res, err) {
  const known = err instanceof AuthError || err instanceof CheckError || err instanceof AreaError;
  if (!known) console.error(err);
  noteError(err);
  const extra = err.resetAt ? { resetAt: err.resetAt } : {};
  res.status(err instanceof AreaError ? 400 : known ? 409 : 500)
    .json({ error: { code: err.code || 'error', message: known ? err.message : 'Something went wrong in the checker. Try again.', ...extra } });
}

app.get('/api/status', (_req, res) => {
  res.json({ auth: auth.state, loggingIn: auth.loggingIn, browserError: auth.browserError });
});

// Opens a visible Chrome window on this machine for the Discord login.
app.post('/api/login', async (_req, res) => {
  auth.loggingIn = true;
  try {
    await session.login();
    auth.state = 'signed_in';
    auth.browserError = null;
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  } finally {
    auth.loggingIn = false;
  }
});

app.post('/api/login/cancel', async (_req, res) => {
  await session.cancelLogin();
  res.json({ ok: true });
});

// Starts Chrome and loads the deals page ahead of time, so the first check doesn't wait for it.
// Fire-and-forget: the page calls this when it opens and when you click Paste & check.
let warming = null;
app.post('/api/warm', (_req, res) => {
  if (!warming && getArea().location) {
    warming = prewarm(session)
      .catch((err) => { noteError(err); })
      .finally(() => { warming = null; });
  }
  res.json({ ok: true });
});

app.get('/api/area', (_req, res) => {
  res.json({ area: getArea(), radius: { min: RADIUS_MIN, max: RADIUS_MAX, step: 10 } });
});

// Body: { place?: "78701" | "Austin, TX" | "30.27, -97.74", location?: {lat,lng,address}, radiusMiles? }
app.post('/api/area', async (req, res) => {
  try {
    const { place, location, radiusMiles } = req.body || {};
    const update = { radiusMiles };
    if (typeof place === 'string' && place.trim()) update.location = await geocode(place);
    else if (location) update.location = { lat: Number(location.lat), lng: Number(location.lng), address: String(location.address || 'My location') };
    res.json({ area: setArea(update) });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/parse', async (req, res) => {
  const items = parsePost(req.body?.text || '');
  res.json({ items: await resolveAll(items) });
});

app.post('/api/check', async (req, res) => {
  const { dealsUrl } = req.body || {};
  if (typeof dealsUrl !== 'string' || !dealsUrl.startsWith('https://instoreclearance.com/deals?')) {
    return res.status(400).json({ error: { code: 'bad_request', message: 'That isn\'t an instoreclearance.com deal link.' } });
  }
  try {
    const result = await checkDeal(session, dealsUrl);
    auth.state = 'signed_in';
    auth.browserError = null;
    res.json({ result });
  } catch (err) {
    sendError(res, err);
  }
});

// One store's stock, on demand (the site's "Scan"). Body: { retailer, sku, store, token }.
app.post('/api/stock', async (req, res) => {
  const { retailer, sku, store, token } = req.body || {};
  try {
    res.json({ stock: await checkStock(session, { retailer, sku: String(sku ?? ''), store: String(store ?? ''), token }) });
  } catch (err) {
    sendError(res, err);
  }
});

function openInBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

const server = app.listen(config.port, '127.0.0.1', (err) => {
  if (err) {
    if (err.code === 'EADDRINUSE') {
      console.log(`The checker is already running. Open ${appUrl} in your browser.`);
      if (config.openBrowser) openInBrowser(appUrl);
    } else {
      console.error(`Couldn't start the checker: ${err.message}`);
    }
    process.exit(1);
  }
  console.log(`Clearance checker running at ${appUrl}`);
  console.log('Keep this window open while you use it.');
  if (config.openBrowser) openInBrowser(appUrl);

  // One quick look at the saved login so the light isn't blank on first load.
  session.hasSessionCookie()
    .then((saved) => { if (auth.state === 'unknown') auth.state = saved ? 'saved' : 'signed_out'; })
    .catch(noteError);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    server.close();
    await session.close();
    process.exit(0);
  });
}
