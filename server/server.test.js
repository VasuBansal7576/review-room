const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const dataDir = path.join(os.tmpdir(), `review-room-test-${process.pid}`);
process.env.REVIEW_ROOM_DATA_DIR = dataDir;
const { start } = require('./index');

test('feedback status belongs to a note in the room and persists in order', async () => {
  const server = await start(0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, value) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  try {
    const first = await (await post('/api/rooms', { name: 'Review', url: 'https://example.com' })).json();
    const second = await (await post('/api/rooms', { name: 'Other', url: 'https://example.com' })).json();
    const endpoint = `/api/rooms/${first.id}/events`;
    const note = await (await post(endpoint, { type: 'note', author: 'Client', data: { client: 'a', text: 'Move the title' } })).json();
    const change = (noteId, status) => ({ type: 'note_status', author: 'Designer', data: { client: 'b', noteId, status } });
    assert.equal((await post(endpoint, change(note.id, 'resolved'))).status, 201);
    assert.equal((await post(endpoint, change(note.id, 'open'))).status, 201);
    assert.equal((await post(endpoint, change(note.id, 'unknown'))).status, 400);
    assert.equal((await post(endpoint, change('0'.repeat(32), 'resolved'))).status, 400);
    assert.equal((await post(`/api/rooms/${second.id}/events`, change(note.id, 'resolved'))).status, 400);
    const room = await (await fetch(base + `/api/rooms/${first.id}`)).json();
    assert.deepEqual(room.events.filter(event => event.type === 'note_status').map(event => event.data.status), ['resolved', 'open']);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('configured Switch mention is exposed only when valid', async () => {
  const server = await start(0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;
  const original = process.env.SWITCH_HANDOFF_MENTION;
  try {
    const room = await (await fetch(base + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Mention', url: 'https://example.com' }) })).json();
    const endpoint = `${base}/api/rooms/${room.id}`;
    for (const [value, expected] of [['@review-codex', '@review-codex'], ['@name\nextra', ''], ['', '']]) {
      process.env.SWITCH_HANDOFF_MENTION = value;
      assert.equal((await (await fetch(endpoint)).json()).switchHandoffMention, expected);
    }
  } finally {
    if (original === undefined) delete process.env.SWITCH_HANDOFF_MENTION;
    else process.env.SWITCH_HANDOFF_MENTION = original;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('ICE configuration defaults, accepts TURN credentials and rejects invalid configuration', async () => {
  const server = await start(0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;
  const original = process.env.ICE_SERVERS_JSON;
  try {
    delete process.env.ICE_SERVERS_JSON;
    const room = await (await fetch(base + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'ICE', url: 'https://example.com' }) })).json();
    const endpoint = `${base}/api/rooms/${room.id}/ice-config`;
    assert.equal((await fetch(base + '/api/ice-config')).status, 404);
    assert.equal((await fetch(base + '/api/rooms/00000000000000000000000000000000/ice-config')).status, 404);
    let response = await fetch(endpoint);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    const iceServers = [{ urls: ['turn:relay.example.com:3478?transport=udp', 'turns:relay.example.com:5349'], username: 'user', credential: 'secret' }];
    process.env.ICE_SERVERS_JSON = JSON.stringify(iceServers);
    response = await fetch(endpoint);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { iceServers });
    for (const invalid of ['{', '[]', '[{"urls":"https://example.com"}]', '[{"urls":"turn:user:pass@example.com"}]', '[{"urls":"stun:example.com","credential":{}}]']) {
      process.env.ICE_SERVERS_JSON = invalid;
      response = await fetch(endpoint);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'ICE configuration is invalid' });
    }
  } finally {
    if (original === undefined) delete process.env.ICE_SERVERS_JSON;
    else process.env.ICE_SERVERS_JSON = original;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('rooms, event streams, concurrent writes, recordings, and restart', async () => {
  let server = await start(0, '127.0.0.1');
  const base = () => `http://127.0.0.1:${server.address().port}`;
  const post = (url, value) => fetch(base() + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  try {
    assert.equal((await post('/api/rooms', { name: 'Bad', url: 'javascript:alert(1)' })).status, 400);
    const created = await post('/api/rooms', { name: 'Test', url: 'https://example.com/' });
    assert.equal(created.status, 201);
    const room = await created.json();
    const endpoint = `/api/rooms/${room.id}`;
    const controller = new AbortController();
    const stream = await fetch(base() + endpoint + '/events', { signal: controller.signal });
    const reader = stream.body.getReader();
    await reader.read();
    const sent = await post(endpoint + '/events', { type: 'note', author: 'client', data: { client: 'client', text: 'hello' } });
    assert.equal(sent.status, 201);
    const event = await sent.json();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    assert.equal(chunk.match(/^id: (.*)$/m)[1], event.id);
    assert.deepEqual(JSON.parse(chunk.match(/^data: (.*)$/m)[1]), event);
    controller.abort();
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => post(endpoint + '/events', { type: 'note', author: 'test', data: { client: 'test', text: `Note ${i}`, i } })));
    assert.ok(results.every(result => result.status === 201));
    const reconnect = new AbortController();
    const replay = await fetch(base() + endpoint + '/events', { headers: { 'Last-Event-ID': event.id }, signal: reconnect.signal });
    const replayReader = replay.body.getReader();
    let replayText = '';
    while ((replayText.match(/^data: /gm) || []).length < 12) replayText += new TextDecoder().decode((await replayReader.read()).value);
    const replayed = [...replayText.matchAll(/^data: (.*)$/gm)].map(match => JSON.parse(match[1]));
    assert.equal(new Set(replayed.map(item => item.data.i)).size, 12);
    reconnect.abort();
    const beginning = new AbortController();
    const allEvents = await fetch(base() + endpoint + '/events?cursor=0', { signal: beginning.signal });
    const allReader = allEvents.body.getReader();
    let allText = '';
    while ((allText.match(/^data: /gm) || []).length < 13) allText += new TextDecoder().decode((await allReader.read()).value);
    assert.equal((allText.match(/^data: /gm) || []).length, 13);
    beginning.abort();
    assert.equal((await fetch(base() + endpoint + '/events?cursor=unknown')).status, 409);
    assert.equal((await post(endpoint + '/events', { type: '', author: 'x', data: null })).status, 400);
    for (const [type, data] of [['unknown', { client: 'test' }], ['note', null], ['note', { client: 'test', text: 4 }], ['signal', { client: 'test', recipient: 'other', payload: null }], ['stroke', { client: 'test', points: [] }], ['presence', { client: 'test', action: 'unknown' }]]) assert.equal((await post(endpoint + '/events', { type, author: 'test', data })).status, 400);
    const media = Buffer.from('test webm bytes');
    const upload = await fetch(base() + endpoint + '/recordings', { method: 'POST', headers: { 'Content-Type': 'video/webm' }, body: media });
    assert.equal(upload.status, 201);
    const { url } = await upload.json();
    assert.equal((await post(endpoint + '/events', { type: 'recording', author: 'test', data: { client: 'test', startedAt: 1, endedAt: 2, url: 'javascript:alert(1)' } })).status, 400);
    assert.equal((await post(endpoint + '/events', { type: 'recording', author: 'test', data: { client: 'test', startedAt: 1, endedAt: 2, url: `/recordings/${room.id}/${'0'.repeat(32)}` } })).status, 400);
    const recordingResponse = await fetch(base() + url);
    assert.equal(recordingResponse.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(Buffer.from(await recordingResponse.arrayBuffer()), media);
    const otherRoom = await (await post('/api/rooms', { name: 'Other', url: 'https://example.com/' })).json();
    assert.equal((await fetch(base() + url.replace(room.id, otherRoom.id))).status, 404);
    const partial = await fetch(base() + url, { headers: { Range: 'bytes=2-5' } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('cache-control'), 'private, no-store');
    assert.equal(partial.headers.get('content-range'), `bytes 2-5/${media.length}`);
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), media.subarray(2, 6));
    const unsatisfiable = await fetch(base() + url, { headers: { Range: 'bytes=999-' } });
    assert.equal(unsatisfiable.status, 416);
    assert.equal(unsatisfiable.headers.get('cache-control'), 'private, no-store');
    assert.equal((await fetch(base() + '/')).headers.get('referrer-policy'), 'no-referrer');
    assert.equal((await fetch(base() + '/api/rooms/invalid')).status, 404);
    await new Promise(resolve => server.close(resolve));
    server = await start(0, '127.0.0.1');
    const saved = await (await fetch(base() + endpoint)).json();
    assert.equal(saved.events.length, 13);
    assert.deepEqual(saved.events[0], event);
    assert.deepEqual(Buffer.from(await (await fetch(base() + url)).arrayBuffer()), media);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('multiple subscribers see concurrent events in persisted order and replay without gaps', async () => {
  const server = await start(0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, value) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const controllers = [new AbortController(), new AbortController()];
  try {
    const room = await (await post('/api/rooms', { name: 'Ordering', url: 'https://example.com' })).json();
    const endpoint = `/api/rooms/${room.id}`;
    const streams = await Promise.all(controllers.map(controller => fetch(base + endpoint + '/events?cursor=0', { signal: controller.signal })));
    const readers = streams.map(stream => stream.body.getReader());
    await Promise.all(readers.map(reader => reader.read()));
    const writes = Array.from({ length: 20 }, (_, i) => post(endpoint + '/events', { type: 'note', author: 'test', data: { client: 'test', text: `Note ${i}`, i } }));
    const readEvents = async reader => {
      let text = '';
      while ((text.match(/^data: /gm) || []).length < 20) text += new TextDecoder().decode((await reader.read()).value);
      return [...text.matchAll(/^data: (.*)$/gm)].map(match => JSON.parse(match[1]));
    };
    const [first, second] = await Promise.all(readers.map(readEvents));
    assert.ok((await Promise.all(writes)).every(response => response.status === 201));
    const saved = await (await fetch(base + endpoint)).json();
    assert.deepEqual(first, saved.events);
    assert.deepEqual(second, saved.events);
    controllers.forEach(controller => controller.abort());
    const replayController = new AbortController();
    controllers.push(replayController);
    const replay = await fetch(base + endpoint + '/events', { headers: { 'Last-Event-ID': first[9].id }, signal: replayController.signal });
    const reader = replay.body.getReader();
    let text = '';
    while ((text.match(/^data: /gm) || []).length < 10) text += new TextDecoder().decode((await reader.read()).value);
    assert.deepEqual([...text.matchAll(/^data: (.*)$/gm)].map(match => JSON.parse(match[1])), saved.events.slice(10));
  } finally {
    controllers.forEach(controller => controller.abort());
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('Switch handoff forwards as the configured agent to a local stub', async () => {
  const http = require('node:http');
  let received;
  const stub = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received = { path: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
    res.writeHead(200).end('{}');
  });
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
  let server;
  try {
    server = await start(0, '127.0.0.1');
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const room = await (await post('/api/rooms', { name: 'Switch', url: 'https://example.com' })).json();
    const endpoint = `/api/rooms/${room.id}/switch-handoff`;
    assert.equal((await post(endpoint, { content: 'hello' })).status, 503);
    Object.assign(process.env, { SWITCH_AGENT_BASE_URL: `http://127.0.0.1:${stub.address().port}`, SWITCH_AGENT_ID: 'agent-1', SWITCH_AGENT_API_KEY: 'secret-key', SWITCH_ROOM_ID: 'switch-room' });
    assert.equal((await post(endpoint, { content: 'hello' })).status, 200);
    assert.deepEqual(received, { path: '/agents/agent-1/message', auth: 'Bearer secret-key', body: { room_id: 'switch-room', content: 'hello' } });
    assert.equal((await post('/api/switch-replies', { token: 'a'.repeat(64), text: 'Unexpected' })).status, 404);
    process.env.SWITCH_DEMO_REPLIES = '1';
    assert.equal((await post(`/api/rooms/${room.id}/events`, { type: 'switch_reply', author: 'Switch agent', data: { text: 'Forged' } })).status, 403);
    const otherRoom = await (await post('/api/rooms', { name: 'Other', url: 'https://example.com' })).json();
    const handoff = await post(endpoint, { content: '@agent Please review this' });
    assert.equal(handoff.status, 200);
    const token = /^Review-Room-Reply: ([a-f0-9]{64})\n@agent Please review this$/.exec(received.body.content)?.[1];
    assert.ok(token);
    assert.equal((await post('/api/switch-replies', { token: 'a'.repeat(64), text: 'Unexpected' })).status, 404);
    assert.equal((await post('/api/switch-replies', { token, text: 'Agent feedback' })).status, 201);
    assert.equal((await post('/api/switch-replies', { token, text: 'Duplicate' })).status, 404);
    const roomWithReply = await (await fetch(base + `/api/rooms/${room.id}`)).json();
    const isolatedRoom = await (await fetch(base + `/api/rooms/${otherRoom.id}`)).json();
    assert.deepEqual(roomWithReply.events.map(event => [event.type, event.data.text]), [['switch_reply', 'Agent feedback']]);
    assert.equal(isolatedRoom.events.length, 0);
    assert.equal((await post(endpoint, { content: '' })).status, 400);
    process.env.SWITCH_AGENT_BASE_URL = 'http://example.com';
    assert.equal((await post(endpoint, { content: 'hello' })).status, 503);
  } finally {
    for (const name of ['SWITCH_AGENT_BASE_URL', 'SWITCH_AGENT_ID', 'SWITCH_AGENT_API_KEY', 'SWITCH_ROOM_ID', 'SWITCH_DEMO_REPLIES']) delete process.env[name];
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    stub.closeAllConnections();
    await new Promise(resolve => stub.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
