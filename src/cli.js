import fs from 'node:fs';
import { BrowserSession } from './browser.js';
import { checkDeal } from './checker.js';
import { parsePost } from './parse.js';
import { resolveAll } from './resolve.js';

const usage = `Usage:
  npm run login                  One-time: sign in to Discord in the saved Chrome profile
  npm run check -- post.txt      Check every link in a pasted Discord post (or pipe it on stdin)`;

function money(n) {
  return typeof n === 'number' ? `$${n.toFixed(2)}` : '-';
}

async function login(session) {
  console.log('Opening Chrome. Sign in to Discord and approve the site if asked.');
  const { location } = await session.login();
  console.log(`Logged in. Location on the site: ${location?.address ?? `${location?.lat}, ${location?.lng}`}`);
}

async function check(session, file) {
  const text = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
  const items = await resolveAll(parsePost(text));
  if (!items.length) throw new Error('No instoreclearance.com links found.');

  for (const item of items) {
    const label = item.name || item.url;
    if (item.error) {
      console.log(`✗ ${label}\n    ${item.error}`);
      continue;
    }
    try {
      const r = await checkDeal(session, item.dealsUrl);
      const best = r.best
        ? `${money(r.best.price)} (${r.best.discountPct}% off ${money(r.msrp)}) at ${r.best.name}${r.best.distanceMi != null ? `, ${r.best.distanceMi} mi` : ''}`
        : 'no discounted price near you';
      const profit = r.best && item.resell ? `  est. profit ${money(item.resell.low - r.best.price)}` : '';
      console.log(`✓ ${r.name || label}  [${r.retailer} ${r.sku}]\n    best: ${best}; ${r.stores.length} store(s) with a price${profit}`);
    } catch (err) {
      console.log(`✗ ${label}\n    ${err.message}`);
      process.exitCode = 1;
      if (['out_of_credits', 'needs_login', 'not_authorized', 'login_timeout', 'no_location'].includes(err.code)) break;
    }
  }
}

const [command, arg] = process.argv.slice(2);
const session = new BrowserSession();
try {
  if (command === 'login') await login(session);
  else if (command === 'check') await check(session, arg);
  else console.log(usage);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await session.close();
}
