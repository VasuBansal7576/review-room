const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { handoff } = require('./switch');
const { createTurnConfig } = require('./turn');
const { createCloudflareTurn, cloudflareTurnConfigured } = require('./cloudflare-turn');
const { isTransient, formatEvent, roomStorageBytes, validateRoomGrowth } = require('./events');
const { createAccess } = require('./access');

const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
const dataDir = process.env.REVIEW_ROOM_DATA_DIR || path.join(root, 'data');
const roomDir = path.join(dataDir, 'rooms');
const recordingDir = path.join(dataDir, 'recordings');
const clients = new Map();
const queues = new Map();
const pendingSwitchReplies = new Map();
const idPattern = /^[a-f0-9]{32}$/;
const maxRecordingBytes = 256 * 1024 * 1024;
let recordingUploadInProgress = false;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
function fail(status, message) { return Object.assign(new Error(message), { status }); }
async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw fail(413, 'Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function bodyJson(req) {
  try { return JSON.parse((await readBody(req, 256 * 1024)).toString('utf8')); }
  catch (error) { if (error.status) throw error; throw fail(400, 'Invalid JSON'); }
}
function text(value, max) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max; }
function validPublicEvent(type, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !text(data.client, 128)) return false;
  if (type === 'clear') return true;
  if (type === 'note') return text(data.text, 500);
  if (type === 'note_status') return /^[a-f0-9]{32}$/.test(data.noteId || '') && ['open', 'resolved'].includes(data.status);
  if (type === 'presence') return ['join', 'hello', 'heartbeat', 'leave'].includes(data.action) && (data.action !== 'hello' || text(data.recipient, 128)) && (data.recording === undefined || typeof data.recording === 'boolean');
  if (type === 'signal') {
    if (!text(data.recipient, 128) || !data.payload || typeof data.payload !== 'object' || Array.isArray(data.payload)) return false;
    const { description, candidate } = data.payload;
    if (description && !candidate) return typeof description === 'object' && ['offer', 'answer'].includes(description.type) && text(description.sdp, 200000);
    if (candidate && !description) return typeof candidate === 'object' && typeof candidate.candidate === 'string' && candidate.candidate.length <= 10000;
    return false;
  }
  if (type === 'stroke') return text(data.strokeId, 128) && /^#[a-f0-9]{6}$/i.test(data.color || '') && Number.isSafeInteger(data.seq) && data.seq > 0 && Array.isArray(data.points) && data.points.length > 0 && data.points.every(point => point && Number.isFinite(point.x) && point.x >= 0 && point.x <= 1 && Number.isFinite(point.y) && point.y >= 0 && point.y <= 1);
  if (type === 'recording') return Number.isFinite(data.startedAt) && Number.isFinite(data.endedAt) && data.endedAt >= data.startedAt;
  return false;
}
function id() { return crypto.randomBytes(16).toString('hex'); }
function iceConfig() {
  if (!process.env.ICE_SERVERS_JSON) return [{ urls: 'stun:stun.l.google.com:19302' }];
  let servers;
  try { servers = JSON.parse(process.env.ICE_SERVERS_JSON); } catch { throw fail(503, 'ICE configuration is invalid'); }
  const validUrl = value => {
    if (typeof value !== 'string' || value.length > 2048) return false;
    const match = /^(stun|stuns|turn|turns):(?:\[[0-9a-f:.]+\]|[a-z0-9][a-z0-9.-]*)(?::(\d{1,5}))?(\?transport=(?:udp|tcp))?$/i.exec(value);
    return !!match && (!match[2] || (Number(match[2]) > 0 && Number(match[2]) <= 65535)) && (!match[3] || /^turn/i.test(match[1]));
  };
  if (!Array.isArray(servers) || !servers.length || servers.length > 20 || !servers.every(server => {
    if (!server || typeof server !== 'object' || Array.isArray(server)) return false;
    if (Object.keys(server).some(key => !['urls', 'username', 'credential'].includes(key))) return false;
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.length > 0 && urls.length <= 20 && urls.every(validUrl) &&
      ['username', 'credential'].every(key => server[key] === undefined || (typeof server[key] === 'string' && server[key].length <= 2048));
  })) throw fail(503, 'ICE configuration is invalid');
  return servers;
}
function writeEvent(res, event) { if (res.roomAuthorized && !res.roomAuthorized()) return res.end(); res.write(formatEvent(event)); }
async function loadRoom(roomId) {
  try { return JSON.parse(await fs.readFile(path.join(roomDir, `${roomId}.json`), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') throw fail(404, 'Room not found'); throw error; }
}
async function saveRoom(room) {
  const target = path.join(roomDir, `${room.id}.json`);
  const temp = `${target}.${id()}.tmp`;
  try { await fs.writeFile(temp, JSON.stringify(room), { flag: 'wx' }); await fs.rename(temp, target); }
  finally { await fs.rm(temp, { force: true }); }
}
async function recordingBytes() {
  let total = 0;
  for (const entry of await fs.readdir(recordingDir, { withFileTypes: true })) {
    if (entry.isFile() && /^[a-f0-9]{32}-[a-f0-9]{32}$/.test(entry.name)) total += (await fs.stat(path.join(recordingDir, entry.name))).size;
  }
  return total;
}
function locked(roomId, action) {
  const previous = queues.get(roomId) || Promise.resolve();
  const next = previous.catch(() => {}).then(action);
  queues.set(roomId, next);
  next.finally(() => { if (queues.get(roomId) === next) queues.delete(roomId); }).catch(() => {});
  return next;
}
async function serveStatic(req, res, pathname) {
  let relative;
  try { relative = decodeURIComponent(pathname); } catch { throw fail(400, 'Invalid path'); }
  if (relative.includes('\0') || relative.split('/').some(part => part === '..')) throw fail(400, 'Invalid path');
  const file = path.resolve(publicDir, `.${relative === '/' ? '/index.html' : relative}`);
  if (!file.startsWith(publicDir + path.sep)) throw fail(403, 'Invalid path');
  try {
    const content = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'EISDIR') throw fail(404, 'Not found'); throw error; }
}
async function handler(req, res, access) {
  try {
    res.setHeader('Referrer-Policy', 'no-referrer');
    const requestUrl = new URL(req.url, 'http://localhost');
    const pathname = requestUrl.pathname;
    if (access.secure && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && pathname !== '/api/switch-replies') access.checkOrigin(req);
    if (req.method === 'GET' && pathname === '/api/auth/status') return json(res, 200, { secure: access.secure, owner: access.owner(req) });
    if (req.method === 'POST' && pathname === '/api/owner/session') {
      if (!access.secure) return json(res, 200, { ok: true });
      const value = await bodyJson(req);
      await access.login(req, res, value?.password);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && pathname === '/api/owner/logout') { if (access.secure) access.logout(req, res); return json(res, 200, { ok: true }); }
    if (req.method === 'POST' && pathname === '/api/switch-replies') {
      if (process.env.SWITCH_DEMO_REPLIES !== '1') throw fail(404, 'Not found');
      const value = await bodyJson(req);
      const token = value?.token;
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !text(value.text, 16000)) throw fail(400, 'Invalid reply');
      const pending = pendingSwitchReplies.get(token);
      if (!pending || pending.expires < Date.now()) { pendingSwitchReplies.delete(token); throw fail(404, 'Reply request expired or not found'); }
      pendingSwitchReplies.delete(token);
      const event = { id: id(), type: 'switch_reply', author: 'Switch agent', data: { text: value.text.trim() }, at: new Date().toISOString() };
      try {
        await locked('__event_quota__', () => locked(pending.roomId, async () => {
          const room = await loadRoom(pending.roomId);
          if (access.secure) validateRoomGrowth(room, event, await roomStorageBytes(roomDir));
          room.events.push(event);
          await saveRoom(room);
          for (const client of clients.get(pending.roomId) || []) writeEvent(client, event);
        }));
      } catch (error) { pendingSwitchReplies.set(token, pending); throw error; }
      return json(res, 201, { ok: true });
    }
    if (req.method === 'GET' && pathname === '/api/rooms') {
      access.requireOwner(req);
      const files = (await fs.readdir(roomDir)).filter(name => /^[a-f0-9]{32}\.json$/.test(name));
      const rooms = await Promise.all(files.map(name => loadRoom(name.slice(0, -5))));
      return json(res, 200, { rooms: rooms.map(({ events, ...room }) => room).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
    }
    if (req.method === 'POST' && pathname === '/api/rooms') {
      access.requireOwner(req);
      const value = await bodyJson(req);
      if (!value || !text(value.name, 120) || !text(value.url, 2048)) throw fail(400, 'Name and URL are required');
      let url;
      try { url = new URL(value.url); } catch { throw fail(400, 'Invalid URL'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw fail(400, 'URL must be HTTP or HTTPS without credentials');
      const room = { id: id(), name: value.name.trim(), url: url.href, createdAt: new Date().toISOString(), events: [] };
      await locked('__event_quota__', async () => { if (access.secure && (await roomStorageBytes(roomDir)) + Buffer.byteLength(JSON.stringify(room)) > 64 * 1024 * 1024) throw fail(413, 'Review storage is full'); await saveRoom(room); });
      const { events, ...summary } = room;
      return json(res, 201, summary);
    }
    const match = pathname.match(/^\/api\/rooms\/([^/]+)(?:\/(events|recordings|switch-handoff|ice-config|invitations|join))?$/);
    if (match) {
      const [, roomId, resource] = match;
      if (!idPattern.test(roomId)) throw fail(404, 'Room not found');
      if (resource === 'invitations') {
        access.requireOwner(req);
        await loadRoom(roomId);
        if (!access.secure) throw fail(404, 'Invitations require secure mode');
        if (req.method === 'POST') { const invitation = await locked(roomId, () => access.invite(roomId)); return json(res, 201, invitation); }
        if (req.method === 'DELETE') {
          await locked(roomId, () => access.revoke(roomId));
          for (const client of clients.get(roomId) || []) { client.write('event: access-revoked\ndata: {}\n\n'); client.end(); }
          return json(res, 200, { ok: true });
        }
        throw fail(405, 'Method not allowed');
      }
      if (resource === 'join' && req.method === 'POST') {
        if (!access.secure) return json(res, 200, { ok: true });
        await loadRoom(roomId);
        const value = await bodyJson(req);
        await locked(roomId, () => access.join(res, roomId, value?.token));
        return json(res, 200, { ok: true });
      }
      if (resource === 'switch-handoff') access.requireOwner(req);
      else access.requireRoom(req, roomId);
      if (req.method === 'GET' && !resource) {
        const room = await loadRoom(roomId);
        const mention = process.env.SWITCH_HANDOFF_MENTION || '';
        return json(res, 200, { ...room, events: room.events.filter(event => !isTransient(event)), switchHandoffMention: /^@[A-Za-z0-9._-]{1,64}$/.test(mention) ? mention : '' });
      }
      if (req.method === 'GET' && resource === 'ice-config') {
        await loadRoom(roomId);
        const iceServers = iceConfig();
        if (access.secure && iceServers.some(server => (Array.isArray(server.urls) ? server.urls : [server.urls]).some(url => /^turns?:/i.test(url)))) throw fail(503, 'Static TURN credentials are not allowed in secure mode');
        const turn = createTurnConfig();
        const cloudflareConfigured = cloudflareTurnConfigured();
        if (turn && cloudflareConfigured) throw fail(503, 'Configure only one TURN provider');
        const cloudflare = cloudflareConfigured ? await createCloudflareTurn() : null;
        if (turn) iceServers.push(turn.server);
        if (cloudflare) iceServers.push(...cloudflare.servers);
        const expiry = turn?.expiresAt || cloudflare?.expiresAt;
        return json(res, 200, expiry ? { iceServers, turnExpiresAt: expiry } : { iceServers });
      }
      if (req.method === 'GET' && resource === 'events') {
        const cursor = req.headers['last-event-id'] || requestUrl.searchParams.get('cursor');
        await locked(roomId, async () => {
          access.requireRoom(req, roomId);
          const room = await loadRoom(roomId);
          const index = cursor && cursor !== '0' ? room.events.findIndex(event => event.id === cursor) : -1;
          if (cursor && cursor !== '0' && index === -1) throw fail(409, 'Event cursor not found');
          if (req.destroyed) return;
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.write(': connected\n\n');
          if (!clients.has(roomId)) clients.set(roomId, new Set());
          const subscribers = clients.get(roomId);
          res.roomAuthorized = () => { try { access.requireRoom(req, roomId); return true; } catch { return false; } };
          subscribers.add(res);
          const heartbeat = setInterval(() => { try { access.requireRoom(req, roomId); res.write(': heartbeat\n\n'); } catch { res.end(); } }, 25000);
          req.on('close', () => { clearInterval(heartbeat); subscribers.delete(res); if (!subscribers.size && clients.get(roomId) === subscribers) clients.delete(roomId); });
          if (cursor) for (const event of room.events.slice(index + 1)) if (!isTransient(event)) writeEvent(res, event);
        });
        return;
      }
      if (req.method === 'POST' && resource === 'events') {
        const value = await bodyJson(req);
        if (!value || !text(value.type, 80) || !text(value.author, 120) || !Object.hasOwn(value, 'data')) throw fail(400, 'Type, author, and data are required');
        if (value.type.trim() === 'switch_reply') throw fail(403, 'Switch replies cannot be posted as room events');
        if (!validPublicEvent(value.type.trim(), value.data)) throw fail(400, 'Invalid event data');
        if (value.type.trim() === 'recording') {
          const match = typeof value.data?.url === 'string' && /^\/recordings\/([a-f0-9]{32})\/([a-f0-9]{32})$/.exec(value.data.url);
          if (!match || match[1] !== roomId) throw fail(400, 'Invalid recording URL');
          try { await fs.access(path.join(recordingDir, `${roomId}-${match[2]}`)); } catch (error) { if (error.code === 'ENOENT') throw fail(400, 'Recording does not exist'); throw error; }
        }
        const event = { id: id(), type: value.type.trim(), author: value.author.trim(), data: value.data, at: new Date().toISOString() };
        const write = () => locked(roomId, async () => {
          access.requireRoom(req, roomId);
          const room = await loadRoom(roomId);
          if (event.type === 'note_status' && !room.events.some(previous => previous.id === event.data.noteId && previous.type === 'note')) throw fail(400, 'Note does not exist in this room');
          if (event.type === 'recording') {
            const recordingId = event.data.url.split('/').at(-1);
            try { await fs.access(path.join(recordingDir, `${roomId}-${recordingId}`)); }
            catch (error) { if (error.code === 'ENOENT') throw fail(400, 'Recording does not exist'); throw error; }
          }
          if (!isTransient(event)) {
            if (access.secure) validateRoomGrowth(room, event, await roomStorageBytes(roomDir));
            room.events.push(event);
            await saveRoom(room);
          }
          for (const client of clients.get(roomId) || []) writeEvent(client, event);
        });
        if (isTransient(event) || !access.secure) await write(); else await locked('__event_quota__', write);
        return json(res, 201, event);
      }
      if (req.method === 'POST' && resource === 'switch-handoff') {
        await loadRoom(roomId);
        const value = await bodyJson(req);
        if (process.env.SWITCH_DEMO_REPLIES !== '1' || typeof value?.content !== 'string' || !value.content.trim()) return json(res, 200, await handoff(value && value.content));
        for (const [token, pending] of pendingSwitchReplies) if (pending.expires < Date.now()) pendingSwitchReplies.delete(token);
        if (pendingSwitchReplies.size >= 1000) throw fail(503, 'Too many pending Switch replies');
        const token = crypto.randomBytes(32).toString('hex');
        pendingSwitchReplies.set(token, { roomId, expires: Date.now() + 15 * 60 * 1000 });
        try { await handoff(`Review-Room-Reply: ${token}\n${value.content}`); }
        catch (error) { pendingSwitchReplies.delete(token); throw error; }
        return json(res, 200, { ok: true, message: 'Sent to Switch. A configured demo agent can reply in activity.' });
      }
      if (req.method === 'POST' && resource === 'recordings') {
        await loadRoom(roomId);
        if (!/^video\/webm(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw fail(415, 'Expected video/webm');
        if (recordingUploadInProgress) throw fail(429, 'Another recording is uploading. Try again shortly');
        recordingUploadInProgress = true;
        const recordingId = id();
        const temporary = path.join(recordingDir, `.${roomId}-${recordingId}.upload`);
        let file;
        try {
          file = await fs.open(temporary, 'wx', 0o600);
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 100 * 1024 * 1024) throw fail(413, 'Request body too large');
            await file.writeFile(chunk);
          }
          if (!size) throw fail(400, 'Recording is empty');
          await file.close(); file = null;
          await locked('__recording_quota__', async () => locked(roomId, async () => {
            access.requireRoom(req, roomId);
            if (access.secure && (await recordingBytes()) + size > maxRecordingBytes) throw fail(413, 'Recording storage is full');
            await fs.rename(temporary, path.join(recordingDir, `${roomId}-${recordingId}`));
          }));
          return json(res, 201, { url: `/recordings/${roomId}/${recordingId}` });
        } finally {
          if (file) await file.close().catch(() => {});
          await fs.rm(temporary, { force: true });
          recordingUploadInProgress = false;
        }
      }
      throw fail(405, 'Method not allowed');
    }
    const recording = pathname.match(/^\/recordings\/(?:([^/]+)\/)?([^/]+)$/);
    if (recording && req.method === 'DELETE') {
      const [, roomId, recordingId] = recording;
      if (!idPattern.test(roomId || '') || !idPattern.test(recordingId)) throw fail(404, 'Recording not found');
      access.requireOwner(req);
      await locked('__recording_quota__', async () => locked(roomId, async () => {
        const room = await loadRoom(roomId);
        const url = `/recordings/${roomId}/${recordingId}`;
        if (!room.events.some(event => event.type === 'recording' && event.data.url === url)) throw fail(404, 'Recording not found');
        try { await fs.unlink(path.join(recordingDir, `${roomId}-${recordingId}`)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const event = { id: id(), type: 'recording_deleted', author: 'Owner', data: { url }, at: new Date().toISOString() };
        room.events.push(event);
        await saveRoom(room);
        for (const client of clients.get(roomId) || []) writeEvent(client, event);
      }));
      return json(res, 200, { ok: true });
    }
    if (recording && (req.method === 'GET' || req.method === 'HEAD')) {
      const [, roomId, recordingId] = recording;
      if (!idPattern.test(recordingId) || (roomId && !idPattern.test(roomId))) throw fail(404, 'Recording not found');
      if (access.secure && !roomId) throw fail(404, 'Recording not found');
      if (roomId) access.requireRoom(req, roomId);
      if (roomId) await loadRoom(roomId);
      let file;
      try { file = await fs.open(path.join(recordingDir, roomId ? `${roomId}-${recordingId}` : recordingId), 'r'); }
      catch (error) { if (error.code === 'ENOENT') throw fail(404, 'Recording not found'); throw error; }
      const { size } = await file.stat();
      res.setHeader('Cache-Control', 'private, no-store');
      let start = 0, end = size - 1;
      if (req.headers.range) {
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (!range || (!range[1] && !range[2])) { await file.close(); res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
        if (!range[1]) { const suffix = Number(range[2]); start = Math.max(0, size - suffix); }
        else { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) { await file.close(); res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      }
      res.writeHead(req.headers.range ? 206 : 200, { 'Content-Type': 'video/webm', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff' });
      if (req.method === 'HEAD') { await file.close(); return res.end(); }
      const stream = file.createReadStream({ start, end, autoClose: true });
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      return stream.pipe(res);
    }
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res, pathname);
    throw fail(404, 'Not found');
  } catch (error) {
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Internal server error' });
    else res.destroy();
    if (!error.status) console.error(error);
  }
}
async function start(port = Number(process.env.PORT || 3000), host = process.env.HOST || '127.0.0.1') {
  const access = createAccess(dataDir, host);
  await Promise.all([fs.mkdir(roomDir, { recursive: true }), fs.mkdir(recordingDir, { recursive: true })]);
  const server = http.createServer((req, res) => handler(req, res, access));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return server;
}
if (require.main === module) start().then(server => console.log(`Review Room listening on http://localhost:${server.address().port}`)).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { start };
