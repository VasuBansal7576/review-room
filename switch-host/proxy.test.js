const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createProxy } = require('./proxy');

test('the proxy exposes only the authorized sender and room', async t => {
  const key = 's'.repeat(48); let forwarded = 0;
  const server = createProxy({ upstream: 'http://127.0.0.1:18082', agent: 'sender', key, room: 'room1', fetchImpl: async (url, options) => { forwarded++; assert.equal(url, 'http://127.0.0.1:18082/agents/sender/message'); assert.equal(JSON.parse(options.body).room_id, 'room1'); return new Response(null, { status: 200 }); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, auth, body) => fetch(base + path, { method: 'POST', headers: { authorization: auth }, body: JSON.stringify(body) });
  assert.equal((await post('/admin', `Bearer ${key}`, {})).status, 404);
  assert.equal((await post('/agents/sender/message', 'Bearer wrong', {})).status, 401);
  assert.equal((await post('/agents/sender/message', `Bearer ${key}`, { room_id: 'other', content: 'hello' })).status, 400);
  assert.equal((await post('/agents/sender/message', `Bearer ${key}`, { room_id: 'room1', content: 'hello' })).status, 200);
  assert.equal(forwarded, 1);
});
