const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixDuration } = require('../public/webm-duration');
function fixture({ unknown = true, duration = null, indexed = false, scale = 1000000 } = {}) {
  const info = [0x2a, 0xd7, 0xb1, 0x83, scale >> 16 & 255, scale >> 8 & 255, scale & 255];
  if (duration !== null) { const f = Buffer.alloc(8); f.writeDoubleBE(duration); info.push(0x44, 0x89, 0x88, ...f); }
  const payload = [0x15, 0x49, 0xa9, 0x66, 0x80 | info.length, ...info, ...(indexed ? [0x11, 0x4d, 0x9b, 0x74, 0x80] : []), 0x1f, 0x43, 0xb6, 0x75, 0x80];
  return new Blob([Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x80, 0x18, 0x53, 0x80, 0x67, unknown ? 0xff : 0x80 | payload.length, ...payload])], { type: 'video/webm' });
}
async function value(blob) { const b = Buffer.from(await blob.arrayBuffer()); const at = b.indexOf(Buffer.from([0x44, 0x89, 0x88])); return b.readDoubleBE(at + 3); }
test('adds Duration for raw unknown-size and known-size Segments, preserves media payload', async () => {
  for (const unknown of [true, false]) { const raw = fixture({ unknown }); const fixed = await fixDuration(raw, 2345); assert.equal(await value(fixed), 2345); assert.equal(fixed.size, raw.size + 11); assert.equal(fixed.type, 'video/webm'); const b=Buffer.from(await fixed.arrayBuffer()); assert.equal(b.subarray(-5).toString('hex'), '1f43b67580'); }
});
test('respects TimecodeScale and updates empty Duration without shifting bytes', async () => {
  const raw=fixture({ duration: 0, scale: 2000000 }); const fixed=await fixDuration(raw, 2345); assert.equal(await value(fixed),1172.5); assert.equal(fixed.size,raw.size);
});
test('leaves existing valid Duration and indexes unchanged', async () => {
  const raw=fixture({duration:2000,indexed:true}); assert.equal(await fixDuration(raw,3000),raw);
});
test('repair is idempotent', async () => { const fixed=await fixDuration(fixture(),2500); assert.equal(await fixDuration(fixed,2500),fixed); });
test('does not shift position indexes when inserting a new Duration', async () => { await assert.rejects(fixDuration(fixture({indexed:true}),2000), /indexed/); });
test('fails safely on invalid duration and malformed containers', async () => {
  for (const duration of [0,-1,Infinity,NaN]) await assert.rejects(fixDuration(fixture(),duration),/duration/);
  for(const bytes of [[],[0],[0x18,0x53,0x80,0x67],[0x18,0x53,0x80,0x67,0x80]]) await assert.rejects(fixDuration(new Blob([Uint8Array.from(bytes)]),1000),/WebM/);
});
