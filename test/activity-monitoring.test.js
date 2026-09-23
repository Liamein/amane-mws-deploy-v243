import assert from 'node:assert/strict';
import test from 'node:test';
import { isInactivityMonitoringTarget } from '../src/activity.js';

test('monitors every member except the guild owner and bots', () => {
  assert.equal(isInactivityMonitoringTarget({ userId: 'owner', ownerId: 'owner', isBot: false }), false);
  assert.equal(isInactivityMonitoringTarget({ userId: 'bot', ownerId: 'owner', isBot: true }), false);
  assert.equal(isInactivityMonitoringTarget({ userId: 'admin', ownerId: 'owner', isBot: false }), true);
  assert.equal(isInactivityMonitoringTarget({ userId: 'member', ownerId: 'owner', isBot: false }), true);
});
