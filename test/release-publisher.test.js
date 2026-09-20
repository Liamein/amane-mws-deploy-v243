import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReleasePublisher } from '../src/release-publisher.js';

test('the same release is sent once across publisher instances', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amane-release-'));
  const stateFile = new URL(`file:///${join(directory, 'release-state.json').replace(/\\/g, '/')}`);
  let sends = 0;
  const release = { id: 'test-release', version: '9.9.9', title: 'test', description: 'test', target: 'test', verification: 'test' };
  assert.equal((await createReleasePublisher({ stateFile, send: async () => ({ id: String(++sends) }) }).publish(release)).published, true);
  assert.equal((await createReleasePublisher({ stateFile, send: async () => ({ id: String(++sends) }) }).publish(release)).published, false);
  assert.equal(sends, 1);
});
