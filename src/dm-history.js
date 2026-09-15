import { mkdir, readFile, writeFile } from 'node:fs/promises';

const DAY_MS = 24 * 60 * 60 * 1_000;

export class DmHistoryStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.messages = [];
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.filePath, 'utf8'));
      this.messages = Array.isArray(saved?.messages) ? saved.messages : [];
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.messages = [];
    }
  }

  async save() {
    await mkdir(new URL('.', this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ messages: this.messages }, null, 2), 'utf8');
  }

  async track(message) {
    if (!message?.id || !message?.channelId) return;
    this.messages = this.messages.filter((entry) => entry.messageId !== message.id);
    this.messages.push({ messageId: message.id, channelId: message.channelId, sentAt: Date.now() });
    await this.save();
  }

  async cleanup(client, now = Date.now()) {
    const expired = this.messages.filter((entry) => now - entry.sentAt >= DAY_MS);
    if (!expired.length) return { deleted: 0, retained: 0 };
    const retained = [];
    let deleted = 0;
    for (const entry of expired) {
      try {
        const channel = await client.channels.fetch(entry.channelId);
        const message = await channel.messages.fetch(entry.messageId);
        await message.delete();
        deleted += 1;
      } catch {
        // 既に削除済み・DMチャンネル消滅は保持する必要がない。
        deleted += 1;
      }
    }
    retained.push(...this.messages.filter((entry) => now - entry.sentAt < DAY_MS));
    this.messages = retained;
    await this.save();
    return { deleted, retained: retained.length };
  }
}
