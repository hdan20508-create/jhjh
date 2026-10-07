import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Values observed in the site's own login flow (see README "How the site's auth works").
export const SITE_ORIGIN = 'https://instoreclearance.com';
export const SITE_HOST = 'instoreclearance.com';
export const SUPABASE_ORIGIN = 'https://ufpyekjfmuwzfdczaddc.supabase.co';
export const SESSION_COOKIE = 'sb-ufpyekjfmuwzfdczaddc-auth-token';
export const DISCORD_CLIENT_ID = '1380363144345682001';

function num(value) {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

const lat = num(process.env.LAT);
const lng = num(process.env.LNG);

export const config = {
  port: num(process.env.PORT) ?? 3000,
  // A dedicated profile directory, not your everyday Chrome profile: Chrome locks a
  // profile while it is open and refuses automation on its default profile.
  profileDir: path.resolve(process.env.PROFILE_DIR || path.join(root, '.chrome-profile')),
  // Saved search area (location + radius) set from the app.
  settingsFile: path.resolve(process.env.SETTINGS_FILE || path.join(root, 'settings.json')),
  // 'chrome' uses your installed Google Chrome; 'chromium' uses Playwright's bundled build.
  channel: process.env.BROWSER_CHANNEL || 'chrome',
  headless: process.env.HEADLESS !== 'false',
  // Optional starting search area; the app's Search area panel (settings.json) overrides it.
  location: lat !== undefined && lng !== undefined
    ? { lat, lng, address: process.env.LOCATION_LABEL || `${lat}, ${lng}` }
    : null,
  radiusMiles: num(process.env.RADIUS_MILES),
  // Minimum gap between item checks. Each check spends the site's per-hour credits.
  checkDelayMs: num(process.env.CHECK_DELAY_MS) ?? 4000,
  loginTimeoutMs: num(process.env.LOGIN_TIMEOUT_MS) ?? 5 * 60 * 1000,
  idleCloseMs: num(process.env.IDLE_CLOSE_MS) ?? 5 * 60 * 1000,
};
