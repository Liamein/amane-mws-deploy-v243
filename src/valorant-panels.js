import { mkdir, readFile, writeFile } from 'node:fs/promises';

const DEFAULT_COPY = Object.freeze({
  crosshairTitle: '🎯 VALORANT クロスヘア',
  crosshairDescription: '気になるクロスヘアを選択すると、ゲーム内に貼り付けられるコードを表示します。',
  trackerTitle: '📊 VALORANT 戦績・ライブマッチ',
  trackerDescription: 'Riot連携済みのプレイヤーは、ここから戦績・試合履歴・ライブマッチを確認できます。',
  crosshairPanelChannelId: null,
  crosshairPanelMessageId: null,
  trackerPanelChannelId: null,
  trackerPanelMessageId: null,
  crosshairCatalogChannelId: null,
  crosshairCatalogIntroMessageId: null,
  crosshairCatalogMessages: {},
  crosshairCatalogPreviewed: {},
});

function normalizedText(value) { return typeof value === 'string' ? value.trim() : ''; }

function withCrosshairDefaults(crosshair) {
  return {
    id: crosshair.id,
    name: normalizedText(crosshair.name),
    code: normalizedText(crosshair.code),
    author: normalizedText(crosshair.author) || 'AmA Community',
    color: normalizedText(crosshair.color) || '指定なし',
    category: normalizedText(crosshair.category) || '汎用',
    description: normalizedText(crosshair.description) || 'ゲーム内のクロスヘア設定でコードをインポートしてください。',
    imageUrl: normalizedText(crosshair.imageUrl) || null,
    sourceUrl: normalizedText(crosshair.sourceUrl) || null,
    rank: Number(crosshair.rank) || null,
    createdAt: Number(crosshair.createdAt) || Date.now(),
    updatedAt: Number(crosshair.updatedAt) || Date.now(),
  };
}

export function agentIconUrl(agentName) {
  const ids = {
    brimstone: '9f0d8ba9-4140-b941-57d3-a7ad57c6b417',
    viper: '707eab51-4836-f488-046a-cda6bf494859',
    omen: '8e253930-4c05-31dd-1b6c-968525494517',
    cypher: '117ed9e3-49f3-6512-3ccf-0cada7e3823b',
    sova: '320b2a48-4d9b-a075-30f1-1f93a9b638fa',
    sage: '569fdd95-4d10-43ab-ca70-79becc718b46',
    jett: 'add6443a-41bd-e414-f6ad-e58d267f4e95',
    reyna: 'a3bfb853-43b2-7238-a4f1-ad90e9e46bcc',
    raze: 'f94c3b30-42be-e959-889c-5aa313dba261',
    killjoy: '1e88f9d0-4c77-0d4d-1c9c-8e42ccf1c64e',
    skye: '6f2a04ca-43e0-be17-7f36-b3908627744d',
    yoru: '7f94d92c-4234-0b7b-1b0f-11c8f9e7d1b2',
    astra: '41fb69c1-4189-7b37-f117-bcaf1e96f1bf',
    kayo: '601dbbe7-43ce-be57-2a40-4abd24953621',
    chamber: '22697a3d-45bf-8dd7-4e2c-3ba11fb6535e',
    neon: 'bb2a4828-46eb-8cd1-e765-15848195d751',
    fade: 'dade69b4-4f5a-8528-247b-219e5a1facd6',
    harbor: '95b78ed7-4637-86d9-7e41-71ba8c293152',
    gekko: 'e370fa57-4757-3604-3648-499e1f642d3f',
    deadlock: 'cc8b64c8-4b25-4ff9-6e7f-37b4da43d235',
    iso: '0e38b510-28a8-4f6c-92d3-7c8dc7c8b096',
    clove: '1dbf2edd-4729-0984-3115-daa5eed44993',
    vyse: 'efba5359-4016-a1e5-7626-b1ae76895940',
    tejo: 'b444168c-4e35-8076-db47-ef9bf58e3135',
    waylay: '1c5b9f0e-4cc5-3b1b-1e9b-329c5e2c4992',
  };
  const key = normalizedText(agentName).toLowerCase();
  const id = ids[key];
  return id ? `https://media.valorant-api.com/agents/${id}/displayicon.png` : null;
}

export function formatRiotId(value) {
  const riotId = normalizedText(value).replaceAll('＃', '#');
  if (!/^[^#\s]{3,16}#[^#\s]{3,8}$/u.test(riotId)) throw new Error('Riot IDは「ゲーム名#タグ」の形式で入力してください。');
  return riotId;
}

export class ValorantPanelStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.crosshairs = new Map();
    this.guilds = {};
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.filePath, 'utf8'));
      this.crosshairs = new Map(Array.isArray(saved?.crosshairs) ? saved.crosshairs.map((crosshair) => [crosshair.id, withCrosshairDefaults(crosshair)]) : []);
      this.guilds = saved?.guilds && typeof saved.guilds === 'object' ? saved.guilds : {};
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.crosshairs = new Map();
      this.guilds = {};
    }
  }

  async save() {
    await mkdir(new URL('.', this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ crosshairs: [...this.crosshairs.values()], guilds: this.guilds }, null, 2), 'utf8');
  }

  getGuild(guildId) { return { ...DEFAULT_COPY, ...(this.guilds[guildId] || {}) }; }

  updateGuild(guildId, patch) {
    this.guilds[guildId] = { ...this.getGuild(guildId), ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined && value !== null)) };
    return this.getGuild(guildId);
  }

  setCatalogMessage(guildId, crosshairId, messageId, previewed = true) {
    const settings = this.getGuild(guildId);
    this.guilds[guildId] = {
      ...settings,
      crosshairCatalogMessages: { ...settings.crosshairCatalogMessages, [crosshairId]: messageId },
      crosshairCatalogPreviewed: previewed ? { ...settings.crosshairCatalogPreviewed, [crosshairId]: true } : settings.crosshairCatalogPreviewed,
    };
  }

  setCatalogChannel(guildId, channelId, introMessageId = null) {
    this.updateGuild(guildId, { crosshairCatalogChannelId: channelId, ...(introMessageId ? { crosshairCatalogIntroMessageId: introMessageId } : {}) });
  }

  clearCatalog(guildId) {
    const settings = this.getGuild(guildId);
    this.guilds[guildId] = {
      ...settings,
      crosshairCatalogChannelId: null,
      crosshairCatalogIntroMessageId: null,
      crosshairCatalogMessages: {},
      crosshairCatalogPreviewed: {},
    };
  }

  resetCatalogPreviews(guildId) {
    const settings = this.getGuild(guildId);
    this.guilds[guildId] = { ...settings, crosshairCatalogPreviewed: {} };
  }

  listCrosshairs() { return [...this.crosshairs.values()].sort((left, right) => left.name.localeCompare(right.name, 'ja')); }
  getCrosshair(id) { return this.crosshairs.get(id) || null; }

  createCrosshair({ name, code, author, color, category, description, imageUrl }) {
    if (!normalizedText(name)) throw new Error('クロスヘア名を入力してください。');
    if (!normalizedText(code)) throw new Error('クロスヘアコードを入力してください。');
    const crosshair = withCrosshairDefaults({ id: crypto.randomUUID().slice(0, 12), name, code, author, color, category, description, imageUrl, createdAt: Date.now(), updatedAt: Date.now() });
    this.crosshairs.set(crosshair.id, crosshair);
    return crosshair;
  }

  replaceCrosshairs(entries) {
    this.crosshairs = new Map(entries.map((entry) => {
      const crosshair = withCrosshairDefaults({
        id: `vt-${entry.id}`,
        name: entry.name,
        code: entry.code,
        description: entry.description,
        sourceUrl: entry.url,
        rank: entry.rank,
        author: 'valoranttracker.com',
        category: '公開クロスヘア',
      });
      return [crosshair.id, crosshair];
    }));
  }

  updateCrosshair(id, patch) {
    const existing = this.getCrosshair(id);
    if (!existing) return null;
    const updated = withCrosshairDefaults({ ...existing, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined && value !== null)), updatedAt: Date.now() });
    this.crosshairs.set(id, updated);
    return updated;
  }

  removeCrosshair(id) { return this.crosshairs.delete(id); }
}
