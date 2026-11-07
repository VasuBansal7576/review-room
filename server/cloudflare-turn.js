const invalid = () => Object.assign(new Error('Cloudflare TURN configuration is invalid'), { status: 503 });
const unavailable = () => Object.assign(new Error('Cloudflare TURN service is unavailable'), { status: 503 });

function cloudflareTurnConfigured(env = process.env) {
  const keyId = env.CLOUDFLARE_TURN_KEY_ID || '';
  const apiToken = env.CLOUDFLARE_TURN_API_TOKEN || '';
  const ttlText = env.CLOUDFLARE_TURN_TTL_SECONDS || '';
  if (!keyId && !apiToken && !ttlText) return null;
  const ttl = ttlText ? Number(ttlText) : 3600;
  if (!/^[a-f0-9]{32}$/i.test(keyId) || !/^[A-Za-z0-9_-]{32,256}$/.test(apiToken) ||
      (ttlText && !/^\d+$/.test(ttlText)) || !Number.isSafeInteger(ttl) || ttl < 300 || ttl > 86400) throw invalid();
  return { keyId, apiToken, ttl };
}

function validIceUrl(value) {
  if (typeof value !== 'string' || value.length > 256) return false;
  const match = /^(stun|turn|turns):(stun\.cloudflare\.com|turn\.cloudflare\.com):(\d{1,5})(?:\?transport=(udp|tcp))?$/i.exec(value);
  if (!match || Number(match[3]) < 1 || Number(match[3]) > 65535) return false;
  return match[1].toLowerCase() === 'stun' ? match[2].toLowerCase() === 'stun.cloudflare.com' && !match[4] : match[2].toLowerCase() === 'turn.cloudflare.com';
}

async function readBounded(response) {
  if (!response.body) throw unavailable();
  const chunks = []; let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > 65536) throw unavailable();
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function createCloudflareTurn(env = process.env, fetchImpl = fetch, nowMs = Date.now()) {
  const config = cloudflareTurnConfigured(env);
  if (!config) return null;
  if (!Number.isFinite(nowMs) || nowMs < 0) throw invalid();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetchImpl(`https://rtc.live.cloudflare.com/v1/turn/keys/${config.keyId}/credentials/generate-ice-servers`, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${config.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: config.ttl })
    });
    if (response.status !== 201) throw unavailable();
    const data = await readBounded(response);
    if (!Array.isArray(data.iceServers) || data.iceServers.length < 1 || data.iceServers.length > 10) throw unavailable();
    const servers = data.iceServers.map(server => {
      const requestedUrls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
      if (!requestedUrls.length || requestedUrls.length > 20 || !requestedUrls.every(validIceUrl)) throw unavailable();
      const urls = requestedUrls.filter(url => !/:53(?:\?|$)/.test(url));
      if (!urls.length) throw unavailable();
      const turn = urls.some(url => /^turns?:/i.test(url));
      if (turn && (typeof server.username !== 'string' || !server.username || server.username.length > 2048 || typeof server.credential !== 'string' || !server.credential || server.credential.length > 2048)) throw unavailable();
      return turn ? { urls, username: server.username, credential: server.credential } : { urls };
    });
    if (!servers.some(server => server.username)) throw unavailable();
    return { servers, expiresAt: new Date(nowMs + config.ttl * 1000).toISOString() };
  } catch { throw unavailable(); }
  finally { clearTimeout(timer); }
}

module.exports = { cloudflareTurnConfigured, createCloudflareTurn };
