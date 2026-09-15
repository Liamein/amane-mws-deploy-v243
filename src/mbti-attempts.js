import { mkdir, readFile, writeFile } from 'node:fs/promises';

export const MBTI_DAILY_LIMIT = 2;

export function tokyoDay(timestamp = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(timestamp);
  const value = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export class MbtiAttemptStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.users = {};
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.filePath, 'utf8'));
      this.users = saved?.users && typeof saved.users === 'object' ? saved.users : {};
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.users = {};
    }
  }

  async save() {
    await mkdir(new URL('.', this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ users: this.users }, null, 2), 'utf8');
  }

  count(userId, timestamp = Date.now()) {
    const day = tokyoDay(timestamp);
    return (this.users[userId] || []).filter((entry) => tokyoDay(entry) === day).length;
  }

  canStart(userId, timestamp = Date.now()) { return this.count(userId, timestamp) < MBTI_DAILY_LIMIT; }

  record(userId, timestamp = Date.now()) {
    const cutoff = timestamp - 48 * 60 * 60 * 1_000;
    const retained = (this.users[userId] || []).filter((entry) => entry >= cutoff);
    this.users[userId] = [...retained, timestamp];
  }
}
