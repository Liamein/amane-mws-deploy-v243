import { mkdir, readFile, writeFile } from 'node:fs/promises';

const DEFAULTS = Object.freeze({
  panelChannelId: null,
  panelMessageId: null,
  categoryChannelIds: {},
  customForumChannelIds: [],
  avatars: [],
  assets: [],
});

function uniqueChannelIds(value) {
  return [...new Set((Array.isArray(value) ? value : []).filter((id) => typeof id === 'string' && id.length > 0))];
}

function withDefaults(value = {}) {
  return {
    ...DEFAULTS,
    ...value,
    categoryChannelIds: { ...DEFAULTS.categoryChannelIds, ...(value.categoryChannelIds || {}) },
    customForumChannelIds: uniqueChannelIds(value.customForumChannelIds),
    avatars: Array.isArray(value.avatars) ? value.avatars : [],
    assets: Array.isArray(value.assets) ? value.assets : [],
  };
}

export class AssetStorageStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.guilds = new Map();
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.filePath, 'utf8'));
      this.guilds = new Map(Object.entries(saved?.guilds || {}).map(([guildId, value]) => [guildId, withDefaults(value)]));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.guilds = new Map();
    }
  }

  async save() {
    await mkdir(new URL('.', this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ guilds: Object.fromEntries(this.guilds) }, null, 2), 'utf8');
  }

  get(guildId) { return withDefaults(this.guilds.get(guildId)); }

  configure(guildId, patch) {
    const updated = withDefaults({ ...this.get(guildId), ...patch });
    this.guilds.set(guildId, updated);
    return updated;
  }

  addAsset(guildId, asset) {
    const settings = this.get(guildId);
    settings.assets.push(asset);
    this.guilds.set(guildId, settings);
    return asset;
  }

  getAsset(guildId, assetId) {
    return this.get(guildId).assets.find((asset) => asset.id === assetId) || null;
  }

  getAssetByThread(guildId, threadId) {
    return this.get(guildId).assets.find((asset) => asset.threadId === threadId) || null;
  }
}
