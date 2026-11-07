function error(status, message) { return Object.assign(new Error(message), { status }); }

async function handoff(content) {
  const { SWITCH_AGENT_BASE_URL: base, SWITCH_AGENT_ID: agentId, SWITCH_AGENT_API_KEY: key, SWITCH_ROOM_ID: roomId } = process.env;
  if (!base || !agentId || !key || !roomId) throw error(503, 'Switch handoff is not configured');
  if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content, 'utf8') > 65536) throw error(400, 'Content must be a nonempty string of at most 65536 bytes');
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(agentId) || roomId.length > 500 || key.length > 4096) throw error(503, 'Switch handoff configuration is invalid');
  let url;
  try { url = new URL(base); } catch { throw error(503, 'Switch handoff configuration is invalid'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) throw error(503, 'Switch handoff requires an HTTPS or local HTTP base URL');
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/agents/${encodeURIComponent(agentId)}/message`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ room_id: roomId, content })
    });
  } catch { throw error(502, 'Switch handoff could not reach the configured server'); }
  if (response.body) await response.body.cancel();
  if (!response.ok) throw error(502, `Switch handoff failed with upstream status ${response.status}`);
  return { ok: true };
}
module.exports = { handoff };
