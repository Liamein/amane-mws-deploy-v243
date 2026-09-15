import { mkdir, readFile, writeFile } from 'node:fs/promises';

export class DmSupportStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.conversations = {};
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.filePath, 'utf8'));
      this.conversations = saved?.conversations && typeof saved.conversations === 'object' ? saved.conversations : {};
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.conversations = {};
    }
  }

  async save() {
    await mkdir(new URL('.', this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ conversations: this.conversations }, null, 2), 'utf8');
  }

  isClosed(userId) { return Boolean(this.conversations[userId]?.closedAt); }
  close(userId, closedByUserId) { this.conversations[userId] = { ...(this.conversations[userId] || {}), closedAt: Date.now(), closedByUserId }; }
  reopen(userId) { this.conversations[userId] = { ...(this.conversations[userId] || {}), closedAt: null, closedByUserId: null }; }
}
