const crypto = require('node:crypto');
const net = require('node:net');

const DEFAULT_TTL = 3600;
const MIN_TTL = 300;
const MAX_TTL = 86400;
const invalid = () => Object.assign(new Error('TURN configuration is invalid'), { status: 503 });

function isTurnUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  const match = /^turns?:(?:\[([0-9a-f:.]+)\]|([a-z0-9.-]+))(?::(\d{1,5}))?(?:\?transport=(udp|tcp))?$/i.exec(value);
  if (!match) return false;
  if (match[1] && net.isIP(match[1]) !== 6) return false;
  if (match[2]) {
    const labels = match[2].split('.');
    if (labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return false;
  }
  return !match[3] || (Number(match[3]) > 0 && Number(match[3]) <= 65535);
}

function createTurnConfig(env = process.env, nowMs = Date.now()) {
  const urlsText = env.TURN_URLS_JSON || '';
  const secret = env.TURN_SHARED_SECRET || '';
  const ttlText = env.TURN_CREDENTIAL_TTL_SECONDS || '';
  if (!urlsText && !secret && !ttlText) return null;
  let urls;
  try { urls = JSON.parse(urlsText); } catch { throw invalid(); }
  const ttl = ttlText ? Number(ttlText) : DEFAULT_TTL;
  if (!Array.isArray(urls) || urls.length === 0 || urls.length > 20 || !urls.every(isTurnUrl) ||
      typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32 || Buffer.byteLength(secret, 'utf8') > 4096 ||
      (ttlText && !/^\d+$/.test(ttlText)) || !Number.isSafeInteger(ttl) || ttl < MIN_TTL || ttl > MAX_TTL ||
      !Number.isFinite(nowMs) || nowMs < 0) throw invalid();
  const expiry = Math.floor(nowMs / 1000) + ttl;
  const username = `${expiry}:${crypto.randomBytes(16).toString('hex')}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return { server: { urls, username, credential }, expiresAt: new Date(expiry * 1000).toISOString() };
}

module.exports = { createTurnConfig };
