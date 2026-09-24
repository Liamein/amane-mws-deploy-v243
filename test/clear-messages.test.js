import assert from 'node:assert/strict';
import test from 'node:test';
import { Collection } from 'discord.js';
import { deleteRequestedMessages } from '../src/clear-messages.js';

test('deletes the exact requested count across Discord bulk-delete age boundary', async () => {
  const now = Date.now();
  const deletedIndividually = [];
  const messages = Array.from({ length: 7 }, (_, index) => ({
    id: String(100 - index),
    createdTimestamp: index < 4 ? now - index * 1_000 : now - 20 * 24 * 60 * 60 * 1_000,
    deletable: true,
    async delete() { deletedIndividually.push(this.id); },
  }));
  const channel = {
    messages: { async fetch() { return new Collection(messages.map((message) => [message.id, message])); } },
    async bulkDelete(selected) { return new Collection(selected.map((message) => [message.id, message])); },
  };

  const result = await deleteRequestedMessages(channel, 6, { now });
  assert.deepEqual(result, { requested: 6, found: 6, deleted: 6 });
  assert.deepEqual(deletedIndividually.sort(), ['95', '96']);
});

test('reports when fewer messages exist instead of claiming the requested count', async () => {
  const now = Date.now();
  const message = { id: '1', createdTimestamp: now, deletable: true, async delete() {} };
  const channel = {
    messages: { async fetch() { return new Collection([['1', message]]); } },
    async bulkDelete() { throw new Error('single message must not use bulk delete'); },
  };
  assert.deepEqual(await deleteRequestedMessages(channel, 5, { now }), { requested: 5, found: 1, deleted: 1 });
});
