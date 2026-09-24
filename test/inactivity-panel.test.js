import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInactivityPanelPayloads, formatRemainingHours } from '../src/inactivity-panel.js';

test('rounds remaining time up to whole hours for the minute-updated panel', () => {
  assert.equal(formatRemainingHours(0), '0時間');
  assert.equal(formatRemainingHours(1), '1時間');
  assert.equal(formatRemainingHours(3_600_000), '1時間');
  assert.equal(formatRemainingHours(3_600_001), '2時間');
});

test('panel separates monitored and kicked members and reports DM outcome truthfully', () => {
  const now = Date.UTC(2026, 8, 24);
  const payloads = buildInactivityPanelPayloads({
    guild: { name: 'AmA', iconURL: () => null },
    now,
    settings: { kickDays: 20, warningBeforeDays: 6 },
    activities: [{ userId: '123', lastActiveAt: now - 14 * 86_400_000 }],
    kicked: [
      { userId: '456', displayName: 'sent', kickedAt: now - 1_000, dmSent: true },
      { userId: '789', displayName: 'closed', kickedAt: now - 2_000, dmSent: false },
    ],
  });
  const json = payloads.flatMap((payload) => payload.embeds.map((embed) => embed.toJSON()));
  const rendered = json.map((embed) => `${embed.title || ''}\n${embed.description || ''}`).join('\n');
  assert.match(rendered, /最終活動 <t:\d+:f>/);
  assert.match(rendered, /期限間近・あと144時間/);
  assert.doesNotMatch(rendered, /最終活動.*前/);
  assert.match(rendered, /退出日時 <t:\d+:f>/);
  assert.match(rendered, /Kick済み.*DM送信済み/s);
  assert.match(rendered, /Kick済み.*DM送信不可/s);
  assert.equal(payloads[0].allowedMentions.parse.length, 0);
  assert.equal(payloads[0].components[0].components[0].data.custom_id, 'inactivity:configure:kick');
  assert.equal(payloads[0].components[0].components[1].data.custom_id, 'inactivity:configure:warning');
});
