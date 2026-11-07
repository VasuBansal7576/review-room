const { test } = require('node:test');
const assert = require('node:assert/strict');
const { meteredTurnConfigured, getMeteredTurn } = require('./metered-turn');
const config = { METERED_TURN_APP: 'room-demo', METERED_TURN_API_KEY: 'credential-key' };
const body = [
  { urls: 'stun:stun.relay.metered.ca:80' },
  { urls: 'turn:global.relay.metered.ca:443?transport=tcp', username: 'user', credential: 'password' },
  { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: 'user', credential: 'password' }
];
const response = value => new Response(JSON.stringify(value));

test('validates optional configuration and restricts the API destination', () => {
  assert.equal(meteredTurnConfigured({}), null);
  assert.throws(() => meteredTurnConfigured({ ...config, METERED_TURN_APP: 'example.com' }), /configuration is invalid/);
  assert.throws(() => meteredTurnConfigured({ METERED_TURN_APP: 'example' }), /configuration is invalid/);
});

test('retrieves and validates provider ICE servers', async () => {
  const result = await getMeteredTurn(config, async (url, options) => {
    const request = new URL(url);
    assert.equal(request.hostname, 'room-demo.metered.live');
    assert.equal(request.searchParams.get('apiKey'), config.METERED_TURN_API_KEY);
    assert.equal(options.redirect, 'error');
    return response(body);
  });
  assert.equal(result.servers.length, 3);
  assert.deepEqual(result.servers[1].urls, ['turn:global.relay.metered.ca:443?transport=tcp']);
  assert.equal(result.servers[1].username, 'user');
  assert.equal('expiresAt' in result, false);
});

test('fails closed without leaking the API key on bad provider responses', async () => {
  const variants = [[], [{ urls: 'turn:evil.example:443', username: 'user', credential: 'password' }], [{ urls: 'turn:global.relay.metered.ca:443' }], [{ urls: 'stun:stun.relay.metered.ca:80' }]];
  for (const value of variants) await assert.rejects(getMeteredTurn(config, async () => response(value)), error => error.status === 503 && !error.message.includes(config.METERED_TURN_API_KEY));
  await assert.rejects(getMeteredTurn(config, async () => new Response('x'.repeat(65537))), /service is unavailable/);
  await assert.rejects(getMeteredTurn(config, async () => { throw new Error(config.METERED_TURN_API_KEY); }), error => !error.message.includes(config.METERED_TURN_API_KEY));
});
