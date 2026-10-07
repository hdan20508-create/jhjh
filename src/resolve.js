import { SITE_HOST, SITE_ORIGIN } from './config.js';

// Short links (/s/<code>) answer with a 302 to /deals?...&featuredItem=<token>, no login needed.
// The token is base64url("<sku>:<retailer>:<unix seconds>:<signature>"); the site's API
// takes it as-is, so we only decode it to show the SKU and retailer up front.

export function decodeItemToken(token) {
  try {
    const [sku, retailer, seconds, signature] = Buffer.from(token, 'base64url').toString('utf8').split(':');
    if (!sku || !retailer || !signature) return null;
    const ts = Number(seconds);
    return {
      sku,
      retailer,
      tokenDate: Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : null,
    };
  } catch {
    return null;
  }
}

function fromDealsUrl(dealsUrl) {
  const token = dealsUrl.searchParams.get('featuredItem');
  if (!token) throw new Error('This link didn\'t lead to a deal on the site.');
  const decoded = decodeItemToken(token);
  if (!decoded) throw new Error('This link\'s deal code couldn\'t be read.');
  return { dealsUrl: dealsUrl.toString(), token, ...decoded };
}

function isSiteHost(url) {
  return url.hostname.replace(/^www\./, '') === SITE_HOST;
}

export async function resolveLink(link) {
  let url = new URL(link);
  if (!isSiteHost(url)) throw new Error(`Not an ${SITE_HOST} link`);
  url.hostname = SITE_HOST; // www. links just redirect to the same path

  // Follow the site's own redirects (a few at most) until we reach the featured deal.
  for (let hops = 0; hops < 4; hops++) {
    if (url.searchParams.has('featuredItem')) return fromDealsUrl(url);
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !location) {
      throw new Error(res.status === 404 ? 'This link doesn\'t exist on the site (it may have been mistyped).' : 'This link didn\'t lead to a deal on the site.');
    }
    url = new URL(location, SITE_ORIGIN);
    if (!isSiteHost(url)) throw new Error('This link points somewhere other than the site.');
    url.hostname = SITE_HOST;
  }
  throw new Error('This link didn\'t lead to a deal on the site.');
}

export async function resolveAll(items, concurrency = 4) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ...items[i], ...(await resolveLink(items[i].url)) };
      } catch (err) {
        results[i] = { ...items[i], error: err.message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return mergeDuplicates(results);
}

// The same product posted under two links would otherwise be looked up (and paid for) twice.
export function mergeDuplicates(items) {
  const byKey = new Map();
  const merged = [];
  for (const item of items) {
    const key = item.sku && item.retailer ? `${item.retailer}:${item.sku}` : null;
    const first = key && byKey.get(key);
    if (first) {
      first.alsoPostedAs = [...(first.alsoPostedAs || []), item.url];
      continue;
    }
    if (key) byKey.set(key, item);
    merged.push(item);
  }
  return merged;
}
