const fs = require('node:fs/promises');

const transientTypes = new Set(['presence', 'signal']);
const defaultRoomBytes = 4 * 1024 * 1024;
const defaultTotalBytes = 64 * 1024 * 1024;
const defaultEvents = 20000;

function isTransient(event) { return transientTypes.has(event.type); }

function formatEvent(event) {
  const id = isTransient(event) ? '' : `id: ${event.id}\n`;
  return `${id}data: ${JSON.stringify(event)}\n\n`;
}

async function roomStorageBytes(directory) {
  let total = 0;
  for (const file of await fs.readdir(directory, { withFileTypes: true })) {
    if (file.isFile() && /^[a-f0-9]{32}\.json$/.test(file.name)) total += (await fs.stat(`${directory}/${file.name}`)).size;
  }
  return total;
}

function validateRoomGrowth(room, event, totalBytes, limits = {}) {
  if (isTransient(event)) return;
  const maxRoomBytes = limits.maxRoomBytes ?? defaultRoomBytes;
  const maxTotalBytes = limits.maxTotalBytes ?? defaultTotalBytes;
  const maxEvents = limits.maxEvents ?? defaultEvents;
  const before = Buffer.byteLength(JSON.stringify(room));
  const after = Buffer.byteLength(JSON.stringify({ ...room, events: [...room.events, event] }));
  if (room.events.length >= maxEvents || after > maxRoomBytes || totalBytes - before + after > maxTotalBytes) {
    throw Object.assign(new Error('Review storage is full'), { status: 413 });
  }
}

module.exports = { isTransient, formatEvent, roomStorageBytes, validateRoomGrowth };
