import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  config, DISCORD_CLIENT_ID, SESSION_COOKIE, SITE_HOST, SITE_ORIGIN, SUPABASE_ORIGIN,
} from './config.js';

export class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const NEEDS_LOGIN = () => new AuthError(
  'needs_login',
  'You\'re logged out. Click "Log in with Discord" and finish signing in in the Chrome window that opens.',
);

// Errors that mean the browser itself can't run, so every other check would fail the same way.
const BROWSER_MISSING = () => new AuthError(
  'browser_missing',
  'Couldn\'t start Google Chrome. Install it from google.com/chrome, then try again.',
);

const CLOSED_RE = /Target (page, context or browser )?(has been |is )?closed|Browser (has been )?closed|browser has disconnected/i;

function isSitePage(url) {
  return url.hostname === SITE_HOST || url.hostname === `www.${SITE_HOST}`;
}

export function isLoginPage(page) {
  const url = new URL(page.url());
  return isSitePage(url) && url.pathname === '/login';
}

// Only approve the Discord consent screen for the app this site actually uses.
function assertExpectedOAuthClient(url) {
  const clientId = url.searchParams.get('client_id');
  const redirectUri = url.searchParams.get('redirect_uri') || '';
  if (clientId !== DISCORD_CLIENT_ID || !redirectUri.startsWith(`${SUPABASE_ORIGIN}/auth/v1/callback`)) {
    throw new AuthError(
      'unexpected_oauth_app',
      `The site's Discord login changed (app ${clientId}), so the checker won't approve it automatically. Log in with Discord to approve it yourself.`,
    );
  }
}

// Drives the site's own login: /login -> "Continue with Discord" -> Discord consent -> /callback.
// With a signed-in Discord profile this runs unattended. When Discord asks for a password,
// it waits for you to sign in (interactive) or fails with needs_login (headless).
export async function completeLogin(page, { interactive, timeoutMs = config.loginTimeoutMs }) {
  if (!isLoginPage(page)) await page.goto(`${SITE_ORIGIN}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /continue with discord/i }).click();

  const deadline = Date.now() + timeoutMs;
  let approved = false;
  let leftSite = false;
  while (Date.now() < deadline) {
    const url = new URL(page.url());

    if (isSitePage(url)) {
      // /login?error=... before we reach Discord is just the expired-session page we started on.
      if (leftSite && url.pathname === '/login' && url.searchParams.has('error')) {
        const reason = await page.locator('.text-red-700').first().innerText().catch(() => url.searchParams.get('error'));
        throw new AuthError('not_authorized', `The site rejected this Discord account: ${reason}`);
      }
      // Back on any page other than /login or /callback means the site accepted the session.
      if (leftSite && url.pathname !== '/login' && url.pathname !== '/callback') return;
    } else if (url.hostname.endsWith('discord.com')) {
      leftSite = true;
      if (url.pathname.startsWith('/login') || url.pathname.startsWith('/register')) {
        if (!interactive) throw NEEDS_LOGIN();
      } else if (url.pathname.includes('/oauth2/authorize') && !approved) {
        const authorize = page.getByRole('button', { name: /^authori[sz]e$/i });
        if (await authorize.isVisible().catch(() => false)) {
          assertExpectedOAuthClient(url);
          await authorize.click();
          approved = true;
        }
      }
    } else {
      leftSite = true; // the Supabase hop
    }
    await page.waitForTimeout(500);
  }
  throw new AuthError('login_timeout', 'Timed out waiting for the Discord login to finish.');
}

export async function readSavedLocation(page) {
  const raw = await page.evaluate(() => localStorage.getItem('userLocation')).catch(() => null);
  try {
    const loc = JSON.parse(raw);
    return Number.isFinite(loc?.lat) && Number.isFinite(loc?.lng) ? loc : null;
  } catch {
    return null;
  }
}

// The deals page only asks for prices once it knows where you are, and it reads that from
// localStorage. Writing the area there before the site's scripts run makes every check use it.
export async function applyArea(page, area) {
  if (!area.location && area.radiusMiles === undefined) return;
  await page.addInitScript(({ host, location, radius }) => {
    if (window.location.hostname !== host) return;
    if (location) localStorage.setItem('userLocation', JSON.stringify(location));
    if (radius !== undefined) localStorage.setItem('searchSettings', JSON.stringify({ searchRadius: radius }));
  }, { host: SITE_HOST, location: area.location, radius: area.radiusMiles });
}

// Chrome doesn't fail when a profile is already open; it hands off to the running copy and the
// launch hangs or half-works. So the checker keeps its own lock file in the profile.
const lockFile = () => path.join(config.profileDir, 'checker.pid');

function takeProfileLock() {
  try {
    const pid = Number(fs.readFileSync(lockFile(), 'utf8'));
    if (pid && pid !== process.pid) {
      process.kill(pid, 0); // throws if that process is gone
      throw new AuthError(
        'profile_in_use',
        'The checker is already running in another window. Use that one, or close it and try again.',
      );
    }
  } catch (err) {
    if (err instanceof AuthError) throw err;
  }
  fs.writeFileSync(lockFile(), String(process.pid));
}

function releaseProfileLock() {
  try {
    if (Number(fs.readFileSync(lockFile(), 'utf8')) === process.pid) fs.rmSync(lockFile());
  } catch {
    // already gone
  }
}

// Tries your Chrome, then Edge (preinstalled on Windows), then Playwright's own Chromium.
async function launch(headless) {
  fs.mkdirSync(config.profileDir, { recursive: true });
  takeProfileLock();
  const options = { headless, viewport: { width: 1280, height: 900 }, timeout: 30000 };
  const channels = [...new Set([config.channel, 'chrome', 'msedge', 'chromium'])];
  for (const channel of channels) {
    try {
      const context = await chromium.launchPersistentContext(
        config.profileDir,
        channel === 'chromium' ? options : { ...options, channel },
      );
      if (channel !== config.channel) console.warn(`[browser] Using ${channel}; ${config.channel} was not found.`);
      return context;
    } catch (err) {
      if (!/executable|is not found|not installed|distribution|doesn't exist/i.test(err.message)) {
        releaseProfileLock();
        throw err;
      }
    }
  }
  releaseProfileLock();
  throw BROWSER_MISSING();
}

// Owns the single persistent context. Chrome locks a profile directory, so every use goes
// through one queue, and the browser closes when idle so you can open the profile yourself.
export class BrowserSession {
  #context = null;
  #headless = true;
  #queue = Promise.resolve();
  #idleTimer = null;

  run(task, { headless = config.headless } = {}) {
    const result = this.#queue.then(async () => {
      clearTimeout(this.#idleTimer);
      const context = await this.#open(headless);
      try {
        return await task(context);
      } finally {
        this.#idleTimer = setTimeout(() => this.close(), config.idleCloseMs);
        this.#idleTimer.unref?.();
      }
    });
    this.#queue = result.catch(() => {});
    return result;
  }

  async #open(headless) {
    if (this.#context && this.#headless === headless) return this.#context;
    await this.close();
    this.#context = await launch(headless);
    this.#headless = headless;
    const context = this.#context;
    context.on('close', () => {
      if (this.#context === context) this.#context = null;
      releaseProfileLock();
    });
    return this.#context;
  }

  async close() {
    clearTimeout(this.#idleTimer);
    const context = this.#context;
    this.#context = null;
    if (context) await context.close().catch(() => {});
    releaseProfileLock();
  }

  // Closes the visible login window if one is open (the login() call then fails as cancelled).
  async cancelLogin() {
    if (this.#context && !this.#headless) await this.#context.close().catch(() => {});
  }

  // Cheap check: is there a site session cookie in the profile? (It may still be expired;
  // the site refreshes it on the next page load if the refresh token is still valid.)
  hasSessionCookie() {
    return this.run(async (context) => {
      const cookies = await context.cookies(SITE_ORIGIN);
      return cookies.some((c) => c.name === SESSION_COOKIE || c.name.startsWith(`${SESSION_COOKIE}.`));
    });
  }

  // One-time setup: opens a visible browser so you can sign in to Discord and approve the site.
  login() {
    return this.run(async (context) => {
      const page = await context.newPage();
      try {
        await page.goto(`${SITE_ORIGIN}/deals`, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        if (isLoginPage(page)) await completeLogin(page, { interactive: true });
        return { ok: true };
      } catch (err) {
        if (CLOSED_RE.test(err.message)) {
          throw new AuthError('login_cancelled', 'The login window was closed before you finished. Click "Log in with Discord" to try again.');
        }
        throw err;
      } finally {
        await page.close().catch(() => {});
      }
    }, { headless: false });
  }
}
