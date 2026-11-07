#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');

const AGE_MS = 24 * 60 * 60 * 1000;
const FILE = /^([a-f0-9]{32})-([a-f0-9]{32})$/;

async function inspect(dataDir, now = Date.now()) {
  if (!path.isAbsolute(dataDir)) throw new Error('The data directory must be an absolute path.');
  const roomDir = path.join(dataDir, 'rooms');
  const recordingDir = path.join(dataDir, 'recordings');
  const rooms = new Map();
  for (const entry of await fs.readdir(roomDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-f0-9]{32}\.json$/.test(entry.name)) continue;
    const room = JSON.parse(await fs.readFile(path.join(roomDir, entry.name), 'utf8'));
    const roomId = entry.name.slice(0, -5);
    if (room.id !== roomId || !Array.isArray(room.events)) throw new Error(`Invalid room record: ${entry.name}`);
    const references = new Set();
    for (const event of room.events) {
      if (!event || typeof event !== 'object' || typeof event.type !== 'string') throw new Error(`Invalid event in room: ${entry.name}`);
      if (event.type === 'recording') {
        const url = event.data?.url;
        if (typeof url !== 'string' || !new RegExp(`^/recordings/${roomId}/[a-f0-9]{32}$`).test(url)) throw new Error(`Invalid recording reference in room: ${entry.name}`);
        references.add(url.slice(-32));
      }
    }
    rooms.set(roomId, references);
  }
  const orphaned = [];
  let missingRoom = 0;
  for (const entry of await fs.readdir(recordingDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = FILE.exec(entry.name);
    if (!match) continue;
    const references = rooms.get(match[1]);
    if (!references) { missingRoom++; continue; }
    if (references.has(match[2])) continue;
    const fullPath = path.join(recordingDir, entry.name);
    const stat = await fs.lstat(fullPath);
    if (!stat.isFile()) continue;
    orphaned.push({ name: entry.name, bytes: stat.size, modifiedAt: new Date(stat.mtimeMs).toISOString(), eligible: now - stat.mtimeMs >= AGE_MS, dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs });
  }
  return { recordingDir, orphaned, missingRoom };
}

async function main(args) {
  const dataIndex = args.indexOf('--data-dir');
  if (dataIndex === -1 || !args[dataIndex + 1] || args.some((value, index) => index !== dataIndex && index !== dataIndex + 1 && !['--delete', '--server-stopped'].includes(value))) {
    throw new Error('Usage: node tools/prune-orphan-recordings.js --data-dir /absolute/data/path [--delete --server-stopped]');
  }
  const deleting = args.includes('--delete');
  if (deleting && !args.includes('--server-stopped')) throw new Error('Stop all app instances and supply --server-stopped before deleting.');
  const dataDir = args[dataIndex + 1];
  const result = await inspect(dataDir);
  const deleted = [];
  if (deleting) {
    for (const item of result.orphaned.filter(item => item.eligible)) {
      const current = await inspect(dataDir);
      const candidate = current.orphaned.find(entry => entry.name === item.name && entry.eligible && entry.dev === item.dev && entry.ino === item.ino && entry.mtimeMs === item.mtimeMs && entry.bytes === item.bytes);
      if (!candidate) continue;
      await fs.unlink(path.join(current.recordingDir, candidate.name));
      deleted.push(candidate.name);
    }
  }
  console.log(JSON.stringify({ mode: deleting ? 'delete' : 'dry-run', orphaned: result.orphaned.map(({ name, bytes, modifiedAt, eligible }) => ({ name, bytes, modifiedAt, eligible })), skippedMissingRoom: result.missingRoom, deleted }, null, 2));
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { inspect, main };
