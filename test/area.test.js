import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'area-test-'));
process.env.SETTINGS_FILE = path.join(dir, 'settings.json');
delete process.env.LAT;
delete process.env.LNG;
delete process.env.RADIUS_MILES;
const { geocode, getArea, setArea } = await import('../src/area.js');

test('starts with no location and the site default radius', () => {
  assert.deepEqual(getArea(), { location: null, radiusMiles: 50 });
});

test('saves the area and snaps the radius to the site slider (10-80, steps of 10)', () => {
  setArea({ location: { lat: 30.27, lng: -97.74, address: 'Austin, TX' }, radiusMiles: 34 });
  assert.equal(getArea().radiusMiles, 30);
  assert.equal(setArea({ radiusMiles: 500 }).radiusMiles, 80);
  assert.equal(setArea({ radiusMiles: 1 }).radiusMiles, 10);
  assert.equal(getArea().location.address, 'Austin, TX');

  const saved = JSON.parse(fs.readFileSync(process.env.SETTINGS_FILE, 'utf8'));
  assert.deepEqual(saved.area, { location: { lat: 30.27, lng: -97.74, address: 'Austin, TX' }, radiusMiles: 10 });
});

test('rejects a location without valid coordinates', () => {
  assert.throws(() => setArea({ location: { lat: 200, lng: 0 } }), /no valid coordinates/);
  assert.throws(() => setArea({ location: { lat: Number.NaN, lng: 0 } }), /no valid coordinates/);
});

test('reads "lat, lng" without a network lookup', async () => {
  assert.deepEqual(await geocode(' 30.2672, -97.7431 '), { lat: 30.2672, lng: -97.7431, address: '30.2672, -97.7431' });
  await assert.rejects(geocode('95, 10'), /out of range/);
  await assert.rejects(geocode('   '), /Enter a ZIP/);
});
