import assert from 'node:assert/strict';
import test from 'node:test';
import { globalCommands } from '../src/commands.js';

test('removes inactivity-status while retaining clear', () => {
  const names = globalCommands.map((command) => command.name);
  assert.equal(names.includes('inactivity-status'), false);
  assert.equal(names.includes('clear'), true);
});
