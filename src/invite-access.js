import { mkdir, readFile, writeFile } from 'node:fs/promises';

function normalize(value) {
  return {
    enabled: false,
    inviteCode: null,
    channelId: null,
    roleId: null,
    roleCreatedAt: null,
    legacyRoleId: null,
    inviteUses: {},
    ...(value || {}),
    inviteUses: value?.inviteUses && typeof value.inviteUses === 'object' ? value.inviteUses : {},
  };
}

export class InviteAccessStore {
  constructor(filePath) { this.filePath = filePath; this.guilds = {}; }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.filePath, 'utf8'));
      this.guilds = Object.fromEntries(Object.entries(saved?.guilds || {}).map(([id, value]) => [id, normalize(value)]));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.guilds = {};
    }
  }

  async save() {
    await mkdir(new URL('.', this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ guilds: this.guilds }, null, 2), 'utf8');
  }

  get(guildId) { return normalize(this.guilds[guildId]); }
  update(guildId, values) { this.guilds[guildId] = { ...this.get(guildId), ...values }; return this.get(guildId); }
}
