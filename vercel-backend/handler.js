const crypto = require('node:crypto');
const { handoff } = require('../server/switch');
const { createTurnConfig } = require('../server/turn');
const { createCloudflareTurn, cloudflareTurnConfigured } = require('../server/cloudflare-turn');
const { createRstreamTurn, rstreamTurnConfigured } = require('../server/rstream-turn');
const { handleRevisions } = require('./revisions');

const validId = /^[a-f0-9]{32}$/;
const validSecret = /^[a-f0-9]{64}$/;
const random = () => crypto.randomBytes(32).toString('hex');
const id = () => crypto.randomBytes(16).toString('hex');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const failure = (status, message) => Object.assign(new Error(message), { status });
const lifetime = 7 * 24 * 60 * 60 * 1000;
const bucket = 'review-room-recordings';
const text = (v, n) => typeof v === 'string' && v.trim().length > 0 && v.length <= n;
const safePath = (room, recording) => `${room}/${recording}.webm`;

function settings() {
  const { SUPABASE_URL: base, SUPABASE_SERVICE_ROLE_KEY: key, REVIEW_OWNER_PASSWORD: password, REVIEW_PUBLIC_ORIGIN: origin } = process.env;
  if (!base || !key || !password || password.length < 32 || !origin) throw failure(503, 'Server configuration incomplete');
  let target, publicOrigin;
  try { target = new URL(base); publicOrigin = new URL(origin); } catch { throw failure(503, 'Server configuration invalid'); }
  if (target.protocol !== 'https:' || target.origin !== base || publicOrigin.protocol !== 'https:' || publicOrigin.origin !== origin) throw failure(503, 'Server configuration invalid');
  return { base, key, password, origin };
}
async function call(config, endpoint, options = {}) {
  const response = await fetch(config.base + endpoint, { ...options, headers: { apikey: config.key, authorization: `Bearer ${config.key}`, ...options.headers } });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    if (data?.message === 'review_room_event_limit') throw failure(413, 'Review storage is full');
    if (data?.message === 'review_room_recording_missing') throw failure(400, 'Recording does not exist');
    throw failure(response.status === 404 ? 404 : 503, response.status === 404 ? 'Not found' : 'Storage service unavailable');
  }
  return data;
}
function table(config, tableName, query = '', options = {}) {
  return call(config, `/rest/v1/${tableName}${query ? '?' + query : ''}`, { ...options, headers: { 'Content-Type': 'application/json', Prefer: 'return=representation', ...options.headers } });
}
function cookie(req, name) { return Object.fromEntries((req.headers.cookie || '').split(';').map(part => part.trim().split('=')))[name]; }
function setCookie(res, name, value, seconds) { res.setHeader('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`); }
function output(res, status, value) { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(value)); }
async function body(req, limit = 256 * 1024) {
  if (req.body && typeof req.body === 'object') { if (Buffer.byteLength(JSON.stringify(req.body)) > limit) throw failure(413, 'Request too large'); return req.body; }
  if (typeof req.body === 'string') { if (Buffer.byteLength(req.body) > limit) throw failure(413, 'Request too large'); try { return JSON.parse(req.body); } catch { throw failure(400, 'Invalid JSON'); } }
  const chunks = []; let size = 0;
  for await (const part of req) { size += part.length; if (size > limit) throw failure(413, 'Request too large'); chunks.push(part); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw failure(400, 'Invalid JSON'); }
}
async function session(config, req, name, room) {
  const secret = cookie(req, name);
  if (!validSecret.test(secret || '')) return false;
  const items = await table(config, 'rr_sessions', `hash=eq.${hash(secret)}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=room_id,invitation_hash`);
  if (!items.length || items[0].room_id !== room) return false;
  if (room === null) return true;
  if (!validSecret.test(items[0].invitation_hash || '')) return false;
  const invites = await table(config, 'rr_invitations', `room_id=eq.${room}&hash=eq.${items[0].invitation_hash}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=hash`);
  return invites.length > 0;
}
async function owner(config, req) { return session(config, req, '__Host-rr-owner', null); }
async function requireOwner(config, req) { if (!await owner(config, req)) throw failure(401, 'Owner sign-in required'); }
async function requireRoom(config, req, roomId) { if (!await owner(config, req) && !await session(config, req, `__Host-rr-${roomId}`, roomId)) throw failure(401, 'Room invitation required'); }
async function loadRoom(config, roomId) { const rows = await table(config, 'rr_rooms', `id=eq.${roomId}&select=*`); if (!rows.length) throw failure(404, 'Room not found'); const r = rows[0]; return { id: r.id, name: r.name, url: r.url, createdAt: r.created_at }; }
function validEvent(type, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !text(data.client, 128)) return false;
  if (type === 'clear') return true;
  if (type === 'note') return text(data.text, 500);
  if (type === 'note_status') return validId.test(data.noteId || '') && ['open', 'resolved'].includes(data.status);
  if (type === 'presence') return ['join','hello','heartbeat','leave'].includes(data.action) && (data.action !== 'hello' || text(data.recipient, 128)) && (data.recording === undefined || typeof data.recording === 'boolean');
  if (type === 'signal') { const p = data.payload; if (!text(data.recipient, 128) || !p || typeof p !== 'object') return false; if (p.description && !p.candidate) return ['offer','answer'].includes(p.description.type) && text(p.description.sdp, 200000); if (p.candidate && !p.description) return typeof p.candidate.candidate === 'string' && p.candidate.candidate.length <= 10000; return false; }
  if (type === 'stroke') return text(data.strokeId,128) && /^#[a-f0-9]{6}$/i.test(data.color || '') && Number.isSafeInteger(data.seq) && data.seq > 0 && Array.isArray(data.points) && data.points.length > 0 && data.points.length <= 5000 && data.points.every(p => p && Number.isFinite(p.x) && p.x >= 0 && p.x <= 1 && Number.isFinite(p.y) && p.y >= 0 && p.y <= 1);
  if (type === 'recording') return Number.isFinite(data.startedAt) && Number.isFinite(data.endedAt) && data.endedAt >= data.startedAt;
  return false;
}
function publicEvent(e) { return { id: e.id, type: e.type, author: e.author, data: e.data, at: e.at }; }
function frame(e) { return `${e.transient ? '' : `id: ${e.id}\n`}data: ${JSON.stringify(publicEvent(e))}\n\n`; }
async function storage(config, endpoint, options) { return call(config, '/storage/v1' + endpoint, options); }
async function cleanupReservations(config) {
  const before = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const expired = await table(config, 'rr_recordings', `state=in.(deleted,pending,deleting)&created_at=lt.${encodeURIComponent(before)}&select=id,room_id,created_at,state`);
  for (const record of expired) {
    if (record.state !== 'deleting') {
      const claimed = await table(config, 'rr_recordings', `id=eq.${record.id}&state=eq.${record.state}&created_at=lt.${encodeURIComponent(before)}`, {method:'PATCH',body:JSON.stringify({state:'deleting'})});
      if (!claimed.length) continue;
    }
    await storage(config, `/object/${bucket}`, { method:'DELETE', headers:{'Content-Type':'application/json'}, body:JSON.stringify({prefixes:[safePath(record.room_id,record.id)]}) });
    await table(config, 'rr_recordings', `id=eq.${record.id}&state=eq.deleting&created_at=lt.${encodeURIComponent(before)}`, {method:'DELETE'});
  }
}
async function tombstone(config, roomId, rec) {
  await table(config, 'rr_recordings', `room_id=eq.${roomId}&id=eq.${rec}&state=in.(pending,active,deleted)`, {method:'PATCH',body:JSON.stringify({state:'deleted'})});
}
async function eventExists(config, room, idValue, type) { return (await table(config, 'rr_events', `room_id=eq.${room}&id=eq.${idValue}&type=eq.${type}&select=id&limit=1`)).length > 0; }
async function history(config, room, after = 0, through = null) {
  const result = [];
  while (result.length < 20000) {
    const rows = await table(config, 'rr_events', `room_id=eq.${room}&transient=eq.false&seq=gt.${after}${through === null ? '' : `&seq=lte.${through}`}&select=*&order=seq.asc&limit=500`);
    result.push(...rows);
    if (rows.length < 500) break;
    after = rows.at(-1).seq;
  }
  return result;
}
async function handler(req, res) {
  try {
    const config = settings();
    res.setHeader('Referrer-Policy', 'no-referrer');
    const url = new URL(req.url, config.origin), pathname = url.pathname;
    const workerRequest = /^\/api\/worker\/(claim|heartbeat|revisions\/[a-f0-9]{32}\/(complete|fail))$/.test(pathname);
    if (['POST','PUT','PATCH','DELETE'].includes(req.method) && pathname !== '/api/switch-replies' && !workerRequest && req.headers.origin !== config.origin) throw failure(403, 'Invalid request origin');
    if (await handleRevisions(req, res, { config, pathname, call, table, body, owner, requireOwner, requireRoom, loadRoom, storage, output, hash, id, random, failure })) return;
    if (req.method === 'POST' && pathname === '/api/switch-replies') {
      if (process.env.SWITCH_DEMO_REPLIES !== '1') throw failure(404, 'Not found');
      const value = await body(req);
      if (!validSecret.test(value?.token || '') || !text(value?.text, 16000)) throw failure(400, 'Invalid reply');
      const accepted = await call(config, '/rest/v1/rpc/rr_switch_reply', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({token_hash:hash(value.token), reply_text:value.text.trim(), event_id:id()}) });
      if (!accepted) throw failure(404, 'Reply request expired or not found');
      return output(res, 201, {ok:true});
    }
    if (req.method === 'GET' && pathname === '/api/auth/status') return output(res, 200, { secure: true, owner: await owner(config, req) });
    if (req.method === 'POST' && pathname === '/api/owner/session') {
      if (!await call(config, '/rest/v1/rpc/rr_claim_login_attempt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })) throw failure(429, 'Too many sign-in attempts');
      const value = await body(req), candidate = value?.password;
      if (typeof candidate !== 'string' || candidate.length > 1024 || !crypto.timingSafeEqual(crypto.createHash('sha256').update(candidate).digest(), crypto.createHash('sha256').update(config.password).digest())) throw failure(401, 'Invalid owner password');
      const secret = random(); await table(config, 'rr_sessions', '', { method: 'POST', body: JSON.stringify({ hash: hash(secret), room_id: null, expires_at: new Date(Date.now() + lifetime).toISOString() }) });
      setCookie(res, '__Host-rr-owner', secret, lifetime / 1000); return output(res, 200, { ok: true });
    }
    if (req.method === 'POST' && pathname === '/api/owner/logout') { const secret = cookie(req, '__Host-rr-owner'); if (validSecret.test(secret || '')) await table(config, 'rr_sessions', `hash=eq.${hash(secret)}`, { method: 'DELETE' }); setCookie(res, '__Host-rr-owner', '', 0); return output(res, 200, { ok: true }); }
    if (pathname === '/api/rooms') {
      await requireOwner(config, req);
      if (req.method === 'GET') { const rows = await table(config, 'rr_rooms', 'select=*&order=created_at.desc&limit=1000'); return output(res, 200, { rooms: rows.map(r => ({ id:r.id, name:r.name, url:r.url, createdAt:r.created_at })) }); }
      if (req.method === 'POST') { const value = await body(req); if (!text(value?.name,120) || !text(value?.url,2048)) throw failure(400, 'Name and URL are required'); let page; try { page = new URL(value.url); } catch { throw failure(400, 'Invalid URL'); } if (!['https:','http:'].includes(page.protocol) || page.username || page.password) throw failure(400, 'Invalid URL'); const room = { id:id(), name:value.name.trim(), url:page.href, created_at:new Date().toISOString() }; await table(config, 'rr_rooms', '', { method:'POST', body:JSON.stringify(room) }); return output(res, 201, { id:room.id, name:room.name, url:room.url, createdAt:room.created_at }); }
    }
    const recordingMatch = /^\/recordings\/([a-f0-9]{32})\/([a-f0-9]{32})$/.exec(pathname);
    if (recordingMatch) {
      const [, room, rec] = recordingMatch; const obj = safePath(room, rec);
      if (req.method === 'GET' || req.method === 'HEAD') { await requireRoom(config, req, room); const [record] = await table(config, 'rr_recordings', `room_id=eq.${room}&id=eq.${rec}&state=eq.active&select=id`); if (!record) throw failure(404, 'Recording not found'); const signed = await storage(config, `/object/sign/${bucket}/${obj}`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({expiresIn:60}) }); if (typeof signed?.signedURL !== 'string' || !signed.signedURL.startsWith('/object/sign/')) throw failure(503, 'Storage service unavailable'); res.writeHead(302, { Location: config.base + '/storage/v1' + signed.signedURL, 'Cache-Control':'private, no-store' }); return res.end(); }
      if (req.method === 'DELETE') { await requireOwner(config, req); const [record] = await table(config, 'rr_recordings', `room_id=eq.${room}&id=eq.${rec}&select=id,state`); if (!record) throw failure(404, 'Recording not found'); await call(config,'/rest/v1/rpc/rr_delete_recording',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({target_id:rec,target_room:room,event_id:id()})}); await storage(config, `/object/${bucket}`, { method:'DELETE', headers:{'Content-Type':'application/json'}, body:JSON.stringify({prefixes:[obj]}) }); return output(res,200,{ok:true}); }
    }
    const match = /^\/api\/rooms\/([a-f0-9]{32})(?:\/(events|recordings\/upload-url|ice-config|invitations|join|switch-handoff))?$/.exec(pathname);
    if (!match) throw failure(404, 'Not found');
    const [, roomId, resource] = match;
    if (resource === 'invitations') {
      await requireOwner(config, req); await loadRoom(config, roomId);
      if (req.method === 'POST') { const secret=random(), expires=new Date(Date.now()+lifetime).toISOString(); await table(config,'rr_invitations','',{method:'POST',body:JSON.stringify({hash:hash(secret),room_id:roomId,expires_at:expires})}); return output(res,201,{url:`${config.origin}/?room=${roomId}#invite=${secret}`,expiresAt:expires}); }
      if (req.method === 'DELETE') { await table(config,'rr_invitations',`room_id=eq.${roomId}`,{method:'DELETE'}); await table(config,'rr_sessions',`room_id=eq.${roomId}`,{method:'DELETE'}); return output(res,200,{ok:true}); }
    }
    if (resource === 'join' && req.method === 'POST') { await loadRoom(config, roomId); const value=await body(req); if (!validSecret.test(value?.token || '')) throw failure(401,'Invitation is invalid or expired'); const invitationHash=hash(value.token); const [invite]=await table(config,'rr_invitations',`room_id=eq.${roomId}&hash=eq.${invitationHash}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=expires_at`); if (!invite) throw failure(401,'Invitation is invalid or expired'); const secret=random(); await table(config,'rr_sessions','',{method:'POST',body:JSON.stringify({hash:hash(secret),room_id:roomId,invitation_hash:invitationHash,expires_at:invite.expires_at})}); setCookie(res,`__Host-rr-${roomId}`,secret,Math.max(0,Math.floor((Date.parse(invite.expires_at)-Date.now())/1000))); return output(res,200,{ok:true}); }
    if (resource === 'switch-handoff') await requireOwner(config, req); else await requireRoom(config, req, roomId);
    const room = await loadRoom(config, roomId);
    if (!resource && req.method === 'GET') { const rows=await history(config,roomId); const mention=process.env.SWITCH_HANDOFF_MENTION || ''; return output(res,200,{...room,events:rows.map(publicEvent),switchHandoffMention:/^@[A-Za-z0-9._-]{1,64}$/.test(mention) ? mention : ''}); }
    if (resource === 'ice-config' && req.method === 'GET') {
      const turn = createTurnConfig();
      const useCloudflare = cloudflareTurnConfigured();
      const useRstream = rstreamTurnConfigured();
      if ([turn, useCloudflare, useRstream].filter(Boolean).length > 1) throw failure(503, 'Configure only one TURN provider');
      const provider = useCloudflare ? await createCloudflareTurn() : useRstream ? await createRstreamTurn() : null;
      const iceServers = [{ urls:'stun:stun.l.google.com:19302' }, ...(turn ? [turn.server] : []), ...(provider?.servers || [])];
      const expiry = turn?.expiresAt || provider?.expiresAt;
      return output(res, 200, expiry ? { iceServers, turnExpiresAt:expiry } : { iceServers });
    }
    if (resource === 'recordings/upload-url' && req.method === 'POST') { const value=await body(req); if (!/^video\/webm(?:\s*;|$)/i.test(value?.contentType || '') || !Number.isSafeInteger(value?.size) || value.size <= 0 || value.size > 50 * 1024 * 1024) throw failure(400,'Invalid recording'); await cleanupReservations(config); const rec=id(), obj=safePath(roomId,rec); const reserved=await call(config,'/rest/v1/rpc/rr_reserve_recording',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({new_id:rec,new_room:roomId})}); if (!reserved) throw failure(413,'Recording storage is full; deleted recordings may take up to three hours to release space'); try { const signed=await storage(config,`/object/upload/sign/${bucket}/${obj}`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}); if (typeof signed?.url !== 'string' || !signed.url.startsWith('/object/upload/sign/')) throw failure(503,'Storage service unavailable'); await requireRoom(config,req,roomId); return output(res,201,{uploadUrl:config.base+'/storage/v1'+signed.url,url:`/recordings/${roomId}/${rec}`}); } catch(error) { await tombstone(config,roomId,rec).catch(()=>{}); throw error; } }
    if (resource === 'switch-handoff' && req.method === 'POST') {
      const value=await body(req);
      if (process.env.SWITCH_DEMO_REPLIES !== '1') return output(res,200,await handoff(value?.content));
      if (!text(value?.content, 65000)) throw failure(400,'Content must be a nonempty string of at most 65000 characters');
      const token=random(), tokenHash=hash(token);
      const reserved=await call(config,'/rest/v1/rpc/rr_switch_prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token_hash:tokenHash,target_room:roomId})});
      if (!reserved) throw failure(503,'Too many pending Switch replies');
      try { await handoff(`Review-Room-Reply: ${token}\n${value.content}`); }
      catch(error) { await table(config,'rr_pending_switch',`hash=eq.${tokenHash}`,{method:'DELETE'}).catch(()=>{}); throw error; }
      return output(res,200,{ok:true,message:'Sent to Switch. A configured agent can reply in activity.'});
    }
    if (resource === 'events' && req.method === 'POST') { const value=await body(req); if (!text(value?.type,80) || !text(value.author,120) || !validEvent(value.type,value.data)) throw failure(400,'Invalid event data'); if (value.type==='note_status' && !await eventExists(config,roomId,value.data.noteId,'note')) throw failure(400,'Note does not exist in this room'); if (value.type==='recording') { const match=typeof value.data.url==='string' && /^\/recordings\/([a-f0-9]{32})\/([a-f0-9]{32})$/.exec(value.data.url); if (!match || match[1]!==roomId) throw failure(400,'Invalid recording URL'); const [record]=await table(config,'rr_recordings',`room_id=eq.${roomId}&id=eq.${match[2]}&state=in.(pending,active)&select=id`); if (!record) throw failure(400,'Recording does not exist'); await storage(config,`/object/info/${bucket}/${safePath(roomId,match[2])}`); } const event={room_id:roomId,id:id(),type:value.type,author:value.author.trim(),data:value.data,transient:['signal','presence'].includes(value.type)}; const [saved]=await table(config,'rr_events','',{method:'POST',body:JSON.stringify(event)}); return output(res,201,publicEvent(saved)); }
    if (resource === 'events' && req.method === 'GET') {
      const cursor=req.headers['last-event-id'] || url.searchParams.get('cursor');
      const latest=await table(config,'rr_events',`room_id=eq.${roomId}&select=seq&order=seq.desc&limit=1`); let sequence=latest[0]?.seq || 0;
      let after=0;
      if (cursor && cursor!=='0') { if (!validId.test(cursor)) throw failure(409,'Event cursor not found'); const [event]=await table(config,'rr_events',`room_id=eq.${roomId}&id=eq.${cursor}&transient=eq.false&select=seq`); if (!event) throw failure(409,'Event cursor not found'); after=event.seq; }
      const replay=cursor ? await history(config,roomId,after,sequence) : [];
      res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','X-Accel-Buffering':'no'}); res.write(': connected\n\n'); for (const e of replay) res.write(frame(e));
      let closed=false; req.on('close',()=>{closed=true;}); const end=Date.now()+240000;
      while (!closed && Date.now()<end) { await new Promise(resolve=>setTimeout(resolve,1200)); if (closed) break; try { await requireRoom(config,req,roomId); const events=await table(config,'rr_events',`room_id=eq.${roomId}&seq=gt.${sequence}&select=*&order=seq.asc&limit=1000`); for(const e of events) { sequence=e.seq; res.write(frame(e)); } if (!events.length) res.write(': heartbeat\n\n'); } catch(error) { if (error.status===401) res.write('event: access-revoked\ndata: {}\n\n'); break; } }
      return res.end();
    }
    throw failure(405,'Method not allowed');
  } catch (error) { if (!res.headersSent) output(res,error.status || 500,{error:error.status ? error.message : 'Internal server error'}); else res.end(); if (!error.status) console.error(error); }
}
module.exports = handler;
