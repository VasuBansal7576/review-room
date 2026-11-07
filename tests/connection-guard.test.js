const { test } = require('node:test');
const assert = require('node:assert/strict');
const { connectionGuard } = require('../public/connection-guard');

function setup() {
  let closeCount = 0;
  let nextId = 0;
  const timers = new Map();
  const guard = connectionGuard(() => closeCount++, 30000, (callback, delay) => {
    const id = ++nextId;
    timers.set(id, { callback, delay });
    return id;
  }, id => timers.delete(id));
  return { guard, timers, get closeCount() { return closeCount; } };
}

test('a brief stream interruption keeps the call connected', () => {
  const state = setup();
  state.guard.disconnected();
  state.guard.disconnected();
  assert.equal(state.timers.size, 1);
  assert.equal([...state.timers.values()][0].delay, 30000);
  state.guard.connected();
  assert.equal(state.timers.size, 0);
  assert.equal(state.closeCount, 0);
});

test('a prolonged interruption ends the call', () => {
  const state = setup();
  state.guard.disconnected();
  [...state.timers.values()][0].callback();
  assert.equal(state.closeCount, 1);
});

test('revocation immediately ends the call and cancels pending timeout', () => {
  const state = setup();
  state.guard.disconnected();
  state.guard.revoked();
  assert.equal(state.timers.size, 0);
  assert.equal(state.closeCount, 1);
});
