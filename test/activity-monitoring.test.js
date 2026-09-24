import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ActivityStore, isInactivityMonitoringTarget } from '../src/activity.js';

test('monitors every member except the guild owner and bots', () => {
  assert.equal(isInactivityMonitoringTarget({ userId: 'owner', ownerId: 'owner', isBot: false }), false);
  assert.equal(isInactivityMonitoringTarget({ userId: 'bot', ownerId: 'owner', isBot: true }), false);
  assert.equal(isInactivityMonitoringTarget({ userId: 'admin', ownerId: 'owner', isBot: false }), true);
  assert.equal(isInactivityMonitoringTarget({ userId: 'member', ownerId: 'owner', isBot: false }), true);
});

test('migrates legacy activity data and persists kick, panel, and rejoin state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amane-activity-'));
  const file = join(directory, 'activity.json');
  try {
    await writeFile(file, JSON.stringify({ guild: { user: { lastActiveAt: 100, notifiedDays: [] } } }));
    const store = new ActivityStore(file);
    await store.load();
    assert.equal(store.get('guild', 'user').lastActiveAt, 100);
    store.remove('guild', 'user');
    store.recordKick('guild', 'user', { kickedAt: 200, dmSent: true });
    store.setPanelMessageIds('guild', ['message']);
    await store.save();

    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.kicked.guild.user.dmSent, true);
    assert.deepEqual(saved.panelMessages.guild, ['message']);
    assert.equal(store.restoreKickedUser('guild', 'user'), true);
    store.touch('guild', 'user', 300);
    assert.equal(store.get('guild', 'user').lastActiveAt, 300);
    assert.deepEqual(store.kickedEntries('guild'), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
