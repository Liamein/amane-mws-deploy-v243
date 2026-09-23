import { mkdir, readFile, writeFile } from 'node:fs/promises';

export const DAY_MS = 24 * 60 * 60 * 1_000;
export const INACTIVITY_KICK_DAYS = 15;
export const INACTIVITY_WARNING_DAYS = [INACTIVITY_KICK_DAYS - 3];

export function isInactivityMonitoringTarget({ userId, ownerId, isBot }) {
  return !isBot && userId !== ownerId;
}

export function reachedInactivityDay(lastActiveAt, day, now = Date.now()) {
  return now - lastActiveAt >= day * DAY_MS;
}

export function isInactivityKickDue(activity, now = Date.now()) {
  const warningGraceDays = INACTIVITY_KICK_DAYS - INACTIVITY_WARNING_DAYS.at(-1);
  return Boolean(activity
    && reachedInactivityDay(activity.lastActiveAt, INACTIVITY_KICK_DAYS, now)
    && Number.isFinite(activity.warningSentAt)
    && reachedInactivityDay(activity.warningSentAt, warningGraceDays, now));
}

export class ActivityStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.activities = {};
    this.saveInFlight = null;
    this.saveRequested = false;
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.filePath, 'utf8'));
      this.activities = {};
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        for (const [guildId, members] of Object.entries(saved)) {
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
        const snapshot = JSON.stringify(this.activities, null, 2);
        await mkdir(new URL('.', this.filePath), { recursive: true });
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
}
