const { test } = require('node:test');
const assert = require('node:assert/strict');
const { uploadRecording } = require('../public/recording-upload');

test('uploads a recording directly and returns its private room link', async () => {
  const blob = new Blob(['video'], { type: 'video/webm' });
  const calls = [];
  const response = await uploadRecording('abc', blob, async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return { ok: true, json: async () => ({ uploadUrl: 'https://storage.example/upload?token=secret', url: '/recordings/abc/00000000000000000000000000000000' }) };
    return { ok: true };
  });
  assert.equal(response.url, '/recordings/abc/00000000000000000000000000000000');
  assert.equal(calls[1].options.method, 'PUT');
  assert.equal(calls[1].options.credentials, 'omit');
  assert.equal(calls[1].options.body, blob);
});

test('local server fallback uploads through the existing endpoint', async () => {
  const calls = [];
  const result = await uploadRecording('abc', new Blob(['video']), async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return { status: 404, ok: false };
    return { ok: true, json: async () => ({ url: '/recordings/abc/00000000000000000000000000000000' }) };
  });
  assert.equal(result.url, '/recordings/abc/00000000000000000000000000000000');
  assert.equal(calls[1].url, '/api/rooms/abc/recordings');
});

test('does not bypass authorization or send video to an unsafe destination', async () => {
  let calls = 0;
  await assert.rejects(uploadRecording('abc', new Blob(['video']), async () => { calls++; return { status: 403, ok: false }; }));
  assert.equal(calls, 1);
  await assert.rejects(uploadRecording('abc', new Blob(['video']), async () => ({ ok: true, json: async () => ({ uploadUrl: 'http://example.com/upload', url: '/recordings/abc/00000000000000000000000000000000' }) })));
});

test('rejects zero-byte recordings before requesting an upload URL', async () => {
  let calls = 0;
  await assert.rejects(uploadRecording('abc', new Blob([], { type: 'video/webm' }), async () => { calls++; }), /No recording data was captured/);
  assert.equal(calls, 0);
});

test('rejects oversized recordings before requesting an upload URL', async () => {
  let calls = 0;
  await assert.rejects(uploadRecording('abc', { size: 50 * 1024 * 1024 + 1 }, async () => { calls++; }), /50 MB limit/);
  assert.equal(calls, 0);
});
