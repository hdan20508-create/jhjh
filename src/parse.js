// Turns a pasted Discord post into one entry per instoreclearance.com link.
//
// Posts look like:
//   Ninja 0.5qt Stainless Steel Creami NC501
//   Retail: $75 (70% off)
//   Resell: $170+ on eBay
//   https://instoreclearance.com/s/L4ljS

const LINK_RE = /https?:\/\/(?:www\.)?instoreclearance\.com\/[^\s<>()]+/gi;
const LABEL_RE = /^\s*(retail|resell|resale|sells? for|msrp|price|sale|clearance)\s*:/i;
const PRICE_LINE_RE = /^\s*(?:retail|price|sale|clearance)\s*:\s*~?\s*\$?\s*([\d,]+(?:\.\d+)?)\s*\+?\s*(?:\(\s*(\d+(?:\.\d+)?)\s*%\s*off\s*\))?/i;
const RESELL_LINE_RE = /^\s*(?:resell|resale|sells? for)\s*:\s*(~)?\s*\$?\s*([\d,]+(?:\.\d+)?)\s*(\+)?\s*(?:on\s+(.+?))?\s*$/i;

// Discord copy-paste noise: "[3:16 PM]" prefixes and "Name — Today at 3:16 PM" header lines.
const TIME_PREFIX_RE = /^\[\d{1,2}:\d{2}(?:\s*[AP]M)?\]\s*/i;
const HEADER_LINE_RE = /\s[—–-]\s(?:Today|Yesterday|\d{1,2}\/\d{1,2}\/\d{2,4})(?:\s+at)?\s+\d{1,2}:\d{2}(?:\s*[AP]M)?\s*$/i;

// Strips Discord markdown and leading emoji/bullets so "🔥 **Retail:** $75" reads as "Retail: $75".
// Links are left alone (their codes can contain underscores).
function normalizeLine(line) {
  const parts = line.replace(TIME_PREFIX_RE, '').split(/(https?:\/\/\S+)/);
  return parts
    .map((part, i) => (i % 2 ? part : part.replace(/\*\*|__|~~|\|\||[*_`]/g, '')))
    .join('')
    .replace(/^[^\p{L}\p{N}$~(\[]+/u, '')
    .trim();
}

function money(text) {
  return Number(text.replace(/,/g, ''));
}

function cleanName(text) {
  return text
    .replace(LINK_RE, '')
    .replace(/[^\p{L}\p{N})\]"'.+%!?]+$/u, '') // trailing emoji and separators
    .replace(/\s+/g, ' ')
    .trim();
}

function describeBlock(lines) {
  const item = { name: null, postedPrice: null, postedDiscountPct: null, resell: null };
  let firstLabeled = lines.findIndex((l) => LABEL_RE.test(l));
  if (firstLabeled === -1) firstLabeled = lines.length;

  // The product name is the last unlabeled line before the price lines.
  for (let i = firstLabeled - 1; i >= 0 && !item.name; i--) {
    const name = cleanName(lines[i]);
    if (name) item.name = name;
  }

  for (const line of lines) {
    const price = line.match(PRICE_LINE_RE);
    if (price) {
      item.postedPrice = money(price[1]);
      if (price[2]) item.postedDiscountPct = Number(price[2]);
    }
    const resell = line.match(RESELL_LINE_RE);
    if (resell) {
      item.resell = {
        low: money(resell[2]),
        approx: Boolean(resell[1]),
        orMore: Boolean(resell[3]),
        venue: resell[4]?.trim() || null,
        text: line.replace(/^\s*resell\s*:\s*/i, '').trim(),
      };
    }
  }
  return item;
}

export function parsePost(text) {
  const items = [];
  const seen = new Set();
  let block = [];

  for (const rawLine of String(text).split(/\r?\n/)) {
    if (HEADER_LINE_RE.test(rawLine)) continue;
    const line = normalizeLine(rawLine);
    const links = line.match(LINK_RE);
    if (!links) {
      // A blank line ends a block, so intro text above the first item is dropped.
      if (line) block.push(line);
      else block = [];
      continue;
    }

    const inline = cleanName(line);
    const details = describeBlock(inline ? [...block, inline] : block);
    for (const link of links) {
      const url = link.replace(/[.,!?)\]]+$/, '');
      if (seen.has(url)) continue;
      seen.add(url);
      items.push({ ...details, name: details.name || inline || null, url });
    }
    block = [];
  }
  return items;
}
