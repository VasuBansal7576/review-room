const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ApprovalGate, SwitchClient, frames, cleanURL, packageBody, run } = require('./bridge');
const { digest, parseProposal } = require('../server/revisions');
const pkg = { shareWithSwitch: true, finished: true, reviewId: 'a'.repeat(32), roomId: 'b'.repeat(32), transcript: 'Synthetic review', collageURL: 'https://example.invalid/collage', replayURL: 'https://example.invalid/replay' };
const input = { sourceHtml: '<html>before</html>', sourceHash: digest('<html>before</html>'), fromMs: 0, toMs: 1000, frameTimes: [0] };
const proposal = parseProposal({ summary: 'Synthetic change', html: '<html>after</html>', baseHash: input.sourceHash, diff: '-before\n+after', transcript: [{ fromMs: 0, toMs: 1000, text: 'Synthetic change' }], frames: [{ atMs: 0, image: 'data:image/jpeg;base64,/9j/AAAA/9k=' }] }, input);
const row = { id: pkg.reviewId, roomId: pkg.roomId, state: 'proposed', input, proposal };
const humans = ['opaque-human-fixture'];
const roster = [{ id: humans[0], type: 'user' }];
const make = () => new ApprovalGate({ pkg, row, room: 'switch-room', thread: 'root-message', humans, issuedAt: 100 });
const event = gate => ({ type: 'message', room_id: 'switch-room', payload: { sender: humans[0], message_id: 'event-fixture', timestamp: 101, thread_id: 'root-message', body: gate.command() } });
test('explicit enable and individual finished package consent are both required', async () => {
  await assert.rejects(run({ SWITCH_AGENT_API_KEY: 'synthetic-fixture' }, []));
  for (const change of [{ shareWithSwitch: false }, { finished: false }, { reviewId: '../bad' }]) assert.throws(() => packageBody({ ...pkg, ...change }));
});
test('invitation query and fragment secrets are removed, invitation paths withheld', () => {
  assert.equal(cleanURL('https://example.invalid/replay?token=synthetic#invite=synthetic'), 'https://example.invalid/replay');
  assert(!packageBody({ ...pkg, transcript: 'https://example.invalid/join/synthetic' }).includes('/join/'));
  assert.throws(() => cleanURL('https://synthetic:synthetic@example.invalid/replay'));
});
test('authorized exact human approval persists before owner apply and is single-use', async () => {
  const gate = make(), calls = [];
  const io = { roster, load: async () => row, persist: async () => calls.push('persist'), apply: async hash => { assert.equal(hash, proposal.proposalHash); calls.push('owner-apply'); } };
  assert.equal(await gate.approve(event(gate), io), true);
  assert.equal(await gate.approve(event(gate), io), false);
  assert.deepEqual(calls, ['persist', 'owner-apply']);
});
for (const [name, change] of Object.entries({ 'wrong room': e => e.room_id = 'other', 'wrong thread': e => e.payload.thread_id = 'other', 'unauthorized human': e => e.payload.sender = 'other', 'platform impersonation': e => e.payload.sender_kind = 'platform', 'delegated identity': e => e.payload.on_behalf_of = humans[0], 'bare approve': e => e.payload.body = 'approve', 'wrong review': e => e.payload.body = e.payload.body.replace(pkg.reviewId, 'c'.repeat(32)), 'changed hash': e => e.payload.body += '0', 'historical approval': e => e.payload.timestamp = 99 })) {
  test('denies ' + name, () => { const gate = make(), e = event(gate); change(e); assert.equal(gate.accepts(e, roster), false); });
}
test('configured ID still cannot approve if room roster identifies an agent', () => { const gate = make(); assert.equal(gate.accepts(event(gate), [{ id: humans[0], type: 'agent' }]), false); });
test('changed or malformed backend bytes cannot apply after approval', async () => {
  for (const changed of [{ ...row, proposal: { ...proposal, html: '<html>tampered</html>' } }, { ...row, state: 'ready' }]) {
    const gate = make(); await assert.rejects(gate.approve(event(gate), { roster, load: async () => changed, persist: async () => assert.fail(), apply: async () => assert.fail() }));
  }
});
test('owner rejection is propagated and never retried as unauthenticated apply', async () => {
  const gate = make(); await assert.rejects(gate.approve(event(gate), { roster, load: async () => row, persist: async () => {}, apply: async () => { throw Error('Owner denied'); } }));
  assert.equal(gate.accepts(event(gate), roster), false);
});
test('actual documented HTTP operations use raw arguments, bearer auth and connection header', async () => {
  const calls = []; const c = new SwitchClient({ base: 'http://127.0.0.1:1234', agent: 'reviewer', token: 'synthetic-fixture', room: 'room-fixture', connection: 'connection-fixture', fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ result: { event_id: 'synthetic-event' } })); } });
  await c.op('send_targeted_message', { body: 'Synthetic', target_names: ['coder'], thread_id: 'root' }); await c.open(); await c.beat();
  assert(calls[0].url.endsWith('/agents/reviewer/ops/send_targeted_message'));
  assert.equal(JSON.parse(calls[0].init.body).thread_id, 'root'); assert(!Object.hasOwn(JSON.parse(calls[0].init.body), 'arguments'));
  assert.equal(calls[0].init.headers['X-Switch-Connection-Id'], 'connection-fixture');
  assert(calls[1].url.includes('rooms=room-fixture')); assert(calls[1].url.includes('filter=all'));
  assert(calls[2].url.endsWith('/connection/beat'));
});
test('SSE decodes split CRLF frames and rejects stream loss', async () => {
  async function* body() { yield Buffer.from('event: message\r\nid: 7\r\nda'); yield Buffer.from('ta: {"sequence":7}\r\n\r\n'); }
  const it = frames(body()); const first = await it.next(); assert.equal(first.value.id, '7'); assert.equal(first.value.value.sequence, 7); await assert.rejects(it.next());
});

test('persisted consumed approval cannot be replayed after restart', () => {
  const gate = new ApprovalGate({ pkg, row, room: 'switch-room', thread: 'root-message', humans, issuedAt: 100, consumed: true });
  assert.equal(gate.accepts(event(gate), roster), false);
});
test('valid regenerated proposal still cannot replace the advertised snapshot', async () => {
  const gate = make();
  const replacement = parseProposal({ ...proposal, html: '<html>different</html>', diff: '-before\n+different' }, input);
  await assert.rejects(gate.approve(event(gate), { roster, load: async () => ({ ...row, proposal: replacement }), persist: async () => assert.fail(), apply: async () => assert.fail() }));
});
