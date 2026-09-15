import { mkdir, readFile, writeFile } from 'node:fs/promises';

export const MODERATION_DEFAULTS = Object.freeze({
  logChannelId: null,
  bannedWords: [],
  offenses: {},
  spam: { maxMessages: 5, windowMs: 10_000 },
  duplicate: { maxMessages: 3, windowMs: 10 * 60_000 },
  mentions: { maxMentions: 5 },
  timeoutMs: 10 * 60_000,
  offenseWindowMs: 90 * 24 * 60 * 60 * 1_000,
});

export function normalizedMessage(content) {
  return content.trim().replaceAll(/\s+/g, ' ').toLocaleLowerCase();
}

export function findModerationViolation({ content, mentionCount, history, config, now = Date.now() }) {
  const normalized = normalizedMessage(content);
  const bannedWord = config.bannedWords.find((word) => normalized.includes(word.toLocaleLowerCase()));
  if (bannedWord) return { type: 'NGワード', entries: [] };
  if (mentionCount >= config.mentions.maxMentions) return { type: 'メンション爆撃', entries: [] };

  const spamEntries = [...history.filter((entry) => now - entry.at <= config.spam.windowMs), { at: now }];
  if (spamEntries.length >= config.spam.maxMessages) return { type: '連投', entries: spamEntries.filter((entry) => entry.message) };

  const duplicateEntries = [...history.filter((entry) => now - entry.at <= config.duplicate.windowMs && entry.normalized === normalized), { at: now }];
  if (normalized && duplicateEntries.length >= config.duplicate.maxMessages) return { type: '同一文の連投', entries: duplicateEntries.filter((entry) => entry.message) };
  return null;
}

export class ModerationStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.guilds = {};
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.filePath, 'utf8'));
      this.guilds = saved && typeof saved === 'object' ? saved : {};
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.guilds = {};
    }
  }

  async save() {
    await mkdir(new URL('.', this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.guilds, null, 2), 'utf8');
  }

  get(guildId) {
    const saved = this.guilds[guildId] || {};
    return {
      ...MODERATION_DEFAULTS,
      ...saved,
      spam: { ...MODERATION_DEFAULTS.spam, ...saved.spam },
      duplicate: { ...MODERATION_DEFAULTS.duplicate, ...saved.duplicate },
      mentions: { ...MODERATION_DEFAULTS.mentions, ...saved.mentions },
      bannedWords: [...(saved.bannedWords || [])],
      offenses: { ...(saved.offenses || {}) },
    };
  }

  setLogChannel(guildId, channelId) {
    this.guilds[guildId] = { ...this.get(guildId), logChannelId: channelId };
  }

  updateSettings(guildId, { timeoutMs, spamMaxMessages, spamWindowMs, duplicateMaxMessages, mentionMaxMentions }) {
    const config = this.get(guildId);
    this.guilds[guildId] = {
      ...config,
      timeoutMs,
      spam: { ...config.spam, maxMessages: spamMaxMessages, windowMs: spamWindowMs },
      duplicate: { ...config.duplicate, maxMessages: duplicateMaxMessages },
      mentions: { ...config.mentions, maxMentions: mentionMaxMentions },
    };
  }

  addBannedWord(guildId, word) {
    const config = this.get(guildId);
    const normalized = word.trim();
    if (!normalized || config.bannedWords.some((item) => item.toLocaleLowerCase() === normalized.toLocaleLowerCase())) return false;
    config.bannedWords.push(normalized);
    this.guilds[guildId] = config;
    return true;
  }

  removeBannedWord(guildId, word) {
    const config = this.get(guildId);
    const index = config.bannedWords.findIndex((item) => item.toLocaleLowerCase() === word.trim().toLocaleLowerCase());
    if (index === -1) return false;
    config.bannedWords.splice(index, 1);
    this.guilds[guildId] = config;
    return true;
  }

  recordOffense(guildId, userId, now = Date.now()) {
    const config = this.get(guildId);
    const previous = (config.offenses[userId] || []).filter((at) => now - at <= config.offenseWindowMs);
    previous.push(now);
    config.offenses[userId] = previous;
    this.guilds[guildId] = config;
    return previous.length;
  }
}
