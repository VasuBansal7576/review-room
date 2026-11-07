const invalid = () => Object.assign(new Error('Metered TURN configuration is invalid'), { status: 503 });
const unavailable = () => Object.assign(new Error('Metered TURN service is unavailable'), { status: 503 });

function meteredTurnConfigured(env = process.env) {
  const app = env.METERED_TURN_APP || '';
  const apiKey = env.METERED_TURN_API_KEY || '';
  if (!app && !apiKey) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(app) ||
      !/^[A-Za-z0-9_-]{1,512}$/.test(apiKey)) throw invalid();
  return { app, apiKey };
}

function validIceUrl(value) {
  if (typeof value !== 'string' || value.length > 256) return false;
  const match = /^(stun|turn|turns):((?:[a-z0-9-]+\.)?relay\.metered\.ca|openrelay\.metered\.ca):(\d{1,5})(?:\?transport=(udp|tcp))?$/i.exec(value);
  if (!match || Number(match[3]) < 1 || Number(match[3]) > 65535) return false;
  return match[1].toLowerCase() !== 'stun' || !match[4];
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

async function getMeteredTurn(env = process.env, fetchImpl = fetch) {
  const config = meteredTurnConfigured(env);
  if (!config) return null;
  const endpoint = new URL(`https://${config.app}.metered.live/api/v1/turn/credentials`);
  endpoint.searchParams.set('apiKey', config.apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetchImpl(endpoint.href, { method: 'GET', redirect: 'error', signal: controller.signal });
    if (response.status !== 200) throw unavailable();
    const data = await readBounded(response);
    if (!Array.isArray(data) || !data.length || data.length > 20) throw unavailable();
    const servers = data.map(server => {
      const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
      if (!urls.length || urls.length > 20 || !urls.every(validIceUrl)) throw unavailable();
      const usable = urls.filter(url => !/:53(?:\?|$)/.test(url));
      if (!usable.length) throw unavailable();
      const turn = usable.some(url => /^turns?:/i.test(url));
      if (turn && (typeof server.username !== 'string' || !server.username || server.username.length > 2048 || typeof server.credential !== 'string' || !server.credential || server.credential.length > 2048)) throw unavailable();
      return turn ? { urls: usable, username: server.username, credential: server.credential } : { urls: usable };
    });
    if (!servers.some(server => server.username)) throw unavailable();
    return { servers };
  } catch { throw unavailable(); }
  finally { clearTimeout(timer); }
}

module.exports = { meteredTurnConfigured, getMeteredTurn };
