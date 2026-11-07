const { validHash, fail, digest, canonical, nonempty, parseRequest, parseProposal, parseResult, publicRevision, sendHtml } = require('../server/revisions');

const workerRoute = /^\/api\/worker\/(claim|heartbeat|revisions\/([a-f0-9]{32})\/(complete|fail))$/;
const roomRoute = /^\/api\/rooms\/([a-f0-9]{32})\/revisions(?:\/([a-f0-9]{32})(?:\/(approve|retry|correct|preview|source))?)?$/;

async function handleRevisions(req, res, ctx) {
  const { config, pathname, call, table, body, requireOwner, requireRoom, loadRoom, storage, output, id, random } = ctx;
  const rpc = (name, value) => call(config, '/rest/v1/rpc/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const emit = value => { output(res, 200, value); return true; };
  const rowFor = async (revisionId, roomId) => {
    const [row] = await table(config, 'rr_revisions', `id=eq.${revisionId}${roomId ? '&room_id=eq.' + roomId : ''}&select=*`);
    if (!row) throw fail(404, 'Revision not found');
    return row;
  };
  if (pathname === '/api/worker/session') {
    if (!['POST', 'DELETE'].includes(req.method)) throw fail(405, 'Method not allowed');
    if (req.headers.origin !== config.origin) throw fail(403, 'Invalid request origin');
    await requireOwner(config, req);
    if (req.method === 'DELETE') { await table(config, 'rr_worker_sessions', '', { method: 'DELETE' }); return emit({ ok: true }); }
    const token = random(), expiresAt = new Date(Date.now() + 86400000).toISOString();
    if (!await rpc('rr_worker_session_create', { token_hash: digest(token), expiration: expiresAt })) throw fail(429, 'Revoke old worker sessions before creating another');
    return emit({ token, expiresAt });
  }
  const worker = workerRoute.exec(pathname);
  if (worker) {
    if (req.method !== 'POST') throw fail(405, 'Method not allowed');
    const bearer = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
    if (!bearer) throw fail(401, 'Worker session required');
    const tokenHash = digest(bearer[1]);
    const [session] = await table(config, 'rr_worker_sessions', `hash=eq.${tokenHash}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=hash`);
    if (!session) throw fail(401, 'Worker session expired or revoked');
    if (worker[1] === 'heartbeat') {
      const expiresAt = new Date(Date.now() + 86400000).toISOString();
      const updated = await table(config, 'rr_worker_sessions', `hash=eq.${tokenHash}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}`, { method: 'PATCH', body: JSON.stringify({ last_seen_at: new Date().toISOString(), expires_at: expiresAt }) });
      if (!updated.length) throw fail(401, 'Worker session expired or revoked');
      return emit({ ok: true, expiresAt });
    }
    if (worker[1] === 'claim') {
      const claimed = await rpc('rr_revision_claim', { token_hash: tokenHash, new_lease: random() });
      if (claimed?.error === 'unauthorized') throw fail(401, 'Worker session expired or revoked');
      if (!claimed) return emit({ job: null });
      let recordingUrl = null;
      if (claimed.lease_operation === 'prepare') {
        const [recording] = await table(config, 'rr_recordings', `id=eq.${claimed.input.recordingId}&room_id=eq.${claimed.room_id}&state=eq.active&select=id`);
        if (!recording) {
          await rpc('rr_revision_finish', { token_hash: tokenHash, target_id: claimed.id, expected_lease: claimed.lease, operation: 'prepare', completion: null, completion_hash: null, failure_text: 'The selected recording was deleted' });
          return emit({ job: null });
        }
        try {
          const signed = await storage(config, `/object/sign/review-room-recordings/${claimed.room_id}/${claimed.input.recordingId}.webm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 120 }) });
          if (typeof signed?.signedURL !== 'string' || !signed.signedURL.startsWith('/object/sign/')) throw fail(503, 'Recording access unavailable');
          recordingUrl = config.base + '/storage/v1' + signed.signedURL;
        } catch (error) {
          await rpc('rr_revision_finish', { token_hash: tokenHash, target_id: claimed.id, expected_lease: claimed.lease, operation: 'prepare', completion: null, completion_hash: null, failure_text: 'Recording access unavailable. Retry preparation.' }).catch(() => {});
          throw error;
        }
      }
      return emit({ job: { id: claimed.id, roomId: claimed.room_id, operation: claimed.lease_operation, lease: claimed.lease, input: claimed.input, recordingUrl, proposal: claimed.proposal } });
    }
    const value = await body(req, 3 * 1024 * 1024);
    if (!validHash.test(value?.lease || '')) throw fail(400, 'A valid lease is required');
    const row = await rowFor(worker[2]);
    if (worker[3] === 'fail' && (row.lease !== value.lease || !row.lease_operation)) throw fail(409, 'The lease expired or the revision changed');
    let completion = null, failureText = null;
    const operation = worker[3] === 'fail' ? row.lease_operation : value.operation;
    if (!['prepare', 'apply'].includes(operation)) throw fail(400, 'A valid operation is required');
    if (worker[3] === 'fail') {
      if (!nonempty(value.error, 1000)) throw fail(400, 'Provide a failure message of at most 1000 characters');
      failureText = value.error.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
      if (!failureText) throw fail(400, 'Provide a failure message');
    } else completion = operation === 'prepare' ? parseProposal(value.proposal, row.input) : parseResult(value.result, row.proposal);
    const result = await rpc('rr_revision_finish', { token_hash: tokenHash, target_id: row.id, expected_lease: value.lease, operation, completion, completion_hash: completion ? digest(canonical(completion)) : null, failure_text: failureText });
    if (result?.error === 'unauthorized') throw fail(401, 'Worker session expired or revoked');
    if (!result) throw fail(409, 'The lease expired or the revision changed');
    return emit(publicRevision(result));
  }
  const room = roomRoute.exec(pathname);
  if (!room) return false;
  const [, roomId, revisionId, action] = room;
  await requireRoom(config, req, roomId);
  await loadRoom(config, roomId);
  if (req.method === 'GET') {
    if (action && !['preview', 'source'].includes(action)) throw fail(405, 'Method not allowed');
    if (revisionId) {
      const row = await rowFor(revisionId, roomId);
      if (action) { sendHtml(res, row, action === 'source'); return true; }
      return emit(publicRevision(row));
    }
    const [rows, sessions] = await Promise.all([
      table(config, 'rr_revisions', `room_id=eq.${roomId}&select=id,room_id,state,error,created_at,updated_at,proposal:proposal->summary,proposal_hash:proposal->proposalHash&order=created_at.desc&limit=20`),
      table(config, 'rr_worker_sessions', `expires_at=gt.${encodeURIComponent(new Date().toISOString())}&last_seen_at=gt.${encodeURIComponent(new Date(Date.now() - 90000).toISOString())}&select=hash&limit=1`)
    ]);
    return emit({ revisions: rows.map(row => ({ id: row.id, roomId: row.room_id, state: row.state, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at, ...(typeof row.proposal === 'string' ? { summary: row.proposal, proposalHash: row.proposal_hash } : {}) })), workerOnline: sessions.length > 0 });
  }
  if (req.method !== 'POST') throw fail(405, 'Method not allowed');
  if (req.headers.origin !== config.origin) throw fail(403, 'Invalid request origin');
  await requireOwner(config, req);
  if (!revisionId) {
    const value = await body(req, 1024 * 1024);
    if (!value || !nonempty(value.requestId, 100) || !/^[A-Za-z0-9_-]+$/.test(value.requestId)) throw fail(400, 'A valid requestId is required');
    const [existing] = await table(config, 'rr_revisions', `room_id=eq.${roomId}&request_id=eq.${value.requestId}&select=*`);
    if (existing) return emit(publicRevision(existing));
    const request = parseRequest(value);
    const result = await rpc('rr_revision_create', { new_id: id(), target_room: roomId, request_id_value: request.requestId, request_input: request.input });
    if (result?.error === 'recording') throw fail(400, 'Select an active recording from this room');
    if (result?.error === 'limit') throw fail(413, 'This room has reached its revision limit');
    if (!result) throw fail(503, 'Revision could not be created');
    output(res, 201, publicRevision(result)); return true;
  }
  if (!['approve', 'retry', 'correct'].includes(action)) throw fail(405, 'Method not allowed');
  const value = await body(req, 128 * 1024);
  if (action === 'approve' && !validHash.test(value?.proposalHash || '')) throw fail(400, 'A valid proposalHash is required');
  if (action === 'correct' && !nonempty(value?.transcriptText, 16000)) throw fail(400, 'A corrected transcript of at most 16000 characters is required');
  const result = await rpc('rr_revision_owner_action', { target_id: revisionId, target_room: roomId, action, proposal_hash: action === 'approve' ? value.proposalHash : null, transcript_text: action === 'correct' ? value.transcriptText.trim() : null });
  if (!result) throw fail(409, 'The revision state or proposal hash changed');
  return emit(publicRevision(result));
}

module.exports = { handleRevisions };
