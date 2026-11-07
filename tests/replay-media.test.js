const { test } = require('node:test');
const assert = require('node:assert/strict');
const { durationSeconds, formatDuration, showDuration, downloadRecording } = require('../public/replay-media');
const url = '/recordings/' + 'a'.repeat(32) + '/' + 'b'.repeat(32);
test('elapsed metadata gives finite duration for unindexed WebM', () => {
  assert.equal(durationSeconds({ startedAt: 1000, endedAt: 11234 }, Infinity), 10.234);
  assert.equal(formatDuration(10.234), '0:10');
  assert.equal(formatDuration(65.1), '1:05');
  assert.equal(formatDuration(0.2), '0:01');
});
test('invalid elapsed metadata falls back to finite native duration, never Infinity', () => {
  for (const data of [{}, { startedAt: 9, endedAt: 8 }, { startedAt: '1', endedAt: 2 }, { startedAt: 1, endedAt: Infinity }]) {
    assert.equal(durationSeconds(data, 12.5), 12.5);
    assert.equal(durationSeconds(data, Infinity), null);
  }
  assert.equal(formatDuration(Infinity), 'Duration unavailable');
});
test('duration UI is populated immediately and stays finite on media events without changing playback', () => {
  const events = {}; const video = { duration: Infinity, currentTime: 3, addEventListener: (type, fn) => { events[type] = fn; } };
  const label = { dataset: {} };
  showDuration(video, label, { startedAt: 0, endedAt: 10234 });
  assert.equal(label.textContent, '0:10'); assert.equal(label.dataset.durationSeconds, '10.234');
  events.loadedmetadata(); events.durationchange(); assert.equal(video.currentTime, 3); assert.equal(label.textContent, '0:10');
});
function fixture(request) {
  const calls = []; const anchor = { click() { calls.push('click'); }, remove() { calls.push('remove'); } };
  return { calls, anchor, options: { request, document: { baseURI: 'https://example.test/', body: { append(a) { assert.equal(a, anchor); calls.push('append'); } }, createElement: () => anchor }, urls: { createObjectURL(blob) { calls.push(['blob', blob.size]); return 'blob:local'; }, revokeObjectURL(value) { calls.push(['revoke', value]); } }, schedule(fn, delay) { assert.equal(delay, 60000); fn(); } } };
}
test('downloads authenticated response as object URL with sensible filename and cleanup', async () => {
  const f = fixture(async (target, options) => { assert.equal(target, 'https://example.test' + url); assert.equal(options.credentials, 'same-origin'); assert.equal(options.redirect, 'follow'); return new Response(new Blob(['video'], { type: 'video/webm' })); });
  assert.equal(await downloadRecording(url, 'review-recording-test.webm', f.options), 5);
  assert.equal(f.anchor.href, 'blob:local'); assert.equal(f.anchor.download, 'review-recording-test.webm');
  assert.deepEqual(f.calls, [['blob', 5], 'append', 'click', 'remove', ['revoke', 'blob:local']]);
});
test('rejects HTTP errors, empty media and login/HTML responses without emitting a download', async () => {
  for (const [response, message] of [[new Response('no', { status: 401 }), /401/], [new Response(new Blob([], { type: 'video/webm' })), /empty/], [new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } }), /Invalid recording/]]) {
    const f = fixture(async () => response); await assert.rejects(downloadRecording(url, 'test.webm', f.options), message); assert.deepEqual(f.calls, []);
  }
});
test('rejects external and malformed recording URLs before fetching', async () => {
  for (const target of ['https://evil.test' + url, '/api/owner', url + '?token=anything', url + '#fragment']) {
    const f = fixture(() => { throw Error('must not fetch'); }); await assert.rejects(downloadRecording(target, 'test.webm', f.options), /Invalid recording URL/);
  }
});


test('download repairs legacy raw WebM when elapsed metadata is provided', async () => {
  const f = fixture(async () => new Response(new Blob(['raw'], {type:'video/webm'})));
  let elapsed;
  f.options.durationMs = 2345;
  f.options.fixDuration = async (blob, ms) => { elapsed = ms; assert.equal(blob.size, 3); return new Blob(['fixed-video'], {type:'video/webm'}); };
  assert.equal(await downloadRecording(url, 'fixed.webm', f.options), 11);
  assert.equal(elapsed, 2345);
});
