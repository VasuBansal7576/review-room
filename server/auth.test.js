const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const dataDir = path.join(os.tmpdir(), `review-room-auth-${process.pid}`);
process.env.REVIEW_ROOM_DATA_DIR = dataDir;
process.env.REVIEW_OWNER_PASSWORD = 'test-only-owner-password-at-least-32-characters';
process.env.REVIEW_PUBLIC_ORIGIN = 'https://review.example';
const { start } = require('./index');

test('secure rooms require an owner or a valid room invitation', async () => {
  const server = await start(0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, options = {}) => fetch(base + url, { ...options, headers: { Origin: 'https://review.example', ...options.headers } });
  const post = (url, body, cookie = '') => request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
  try {
    assert.deepEqual(await (await request('/api/auth/status')).json(), { secure: true, owner: false });
    assert.equal((await post('/api/rooms', { name: 'Private', url: 'https://example.com' })).status, 401);
    assert.equal((await request('/api/owner/session', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await post('/api/owner/session', { password: 'bad' })).status, 401);
    const login = await post('/api/owner/session', { password: process.env.REVIEW_OWNER_PASSWORD });
    assert.equal(login.status, 200);
    const ownerCookie = login.headers.get('set-cookie').split(';')[0];
    assert.match(login.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Strict/);
    const room = await (await post('/api/rooms', { name: 'Private', url: 'https://example.com' }, ownerCookie)).json();
    const other = await (await post('/api/rooms', { name: 'Other', url: 'https://example.com' }, ownerCookie)).json();
    assert.equal((await request(`/api/rooms/${room.id}`)).status, 401);
    assert.equal((await request(`/api/rooms/${room.id}/events`)).status, 401);
    assert.equal((await request(`/api/rooms/${room.id}/ice-config`)).status, 401);
    const invitation = await (await post(`/api/rooms/${room.id}/invitations`, {}, ownerCookie)).json();
    const inviteToken = new URL(invitation.url).hash.slice('#invite='.length);
    assert.match(inviteToken, /^[a-f0-9]{64}$/);
    const join = await post(`/api/rooms/${room.id}/join`, { token: inviteToken });
    assert.equal(join.status, 200);
    const guestCookie = join.headers.get('set-cookie').split(';')[0];
    assert.equal((await request(`/api/rooms/${room.id}`, { headers: { Cookie: guestCookie } })).status, 200);
    const nextInvitation = await (await post(`/api/rooms/${room.id}/invitations`, {}, ownerCookie)).json();
    assert.notEqual(nextInvitation.url, invitation.url);
    assert.equal((await request(`/api/rooms/${room.id}`, { headers: { Cookie: guestCookie } })).status, 200);
    assert.equal((await post(`/api/rooms/${room.id}/join`, { token: inviteToken })).status, 200);
    assert.equal((await request(`/api/rooms/${other.id}`, { headers: { Cookie: guestCookie } })).status, 401);
    assert.equal((await request(`/api/rooms/${other.id}`, { headers: { Cookie: guestCookie.replace(room.id, other.id) } })).status, 401);
    assert.equal((await post(`/api/rooms/${room.id}/switch-handoff`, { content: 'hello' }, guestCookie)).status, 401);
    const upload = await request(`/api/rooms/${room.id}/recordings`, { method: 'POST', headers: { Cookie: guestCookie, 'Content-Type': 'video/webm' }, body: Buffer.from('recording') });
    const recording = await upload.json();
    assert.equal(upload.status, 201);
    assert.equal((await request(recording.url)).status, 401);
    assert.equal((await request(recording.url, { headers: { Cookie: guestCookie } })).status, 200);
    const streamAbort = new AbortController();
    const stream = await request(`/api/rooms/${room.id}/events`, { headers: { Cookie: guestCookie }, signal: streamAbort.signal });
    const reader = stream.body.getReader(); await reader.read();
    assert.equal((await request(`/api/rooms/${room.id}/invitations`, { method: 'DELETE', headers: { Cookie: ownerCookie } })).status, 200);
    const revoked = await reader.read();
    assert.match(new TextDecoder().decode(revoked.value), /event: access-revoked/);
    assert.equal((await reader.read()).done, true);
    streamAbort.abort();
    assert.equal((await request(`/api/rooms/${room.id}`, { headers: { Cookie: guestCookie } })).status, 401);
    assert.equal((await post(`/api/rooms/${room.id}/join`, { token: inviteToken })).status, 401);
    assert.equal((await request(`/recordings/${room.id}/` + 'f'.repeat(32))).status, 401);
    assert.equal((await request('/recordings/' + 'f'.repeat(32), { headers: { Cookie: ownerCookie } })).status, 404);
    for (let i = 0; i < 12; i++) await post('/api/owner/session', { password: 'incorrect-password' });
    assert.equal((await post('/api/owner/session', { password: 'incorrect-password' })).status, 429);
    assert.equal((await post('/api/owner/session', { password: process.env.REVIEW_OWNER_PASSWORD })).status, 200, 'Correct owner password remains usable after failed attempts');
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('production and non-loopback fail closed without secure configuration', async () => {
  const saved = [process.env.REVIEW_OWNER_PASSWORD, process.env.REVIEW_PUBLIC_ORIGIN, process.env.NODE_ENV];
  try {
    delete process.env.REVIEW_OWNER_PASSWORD; delete process.env.REVIEW_PUBLIC_ORIGIN;
    process.env.NODE_ENV = 'production';
    await assert.rejects(start(0, '127.0.0.1'));
    delete process.env.NODE_ENV;
    await assert.rejects(start(0, '0.0.0.0'));
  } finally {
    for (const [key, value] of [['REVIEW_OWNER_PASSWORD', saved[0]], ['REVIEW_PUBLIC_ORIGIN', saved[1]], ['NODE_ENV', saved[2]]]) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});
