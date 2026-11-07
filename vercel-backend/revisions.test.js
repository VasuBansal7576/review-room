const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { handleRevisions } = require('./revisions');
const { digest } = require('../server/revisions');

let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const container = process.env.REVISION_PG_CONTAINER;
if (!PGlite && !container) throw new Error('Install the pinned @electric-sql/pglite development dependency or set REVISION_PG_CONTAINER to an isolated Postgres container before running revision tests');
const sqlTest = (name, action) => test(name, action);
const room = 'a'.repeat(32), recording = 'b'.repeat(32);
const sourceHtml = '<!doctype html><html><body><h1>Before</h1></body></html>';
const changedHtml = sourceHtml.replace('Before', 'After');
const image = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYzLjEuMTAyAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAEwAAQEAAAAAAAAAAAAAAAAAAAAGAQEBAAAAAAAAAAAAAAAAAAAGBxABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAIAAgMBIgACEQADEQD/2gAMAwEAAhEDEQA/AIsATX9//9k=';
const input = requestId => ({ requestId, sourceHtml, recordingId: recording, fromMs: 1000, toMs: 5000, note: 'Change title', frameTimes: [1000] });
const proposal = () => ({ summary: 'Changed the title', html: changedHtml, baseHash: digest(sourceHtml), transcript: [{ fromMs: 1000, toMs: 4000, text: 'Please change the title to After.' }], frames: [{ atMs: 1000, image }], diff: '--- before.html\n+++ after.html\n@@ -1 +1 @@\n-Before\n+After' });

class ContainerSql {
  constructor() { this.database = 'rr_revision_test_' + crypto.randomBytes(8).toString('hex'); this.execute(`create database ${this.database}`, 'postgres'); }
  execute(sql, database = this.database) {
    const result = spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-Atq'], { input: sql, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  }
  async exec(sql) { this.execute(sql); }
  async query(statement, parameters = []) {
    const sql = statement.replace(/\$(\d+)/g, (_match, number) => {
      const value = parameters[Number(number) - 1];
      if (value === null) return 'null';
      return "'" + (typeof value === 'object' ? JSON.stringify(value) : String(value)).replaceAll("'", "''") + "'";
    });
    if (/^select\b/i.test(sql)) return { rows: JSON.parse(this.execute(`select coalesce(json_agg(q),'[]'::json) from (${sql}) q`)) };
    if (/\breturning\b/i.test(sql)) return { rows: JSON.parse(this.execute(`with q as (${sql}) select coalesce(json_agg(q),'[]'::json) from q`)) };
    this.execute(sql); return { rows: [] };
  }
  async close() { this.execute(`drop database ${this.database} with (force)`, 'postgres'); }
}

async function setup(t) {
  const db = container ? new ContainerSql() : new PGlite();
  t.after(() => db.close());
  await db.exec("do $$ begin if not exists(select from pg_roles where rolname='anon') then create role anon; end if; if not exists(select from pg_roles where rolname='authenticated') then create role authenticated; end if; if not exists(select from pg_roles where rolname='service_role') then create role service_role; end if; end $$; create table rr_rooms(id text primary key); create table rr_recordings(id text primary key,room_id text,state text); create table rr_events(room_id text,id text,type text,data jsonb,author text,at timestamptz default now(),seq bigint,transient boolean default false);");
  await db.exec(await fs.readFile(path.join(__dirname, 'revisions.sql'), 'utf8'));
  await db.query('insert into rr_rooms values ($1)', [room]);
  await db.query("insert into rr_recordings values ($1,$2,'active')", [recording, room]);
  const table = async (_config, name, query = '', options = {}) => {
    assert.match(name, /^[a-z_]+$/);
    const params = [], search = new URLSearchParams(query), predicates = [];
    for (const [key, value] of search) {
      if (['select', 'limit', 'order'].includes(key)) continue;
      assert.match(key, /^[a-z_]+$/);
      const op = value.slice(0, value.indexOf('.')), operand = value.slice(value.indexOf('.') + 1);
      const operators = { eq: '=', gt: '>', lt: '<' };
      assert.ok(operators[op]); params.push(operand); predicates.push(`${key} ${operators[op]} $${params.length}`);
    }
    const where = predicates.length ? ' where ' + predicates.join(' and ') : '';
    if (options.method === 'DELETE') return (await db.query('delete from ' + name + where + ' returning *', params)).rows;
    if (options.method === 'PATCH') {
      const changes = JSON.parse(options.body);
      const assignments = Object.entries(changes).map(([key, value]) => { assert.match(key, /^[a-z_]+$/); params.push(value); return `${key} = $${params.length}`; });
      return (await db.query(`update ${name} set ${assignments.join(',')}${where} returning *`, params)).rows;
    }
    const select = (search.get('select') || '*').split(',').map(field => {
      if (field === '*') return '*';
      const projection = /^([a-z_]+):([a-z_]+)->([A-Za-z_]+)$/.exec(field);
      if (projection) return `${projection[2]} -> '${projection[3]}' as ${projection[1]}`;
      assert.match(field, /^[a-z_]+$/); return field;
    }).join(',');
    let suffix = '';
    if (search.has('order')) { assert.match(search.get('order'), /^[a-z_]+\.(asc|desc)$/); suffix += ' order by ' + search.get('order').replace('.', ' '); }
    if (search.has('limit')) { assert.match(search.get('limit'), /^\d+$/); suffix += ' limit ' + search.get('limit'); }
    return (await db.query(`select ${select} from ${name}${where}${suffix}`, params)).rows;
  };
  const config = { origin: 'https://review.example', base: 'https://db.example' };
  const invoke = async (method, pathname, value, role = 'owner', token, origin = config.origin) => {
    const req = { method, headers: { origin, ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: value, role };
    const res = { headers: {}, setHeader(name, item) { this.headers[name] = item; }, end(item) { this.payload = item; } };
    const ctx = { config, pathname, table, body: async (request, limit) => { if (Buffer.byteLength(JSON.stringify(request.body) || '') > limit) throw Object.assign(new Error('too large'), { status: 413 }); return request.body; },
      call: async (_config, endpoint, options) => {
        const name = endpoint.split('/').at(-1), args = JSON.parse(options.body); assert.match(name, /^[a-z_]+$/);
        return (await db.query(`select ${name}(${Object.keys(args).map((key, index) => `${key} := $${index + 1}`).join(',')}) as result`, Object.values(args))).rows[0].result;
      },
      requireOwner: async (_config, request) => { if (request.role !== 'owner') throw Object.assign(new Error('Owner sign-in required'), { status: 401 }); },
      requireRoom: async (_config, request, roomId) => { if (!['owner', 'guest'].includes(request.role) || roomId !== room) throw Object.assign(new Error('Room invitation required'), { status: 401 }); },
      loadRoom: async (_config, roomId) => { if (roomId !== room) throw Object.assign(new Error('Room not found'), { status: 404 }); return { id: roomId }; },
      storage: async () => ({ signedURL: '/object/sign/private?token=temporary' }),
      output: (response, status, result) => { response.statusCode = status; response.payload = JSON.stringify(result); },
      id: () => crypto.randomBytes(16).toString('hex'), random: () => crypto.randomBytes(32).toString('hex') };
    try { const handled = await handleRevisions(req, res, ctx); return { handled, status: res.statusCode, headers: res.headers, body: res.headers['Content-Type']?.startsWith('text/html') ? res.payload : res.payload && JSON.parse(res.payload) }; }
    catch (error) { if (!error.status) throw error; return { status: error.status, body: { error: error.message } }; }
  };
  return { db, invoke, route: `/api/rooms/${room}/revisions` };
}

sqlTest('owner request, worker preparation, exact approval, and ready download survive SQL state transitions', async t => {
  const { db, invoke, route } = await setup(t);
  await db.query("insert into rr_events(room_id,id,type,data,author,seq) values ($1,'note1','note','{\"text\":\"Use a larger title\"}','Guest',1)", [room]);
  const token = (await invoke('POST', '/api/worker/session', {})).body.token;
  const created = await invoke('POST', route, input('journey'));
  assert.equal(created.status, 201); assert.equal(created.body.input.notes[0].text, 'Use a larger title');
  const repeated = await invoke('POST', route, { requestId: 'journey' });
  assert.equal(repeated.body.id, created.body.id);
  assert.equal((await db.query('select count(*) as count from rr_revisions')).rows[0].count, 1);
  const job = (await invoke('POST', '/api/worker/claim', {}, 'worker', token)).body.job;
  assert.equal(job.id, created.body.id); assert.equal(job.operation, 'prepare'); assert.match(job.recordingUrl, /^https:\/\/db.example\/storage\/v1\/object\/sign\//);
  const completion = { lease: job.lease, operation: 'prepare', proposal: proposal() };
  const prepared = await invoke('POST', `/api/worker/revisions/${job.id}/complete`, completion, 'worker', token);
  assert.equal(prepared.body.state, 'proposed');
  assert.equal((await invoke('POST', `/api/worker/revisions/${job.id}/complete`, completion, 'worker', token)).body.proposal.proposalHash, prepared.body.proposal.proposalHash);
  assert.equal((await invoke('POST', `${route}/${job.id}/approve`, { proposalHash: '0'.repeat(64) })).status, 409);
  assert.equal((await invoke('GET', `${route}/${job.id}`, undefined, 'guest')).body.state, 'proposed');
  assert.equal((await invoke('POST', '/api/worker/claim', {}, 'worker', token)).body.job, null);
  await db.query("update rr_recordings set state = 'deleted'");
  const approval = { proposalHash: prepared.body.proposal.proposalHash };
  assert.equal((await invoke('POST', `${route}/${job.id}/approve`, approval)).body.state, 'approved');
  const apply = (await invoke('POST', '/api/worker/claim', {}, 'worker', token)).body.job;
  assert.equal(apply.operation, 'apply'); assert.equal(apply.recordingUrl, null);
  assert.equal((await invoke('POST', `/api/worker/revisions/${job.id}/complete`, completion, 'worker', token)).body.state, 'applying');
  assert.equal((await invoke('POST', `${route}/${job.id}/approve`, approval)).body.state, 'applying');
  const result = { html: changedHtml, hash: digest(changedHtml), verification: 'Materialized, parsed, and hashed the exact HTML file.' };
  assert.equal((await invoke('POST', `/api/worker/revisions/${job.id}/complete`, { lease: apply.lease, operation: 'apply', result: { ...result, html: changedHtml + '\n' } }, 'worker', token)).status, 400);
  const finish = { lease: apply.lease, operation: 'apply', result };
  assert.equal((await invoke('POST', `/api/worker/revisions/${job.id}/complete`, finish, 'worker', token)).body.state, 'ready');
  assert.equal((await invoke('POST', `/api/worker/revisions/${job.id}/complete`, finish, 'worker', token)).body.state, 'ready');
  assert.equal((await invoke('POST', `/api/worker/revisions/${job.id}/complete`, { ...finish, result: { ...result, verification: 'Changed after ready' } }, 'worker', token)).status, 409);
  assert.equal((await invoke('POST', `${route}/${job.id}/approve`, approval)).body.state, 'ready');
  const preview = await invoke('GET', `${route}/${job.id}/preview`, undefined, 'guest');
  assert.equal(preview.body, changedHtml); assert.match(preview.headers['Content-Security-Policy'], /sandbox;/); assert.match(preview.headers['Content-Security-Policy'], /script-src 'none'/); assert.doesNotMatch(preview.headers['Content-Security-Policy'], /allow-same-origin|allow-scripts/);
  assert.match((await invoke('GET', `${route}/${job.id}/source`, undefined, 'guest')).headers['Content-Disposition'], /^attachment;/);
  const list = (await invoke('GET', route, undefined, 'guest')).body;
  assert.equal(list.workerOnline, true); assert.equal(list.revisions[0].summary, 'Changed the title');
  assert.equal(Object.hasOwn(list.revisions[0], 'input'), false); assert.equal(Object.hasOwn(list.revisions[0], 'proposal'), false);
});

sqlTest('guest and worker authority cannot create requests, approve, or read private previews without room access', async t => {
  const { invoke, route } = await setup(t);
  const token = (await invoke('POST', '/api/worker/session', {})).body.token;
  assert.equal((await invoke('POST', '/api/worker/heartbeat', {}, 'worker', token)).body.ok, true);
  assert.equal((await invoke('GET', route, undefined, 'guest')).body.workerOnline, true);
  assert.equal((await invoke('POST', route, input('guest'), 'guest')).status, 401);
  assert.equal((await invoke('POST', route, input('cross-origin'), 'owner', undefined, 'https://evil.example')).status, 403);
  assert.equal((await invoke('POST', '/api/worker/session', {}, 'worker', token)).status, 401);
  const created = (await invoke('POST', route, input('authorized'))).body;
  assert.equal((await invoke('POST', `${route}/${created.id}/approve`, { proposalHash: 'c'.repeat(64) }, 'worker', token)).status, 401);
  assert.equal((await invoke('POST', `${route}/${created.id}/approve`, { proposalHash: 'c'.repeat(64) }, 'guest')).status, 401);
  assert.equal((await invoke('GET', `${route}/${created.id}/preview`, undefined, 'anonymous')).status, 401);
  assert.equal((await invoke('GET', `${route}/${created.id}/preview`, undefined, 'guest')).status, 409);
  assert.equal((await invoke('POST', '/api/worker/claim', {}, 'owner')).status, 401);
  await invoke('DELETE', '/api/worker/session', {});
  assert.equal((await invoke('POST', '/api/worker/claim', {}, 'worker', token)).status, 401);
  assert.equal((await invoke('POST', '/api/worker/heartbeat', {}, 'worker', token)).status, 401);
  assert.equal((await invoke('POST', `/api/worker/revisions/${created.id}/fail`, { lease: 'a'.repeat(64), error: 'Revoked worker' }, 'worker', token)).status, 401);
});

sqlTest('expired claims are fenced, retries invalidate old work, and transcript correction invalidates approval', async t => {
  const { db, invoke, route } = await setup(t);
  const token = (await invoke('POST', '/api/worker/session', {})).body.token;
  const revision = (await invoke('POST', route, input('fencing'))).body;
  const first = (await invoke('POST', '/api/worker/claim', {}, 'worker', token)).body.job;
  assert.equal((await invoke('POST', '/api/worker/claim', {}, 'worker', token)).body.job, null);
  await db.query("update rr_revisions set lease_expires_at = now() - interval '1 second' where id = $1", [revision.id]);
  const second = (await invoke('POST', '/api/worker/claim', {}, 'worker', token)).body.job;
  assert.notEqual(first.lease, second.lease);
  assert.equal((await invoke('POST', `/api/worker/revisions/${revision.id}/complete`, { lease: first.lease, operation: 'prepare', proposal: proposal() }, 'worker', token)).status, 409);
  assert.equal((await invoke('POST', `/api/worker/revisions/${revision.id}/fail`, { lease: first.lease, error: 'Old failure' }, 'worker', token)).status, 409);
  assert.equal((await invoke('POST', `/api/worker/revisions/${revision.id}/fail`, { lease: second.lease, error: 'Whisper failed' }, 'worker', token)).body.state, 'failed');
  assert.equal((await invoke('POST', `${route}/${revision.id}/retry`, {})).body.state, 'queued');
  assert.equal((await invoke('POST', `/api/worker/revisions/${revision.id}/fail`, { lease: second.lease, error: 'Stale failure' }, 'worker', token)).status, 409);
  const third = (await invoke('POST', '/api/worker/claim', {}, 'worker', token)).body.job;
  const prepared = (await invoke('POST', `/api/worker/revisions/${revision.id}/complete`, { lease: third.lease, operation: 'prepare', proposal: proposal() }, 'worker', token)).body;
  const transcriptText = '修正'.repeat(8000);
  const corrected = (await invoke('POST', `${route}/${revision.id}/correct`, { transcriptText })).body;
  assert.equal(corrected.state, 'queued'); assert.equal(corrected.proposal, null); assert.equal(corrected.input.transcriptOverride, transcriptText);
  assert.equal((await invoke('POST', `${route}/${revision.id}/approve`, { proposalHash: prepared.proposal.proposalHash })).status, 409);
  assert.equal((await invoke('POST', `/api/worker/revisions/${revision.id}/complete`, { lease: third.lease, operation: 'prepare', proposal: proposal() }, 'worker', token)).status, 409);
});

sqlTest('session cap, active recording validation, and durable uniqueness survive independent calls', async t => {
  const { db, invoke, route } = await setup(t);
  const tokens = [];
  for (let count = 0; count < 5; count++) tokens.push((await invoke('POST', '/api/worker/session', {})).body.token);
  assert.equal((await invoke('POST', '/api/worker/session', {})).status, 429);
  assert.equal((await invoke('POST', '/api/worker/claim', {}, 'worker', tokens[0])).status, 200);
  await db.query("update rr_recordings set state='deleted'");
  assert.equal((await invoke('POST', route, input('deleted'))).status, 400);
  await db.query("update rr_recordings set state='active'");
  const [one, two] = await Promise.all([invoke('POST', route, input('same-key')), invoke('POST', route, input('same-key'))]);
  assert.equal(one.body.id, two.body.id);
  const tokenHash = digest(tokens[0]);
  assert.equal((await db.query("select has_table_privilege('anon','rr_revisions','select') as allowed")).rows[0].allowed, false);
  assert.equal((await db.query("select has_function_privilege('anon','rr_revision_claim(text,text)','execute') as allowed")).rows[0].allowed, false);
  await db.query('delete from rr_worker_sessions where hash=$1', [tokenHash]);
  assert.deepEqual((await db.query('select rr_revision_claim($1,$2) as result', [tokenHash, 'f'.repeat(64)])).rows[0].result, { error: 'unauthorized' });
});

sqlTest('an interrupted apply retries the same approved bytes without preparing another proposal', async t => {
  const { invoke, route } = await setup(t);
  const token = (await invoke('POST', '/api/worker/session', {})).body.token;
  const revision = (await invoke('POST', route, input('apply-recovery'))).body;
  const prepare = (await invoke('POST', '/api/worker/claim', {}, 'worker', token)).body.job;
  const proposed = (await invoke('POST', `/api/worker/revisions/${revision.id}/complete`, { lease: prepare.lease, operation: 'prepare', proposal: proposal() }, 'worker', token)).body;
  await invoke('POST', `${route}/${revision.id}/approve`, { proposalHash: proposed.proposal.proposalHash });
  const first = (await invoke('POST', '/api/worker/claim', {}, 'worker', token)).body.job;
  await invoke('POST', `/api/worker/revisions/${revision.id}/fail`, { lease: first.lease, error: 'The completion connection was interrupted' }, 'worker', token);
  const retried = await invoke('POST', `${route}/${revision.id}/retry`, {});
  assert.equal(retried.status, 200); assert.equal(retried.body.state, 'approved');
  assert.deepEqual(retried.body.proposal, proposed.proposal);
  const second = (await invoke('POST', '/api/worker/claim', {}, 'worker', token)).body.job;
  assert.equal(second.operation, 'apply'); assert.notEqual(second.lease, first.lease);
  const result = { html: changedHtml, hash: digest(changedHtml), verification: 'Reapplied exact approved source.' };
  assert.equal((await invoke('POST', `/api/worker/revisions/${revision.id}/complete`, { lease: first.lease, operation: 'apply', result }, 'worker', token)).status, 409);
  assert.equal((await invoke('POST', `/api/worker/revisions/${revision.id}/complete`, { lease: second.lease, operation: 'apply', result }, 'worker', token)).body.state, 'ready');
});
