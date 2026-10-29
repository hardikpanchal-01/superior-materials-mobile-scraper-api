// Run: node --test src/utils/__tests__/resetLinkBase.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveResetBase } = require('../resetLinkBase');

const env = {
  PASSWORD_RESET_REDIRECT_URL: 'https://tenant.truckast.ai/reset-password',
  NEXT_PUBLIC_APP_URL: 'https://tenant.truckast.ai',
  PASSWORD_RESET_ALLOWED_ORIGINS: ' https://alt.truckast.ai , not a url'
};

test('no redirect_url: configured link, same as before', () => {
  assert.deepEqual(resolveResetBase(null, env),
    { baseUrl: 'https://tenant.truckast.ai/reset-password', source: 'config', rejected: false });
  assert.equal(resolveResetBase(undefined, { NEXT_PUBLIC_APP_URL: 'https://a.example' }).baseUrl,
    'https://a.example/reset-password');
  assert.equal(resolveResetBase('', {}).baseUrl, 'http://localhost:3000/reset-password');
});

test('redirect_url on a configured origin is kept (path kept, query dropped)', () => {
  assert.deepEqual(resolveResetBase('https://tenant.truckast.ai/reset-password?x=1#h', env),
    { baseUrl: 'https://tenant.truckast.ai/reset-password', source: 'request', rejected: false });
  assert.equal(resolveResetBase('https://alt.truckast.ai/reset', env).baseUrl, 'https://alt.truckast.ai/reset');
});

test('foreign or tricky redirect_url is ignored and the configured link is used', () => {
  const bad = [
    'https://evil.example/reset-password',
    'https://tenant.truckast.ai.evil.example/reset-password',
    'https://tenant.truckast.ai@evil.example/reset-password',
    'http://tenant.truckast.ai/reset-password', // wrong scheme
    'https://tenant.truckast.ai:8443/reset-password', // wrong port
    '//evil.example/reset-password',
    'javascript:alert(1)',
    'not a url'
  ];
  for (const r of bad) {
    assert.deepEqual(resolveResetBase(r, env),
      { baseUrl: 'https://tenant.truckast.ai/reset-password', source: 'config', rejected: true }, r);
  }
});

test('nothing configured: any redirect_url is rejected', () => {
  assert.deepEqual(resolveResetBase('https://evil.example/r', {}),
    { baseUrl: 'http://localhost:3000/reset-password', source: 'config', rejected: true });
});
