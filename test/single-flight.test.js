import test from 'node:test';
import assert from 'node:assert/strict';
import { createSingleFlight } from '../src/single-flight.js';

test('concurrent initialization runs once', async () => {
  let calls = 0;
  const run = createSingleFlight();
  const initialize = () => run(async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return 'ready';
  });
  assert.deepEqual(await Promise.all([initialize(), initialize()]), ['ready', 'ready']);
  assert.equal(calls, 1);
});
