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
  if (!token) throw new Error('Link does not point to a featured item');
  const decoded = decodeItemToken(token);
  if (!decoded) throw new Error('Could not read the item token in this link');
  return { dealsUrl: dealsUrl.toString(), token, ...decoded };
}

export async function resolveLink(link) {
  const url = new URL(link);
  if (url.hostname.replace(/^www\./, '') !== SITE_HOST) throw new Error(`Not an ${SITE_HOST} link`);
  if (url.searchParams.has('featuredItem')) return fromDealsUrl(url);

  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
  const location = res.headers.get('location');
  if (res.status < 300 || res.status >= 400 || !location) {
    throw new Error(res.status === 404 ? 'Short link not found' : `Short link did not redirect (HTTP ${res.status})`);
  }
  return fromDealsUrl(new URL(location, SITE_ORIGIN));
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
  return results;
}
