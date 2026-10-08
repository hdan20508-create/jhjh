import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanUrl, redact, shouldRecord } from '../src/capture.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl';

test('removes token-like fields, JWTs, bearer strings and emails', () => {
  const out = redact({
    access_token: JWT,
    refresh_token: 'abc',
    user: { email: 'me@example.com', note: `contact me@example.com`, id: 'u1' },
    nested: [{ provider_token: 'x', value: JWT }, { header: 'Bearer abc.def' }],
    itemToken: 'NTI5OTQ2Mjg6dGFyZ2V0', // deal code, kept
    priceAtStores: { 1001: 104.99 },
  });
  assert.equal(out.access_token, '[removed]');
  assert.equal(out.refresh_token, '[removed]');
  assert.equal(out.user.email, '[removed]');
  assert.equal(out.user.note, 'contact [email removed]');
  assert.equal(out.nested[0].provider_token, '[removed]');
  assert.equal(out.nested[0].value, '[removed]');
  assert.equal(out.nested[1].header, '[removed]');
  assert.equal(out.itemToken, 'NTI5OTQ2Mjg6dGFyZ2V0');
  assert.deepEqual(out.priceAtStores, { 1001: 104.99 });
  assert.ok(!JSON.stringify(out).includes(JWT));
});

test('caps long lists', () => {
  const out = redact(Array.from({ length: 100 }, (_, i) => i));
  assert.equal(out.length, 61);
  assert.match(out[60], /40 more entries/);
});

test('records site data calls but never login traffic', () => {
  assert.ok(shouldRecord('https://ufpyekjfmuwzfdczaddc.supabase.co/functions/v1/stock-check?store=1'));
  assert.ok(shouldRecord('https://instoreclearance.com/api/getlockeditem?token=x&stores=1'));
  assert.ok(!shouldRecord('https://ufpyekjfmuwzfdczaddc.supabase.co/auth/v1/token?grant_type=refresh_token'));
  assert.ok(!shouldRecord('https://ufpyekjfmuwzfdczaddc.supabase.co/auth/v1/user'));
  assert.ok(!shouldRecord('https://discord.com/api/v9/users/@me'));
  assert.ok(!shouldRecord('https://instoreclearance.com/deals'));
  assert.ok(!shouldRecord('https://instoreclearance.com/_next/static/chunks/main.js'));
});

test('blanks secret query parameters', () => {
  assert.equal(
    cleanUrl('https://x.supabase.co/functions/v1/feed?apikey=abc&storetype=target'),
    'https://x.supabase.co/functions/v1/feed?apikey=%5Bremoved%5D&storetype=target',
  );
});
