import { mkdir, readFile, writeFile } from 'node:fs/promises';

const DEFAULTS = Object.freeze({ auditLogChannelId: null, memberLogChannelId: null, lastPanelRepairAt: null, lastPanelRepairSummary: null });

function normalizeSettings(value) {
  return Object.fromEntries(Object.keys(DEFAULTS).map((key) => [key, value?.[key] ?? DEFAULTS[key]]));
}

export class ServerSettingsStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.guilds = {};
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.filePath, 'utf8'));
      this.guilds = saved?.guilds && typeof saved.guilds === 'object'
        ? Object.fromEntries(Object.entries(saved.guilds).map(([guildId, value]) => [guildId, normalizeSettings(value)]))
        : {};
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.guilds = {};
    }
  }

  async save() {
    await mkdir(new URL('.', this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ guilds: this.guilds }, null, 2), 'utf8');
  }

  get(guildId) { return normalizeSettings(this.guilds[guildId]); }
  setMemberLogChannel(guildId, channelId) { this.guilds[guildId] = { ...this.get(guildId), memberLogChannelId: channelId }; }
  setAuditLogChannel(guildId, channelId) { this.guilds[guildId] = { ...this.get(guildId), auditLogChannelId: channelId }; }
  markPanelRepair(guildId, { timestamp = Date.now(), summary = null } = {}) { this.guilds[guildId] = { ...this.get(guildId), lastPanelRepairAt: timestamp, lastPanelRepairSummary: summary }; }
}
