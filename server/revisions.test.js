const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseRequest, parseProposal, parseResult, digest, canonical, publicRevision } = require('./revisions');

const sourceHtml = '<!doctype html><html><body><h1>Before</h1></body></html>';
const changedHtml = sourceHtml.replace('Before', 'After');
const image = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYzLjEuMTAyAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAEwAAQEAAAAAAAAAAAAAAAAAAAAGAQEBAAAAAAAAAAAAAAAAAAAGBxABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAIAAgMBIgACEQADEQD/2gAMAwEAAhEDEQA/AIsATX9//9k=';
const request = extra => ({ requestId: 'request-1', recordingId: 'a'.repeat(32), sourceHtml, fromMs: 1000, toMs: 5000, note: 'Change the title', frameTimes: [1000], ...extra });
const proposal = extra => ({ summary: 'Changed the title', baseHash: digest(sourceHtml), html: changedHtml, transcript: [{ fromMs: 1000, toMs: 4000, text: 'Change the title to After.' }], frames: [{ atMs: 1000, image }], diff: '--- before.html\n+++ after.html\n@@ -1 +1 @@\n-Before\n+After', ...extra });

test('source hashes bind exact UTF-8 bytes and JSON key order does not change evidence hashes', () => {
  assert.equal(digest('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const input = { ...parseRequest(request()).input, notes: [] };
  assert.equal(input.sourceHtml, sourceHtml);
  const first = parseProposal(proposal(), input);
  assert.equal(first.proposalHash, parseProposal({ ...proposal(), transcript: [{ text: 'Change the title to After.', toMs: 4000, fromMs: 1000 }] }, input).proposalHash);
  for (const altered of [proposal({ html: changedHtml + '\n' }), proposal({ summary: 'Another summary' }), proposal({ transcript: [{ fromMs: 1000, toMs: 4000, text: 'Different spoken evidence' }] }), proposal({ diff: 'different diff' })]) assert.notEqual(parseProposal(altered, input).proposalHash, first.proposalHash);
  assert.notEqual(parseProposal(proposal(), { ...input, notes: [{ text: 'New note' }] }).proposalHash, first.proposalHash);
  assert.equal(canonical({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test('requests enforce document byte limits and bounded recording-relative selections', () => {
  for (const invalid of [request({ fromMs: 5000 }), request({ toMs: 121001 }), request({ fromMs: -1 }), request({ recordingId: '../private' }), request({ frameTimes: [] }), request({ frameTimes: [999] }), request({ frameTimes: [1000, 1000] }), request({ sourceHtml: '<p>fragment</p>' }), request({ sourceHtml: '<html>' + '界'.repeat(52000) + '</html>' })]) assert.throws(() => parseRequest(invalid), { status: 400 });
  assert.deepEqual(parseRequest(request({ frameTimes: [4999, 1000] })).input.frameTimes, [1000, 4999]);
});

test('proposals require changed source, real transcript offsets, and matching evidence frames', () => {
  const input = { ...parseRequest(request()).input, notes: [] };
  for (const invalid of [proposal({ html: sourceHtml }), proposal({ baseHash: '0'.repeat(64) }), proposal({ diff: '' }), proposal({ transcript: [] }), proposal({ transcript: [{ fromMs: 0, toMs: 4000, text: 'Outside interval' }] }), proposal({ transcript: [{ fromMs: 1000, toMs: 6000, text: 'Outside interval' }] }), proposal({ transcript: [{ fromMs: 1000, toMs: 4000, text: 'First' }, { fromMs: 2000, toMs: 5000, text: 'Overlap' }] }), proposal({ frames: [{ atMs: 1000, image: 'data:image/jpeg;base64,YQ==' }] })]) assert.throws(() => parseProposal(invalid, input), { status: 400 });
  const frameInput = { ...input, frameTimes: [1000] };
  assert.throws(() => parseProposal(proposal({ frames: [] }), frameInput), { status: 400 });
  assert.throws(() => parseProposal(proposal({ frames: [{ atMs: 1000, image: 'data:image/jpeg;base64,YQ==' }] }), frameInput), { status: 400 });
});

test('apply accepts only exact approved bytes and never exposes worker authority in public rows', () => {
  const approved = parseProposal(proposal(), { ...parseRequest(request()).input, notes: [] });
  const result = { html: changedHtml, hash: digest(changedHtml), verification: 'Parsed the materialized HTML and verified its SHA-256.' };
  assert.deepEqual(parseResult(result, approved), result);
  for (const invalid of [{ ...result, html: changedHtml + '\n' }, { ...result, hash: approved.proposalHash }, { ...result, verification: '' }]) assert.throws(() => parseResult(invalid, approved), { status: 400 });
  const exposed = publicRevision({ id: 'id', room_id: 'room', state: 'ready', input: {}, proposal: approved, result, lease: 'secret', lease_session: 'session', prepare_completion_lease: 'secret', created_at: 'now', updated_at: 'now', error: null });
  assert.equal(JSON.stringify(exposed).includes('secret'), false);
  assert.equal(Object.hasOwn(exposed, 'lease_session'), false);
});
