import { mkdir, readFile, writeFile } from 'node:fs/promises';

export class InstallConsentStore {
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

  get(guildId) { return this.guilds[guildId] || null; }
  recordPanel(guildId, detail) { this.guilds[guildId] = { ...(this.get(guildId) || {}), ...detail }; }
  accept(guildId, userId) { this.guilds[guildId] = { ...(this.get(guildId) || {}), acceptedByUserId: userId, acceptedAt: Date.now() }; }
}
