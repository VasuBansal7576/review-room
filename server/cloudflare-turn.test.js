const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cloudflareTurnConfigured, createCloudflareTurn } = require('./cloudflare-turn');

const env = { CLOUDFLARE_TURN_KEY_ID: 'a'.repeat(32), CLOUDFLARE_TURN_API_TOKEN: 'b'.repeat(64) };
const result = { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'short-lived-user', credential: 'short-lived-password' }] };
const response = value => new Response(JSON.stringify(value), { status: 201 });

test('requests and returns short-lived Cloudflare ICE credentials', async () => {
  let request;
  const got = await createCloudflareTurn(env, async (url, options) => { request = { url, options }; return response(result); }, 1000);
  assert.equal(request.url, `https://rtc.live.cloudflare.com/v1/turn/keys/${env.CLOUDFLARE_TURN_KEY_ID}/credentials/generate-ice-servers`);
  assert.equal(request.options.headers.Authorization, `Bearer ${env.CLOUDFLARE_TURN_API_TOKEN}`);
  assert.equal(request.options.redirect, 'error');
  assert.deepEqual(JSON.parse(request.options.body), { ttl: 3600 });
  assert.deepEqual(got.servers, result.iceServers);
  assert.equal(got.expiresAt, '1970-01-01T01:00:01.000Z');
});

test('configuration is optional but rejects incomplete or unsafe settings', async () => {
  assert.equal(await createCloudflareTurn({}), null);
  for (const value of [
    { CLOUDFLARE_TURN_KEY_ID: 'a'.repeat(32) },
    { ...env, CLOUDFLARE_TURN_KEY_ID: '../bad' },
    { ...env, CLOUDFLARE_TURN_API_TOKEN: 'bad\nsecret' },
    { ...env, CLOUDFLARE_TURN_TTL_SECONDS: '0' },
    { ...env, CLOUDFLARE_TURN_TTL_SECONDS: '86401' }
  ]) assert.throws(() => cloudflareTurnConfigured(value), /configuration is invalid/);
});

test('rejects malformed, untrusted, oversized, or failed responses without leaking credentials', async () => {
  const bad = [
    { iceServers: [{ urls: ['turn:attacker.example:3478'], username: 'u', credential: 'c' }] },
    { iceServers: [{ urls: ['turn:turn.cloudflare.com:3478'], username: '', credential: 'c' }] },
    { iceServers: [{ urls: ['turn:turn.cloudflare.com:53'], username: 'u', credential: 'c' }] },
    { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }] }
  ];
  for (const value of bad) await assert.rejects(createCloudflareTurn(env, async () => response(value)), /service is unavailable/);
  await assert.rejects(createCloudflareTurn(env, async () => new Response('x'.repeat(65537), { status: 201 })), /service is unavailable/);
  await assert.rejects(createCloudflareTurn(env, async () => { throw Error(env.CLOUDFLARE_TURN_API_TOKEN); }), error => error.message === 'Cloudflare TURN service is unavailable');
  await assert.rejects(createCloudflareTurn(env, async () => new Response('', { status: 403 })), /service is unavailable/);
});

test('filters browser-blocked port 53 while preserving usable relay URLs', async () => {
  const value = { iceServers: [{ urls: ['turn:turn.cloudflare.com:53', 'turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' }] };
  const got = await createCloudflareTurn(env, async () => response(value), 1000);
  assert.deepEqual(got.servers[0].urls, ['turn:turn.cloudflare.com:3478?transport=udp']);
});
