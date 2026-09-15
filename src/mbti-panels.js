import { mkdir, readFile, writeFile } from 'node:fs/promises';

const DEFAULTS = Object.freeze({
  channelId: null,
  messageId: null,
  title: '✨ MBTI タイプチェック',
  description: '20問の質問に5段階で答えると、あなたの回答傾向に合ったMBTIタイプとサーバー内ロールを受け取れます。',
});

export class MbtiPanelStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.guilds = {};
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.filePath, 'utf8'));
      this.guilds = saved?.guilds && typeof saved.guilds === 'object' ? saved.guilds : {};
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.guilds = {};
    }
  }

  async save() {
    await mkdir(new URL('.', this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ guilds: this.guilds }, null, 2), 'utf8');
  }

  get(guildId) { return { ...DEFAULTS, ...(this.guilds[guildId] || {}) }; }
  setPanel(guildId, channelId, messageId) { this.guilds[guildId] = { ...this.get(guildId), channelId, messageId }; }
  updateText(guildId, patch) { this.guilds[guildId] = { ...this.get(guildId), ...patch }; }
}
