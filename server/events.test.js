const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { isTransient, formatEvent, roomStorageBytes, validateRoomGrowth } = require('./events');

test('transient frames do not change the replay cursor', () => {
  for (const type of ['presence', 'signal']) {
    const event = { type, id: 'transient', data: {} };
    assert.equal(isTransient(event), true);
    assert.match(formatEvent(event), /^data: /);
    assert.doesNotMatch(formatEvent(event), /^id:/m);
  }
  const note = { type: 'note', id: 'persisted', data: {} };
  assert.match(formatEvent(note), /^id: persisted\ndata: /);
});

test('room and aggregate event bytes are bounded without mutating room', () => {
  const room = { id: 'a', events: [] };
  const note = { type: 'note', id: 'b', data: { text: 'a message' } };
  const before = Buffer.byteLength(JSON.stringify(room));
  const after = Buffer.byteLength(JSON.stringify({ ...room, events: [note] }));
  assert.doesNotThrow(() => validateRoomGrowth(room, note, before, { maxRoomBytes: after, maxTotalBytes: after }));
  assert.throws(() => validateRoomGrowth(room, note, before, { maxRoomBytes: after - 1 }), { status: 413 });
  assert.throws(() => validateRoomGrowth(room, note, before + 10, { maxTotalBytes: after + 9 }), { status: 413 });
  assert.throws(() => validateRoomGrowth(room, note, before, { maxEvents: 0 }), { status: 413 });
  assert.doesNotThrow(() => validateRoomGrowth(room, { type: 'signal' }, before + 100, { maxTotalBytes: 1 }));
  assert.deepEqual(room.events, []);
});

test('aggregate count includes only committed room files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-events-'));
  try {
    await fs.writeFile(path.join(dir, `${'a'.repeat(32)}.json`), 'abcd');
    await fs.writeFile(path.join(dir, `${'b'.repeat(32)}.json`), '123');
    await fs.writeFile(path.join(dir, `${'a'.repeat(32)}.json.tmp`), 'excluded');
    assert.equal(await roomStorageBytes(dir), 7);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
