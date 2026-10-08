import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarize } from '../src/checker.js';
import { decodeItemToken, mergeDuplicates, resolveLink } from '../src/resolve.js';

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
  const stores = [
    { no: 1001, name: 'Target Near', streetAddress: '1 Main St', city: 'Austin', stateProvCode: 'TX', zip: '78701', coordinates: [-97.74, 30.27] },
    { no: 1002, name: 'Target Far', streetAddress: '9 Elm St', city: 'Round Rock', stateProvCode: 'TX', zip: '78664', coordinates: [-97.68, 30.51] },
    { no: 1003, name: 'Target Mall', coordinates: [-97.7, 30.3] },
  ];
  const r = summarize(item, stores, null, { lat: 30.27, lng: -97.74 });

  assert.deepEqual(r.stores.map((s) => s.id), ['1002', '1001']);
  assert.equal(r.best.name, 'Target Far');
  assert.equal(r.best.discountPct, 70);
  assert.equal(r.best.address, '9 Elm St, Round Rock, TX 78664');
  assert.equal(r.stores[1].distanceMi, 0);
  assert.equal(r.fullPriceStores, 1); // store 1003 sells at MSRP, so it's not a deal
});

test('summarize ignores prices at stores that are not the item\'s retailer', () => {
  // The site prices the item across every nearby store number; #2002 here is a Walmart number,
  // not one of the Target stores, so it must not show up as a Target store.
  const item = { retailer: 'target', highestPrice: 100, priceAtStores: { 1001: 40, 2002: 20 } };
  const r = summarize(item, [{ no: 1001, name: 'Target Near', coordinates: [-97.74, 30.27] }], null, null);
  assert.deepEqual(r.stores.map((s) => s.name), ['Target Near']);
  assert.equal(r.best.price, 40);
});

test('summarize never calls a full-price store the best deal', () => {
  const r = summarize({ highestPrice: 100, priceAtStores: { 1: 100, 2: 120 } }, [], null, null);
  assert.equal(r.best, null);
  assert.equal(r.stores.length, 0);
  assert.equal(r.fullPriceStores, 2);
});

test('summarize keeps prices but no discount when MSRP is unknown', () => {
  const r = summarize({ priceAtStores: { 1: 40 } }, [], null, null);
  assert.equal(r.best.price, 40);
  assert.equal(r.best.discountPct, null);
});

test('merges the same product posted under two links', () => {
  const items = mergeDuplicates([
    { url: 'a', sku: '1', retailer: 'target' },
    { url: 'b', sku: '2', retailer: 'target' },
    { url: 'c', sku: '1', retailer: 'target' },
    { url: 'd', error: 'bad link' },
  ]);
  assert.deepEqual(items.map((i) => i.url), ['a', 'b', 'd']);
  assert.deepEqual(items[0].alsoPostedAs, ['c']);
});

test('summarize keeps only stores inside the radius (store lists are nationwide)', () => {
  const item = { retailer: 'walmart', highestPrice: 100, priceAtStores: { 1: 40, 2: 20 } };
  const stores = [
    { no: 1, name: 'Walmart Lowell', coordinates: [-71.33, 42.63] },
    { no: 2, name: 'Walmart Minnetonka', coordinates: [-93.46, 44.97] },
  ];
  const r = summarize(item, stores, null, { lat: 42.629, lng: -71.34 }, { radiusMiles: 50 });
  assert.deepEqual(r.stores.map((s) => s.name), ['Walmart Lowell']);
});

test('not on your plan: ignores the hidden prices and reports nearby stores with it on clearance', () => {
  // Shapes from a real capture: Target not on the plan; getitem prices are for unrelated store
  // numbers, getlockeditem says which nearby Targets have it discounted.
  const item = { retailer: 'target', highestPrice: 98.99, priceAtStores: { 1187: 30, 9999: 30 } };
  const stores = [
    { no: 1187, name: 'Target Lowell', coordinates: [-71.33, 42.63] },
    { no: 1190, name: 'Target Burlington', coordinates: [-71.2, 42.48] },
    { no: 1227, name: 'Target Nashua', coordinates: [-71.46, 42.76] },
    { no: 100, name: 'Target Ridgedale', coordinates: [-93.46, 44.97] },
  ];
  const locked = { available: true, discounted: { 1187: true, 1190: false, 1227: true, 100: true } };
  const r = summarize(item, stores, locked, { lat: 42.629, lng: -71.34 }, { radiusMiles: 50, onPlan: false });
  assert.equal(r.best, null);
  assert.equal(r.stores.length, 0);
  assert.equal(r.locked.checkedStores, 3);
  assert.deepEqual(r.locked.discountedStores.map((s) => s.name), ['Target Lowell', 'Target Nashua']);
});
