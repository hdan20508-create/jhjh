import fs from 'node:fs';
import path from 'node:path';
import { getArea } from './area.js';
import { applyArea } from './browser.js';
import { SITE_ORIGIN } from './config.js';

// Records what instoreclearance.com sends back while you use the site yourself, so the data can be
// shared for development without sharing a login. Everything that could log someone in is removed
// before the file is written: login/auth traffic is never recorded, request headers and cookies are
// never recorded, and token-like fields and values are blanked.

const RECORDED = [
  { host: /(^|\.)instoreclearance\.com$/, path: /^\/(api\/|_next\/data\/)/ },
  { host: /\.supabase\.co$/, path: /^\/(functions\/v1\/|rest\/v1\/)/ },
];
const NEVER = /\/auth\/|\/callback|\/login|\/token|\/session/i;

const SECRET_KEY = /token|secret|password|passwd|session|cookie|authori[sz]ation|apikey|api_key|jwt|refresh|credential|email|phone/i;
const KEEP_KEYS = new Set(['itemToken']); // the deal code from the share link, not a login
const JWT = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/;
const EMAIL = /[^\s@"]+@[^\s@"]+\.[a-z]{2,}/gi;
const SECRET_PARAMS = /^(access_token|refresh_token|apikey|api_key|code|token_hash|provider_token|session)$/i;
const MAX_ARRAY = 400;

export function redact(value, key = '') {
  if (SECRET_KEY.test(key) && !KEEP_KEYS.has(key) && value != null && typeof value !== 'object') return '[removed]';
  if (typeof value === 'string') {
    if (JWT.test(value) || /^Bearer\s/i.test(value)) return '[removed]';
    return value.replace(EMAIL, '[email removed]');
  }
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ARRAY).map((v) => redact(v));
    if (value.length > MAX_ARRAY) kept.push(`[${value.length - MAX_ARRAY} more entries not saved]`);
    return kept;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  }
  return value;
}

export function shouldRecord(url) {
  const u = new URL(url);
  if (NEVER.test(u.pathname)) return false;
  return RECORDED.some((r) => r.host.test(u.hostname) && r.path.test(u.pathname));
}

export function cleanUrl(url) {
  const u = new URL(url);
  for (const name of [...u.searchParams.keys()]) {
    if (SECRET_PARAMS.test(name)) u.searchParams.set(name, '[removed]');
  }
  return u.toString();
}

function parseBody(text) {
  if (!text) return null;
  try {
    return redact(JSON.parse(text));
  } catch {
    return '[not JSON, not saved]';
  }
}

// Opens the logged-in Chrome window on the site and records until you close it.
export function capture(session, outDir) {
  return session.run(async (context) => {
    const startedAt = Date.now();
    const entries = [];
    const reads = [];

    context.on('response', (res) => {
      const req = res.request();
      if (req.method() === 'OPTIONS' || !shouldRecord(res.url())) return;
      reads.push((async () => {
        const headers = res.headers();
        entries.push({
          at: `+${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
          method: req.method(),
          url: cleanUrl(res.url()),
          status: res.status(),
          requestBody: parseBody(req.postData()),
          // Only headers that explain limits or caching; never cookies or auth.
          headers: Object.fromEntries(Object.entries(headers).filter(([k]) => /ratelimit|retry-after|x-cache|age/i.test(k))),
          responseBody: parseBody(await res.text().catch(() => '')),
        });
      })());
    });

    const page = await context.newPage();
    await applyArea(page, getArea());
    await page.goto(`${SITE_ORIGIN}/deals`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    console.log('Recording. Use the site in the Chrome window: open a deal, press Scan on a store or two,');
    console.log('open a locked item if you see one. Close the Chrome window when you\'re done.');

    await new Promise((resolve) => {
      context.on('close', resolve);
      const check = setInterval(() => {
        if (!context.pages().length) { clearInterval(check); resolve(); }
      }, 500);
      process.once('SIGINT', () => { clearInterval(check); resolve(); });
    });
    await Promise.allSettled(reads);
    await context.close().catch(() => {});

    entries.sort((a, b) => parseFloat(a.at.slice(1)) - parseFloat(b.at.slice(1)));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(outDir, `capture-${stamp}.json`);
    fs.writeFileSync(file, `${JSON.stringify({
      note: 'Responses from instoreclearance.com, with login traffic, cookies, headers and token-like values removed.',
      recordedAt: new Date(startedAt).toISOString(),
      entries,
    }, null, 2)}\n`);

    const counts = {};
    for (const e of entries) {
      const name = new URL(e.url).pathname.split('/').pop() || '/';
      counts[name] = (counts[name] || 0) + 1;
    }
    return { file, total: entries.length, counts };
  }, { headless: false });
}
