'use strict';
// Original Review Room adapter. Wire contracts are linked in switch/README.md.
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseProposal, digest, canonical, validId } = require('../server/revisions');
const ID = /^[A-Za-z0-9_-]{1,200}$/;
function origin(value) {
  const u = new URL(value);
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/' || !(u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)))) throw Error('Invalid origin');
  return u.origin;
}
function cleanURL(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password) throw Error('Package URLs must be credential-free HTTPS');
  if (/invite|join|token|secret/i.test(u.pathname)) return '[private invitation URL removed]';
  u.search = ''; u.hash = ''; return u.href;
}
function cleanText(text, limit = 16000) {
  if (typeof text !== 'string' || text.length > limit) throw Error('Invalid transcript');
  return text.replace(/https?:\/\/[^\s<>"']+/g, value => { try { return cleanURL(value); } catch { return '[private URL removed]'; } }).replace(/@/g, '@\u200b');
}
function packageBody(pkg) {
  if (pkg.shareWithSwitch !== true || pkg.finished !== true || !validId.test(pkg.reviewId) || !validId.test(pkg.roomId)) throw Error('Explicit finished-package consent and valid revision IDs required');
  return `Review Room review ${pkg.reviewId}\nTranscript:\n${cleanText(pkg.transcript)}\nCollage: ${cleanURL(pkg.collageURL)}\nReplay: ${cleanURL(pkg.replayURL)}`;
}
function snapshot(row, pkg) {
  if (row.id !== pkg.reviewId || row.roomId !== pkg.roomId || row.state !== 'proposed') throw Error('Existing proposed revision required');
  const proposal = parseProposal(row.proposal, row.input);
  if (Buffer.byteLength(proposal.diff) > 32000) throw Error('Bridge requires a diff of at most 32000 bytes');
  if (proposal.proposalHash !== row.proposal.proposalHash || digest(row.input.sourceHtml) !== row.input.sourceHash) throw Error('Changed or malformed proposal');
  return { proposalHash: proposal.proposalHash, sourceHash: digest(proposal.html), proposal, input: row.input };
}
class ApprovalGate {
  constructor({ pkg, row, room, thread, humans, issuedAt = Date.now(), consumed = false }) {
    this.pkg = { ...pkg }; this.expected = JSON.parse(JSON.stringify(snapshot(row, pkg)));
    this.room = room; this.thread = thread; this.humans = new Set(humans); this.issuedAt = issuedAt; this.consumed = consumed;
  }
  command() { return `approve ${this.pkg.reviewId} ${this.expected.proposalHash} ${this.expected.sourceHash}`; }
  accepts(event, roster) {
    const p = event?.payload;
    return !this.consumed && event?.type === 'message' && event.room_id === this.room &&
      p?.thread_id === this.thread && typeof p.message_id === 'string' && p.message_id.length > 0 &&
      Number.isFinite(p.timestamp) && p.timestamp >= this.issuedAt && !p.sender_kind && !p.on_behalf_of &&
      this.humans.has(p.sender) && roster.some(x => x.id === p.sender && x.type === 'user') &&
      p.body === this.command();
  }
  async approve(event, { roster, load, persist, apply }) {
    if (!this.accepts(event, roster)) return false;
    // Lock before awaiting anything: concurrent delivery cannot authorize twice.
    this.consumed = true;
    const fresh = snapshot(await load(), this.pkg);
    if (canonical(fresh) !== canonical(this.expected)) throw Error('Proposal changed after publication');
    // Durable at-most-once authorization. Ambiguous failures require owner inspection.
    await persist({ messageId: event.payload.message_id, proposalHash: fresh.proposalHash, sourceHash: fresh.sourceHash });
    await apply(fresh.proposalHash);
    return true;
  }
}
async function* frames(body) {
  const decoder = new TextDecoder(); let pending = '';
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true });
    if (pending.length > 2 * 1024 * 1024) throw Error('Oversized SSE frame');
    let match;
    while ((match = /\r?\n\r?\n/.exec(pending))) {
      const block = pending.slice(0, match.index); pending = pending.slice(match.index + match[0].length);
      let kind = '', id = ''; const data = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) kind = line.slice(6).trim();
        if (line.startsWith('id:')) id = line.slice(3).trim();
        if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length) yield { kind, id, value: JSON.parse(data.join('\n')) };
    }
  }
  throw Error('Switch stream closed; approval processing stopped');
}
class SwitchClient {
  constructor({ base, agent, token, room, connection = randomUUID(), fetchImpl = fetch }) {
    this.base = origin(base); if (!ID.test(agent) || !ID.test(room) || !token) throw Error('Missing Switch configuration');
    Object.assign(this, { agent, token, room, connection, fetchImpl }); this.cursor = 0; this.abort = new AbortController();
  }
  async request(suffix, value, stream = false) {
    const response = await this.fetchImpl(`${this.base}/agents/${encodeURIComponent(this.agent)}${suffix}`, {
      method: value === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', 'X-Switch-Connection-Id': this.connection, ...(stream ? { Accept: 'text/event-stream' } : {}) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }), ...(stream ? { signal: this.abort.signal } : { signal: AbortSignal.timeout(10000) })
    });
    if (!response.ok) { await response.body?.cancel(); throw Error('Switch request rejected'); }
    return stream ? response : response.json();
  }
  async discover() {
    const registry = await this.request('/ops');
    for (const [name, keys] of Object.entries({ connect_to_room: ['room_id'], list_participants: [], post_message: ['body', 'thread_id'], send_targeted_message: ['body', 'target_names', 'thread_id'] })) {
      const schema = registry.operations?.[name]?.input_schema;
      if (!schema || keys.some(k => !Object.hasOwn(schema.properties || {}, k))) throw Error('Incompatible Switch operation registry');
    }
  }
  async op(name, args) { return (await this.request('/ops/' + name, args)).result; }
  open() { return this.request('/events?' + new URLSearchParams({ connection_id: this.connection, scope: 'single', filter: 'all', start_from: 'head', rooms: this.room }), undefined, true); }
  beat() { return this.request('/connection/beat', { connection_id: this.connection, cursor: this.cursor }); }
}
function privateRead(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077)) throw Error('Private file must be regular and mode 0600');
  return fs.readFileSync(file, 'utf8').trim();
}
async function run(env, argv) {
  if (env.REVIEW_SWITCH_ENABLED !== 'true' || argv[0] !== '--share' || !argv[1]) throw Error('Disabled: explicit enable and --share package path required');
  const pkg = JSON.parse(privateRead(argv[1])); const body = packageBody(pkg);
  const humans = (env.SWITCH_HUMAN_APPROVERS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!humans.length || !ID.test(env.SWITCH_CODING_AGENT_NAME || '') || env.SWITCH_CODING_AGENT_NAME === 'everyone') throw Error('Configure human IDs and a coding agent');
  const app = origin(env.REVIEW_PUBLIC_ORIGIN); const cookie = privateRead(env.REVIEW_OWNER_COOKIE_FILE);
  if (!cookie || /[\r\n]/.test(cookie)) throw Error('Invalid owner cookie file');
  const endpoint = `/api/rooms/${pkg.roomId}/revisions/${pkg.reviewId}`;
  async function backend(suffix = '', value) {
    const r = await fetch(app + endpoint + suffix, { method: value ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Cookie: cookie, Origin: app, 'Content-Type': 'application/json' }, ...(value ? { body: JSON.stringify(value) } : {}) });
    if (!r.ok) { await r.body?.cancel(); throw Error('Owner-authenticated backend request rejected'); }
    return r.json();
  }
  // Backend is authoritative: this bridge never accepts a chat-supplied HTML proposal.
  const row = await backend(); snapshot(row, pkg);
  const dir = path.resolve(env.REVIEW_SWITCH_STATE_DIR || 'switch/.local'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink() || (fs.statSync(dir).mode & 0o077)) throw Error('Private state directory required');
  const stateFile = path.join(dir, pkg.reviewId + '.json');
  // Exclusive reservation prevents repeat shares, duplicate approvals and competing processes.
  const fd = fs.openSync(stateFile, 'wx', 0o600);
  const state = { reviewId: pkg.reviewId, connection: randomUUID(), status: 'reserved' };
  function save(patch) { Object.assign(state, patch); fs.ftruncateSync(fd, 0); fs.writeSync(fd, JSON.stringify(state), 0, 'utf8'); fs.fsyncSync(fd); }
  save({});
  const client = new SwitchClient({ base: env.SWITCH_AGENT_BASE_URL, agent: env.SWITCH_AGENT_ID, token: env.SWITCH_AGENT_API_KEY, room: env.SWITCH_ROOM_ID, connection: state.connection });
  let timer, gate, failed, readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  try {
    await client.discover(); const response = await client.open();
    const reader = (async () => {
      for await (const frame of frames(response.body)) {
        if (['gap', 'evicted', 'room_released', 'subscription_changed'].includes(frame.kind)) throw Error('Switch delivery continuity lost');
        if (frame.kind === 'connection_state') {
          if (frame.value.connection_id !== client.connection || frame.value.agent_id !== client.agent || !frame.value.rooms?.includes(client.room) || frame.value.heartbeat_interval_seconds !== 2) throw Error('Unexpected Switch connection state');
          client.cursor = frame.value.cursor;
          timer = setInterval(() => client.beat().catch(() => { failed = true; client.abort.abort(); }), 2000);
          readyResolve(); continue;
        }
        if (!Number.isSafeInteger(frame.value.sequence) || String(frame.value.sequence) !== frame.id) throw Error('Invalid event sequence');
        if (frame.value.sequence <= client.cursor) continue;
        if (gate && !failed && frame.kind === 'message') {
          const roster = await client.op('list_participants', {});
          if (await gate.approve(frame.value, { roster, load: backend, persist: receipt => save({ status: 'consumed', receipt }), apply: hash => backend('/approve', { proposalHash: hash }) })) {
            save({ status: 'approval-requested' });
            await client.op('post_message', { thread_id: gate.thread, body: 'Authorized human approval accepted by Review Room. The existing worker will materialize the exact approved bytes. Open the private Review Room revision to view its preview when ready.' });
          }
        }
        client.cursor = frame.value.sequence;
      }
    })().catch(error => { failed = true; readyReject(error); throw error; });
    reader.catch(() => {});
    await Promise.race([ready, new Promise((_, reject) => { const t = setTimeout(() => reject(Error('Connection state timeout')), 10000); t.unref(); })]);
    await client.op('connect_to_room', { room_id: client.room });
    const roster = await client.op('list_participants', {});
    if (!humans.every(id => roster.some(p => p.id === id && p.type === 'user')) || !roster.some(p => p.name === env.SWITCH_CODING_AGENT_NAME && p.type === 'agent')) throw Error('Configured identities do not match room participants');
    const posted = await client.op('post_message', { body });
    if (!posted?.event_id || posted.trust) throw Error('Package delivery changed or unverified');
    const expected = snapshot(row, pkg);
    const pendingGate = new ApprovalGate({ pkg, row, room: client.room, thread: posted.event_id, humans });
    save({ status: 'awaiting-human', thread: pendingGate.thread, proposalHash: expected.proposalHash, sourceHash: expected.sourceHash });
    const addressed = await client.op('send_targeted_message', { target_names: [env.SWITCH_CODING_AGENT_NAME], thread_id: pendingGate.thread, body: `Review the exact diff in the authenticated Review Room for revision ${pkg.reviewId}. Do not rewrite after approval. The following display is sanitized; inspect the private original for exact bytes.\n${cleanText(expected.proposal.diff, 32000)}\nProposed HTML SHA256: ${expected.sourceHash}\nProposal hash: ${expected.proposalHash}\nAn explicitly authorized human must reply in this exact thread with:\n${pendingGate.command()}\nThe source, transcript and full diff remain available in the private Review Room. Chat cannot replace this proposal.` });
    if (!addressed?.event_id || addressed.trust) throw Error('Addressed request changed or unverified');
    if (failed) throw Error('Switch connection failed during publication');
    pendingGate.issuedAt = Date.now(); gate = pendingGate;
    await reader;
  } finally { clearInterval(timer); client.abort.abort(); fs.closeSync(fd); }
}
if (require.main === module) run(process.env, process.argv.slice(2)).catch(() => { console.error('Switch bridge stopped safely. Check local configuration, delivery continuity and owner authorization; no private details logged.'); process.exitCode = 1; });
module.exports = { ApprovalGate, SwitchClient, frames, cleanURL, cleanText, packageBody, snapshot, run };
