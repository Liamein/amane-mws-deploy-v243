import { mkdir, readFile, writeFile } from 'node:fs/promises';

// The server owner explicitly chose one account for irreversible Bot controls.
export const PRIMARY_BOT_OWNER_ID = '1030896490379476992';
export function isPrimaryBotOwner(userId) { return userId === PRIMARY_BOT_OWNER_ID; }

export class CommandAccessStore {
  constructor(filePath, ownerUserIds) {
    this.filePath = filePath;
    this.ownerUserIds = new Set(ownerUserIds);
    this.userIds = new Set(ownerUserIds);
    this.licenses = new Map();
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.filePath, 'utf8'));
      const legacyIds = Array.isArray(saved?.userIds) ? saved.userIds.filter((id) => /^\d{17,20}$/.test(id)) : [];
      const savedLicenses = saved?.licenses && typeof saved.licenses === 'object' ? saved.licenses : {};
      this.licenses = new Map();
      for (const userId of legacyIds) this.licenses.set(userId, { expiresAt: null, planId: 'legacy', grantedAt: null });
      for (const [userId, license] of Object.entries(savedLicenses)) {
        if (!/^\d{17,20}$/.test(userId)) continue;
        const expiresAt = Number(license?.expiresAt);
        this.licenses.set(userId, {
          expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : null,
          planId: typeof license?.planId === 'string' ? license.planId : 'manual',
          grantedAt: Number.isFinite(Number(license?.grantedAt)) ? Number(license.grantedAt) : null,
        });
      }
      this.userIds = new Set(this.licenses.keys());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.userIds = new Set();
    }
    for (const ownerId of this.ownerUserIds) {
      this.userIds.add(ownerId);
      this.licenses.set(ownerId, { expiresAt: null, planId: 'owner', grantedAt: null });
    }
  }

  async save() {
    await mkdir(new URL('.', this.filePath), { recursive: true });
    const licenses = Object.fromEntries([...this.licenses.entries()].sort(([left], [right]) => left.localeCompare(right)));
    await writeFile(this.filePath, JSON.stringify({ userIds: [...this.userIds].sort(), licenses }, null, 2), 'utf8');
  }

  isOwner(userId) { return this.ownerUserIds.has(userId); }
  isRegistered(userId, now = Date.now()) {
    if (!this.userIds.has(userId)) return false;
    const license = this.licenses.get(userId);
    return !license?.expiresAt || license.expiresAt > now;
  }
  getLicense(userId) { return this.licenses.get(userId) || null; }
  register(userId, license = {}) {
    if (this.userIds.has(userId)) return false;
    this.userIds.add(userId);
    this.licenses.set(userId, {
      expiresAt: Number.isFinite(Number(license.expiresAt)) && Number(license.expiresAt) > 0 ? Number(license.expiresAt) : null,
      planId: typeof license.planId === 'string' ? license.planId : 'manual',
      grantedAt: Number.isFinite(Number(license.grantedAt)) ? Number(license.grantedAt) : Date.now(),
    });
    return true;
  }
  grantLicense(userId, { planId = 'manual', durationMs = null, now = Date.now() } = {}) {
    if (this.ownerUserIds.has(userId)) return { changed: false, license: this.getLicense(userId) };
    const current = this.licenses.get(userId);
    const expiresAt = durationMs === null ? null : Math.max(now, current?.expiresAt || 0) + durationMs;
    const license = { expiresAt, planId, grantedAt: now };
    this.userIds.add(userId);
    this.licenses.set(userId, license);
    return { changed: true, license };
  }
  expireDue(now = Date.now()) {
    const expired = [];
    for (const [userId, license] of this.licenses) {
      if (this.ownerUserIds.has(userId) || !license?.expiresAt || license.expiresAt > now) continue;
      this.userIds.delete(userId);
      this.licenses.delete(userId);
      expired.push({ userId, ...license });
    }
    return expired;
  }
  unregister(userId) {
    if (this.ownerUserIds.has(userId) || !this.userIds.has(userId)) return false;
    this.userIds.delete(userId);
    this.licenses.delete(userId);
    return true;
  }
  list() { return [...this.userIds].sort(); }
  listDetails(now = Date.now()) {
    return this.list().map((userId) => ({ userId, ...(this.getLicense(userId) || { expiresAt: null, planId: 'manual', grantedAt: null }), active: this.isRegistered(userId, now), owner: this.isOwner(userId) }));
  }
}
