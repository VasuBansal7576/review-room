const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rstreamTurnConfigured, createRstreamTurn } = require('./rstream-turn');

const env = { RSTREAM_PROJECT_ENDPOINT: 'dad75865', RSTREAM_AUTHENTICATION_TOKEN: 'test.token.value' };
const host = 'aws-ap-southeast-1-1.c.rstream.io';
const tls = `turns:${host}:5349?transport=tcp`;
const output = { username: 'short-lived-user', credential: 'short-lived-secret', urls: [`turn:${host}:3478?transport=udp`, `turn:${host}:3478?transport=tcp`, `turns:${host}:5349?transport=udp`, tls], ttl: 500 };
const response = value => new Response(JSON.stringify(value), { status: 200 });

test('requests a project credential and uses its effective lifetime', async () => {
  let request, resolved;
  const got = await createRstreamTurn(env, async (url, options) => { request = { url, options }; return response(output); }, 1000, async hostname => { resolved = hostname; return ['93.184.216.34']; });
  assert.equal(request.url, 'https://rstream.io/api/projects/tunnels/resolve/dad75865/turn-server/credentials');
  assert.equal(request.options.headers.Authorization, 'Bearer test.token.value');
  assert.equal(request.options.redirect, 'error');
  assert.deepEqual(JSON.parse(request.options.body), { ttlSeconds: 600 });
  assert.equal(resolved, host);
  assert.deepEqual(got.servers, [{ urls: ['turn:93.184.216.34:3478?transport=tcp', tls], username: output.username, credential: output.credential }]);
  assert.equal(got.expiresAt, new Date(501000).toISOString());
});

test('rejects incomplete configuration and unsafe TTLs', () => {
  assert.equal(rstreamTurnConfigured({}), null);
  for (const input of [{ RSTREAM_PROJECT_ENDPOINT: 'example.com' }, { ...env, RSTREAM_TURN_TTL_SECONDS: '1' }, { ...env, RSTREAM_TURN_TTL_SECONDS: '3601' }, { ...env, RSTREAM_AUTHENTICATION_TOKEN: 'bad\nheader' }]) {
    assert.throws(() => rstreamTurnConfigured(input), /configuration is invalid/);
  }
});

test('fails closed on malformed provider data, errors, and untrusted hosts', async () => {
  for (const result of [{ ...output, urls: ['turn:evil.example:3478?transport=udp'] }, { ...output, ttl: 10 }, { ...output, ttl: 601 }, { ...output, credential: '' }, { ...output, urls: [] }]) {
    await assert.rejects(createRstreamTurn(env, async () => response(result)), /service is unavailable/);
  }
  await assert.rejects(createRstreamTurn(env, async () => new Response('', { status: 403 })), /service is unavailable/);
  await assert.rejects(createRstreamTurn(env, async () => { throw Error(env.RSTREAM_AUTHENTICATION_TOKEN); }), error => error.message === 'rstream TURN service is unavailable');
  await assert.rejects(createRstreamTurn(env, async () => new Response('x'.repeat(65537), { status: 200 })), /service is unavailable/);
});

test('keeps one hostname TLS fallback when DNS fails or has no public IPv4 address', async () => {
  const invalidAddresses = ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '198.18.0.1', '::1', 'not-an-address'];
  for (const address of invalidAddresses) {
    const got = await createRstreamTurn(env, async () => response(output), 1000, async () => [address]);
    assert.deepEqual(got.servers[0].urls, [tls], address);
  }
  for (const resolver of [async () => [], async () => { throw Error('DNS unavailable'); }]) {
    const got = await createRstreamTurn(env, async () => response(output), 1000, resolver);
    assert.deepEqual(got.servers[0].urls, [tls]);
    assert.equal(got.servers[0].credential, output.credential);
  }
});

test('bounds a stalled DNS lookup and returns the TLS fallback', { timeout: 3000 }, async () => {
  const got = await createRstreamTurn(env, async () => response(output), 1000, () => new Promise(() => {}));
  assert.deepEqual(got.servers[0].urls, [tls]);
});

test('resolves only provider-approved hosts and skips unusable DNS answers', async () => {
  let lookups = 0;
  await assert.rejects(createRstreamTurn(env, async () => response({ ...output, urls: [...output.urls, 'turn:evil.example:3478?transport=tcp'] }), 1000, async () => { lookups++; return ['93.184.216.34']; }), /service is unavailable/);
  assert.equal(lookups, 0);
  const got = await createRstreamTurn(env, async () => response(output), 1000, async hostname => { assert.equal(hostname, host); return ['10.0.0.1', '93.184.216.34', '93.184.216.35']; });
  assert.deepEqual(got.servers[0].urls, ['turn:93.184.216.34:3478?transport=tcp', tls]);
});

test('keeps a usable original URI when the provider has no TCP or TLS alternatives', async () => {
  const got = await createRstreamTurn(env, async () => response({ ...output, urls: [output.urls[0]] }), 1000, async () => { throw Error('DNS must not run'); });
  assert.deepEqual(got.servers[0].urls, [output.urls[0]]);
});
