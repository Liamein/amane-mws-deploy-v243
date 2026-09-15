export const VOICE_MUTE_LIMIT_MS = 30 * 60 * 1_000;

export function isMutedInVoice({ channelId, selfMute = false, serverMute = false }) {
  return Boolean(channelId && (selfMute || serverMute));
}

export class VoiceMuteGuard {
  constructor(limitMs = VOICE_MUTE_LIMIT_MS) {
    this.limitMs = limitMs;
    this.mutedSince = new Map();
  }

  key(guildId, userId) {
    return `${guildId}:${userId}`;
  }

  observe(state, now = Date.now()) {
    const key = this.key(state.guildId, state.userId);
    if (!isMutedInVoice(state)) {
      this.mutedSince.delete(key);
      return null;
    }
    if (!this.mutedSince.has(key)) this.mutedSince.set(key, now);
    return this.mutedSince.get(key);
  }

  clear(guildId, userId) {
    return this.mutedSince.delete(this.key(guildId, userId));
  }

  due(now = Date.now()) {
    return [...this.mutedSince.entries()]
      .filter(([, since]) => now - since >= this.limitMs)
      .map(([key, since]) => {
        const [guildId, userId] = key.split(':');
        return { guildId, userId, since };
      });
  }
}
