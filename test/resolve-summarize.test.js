import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarize } from '../src/checker.js';
import { decodeItemToken, resolveLink } from '../src/resolve.js';

// featuredItem from https://instoreclearance.com/s/MSnIK
const TOKEN = 'NTI5OTQ2Mjg6dGFyZ2V0OjE3OTA2Nzk0NTI6OGJtVnhCQXFGdzJBYW1TaExJUlpwRlI2LU1YV244b09oSG1YU2U5T1hrcw';

test('decodes the featured item token', () => {
  assert.deepEqual(decodeItemToken(TOKEN), { sku: '52994628', retailer: 'target', tokenDate: '2026-09-29T10:57:32.000Z' });
  assert.equal(decodeItemToken('not-a-token'), null);
});

test('accepts a deals URL without a network call', async () => {
  const resolved = await resolveLink(`https://instoreclearance.com/deals?minDiscount=55&featuredItem=${TOKEN}`);
  assert.equal(resolved.sku, '52994628');
  assert.equal(resolved.token, TOKEN);
});

test('rejects links to other sites', async () => {
  await assert.rejects(resolveLink('https://example.com/s/MSnIK'), /Not an instoreclearance.com link/);
});

test('summarize joins prices with stores and sorts by price then distance', () => {
  const item = {
    name: 'Vitamix E310', sku: '52994628', retailer: 'target', highestPrice: 349.99,
    priceAtStores: { 1001: 114.99, 1002: 104.99, 1003: 349.99, 1004: -1 },
  };
  const stores = [[
    { no: 1001, name: 'Target Near', streetAddress: '1 Main St', city: 'Austin', stateProvCode: 'TX', zip: '78701', coordinates: [-97.74, 30.27] },
    { no: 1002, name: 'Target Far', streetAddress: '9 Elm St', city: 'Round Rock', stateProvCode: 'TX', zip: '78664', coordinates: [-97.68, 30.51] },
  ]];
  const r = summarize(item, stores, null, { lat: 30.27, lng: -97.74 });

  assert.deepEqual(r.stores.map((s) => s.id), ['1002', '1001', '1003']);
  assert.equal(r.best.name, 'Target Far');
  assert.equal(r.best.discountPct, 70);
  assert.equal(r.best.address, '9 Elm St, Round Rock, TX 78664');
  assert.equal(r.stores[1].distanceMi, 0);
  assert.equal(r.stores[2].name, 'Store 1003');
  assert.equal(r.stores[2].discountPct, 0);
});
