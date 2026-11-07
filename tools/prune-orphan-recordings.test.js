const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('lists orphans safely and deletes only old unreferenced recordings', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-orphans-'));
  const rooms = path.join(root, 'rooms'); const recordings = path.join(root, 'recordings');
  const room = 'a'.repeat(32); const ref = 'b'.repeat(32); const old = 'c'.repeat(32); const recent = 'd'.repeat(32); const absentRoom = 'e'.repeat(32);
  const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, 'prune-orphan-recordings.js'), '--data-dir', root, ...args], { encoding: 'utf8' });
  try {
    await fs.mkdir(rooms); await fs.mkdir(recordings);
    await fs.writeFile(path.join(rooms, `${room}.json`), JSON.stringify({ id: room, events: [{ type: 'recording', data: { url: `/recordings/${room}/${ref}` } }] }));
    for (const name of [`${room}-${ref}`, `${room}-${old}`, `${room}-${recent}`, `${absentRoom}-${old}`]) await fs.writeFile(path.join(recordings, name), 'video');
    const oldTime = new Date(Date.now() - 26 * 60 * 60 * 1000);
    await fs.utimes(path.join(recordings, `${room}-${old}`), oldTime, oldTime);
    const listing = run(); assert.equal(listing.status, 0); const list = JSON.parse(listing.stdout);
    assert.equal(list.mode, 'dry-run'); assert.equal(list.skippedMissingRoom, 1);
    assert.deepEqual(new Map(list.orphaned.map(item => [item.name, item.eligible])), new Map([[`${room}-${old}`, true], [`${room}-${recent}`, false]]));
    assert.notEqual(run('--delete').status, 0);
    const deletion = run('--delete', '--server-stopped'); assert.equal(deletion.status, 0); assert.deepEqual(JSON.parse(deletion.stdout).deleted, [`${room}-${old}`]);
    const remaining = await fs.readdir(recordings); assert(remaining.includes(`${room}-${ref}`)); assert(remaining.includes(`${room}-${recent}`)); assert(remaining.includes(`${absentRoom}-${old}`));
    await fs.writeFile(path.join(rooms, `${room}.json`), '{bad');
    assert.notEqual(run('--delete', '--server-stopped').status, 0);
    assert.deepEqual((await fs.readdir(recordings)).sort(), remaining.sort());
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
