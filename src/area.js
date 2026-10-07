import fs from 'node:fs';
import { config } from './config.js';

// The search area: where to look and how far. It is saved to settings.json and pushed into
// the site's own localStorage keys before each check, so it overrides whatever the site has saved.

// The site's radius slider goes from 10 to 80 miles in steps of 10.
export const RADIUS_MIN = 10;
export const RADIUS_MAX = 80;
export const RADIUS_DEFAULT = 50;

export class AreaError extends Error {
  code = 'bad_area';
}

function clampRadius(miles) {
  const n = Number(miles);
  if (!Number.isFinite(n)) return RADIUS_DEFAULT;
  return Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, Math.round(n / 10) * 10));
}

function validLocation(loc) {
  return loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)
    && Math.abs(loc.lat) <= 90 && Math.abs(loc.lng) <= 180;
}

let area = null;

export function getArea() {
  if (!area) {
    let saved = null;
    try {
      saved = JSON.parse(fs.readFileSync(config.settingsFile, 'utf8')).area;
    } catch {
      // No settings yet: fall back to LAT/LNG/RADIUS_MILES from the environment.
    }
    area = {
      location: validLocation(saved?.location) ? saved.location : config.location,
      radiusMiles: clampRadius(saved?.radiusMiles ?? config.radiusMiles ?? RADIUS_DEFAULT),
    };
  }
  return area;
}

export function setArea({ location, radiusMiles }) {
  const current = getArea();
  const next = {
    location: location === undefined ? current.location : location,
    radiusMiles: radiusMiles === undefined ? current.radiusMiles : clampRadius(radiusMiles),
  };
  if (next.location !== null && !validLocation(next.location)) throw new AreaError('That location has no valid coordinates.');
  fs.writeFileSync(config.settingsFile, `${JSON.stringify({ area: next }, null, 2)}\n`);
  area = next;
  return area;
}

const COORDS_RE = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

// Accepts "30.27, -97.74", a ZIP code, a city, or a street address (US only).
export async function geocode(query) {
  const text = String(query || '').trim();
  if (!text) throw new AreaError('Enter a ZIP code, city, or address.');

  const coords = text.match(COORDS_RE);
  if (coords) {
    const location = { lat: Number(coords[1]), lng: Number(coords[2]), address: text };
    if (!validLocation(location)) throw new AreaError('Those coordinates are out of range.');
    return location;
  }

  // OpenStreetMap's free geocoder. Its usage policy asks for an identifying User-Agent and
  // at most one request a second, which manual lookups stay well under.
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.search = new URLSearchParams({ q: text, countrycodes: 'us', format: 'jsonv2', limit: '1' });
  let results;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'clearance-link-checker/0.1 (personal use)', 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    results = await res.json();
  } catch (err) {
    throw new AreaError(`Couldn't look up that place (${err.message}). Try "lat, lng" instead.`);
  }
  if (!results.length) throw new AreaError(`No US place found for "${text}".`);

  const [hit] = results;
  return {
    lat: Number(hit.lat),
    lng: Number(hit.lon),
    address: hit.display_name.replace(/, United States$/, ''),
  };
}
