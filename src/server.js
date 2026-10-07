import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { AuthError, BrowserSession } from './browser.js';
import { CheckError, checkDeal } from './checker.js';
import { config } from './config.js';
import { parsePost } from './parse.js';
import { resolveAll } from './resolve.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const session = new BrowserSession();
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(publicDir));

function sendError(res, err) {
  const known = err instanceof AuthError || err instanceof CheckError;
  if (!known) console.error(err);
  res.status(known ? 409 : 500).json({ error: { code: err.code || 'error', message: err.message } });
}

app.get('/api/status', async (_req, res) => {
  try {
    res.json({
      signedIn: await session.hasSessionCookie(),
      profileDir: config.profileDir,
      location: config.location,
      headless: config.headless,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// Opens a visible Chrome window on this machine for the one-time Discord login.
app.post('/api/login', async (_req, res) => {
  try {
    res.json(await session.login());
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
    return res.status(400).json({ error: { code: 'bad_request', message: 'dealsUrl must be an instoreclearance.com deals link' } });
  }
  try {
    res.json({ result: await checkDeal(session, dealsUrl) });
  } catch (err) {
    sendError(res, err);
  }
});

// Bound to localhost: this server drives a browser that is signed in as you.
const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(`Clearance checker running at http://localhost:${config.port}`);
  console.log(`Chrome profile: ${config.profileDir}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    server.close();
    await session.close();
    process.exit(0);
  });
}
