import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelType, PermissionsBitField } from 'discord.js';
import { GENERATED_ROLE_TTL_MS, GuestAccess, GuestAccessStore } from '../src/guest-access.js';

function fixture({ saved = {}, roles = [] } = {}) {
  const roleMap = new Map(roles.map((role) => [role.id, role]));
  const voice = {
    id: 'voice', name: '雑談', type: ChannelType.GuildVoice, isThread: () => false,
    permissionOverwrites: { cache: new Map(), edit: async () => {} },
  };
  let creates = 0;
  const guild = {
    id: '1414606962846601302',
    roles: {
      fetch: async (id) => id ? roleMap.get(id) ?? null : roleMap,
      create: async (values) => {
        creates++;
        const role = { id: `created-${creates}`, name: values.name, editable: true, createdTimestamp: Date.now(),
          permissions: new PermissionsBitField(0n), setPermissions: async () => {}, delete: async () => {} };
        roleMap.set(role.id, role);
        return role;
      },
    },
    channels: { fetch: async (id) => id ? voice : new Map([[voice.id, voice]]) },
  };
  const store = new GuestAccessStore();
  store.data.roles = structuredClone(saved);
  store.save = async () => {};
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  return { access: new GuestAccess(client, { store }), guild, roleMap, store, creates: () => creates };
}

function role(id, createdTimestamp) {
  const deleted = [];
  return { id, name: 'ゲストVC｜雑談', editable: true, createdTimestamp,
    permissions: new PermissionsBitField(0n), setPermissions: async () => {},
    delete: async (reason) => { deleted.push(reason); }, deleted };
}

test('startup sweep removes expired saved roles and untracked duplicate roles', async () => {
  const now = Date.now();
  const expired = role('expired', now - GENERATED_ROLE_TTL_MS - 1);
  const duplicate = role('duplicate', now);
  const f = fixture({ saved: { voice: { id: expired.id, createdAt: expired.createdTimestamp } }, roles: [expired, duplicate] });
  await f.access.sweep();
  assert.equal(expired.deleted.length, 1);
  assert.equal(duplicate.deleted.length, 1);
  assert.deepEqual(f.store.data.roles, {});
});

test('concurrent guest role requests create one role and persist its creation time', async () => {
  const f = fixture();
  const [first, second] = await Promise.all([
    f.access.ensureRole(f.guild, 'voice'),
    f.access.ensureRole(f.guild, 'voice'),
  ]);
  assert.equal(f.creates(), 1);
  assert.equal(first.id, second.id);
  assert.equal(f.store.data.roles.voice.id, first.id);
  assert.ok(Number.isFinite(f.store.data.roles.voice.createdAt));
});
