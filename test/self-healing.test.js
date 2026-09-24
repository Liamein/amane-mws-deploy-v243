import test from 'node:test';
import assert from 'node:assert/strict';
import { isGatewayOperational, retryRecoverable, shouldRecoverGateway } from '../src/self-healing.js';

test('a reconnecting shard is unavailable even while discord.js still reports ready', () => {
  assert.equal(isGatewayOperational({ isReady: true, unavailableSince: 0 }), true);
  assert.equal(isGatewayOperational({ isReady: true, unavailableSince: 123 }), false);
  assert.equal(isGatewayOperational({ isReady: false, unavailableSince: 0 }), false);
});

test('retryRecoverable retries a temporary failure and returns normally', async () => {
  let calls = 0;
  const result = await retryRecoverable(async () => {
    calls += 1;
    if (calls === 1) throw new Error('temporary');
    return 'recovered';
  }, { delayMs: 0, jitterRatio: 0, sleep: async () => {} });
  assert.equal(result, 'recovered');
  assert.equal(calls, 2);
});

test('gateway recovery waits for its grace period and cooldown', () => {
  assert.equal(shouldRecoverGateway({ isReady: false, now: 100, unavailableSince: 1, lastRecoveryAt: 0, graceMs: 100, cooldownMs: 50 }), false);
  assert.equal(shouldRecoverGateway({ isReady: false, now: 200, unavailableSince: 1, lastRecoveryAt: 100, graceMs: 100, cooldownMs: 50 }), true);
  assert.equal(shouldRecoverGateway({ isReady: true, now: 200, unavailableSince: 1, lastRecoveryAt: 100, graceMs: 100, cooldownMs: 50 }), false);
});
