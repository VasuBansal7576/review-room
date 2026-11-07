const { test } = require('node:test');
const assert = require('node:assert/strict');
const { markers, transcript } = require('../public/review-package');
const t0 = Date.parse('2026-11-06T10:00:00Z'), at = s => new Date(t0 + s * 1000).toISOString();
const events = [
  { id: 'r', type: 'recording', at: at(60), author: 'Vasu', data: { url: '/recordings/x/a', startedAt: t0, endedAt: t0 + 60000 } },
  { id: 's1', type: 'stroke', at: at(5), author: 'Ana', data: { strokeId: 'k', seq: 1, points: [{ x: .1, y: .2 }] } },
  { id: 's2', type: 'stroke', at: at(6), author: 'Ana', data: { strokeId: 'k', seq: 2, points: [{ x: .1, y: .2 }, { x: .3, y: .3 }, { x: .4, y: .5 }] } },
  { id: 's3', type: 'stroke', at: at(12), author: 'Ana', data: { strokeId: 'c', seq: 1, points: [{ x: .5, y: .5 }] } },
  { id: 'n', type: 'note', at: at(75), author: 'Vasu', data: { text: 'Bigger CTA' } }
];
test('strokes collapse to one marker at first-seen time with clicked/drawing kinds', () => {
  const list = markers(events);
  assert.deepEqual(list.map(m => [m.kind, m.t]), [['drawing', '0:05'], ['clicked', '0:12'], ['note', '1:15']]);
  assert.equal(list[0].recording, '/recordings/x/a'); assert.equal(list[2].recording, null);
});
test('transcript carries bracketed markers and counts', () => {
  const text = transcript({ name: 'Acme', url: 'https://acme.test' }, events, 'https://room');
  assert.match(text, /1 clicked · 1 drawing · 1 note/); assert.match(text, /- 0:12 \[clicked\] Ana: at 50%, 50%/); assert.match(text, /\[note\] Vasu: Bigger CTA/);
});
test('out-of-order stroke snapshots keep earliest time and highest sequence', () => {
  const ordered = markers(events), shuffled = markers([events[2], events[0], events[4], events[1], events[3]]);
  assert.deepEqual(shuffled, ordered);
});
test('recording-relative clocks reset per recording and deleted media are never linked', () => {
  const recording = (id, start, end) => ({ id, type: 'recording', at: at(end), data: { url: `/${id}.webm`, startedAt: t0 + start * 1000, endedAt: t0 + end * 1000 } });
  const note = time => ({ id: `n${time}`, type: 'note', at: at(time), data: { text: 'Synthetic fixture' } });
  const list = markers([recording('first', 0, 10), recording('second', 20, 30), note(5), note(15), note(25), note(35)]);
  assert.deepEqual(list.map(m => [m.t, m.recording]), [['0:05', '/first.webm'], ['0:15', null], ['0:05', '/second.webm'], ['0:35', null]]);
  const deleted = markers([recording('first', 0, 10), note(5), { type: 'recording_deleted', at: at(40), data: { url: '/first.webm' } }]);
  assert.equal(deleted[0].recording, null);
});
test('markers before recording retain room time instead of clamping negative recording time', () => {
  const list = markers([{ type: 'note', at: at(0), data: { text: 'First' } }, { type: 'note', at: at(5), data: { text: 'Second' } }, { type: 'recording', at: at(30), data: { url: '/later.webm', startedAt: t0 + 10000, endedAt: t0 + 30000 } }]);
  assert.deepEqual(list.map(m => [m.t, m.recording]), [['0:00', null], ['0:05', null]]);
});
test('overlapping recordings choose latest start and missing end uses recording event time', () => {
  const list = markers([
    { type: 'recording', at: at(60), data: { url: '/old', startedAt: t0, endedAt: t0 + 60000 } },
    { type: 'recording', at: at(40), data: { url: '/new', startedAt: t0 + 20000 } },
    { type: 'note', at: at(25), data: { text: 'During both' } }, { type: 'note', at: at(45), data: { text: 'After new stopped' } }
  ]);
  assert.deepEqual(list.map(m => [m.t, m.recording]), [['0:05', '/new'], ['0:45', '/old']]);
});
test('marker transcript explicitly states its timing, click, and speech limits', () => {
  const text = transcript({}, events);
  assert.match(text, /relative to that recording/);
  assert.match(text, /not speech transcription/);
  assert.match(text, /not a captured page click/);
});


test('per-replay package selects only its recording window and refuses deleted replays', () => {
  const { eventsForRecording } = require('../public/review-package');
  const rec = { id: 'chosen', type: 'recording', at: new Date(3000).toISOString(), data: { url: '/recordings/chosen', startedAt: 1000, endedAt: 3000 } };
  const other = { id: 'other', type: 'recording', at: new Date(9000).toISOString(), data: { url: '/recordings/other', startedAt: 6000, endedAt: 9000 } };
  const note = { type: 'note', at: new Date(2000).toISOString(), data: { text: 'selected' } };
  const outside = { type: 'note', at: new Date(8000).toISOString(), data: { text: 'unrelated' } };
  assert.deepEqual(eventsForRecording([rec, other, note, outside], 'chosen'), [rec, note]);
  assert.throws(() => eventsForRecording([rec, { type: 'recording_deleted', data: {url:rec.data.url} }], 'chosen'), /unavailable/);
  assert.throws(() => eventsForRecording([rec], 'missing'), /unavailable/);
});
