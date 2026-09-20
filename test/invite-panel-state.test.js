import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCurrentInvitePanel } from '../src/invite-panel-state.js';

const currentMessage = {
  author: { id: 'bot' },
  embeds: [{ title: '🔗 サーバー参加・一時ゲスト' }],
  components: [{ components: [{ customId: 'invite-tools:guest', disabled: false }] }],
};

test('a normal invite panel is retained without edit or recreation', () => {
  assert.equal(hasCurrentInvitePanel(currentMessage, { botUserId: 'bot', guestEnabled: true }), true);
  assert.equal(hasCurrentInvitePanel(currentMessage, { botUserId: 'bot', guestEnabled: false }), false);
});
