import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { parsePost } from '../src/parse.js';

const post = fs.readFileSync(new URL('./fixtures/kitchen-post.txt', import.meta.url), 'utf8');

test('parses every item in a multi-item post', () => {
  const items = parsePost(post);
  assert.equal(items.length, 6);
  assert.deepEqual(items.map((i) => i.url.split('/').pop()), ['MSnIK', 'L4ljS', 'B4mDN', 'Bj4RT', 'D3Apd', '06JEW']);
});

test('reads name, posted price, discount and resell', () => {
  const [vitamix, , , , ninjaDetect] = parsePost(post);
  assert.equal(vitamix.name, 'Vitamix Explorian Series E310 10 Speed Blender Black');
  assert.equal(vitamix.postedPrice, 114);
  assert.equal(vitamix.postedDiscountPct, 67);
  assert.deepEqual(vitamix.resell, { low: 250, approx: false, orMore: true, venue: 'eBay', text: '$250+ on eBay' });

  assert.equal(ninjaDetect.name, 'Ninja Detect Power Blender Pro - TB301');
  assert.equal(ninjaDetect.resell.low, 120);
  assert.equal(ninjaDetect.resell.approx, true);
});

test('does not take the intro line as the first item name', () => {
  assert.ok(!parsePost(post)[0].name.includes('clearance at Target'));
});

test('handles a link on the same line as the name and posts without blank lines', () => {
  const items = parsePost([
    'Deals:',
    'Shark Robot Vacuum https://instoreclearance.com/s/AAAAA',
    'Keurig K-Mini',
    'Retail: $1,049.99',
    'https://instoreclearance.com/s/BBBBB.',
  ].join('\n'));
  assert.equal(items.length, 2);
  assert.equal(items[0].name, 'Shark Robot Vacuum');
  assert.equal(items[1].name, 'Keurig K-Mini');
  assert.equal(items[1].postedPrice, 1049.99);
  assert.equal(items[1].url, 'https://instoreclearance.com/s/BBBBB');
});

test('ignores duplicate links and text without links', () => {
  assert.equal(parsePost('nothing here').length, 0);
  assert.equal(parsePost('A\nhttps://instoreclearance.com/s/X1\n\nA\nhttps://instoreclearance.com/s/X1').length, 1);
});

test('reads posts with emoji, bold labels and Discord copy-paste headers', () => {
  const items = parsePost([
    'Deals Bot — Today at 3:16 PM',
    '🔥 **Vitamix Explorian E310** 🔥',
    '💰 **Retail:** $114 (67% off)',
    '📈 __Resell__: $250+ on eBay',
    '🔗 https://instoreclearance.com/s/AB_cd',
    '',
    '[3:17 PM] • Ninja Creami NC501',
    '> Retail: ~$75',
    '> Resale: ~$170 on eBay',
    '> https://www.instoreclearance.com/s/L4ljS',
  ].join('\n'));
  assert.equal(items.length, 2);
  assert.equal(items[0].name, 'Vitamix Explorian E310');
  assert.equal(items[0].postedPrice, 114);
  assert.equal(items[0].postedDiscountPct, 67);
  assert.equal(items[0].resell.low, 250);
  assert.equal(items[0].url, 'https://instoreclearance.com/s/AB_cd'); // underscore in the code survives
  assert.equal(items[1].name, 'Ninja Creami NC501');
  assert.equal(items[1].postedPrice, 75);
  assert.equal(items[1].resell.low, 170);
  assert.equal(items[1].url, 'https://www.instoreclearance.com/s/L4ljS');
});
