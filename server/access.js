const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const token = () => crypto.randomBytes(32).toString('hex');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const validToken = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const failure = (status, message) => Object.assign(new Error(message), { status });
const lifetime = 7 * 24 * 60 * 60 * 1000;

function createAccess(dataDir, host) {
  const password = process.env.REVIEW_OWNER_PASSWORD || '';
  const origin = process.env.REVIEW_PUBLIC_ORIGIN || '';
  const production = process.env.NODE_ENV === 'production';
  const secure = !!(password || origin || production);
  if (!secure && !['127.0.0.1', '::1', 'localhost'].includes(host)) throw failure(500, 'Unauthenticated mode is limited to loopback');
  if (secure) {
    let url;
    try { url = new URL(origin); } catch { throw failure(500, 'REVIEW_PUBLIC_ORIGIN must be an HTTPS origin'); }
    if (url.protocol !== 'https:' || url.origin !== origin || password.length < 32 || password.length > 1024) throw failure(500, 'Secure mode requires an HTTPS origin and an owner password of at least 32 characters');
  }
  const salt = crypto.randomBytes(16);
  const expected = secure ? crypto.scryptSync(password, salt, 32) : null;
  const owners = new Map();
  const guests = new Map();
  const attempts = [];
  let activePasswordChecks = 0;
  const inviteDir = path.join(dataDir, 'invitations');
  const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(v => v.trim().split('=')).filter(v => v.length === 2));
  const session = (req, name, store) => {
    const value = cookies(req)[name];
    if (!validToken(value)) return null;
    const entry = store.get(hash(value));
    if (!entry || entry.expires <= Date.now()) { if (entry) store.delete(hash(value)); return null; }
    return entry;
  };
  const owner = req => !secure || !!session(req, '__Host-rr-owner', owners);
  const guest = (req, roomId) => !secure || session(req, `__Host-rr-${roomId}`, guests)?.roomId === roomId;
  const setCookie = (res, name, value, maxAge) => res.setHeader('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`);
  const roomForSession = store => { for (const [key, entry] of store) if (entry.expires <= Date.now()) store.delete(key); if (store.size >= 5000) throw failure(503, 'Too many active sessions'); };
  const readInvite = async roomId => {
    try { return JSON.parse(await fs.readFile(path.join(inviteDir, `${roomId}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  return {
    secure, origin, owner, guest,
    checkOrigin(req) { if (secure && req.headers.origin !== origin) throw failure(403, 'Invalid request origin'); },
    requireOwner(req) { if (!owner(req)) throw failure(401, 'Owner sign-in required'); },
    requireRoom(req, roomId) { if (!owner(req) && !guest(req, roomId)) throw failure(401, 'Room invitation required'); },
    async login(req, res, candidate) {
      const now = Date.now();
      while (attempts.length && attempts[0] < now - 15 * 60 * 1000) attempts.shift();
      if (typeof candidate !== 'string' || candidate.length > 1024) throw failure(401, 'Invalid owner password');
      if (activePasswordChecks >= 2) throw failure(429, 'Sign-in is busy. Try again shortly.');
      activePasswordChecks++;
      let derived;
      try { derived = await new Promise((resolve, reject) => crypto.scrypt(candidate, salt, 32, (error, key) => error ? reject(error) : resolve(key))); }
      finally { activePasswordChecks--; }
      const matches = crypto.timingSafeEqual(derived, expected);
      if (!matches) {
        if (attempts.length >= 10) throw failure(429, 'Too many sign-in attempts. Try again later.');
        attempts.push(now); throw failure(401, 'Invalid owner password');
      }
      roomForSession(owners); const value = token(); owners.set(hash(value), { expires: now + lifetime }); setCookie(res, '__Host-rr-owner', value, lifetime / 1000);
    },
    logout(req, res) { const value = cookies(req)['__Host-rr-owner']; if (validToken(value)) owners.delete(hash(value)); setCookie(res, '__Host-rr-owner', '', 0); },
    async invite(roomId) {
      await fs.mkdir(inviteDir, { recursive: true, mode: 0o700 });
      const value = token(); const expiresAt = Date.now() + lifetime;
      const target = path.join(inviteDir, `${roomId}.json`); const temp = `${target}.${token()}.tmp`;
      const previous = await readInvite(roomId);
      const invitations = (Array.isArray(previous?.invitations) ? previous.invitations : previous?.hash ? [previous] : []).filter(invite => invite.expiresAt > Date.now());
      if (invitations.length >= 100) throw failure(429, 'Too many active invitations');
      invitations.push({ hash: hash(value), expiresAt });
      try { await fs.writeFile(temp, JSON.stringify({ invitations }), { mode: 0o600, flag: 'wx' }); await fs.rename(temp, target); }
      finally { await fs.rm(temp, { force: true }); }
      return { url: `${origin}/?room=${roomId}#invite=${value}`, expiresAt: new Date(expiresAt).toISOString() };
    },
    async join(res, roomId, candidate) {
      const stored = await readInvite(roomId);
      const invites = Array.isArray(stored?.invitations) ? stored.invitations : stored?.hash ? [stored] : [];
      const candidateHash = validToken(candidate) ? hash(candidate) : '';
      const invite = invites.find(item => item.expiresAt > Date.now() && /^[a-f0-9]{64}$/.test(item.hash || '') && validToken(candidate) && crypto.timingSafeEqual(Buffer.from(candidateHash, 'hex'), Buffer.from(item.hash, 'hex')));
      if (!invite) throw failure(401, 'Invitation is invalid or expired');
      roomForSession(guests); const value = token(); guests.set(hash(value), { roomId, expires: invite.expiresAt }); setCookie(res, `__Host-rr-${roomId}`, value, Math.max(0, Math.floor((invite.expiresAt - Date.now()) / 1000)));
    },
    async revoke(roomId) { await fs.rm(path.join(inviteDir, `${roomId}.json`), { force: true }); for (const [key, entry] of guests) if (entry.roomId === roomId) guests.delete(key); },
  };
}
module.exports = { createAccess };
