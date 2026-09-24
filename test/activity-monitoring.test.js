import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ActivityStore, inactivityWarningDay, isInactivityKickDue, isInactivityMonitoringTarget } from '../src/activity.js';

test('monitors every human except the explicitly excluded manager', () => {
  const excludedUserIds = ['manager'];
  assert.equal(isInactivityMonitoringTarget({ userId: 'manager', isBot: false, excludedUserIds }), false);
  assert.equal(isInactivityMonitoringTarget({ userId: 'bot', isBot: true, excludedUserIds }), false);
  assert.equal(isInactivityMonitoringTarget({ userId: 'owner', isBot: false, excludedUserIds }), true);
  assert.equal(isInactivityMonitoringTarget({ userId: 'member', isBot: false, excludedUserIds }), true);
});

test('uses the configured kick and warning periods', () => {
  const settings = { kickDays: 30, warningBeforeDays: 5 };
  assert.equal(inactivityWarningDay(settings), 25);
  const now = 40 * 86_400_000;
  const activity = { lastActiveAt: 10 * 86_400_000, warningSentAt: 35 * 86_400_000 };
  assert.equal(isInactivityKickDue(activity, settings, now), true);
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
    store.setSettings('guild', { kickDays: 30, warningBeforeDays: 5 });
    await store.save();

    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.kicked.guild.user.dmSent, true);
    assert.deepEqual(saved.panelMessages.guild, ['message']);
    assert.deepEqual(saved.settings.guild, { kickDays: 30, warningBeforeDays: 5 });
    assert.equal(store.restoreKickedUser('guild', 'user'), true);
    store.touch('guild', 'user', 300);
    assert.equal(store.get('guild', 'user').lastActiveAt, 300);
    assert.deepEqual(store.kickedEntries('guild'), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
