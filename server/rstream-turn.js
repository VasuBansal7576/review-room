const { resolve4 } = require('node:dns/promises');
const { isIPv4 } = require('node:net');

const invalid = () => Object.assign(new Error('rstream TURN configuration is invalid'), { status: 503 });
const unavailable = () => Object.assign(new Error('rstream TURN service is unavailable'), { status: 503 });

function rstreamTurnConfigured(env = process.env) {
  const endpoint = env.RSTREAM_PROJECT_ENDPOINT || '';
  const token = env.RSTREAM_AUTHENTICATION_TOKEN || '';
  const ttlText = env.RSTREAM_TURN_TTL_SECONDS || '';
  if (!endpoint && !token && !ttlText) return null;
  const ttl = ttlText ? Number(ttlText) : 600;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(endpoint) || !/^[\x21-\x7e]{1,4096}$/.test(token) ||
      (ttlText && !/^\d+$/.test(ttlText)) || !Number.isSafeInteger(ttl) || ttl < 120 || ttl > 3600) throw invalid();
  return { endpoint, token, ttl };
}

function validIceUrl(value) {
  if (typeof value !== 'string' || value.length > 256) return false;
  const match = /^(turn|turns):([a-z0-9-]+(?:\.[a-z0-9-]+)*\.c\.rstream\.io):(3478|5349)\?transport=(udp|tcp)$/i.exec(value);
  return Boolean(match && ((match[1].toLowerCase() === 'turn' && match[3] === '3478') || (match[1].toLowerCase() === 'turns' && match[3] === '5349')));
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

function publicIpv4(value) {
  if (!isIPv4(value)) return false;
  const [a, b, c] = value.split('.').map(Number);
  return a !== 0 && a !== 10 && a !== 127 && a < 224 &&
    !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168) &&
    !(a === 192 && b === 0 && (c === 0 || c === 2)) && !(a === 192 && b === 88 && c === 99) &&
    !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) && !(a === 203 && b === 0 && c === 113);
}

async function relayUrls(urls, resolve4Impl) {
  const tls = urls.find(url => /^turns:[^:]+:5349\?transport=tcp$/i.test(url));
  const tcp = urls.find(url => /^turn:[^:]+:3478\?transport=tcp$/i.test(url));
  const fallback = [tls || urls[0]];
  if (!tcp) return fallback;
  let timer;
  try {
    const hostname = tcp.match(/^turn:([^:]+):/i)[1];
    const addresses = await Promise.race([
      resolve4Impl(hostname),
      new Promise(resolve => { timer = setTimeout(() => resolve([]), 2000); })
    ]);
    const address = Array.isArray(addresses) ? addresses.find(publicIpv4) : null;
    return address ? [`turn:${address}:3478?transport=tcp`, ...(tls ? [tls] : [])] : fallback;
  } catch { return fallback; }
  finally { clearTimeout(timer); }
}

async function createRstreamTurn(env = process.env, fetchImpl = fetch, nowMs = Date.now(), resolve4Impl = resolve4) {
  const config = rstreamTurnConfigured(env);
  if (!config) return null;
  if (!Number.isFinite(nowMs) || nowMs < 0) throw invalid();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetchImpl(`https://rstream.io/api/projects/tunnels/resolve/${config.endpoint}/turn-server/credentials`, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttlSeconds: config.ttl })
    });
    if (!response.ok) throw unavailable();
    const result = await readBounded(response);
    if (!Number.isSafeInteger(result?.ttl) || result.ttl < 120 || result.ttl > config.ttl ||
        typeof result.username !== 'string' || !result.username || result.username.length > 2048 ||
        typeof result.credential !== 'string' || !result.credential || result.credential.length > 2048 ||
        !Array.isArray(result.urls) || !result.urls.length || result.urls.length > 20 || !result.urls.every(validIceUrl)) throw unavailable();
    const urls = await relayUrls(result.urls, resolve4Impl);
    return { servers: [{ urls, username: result.username, credential: result.credential }], expiresAt: new Date(nowMs + result.ttl * 1000).toISOString() };
  } catch { throw unavailable(); }
  finally { clearTimeout(timer); }
}

module.exports = { rstreamTurnConfigured, createRstreamTurn };
