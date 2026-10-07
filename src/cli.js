import fs from 'node:fs';
import { geocode, getArea, setArea } from './area.js';
import { BrowserSession } from './browser.js';
import { checkDeal } from './checker.js';
import { parsePost } from './parse.js';
import { resolveAll } from './resolve.js';

const usage = `Usage:
  npm run login                  One-time: sign in to Discord in the saved Chrome profile
  npm run check -- post.txt      Check every link in a pasted Discord post (or pipe it on stdin)
  npm run area                   Show the search area
  npm run area -- 78701 30       Set it: ZIP, city, address or "lat, lng", then radius in miles`;

function describeArea(area) {
  const where = area.location ? (area.location.address || `${area.location.lat}, ${area.location.lng}`) : '(no location set)';
  return `${area.radiusMiles} mi around ${where}`;
}

function money(n) {
  return typeof n === 'number' ? `$${n.toFixed(2)}` : '-';
}

async function login(session) {
  console.log('Opening Chrome. Sign in to Discord and approve the site if asked.');
  await session.login();
  console.log('Logged in.');
  if (!getArea().location) console.log('Next, set your search area: npm run area -- <ZIP or city> [radius]');
}

async function area(args) {
  // A trailing 1-2 digit number is the radius (ZIP codes have 5 digits).
  const radius = /^\d{1,2}$/.test(args.at(-1) ?? '') ? Number(args.pop()) : undefined;
  if (args.length) setArea({ location: await geocode(args.join(' ')), radiusMiles: radius });
  else if (radius !== undefined) setArea({ radiusMiles: radius });
  console.log(`Search area: ${describeArea(getArea())}`);
}

async function check(session, file) {
  const text = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
  if (!getArea().location) throw new Error('No search area set. Run: npm run area -- <ZIP or city> [radius]');
  const items = await resolveAll(parsePost(text));
  if (!items.length) throw new Error('No instoreclearance.com links found.');
  console.log(`Checking ${describeArea(getArea())}\n`);

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

const [command, ...args] = process.argv.slice(2);
const session = new BrowserSession();
try {
  if (command === 'login') await login(session);
  else if (command === 'check') await check(session, args[0]);
  else if (command === 'area') await area(args);
  else console.log(usage);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await session.close();
}
