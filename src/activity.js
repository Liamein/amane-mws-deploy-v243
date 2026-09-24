import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const DAY_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_INACTIVITY_SETTINGS = Object.freeze({ kickDays: 15, warningBeforeDays: 3 });

export function isInactivityMonitoringTarget({ userId, isBot, excludedUserIds = [] }) {
  return !isBot && !excludedUserIds.includes(userId);
}

export function reachedInactivityDay(lastActiveAt, day, now = Date.now()) {
  return now - lastActiveAt >= day * DAY_MS;
}

export function inactivityWarningDay(settings) {
  return settings.kickDays - settings.warningBeforeDays;
}

export function isInactivityKickDue(activity, settings = DEFAULT_INACTIVITY_SETTINGS, now = Date.now()) {
  return Boolean(activity
    && reachedInactivityDay(activity.lastActiveAt, settings.kickDays, now)
    && Number.isFinite(activity.warningSentAt)
    && reachedInactivityDay(activity.warningSentAt, settings.warningBeforeDays, now));
}

export class ActivityStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.activities = {};
    this.kicked = {};
    this.panelMessages = {};
    this.settings = {};
    this.saveInFlight = null;
    this.saveRequested = false;
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.filePath, 'utf8'));
      this.activities = {};
      this.kicked = {};
      this.panelMessages = {};
      this.settings = {};
      const activitySource = saved?.activities && typeof saved.activities === 'object' ? saved.activities : saved;
      if (activitySource && typeof activitySource === 'object' && !Array.isArray(activitySource)) {
        for (const [guildId, members] of Object.entries(activitySource)) {
          if (!members || typeof members !== 'object' || Array.isArray(members)) continue;
          for (const [userId, activity] of Object.entries(members)) {
            const lastActiveAt = Number(activity?.lastActiveAt);
            if (!Number.isFinite(lastActiveAt)) continue;
            if (!this.activities[guildId]) this.activities[guildId] = {};
            this.activities[guildId][userId] = {
              lastActiveAt,
              notifiedDays: Array.isArray(activity?.notifiedDays)
                ? [...new Set(activity.notifiedDays.filter(Number.isFinite))].sort((left, right) => left - right)
                : [],
              warningSentAt: Number.isFinite(activity?.warningSentAt) ? activity.warningSentAt : null,
            };
          }
        }
      }
      if (saved?.kicked && typeof saved.kicked === 'object') {
        for (const [guildId, users] of Object.entries(saved.kicked)) {
          if (!users || typeof users !== 'object' || Array.isArray(users)) continue;
          this.kicked[guildId] = Object.fromEntries(Object.entries(users).filter(([, entry]) => Number.isFinite(entry?.kickedAt)));
        }
      }
      if (saved?.panelMessages && typeof saved.panelMessages === 'object') {
        this.panelMessages = Object.fromEntries(Object.entries(saved.panelMessages)
          .map(([guildId, ids]) => [guildId, Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []]));
      }
      if (saved?.settings && typeof saved.settings === 'object') {
        for (const [guildId, settings] of Object.entries(saved.settings)) {
          const kickDays = Number(settings?.kickDays);
          const warningBeforeDays = Number(settings?.warningBeforeDays);
          if (Number.isInteger(kickDays) && kickDays >= 2 && kickDays <= 365
            && Number.isInteger(warningBeforeDays) && warningBeforeDays >= 1 && warningBeforeDays < kickDays) {
            this.settings[guildId] = { kickDays, warningBeforeDays };
          }
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.activities = {};
    }
  }

  save() {
    this.saveRequested = true;
    if (this.saveInFlight) return this.saveInFlight;
    const persist = async () => {
      do {
        this.saveRequested = false;
        const snapshot = JSON.stringify({ activities: this.activities, kicked: this.kicked, panelMessages: this.panelMessages, settings: this.settings }, null, 2);
        const directory = this.filePath instanceof URL ? new URL('.', this.filePath) : dirname(this.filePath);
        await mkdir(directory, { recursive: true });
        await writeFile(this.filePath, snapshot, 'utf8');
      } while (this.saveRequested);
    };
    this.saveInFlight = persist().finally(() => {
      this.saveInFlight = null;
      if (this.saveRequested) return this.save();
    });
    return this.saveInFlight;
  }

  get(guildId, userId) {
    return this.activities[guildId]?.[userId] || null;
  }

  entries(guildId) {
    return Object.entries(this.activities[guildId] || {}).map(([userId, activity]) => ({ userId, ...activity }));
  }

  ensure(guildId, userId, at = Date.now()) {
    if (!this.activities[guildId]) this.activities[guildId] = {};
    if (!this.activities[guildId][userId]) {
      this.activities[guildId][userId] = { lastActiveAt: at, notifiedDays: [], warningSentAt: null };
      return true;
    }
    return false;
  }

  touch(guildId, userId, at = Date.now()) {
    this.ensure(guildId, userId, at);
    this.activities[guildId][userId] = { lastActiveAt: at, notifiedDays: [], warningSentAt: null };
  }

  markNotified(guildId, userId, day, at = Date.now()) {
    const activity = this.get(guildId, userId);
    if (!activity || activity.notifiedDays.includes(day)) return false;
    activity.notifiedDays.push(day);
    activity.notifiedDays.sort((left, right) => left - right);
    activity.warningSentAt = at;
    return true;
  }

  remove(guildId, userId) {
    if (!this.activities[guildId]?.[userId]) return false;
    delete this.activities[guildId][userId];
    return true;
  }

  kickedEntries(guildId) {
    return Object.entries(this.kicked[guildId] || {}).map(([userId, entry]) => ({ userId, ...entry }));
  }

  recordKick(guildId, userId, entry) {
    if (!this.kicked[guildId]) this.kicked[guildId] = {};
    this.kicked[guildId][userId] = { ...entry };
  }

  restoreKickedUser(guildId, userId) {
    if (!this.kicked[guildId]?.[userId]) return false;
    delete this.kicked[guildId][userId];
    return true;
  }

  getPanelMessageIds(guildId) {
    return [...(this.panelMessages[guildId] || [])];
  }

  setPanelMessageIds(guildId, messageIds) {
    this.panelMessages[guildId] = [...new Set(messageIds.filter((id) => typeof id === 'string'))];
  }

  getSettings(guildId) {
    return { ...DEFAULT_INACTIVITY_SETTINGS, ...(this.settings[guildId] || {}) };
  }

  setSettings(guildId, settings) {
    this.settings[guildId] = { ...settings };
    for (const activity of Object.values(this.activities[guildId] || {})) {
      activity.notifiedDays = [];
      activity.warningSentAt = null;
    }
  }
}
