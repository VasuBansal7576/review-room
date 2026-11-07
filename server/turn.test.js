const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createTurnConfig } = require('./turn');

const secret = 'test-secret-only-0123456789-abcdefghijklmnopqrstuvwxyz';
const env = { TURN_URLS_JSON: JSON.stringify(['turn:relay.example.com:3478?transport=udp', 'turns:relay.example.com:5349?transport=tcp']), TURN_SHARED_SECRET: secret };
const now = 1_800_000_000_000;

test('generates a fresh coturn REST credential with an expiry', () => {
  const first = createTurnConfig(env, now);
  const second = createTurnConfig(env, now);
  assert.equal(first.expiresAt, new Date(now + 3600 * 1000).toISOString());
  assert.match(first.server.username, /^1800003600:[a-f0-9]{32}$/);
  assert.equal(first.server.credential, crypto.createHmac('sha1', secret).update(first.server.username).digest('base64'));
  assert.notEqual(first.server.username, second.server.username);
  assert.deepEqual(first.server.urls, JSON.parse(env.TURN_URLS_JSON));
  assert(!JSON.stringify(first).includes(secret));
  assert.equal(createTurnConfig({ ...env, TURN_CREDENTIAL_TTL_SECONDS: '600' }, now).expiresAt, new Date(now + 600_000).toISOString());
});

test('rejects incomplete configuration, invalid URLs and unsafe lifetimes', () => {
  assert.equal(createTurnConfig({}, now), null);
  const bad = [
    { TURN_SHARED_SECRET: secret },
    { TURN_URLS_JSON: env.TURN_URLS_JSON },
    { ...env, TURN_SHARED_SECRET: 'short' },
    { ...env, TURN_URLS_JSON: 'not json' },
    { ...env, TURN_URLS_JSON: '[]' },
    { ...env, TURN_URLS_JSON: '["https://evil.example"]' },
    { ...env, TURN_URLS_JSON: '["turn:relay.example.com:0"]' },
    { ...env, TURN_URLS_JSON: '["turn:user@relay.example.com"]' },
    { ...env, TURN_URLS_JSON: '["turn:relay.example.com?transport=tcp&extra=x"]' },
    { ...env, TURN_CREDENTIAL_TTL_SECONDS: '299' },
    { ...env, TURN_CREDENTIAL_TTL_SECONDS: '86401' },
    { ...env, TURN_CREDENTIAL_TTL_SECONDS: '1e3' },
  ];
  for (const input of bad) assert.throws(() => createTurnConfig(input, now), { status: 503, message: 'TURN configuration is invalid' });
  assert.doesNotThrow(() => createTurnConfig({ ...env, TURN_URLS_JSON: '["turn:[2001:db8::1]:3478"]' }, now));
});
