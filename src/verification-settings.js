import { mkdir, readFile, writeFile } from 'node:fs/promises';

export const DEFAULT_VERIFICATION_DM_MESSAGE = 'ようこそ、{server}へ。\nサーバーのチャンネルを閲覧するには認証が必要です。下のボタンから計算式の答えを選ぶと「{role}」ロールが付与されます。';

function normalize(value) {
  if (!value?.roleId) return null;
  return {
    roleId: value.roleId,
    dmEnabled: value.dmEnabled !== false,
    dmMessage: typeof value.dmMessage === 'string' && value.dmMessage.trim() ? value.dmMessage.trim() : DEFAULT_VERIFICATION_DM_MESSAGE,
    panelChannelId: typeof value.panelChannelId === 'string' ? value.panelChannelId : null,
    panelMessageId: typeof value.panelMessageId === 'string' ? value.panelMessageId : null,
  };
}

export class VerificationSettingsStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.settings = new Map();
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.filePath, 'utf8'));
      this.settings = new Map(Object.entries(saved?.guilds || {}).map(([guildId, value]) => [guildId, normalize(value)]).filter(([, value]) => value));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.settings = new Map();
    }
  }

  async save() {
    await mkdir(new URL('.', this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ guilds: Object.fromEntries(this.settings) }, null, 2), 'utf8');
  }

  get(guildId) { return this.settings.get(guildId) || null; }

  set(guildId, roleId, options = {}) {
    const current = this.get(guildId);
    this.settings.set(guildId, {
      roleId,
      dmEnabled: options.dmEnabled ?? current?.dmEnabled ?? true,
      dmMessage: options.dmMessage ?? current?.dmMessage ?? DEFAULT_VERIFICATION_DM_MESSAGE,
      panelChannelId: options.panelChannelId ?? current?.panelChannelId ?? null,
      panelMessageId: options.panelMessageId ?? current?.panelMessageId ?? null,
    });
  }

  updateDm(guildId, options = {}) {
    const current = this.get(guildId);
    if (!current) return null;
    this.settings.set(guildId, {
      ...current,
      dmEnabled: options.dmEnabled ?? current.dmEnabled,
      dmMessage: options.dmMessage ?? current.dmMessage,
    });
    return this.get(guildId);
  }
}
