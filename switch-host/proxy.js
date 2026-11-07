const http = require('node:http');
const crypto = require('node:crypto');

function createProxy({ upstream, agent, key, room, fetchImpl = fetch }) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(upstream) || !/^[a-zA-Z0-9_-]{1,200}$/.test(agent) || typeof key !== 'string' || key.length < 32 || !room) throw new Error('Invalid proxy configuration');
  const endpoint = `/agents/${agent}/message`;
  const expected = Buffer.from(`Bearer ${key}`);
  return http.createServer(async (req, res) => {
    const send = (status, message) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error: message })); };
    if (req.method !== 'POST' || req.url !== endpoint) return send(404, 'Not found');
    const actual = Buffer.from(req.headers.authorization || '');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return send(401, 'Unauthorized');
    let chunks = [], size = 0;
    try {
      for await (const chunk of req) { size += chunk.length; if (size > 70000) return send(413, 'Request too large'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.room_id !== room || typeof body.content !== 'string' || !body.content.trim() || Buffer.byteLength(body.content) > 65536 || Object.keys(body).some(k => !['room_id','content'].includes(k))) return send(400, 'Invalid request');
      const response = await fetchImpl(upstream + endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (response.body) await response.body.cancel();
      if (!response.ok) return send(502, 'Switch unavailable');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end('{"ok":true}');
    } catch { if (!res.headersSent) send(502, 'Switch unavailable'); }
  });
}

if (require.main === module) {
  const { SWITCH_PROXY_UPSTREAM: upstream, SWITCH_PROXY_AGENT_ID: agent, SWITCH_PROXY_KEY: key, SWITCH_PROXY_ROOM_ID: room, SWITCH_PROXY_PORT: port = '18083' } = process.env;
  if (!/^(?:[1-9]\d{0,4})$/.test(port) || Number(port) > 65535) throw new Error('Invalid port');
  createProxy({ upstream, agent, key, room }).listen(Number(port), '127.0.0.1', () => console.log('Switch proxy listening on loopback'));
}
module.exports = { createProxy };
