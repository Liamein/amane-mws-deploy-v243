import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { ChannelType, Events, PermissionFlagsBits as P, Routes } from 'discord.js';

export const GUEST_GUILD_ID = '1414606962846601302';
export const GUEST_OWNER_ID = '1030896490379476992';
export const GUEST_INVITE_AGE = 3600;
export const GUEST_VOICE_WAIT_MS = 15 * 60_000;
export const GUEST_LEAVE_GRACE_MS = 30_000;
export const GENERATED_ROLE_TTL_MS = 6 * 60 * 60_000;
export const GUEST_ROLE_PREFIX = 'ゲストVC｜';
export class GuestAccessError extends Error {}

export function roleEntry(value) {
  return typeof value === 'string' ? { id: value, createdAt: null } : { id: value?.id ?? null, createdAt: Number(value?.createdAt) || null };
}

export function roleCreatedAt(role, fallback = null) {
  return Number(role?.createdTimestamp) || Number(fallback) || 0;
}

// temporary:true on a normal server invite does NOT set Discord's IS_GUEST flag.
export function isNativeGuest(member) {
  const flags = member?.flags?.bitfield ?? member?.flags ?? 0;
  return typeof flags === 'bigint' ? (flags & 16n) === 16n : (Number(flags) & 16) === 16;
}

export function guestPermissions(target = false) {
  return { ViewChannel: target, Connect: target, Speak: target, Stream: target, UseVAD: target,
    SendMessages: target, ReadMessageHistory: target, AttachFiles: target, EmbedLinks: target, AddReactions: target,
    CreateInstantInvite: false, UseApplicationCommands: false, CreatePublicThreads: false,
    CreatePrivateThreads: false, SendMessagesInThreads: false, MentionEveryone: false };
}
const MANAGED_BITS = Object.keys(guestPermissions()).reduce((bits, key) => bits | P[key], 0n);
function matchesOverwrite(overwrite, patch) {
  return Boolean(overwrite && Object.entries(patch).every(([key, yes]) =>
    (yes ? overwrite.allow.has(P[key], false) && !overwrite.deny.has(P[key], false)
      : overwrite.deny.has(P[key], false) && !overwrite.allow.has(P[key], false))));
}
export function ownsGuestMembership(session, member) {
  return Boolean(session?.status === 'active' && member?.id === session.userId
    && member.guild?.id === GUEST_GUILD_ID && member.id !== GUEST_OWNER_ID && !member.user?.bot
    && member.joinedTimestamp === session.joinedAt);
}
export function guestExitReason(session, voiceChannelId, now = Date.now()) {
  if (session.status !== 'active' || voiceChannelId === session.voiceChannelId) return null;
  if (session.disconnectedAt && now - session.disconnectedAt >= GUEST_LEAVE_GRACE_MS) return 'VC退出によるゲスト参加終了';
  if (!session.connectedAt && now >= session.joinedAt + GUEST_VOICE_WAIT_MS) return 'VC未接続のまま15分経過';
  return null;
}

export class GuestAccessStore {
  constructor(file = new URL('../data/guest-access.json', import.meta.url)) {
    this.file = file; this.data = { roles: {}, sessions: {}, pendingInvites: {} }; this.writing = Promise.resolve();
  }
  async load() {
    try { this.data = { ...this.data, ...JSON.parse(await readFile(this.file, 'utf8')) }; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    this.data.pendingInvites ||= {};
  }
  save() {
    const snapshot = JSON.stringify(this.data, null, 2);
    this.writing = this.writing.catch(() => {}).then(async () => {
      await mkdir(new URL('.', this.file), { recursive: true });
      const temporary = new URL(`${this.file.href}.tmp`);
      await writeFile(temporary, snapshot); await rename(temporary, this.file);
    }); return this.writing;
  }
}

export class GuestAccess {
  constructor(client, { store = new GuestAccessStore(), reportError = async () => {}, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    this.client = client; this.store = store; this.reportError = reportError; this.delay = delay;
    this.jobs = new Map(); this.ready = false;
  }
  serial(key, fn) {
    const previous = this.jobs.get(key) || Promise.resolve();
    const job = previous.catch(() => {}).then(fn); this.jobs.set(key, job);
    return job.finally(() => { if (this.jobs.get(key) === job) this.jobs.delete(key); });
  }
  isGuest(member) {
    if (isNativeGuest(member)) return true;
    if (member?.guild?.id !== GUEST_GUILD_ID || member.id === GUEST_OWNER_ID || member.user?.bot) return false;
    const session = this.store.data.sessions[member.id];
    return ownsGuestMembership(session, member) || Boolean(session?.status === 'pending'
      && member.joinedTimestamp >= session.createdAt && member.joinedTimestamp <= session.inviteExpiresAt)
      || Object.values(this.store.data.pendingInvites).some(p => p.status === 'pending'
        && member.joinedTimestamp >= p.createdAt && member.joinedTimestamp <= p.inviteExpiresAt
        && member.roles?.cache.has(p.roleId));
  }
  async start() {
    await this.store.load(); this.ready = true;
    // Revoke any pre-change, user-targeted invites. They must not remain
    // usable after switching to issuer-only one-use links.
    let migrated = false;
    for (const [key, session] of Object.entries(this.store.data.sessions)) {
      if (!session?.userId || !['pending', 'preparing'].includes(session.status)) continue;
      await this.revokeInvite(session);
      session.status = 'closed';
      session.closedAt = Date.now();
      session.closeReason = 'ユーザーID指定方式からの移行';
      delete this.store.data.sessions[key];
      migrated = true;
    }
    if (migrated) await this.store.save();
    await this.sweep();
    this.timer = setInterval(() => this.sweep().catch(e => this.reportError('ゲスト参加の終了確認', e)), 15_000);
    this.timer.unref();
  }
  async freshMember(guild, id) {
    try { return await guild.members.fetch({ user: id, force: true }); }
    catch (e) { if (e.code === 10007) return null; throw e; }
  }
  async ensureRole(guild, voiceChannelId) {
    return this.serial('permissions', async () => {
      let role = null;
      const savedRole = roleEntry(this.store.data.roles[voiceChannelId]);
      if (savedRole.id) {
        role = await guild.roles.fetch(savedRole.id).catch(error => {
          if (error.code === 10011) return null;
          throw error;
        });
      }
      const voice = await guild.channels.fetch(voiceChannelId);
      if (voice?.type !== ChannelType.GuildVoice) throw new GuestAccessError('参加先のVCが見つかりません。');
      if (role && Date.now() - roleCreatedAt(role, savedRole.createdAt) >= GENERATED_ROLE_TTL_MS) {
        if (!role.editable) throw new GuestAccessError('6時間を経過したゲスト用ロールを削除できません。Botのロール位置を確認してください。');
        await role.delete('生成から6時間が経過したゲスト用ロールを更新');
        delete this.store.data.roles[voiceChannelId];
        await this.store.save();
        role = null;
      }
      if (!role) {
        role = await guild.roles.create({ name: `${GUEST_ROLE_PREFIX}${voice.name}`.slice(0, 100), permissions: 0n, mentionable: false, reason: 'VC限定・認証不要のゲスト用（6時間で自動削除）' });
        this.store.data.roles[voiceChannelId] = { id: role.id, createdAt: roleCreatedAt(role, Date.now()) }; await this.store.save();
      } else if (typeof this.store.data.roles[voiceChannelId] === 'string') {
        this.store.data.roles[voiceChannelId] = { id: role.id, createdAt: roleCreatedAt(role, Date.now()) }; await this.store.save();
      }
      if (role.permissions.bitfield !== 0n) await role.setPermissions(0n, 'ゲストはチャンネル個別許可のみ使用');
      for (const channel of (await guild.channels.fetch()).values()) {
        if (!channel?.permissionOverwrites || channel.isThread()) continue;
        const patch = guestPermissions(channel.id === voiceChannelId);
        if (!matchesOverwrite(channel.permissionOverwrites.cache.get(role.id), patch)) {
          await channel.permissionOverwrites.edit(role.id, patch, 'ゲストは指定VCとそのチャットのみ許可');
        }
      }
      return role;
    });
  }
  async issue({ guild, inviter, voiceChannelId }) {
    if (!this.ready) throw new GuestAccessError('ゲスト機能の起動準備中です。');
    if (guild.id !== GUEST_GUILD_ID) throw new GuestAccessError('対象サーバーが違います。');
    return this.serial(`voice:${voiceChannelId}`, async () => {
      const voice = await guild.channels.fetch(voiceChannelId);
      if (voice?.type !== ChannelType.GuildVoice || !voice.permissionsFor(inviter)?.has([P.ViewChannel, P.Connect])) throw new GuestAccessError('自分が閲覧・接続できるVCを選択してください。');
      const bot = await guild.members.fetchMe();
      if (!bot.permissions.has([P.ManageRoles, P.ManageGuild, P.KickMembers])) throw new GuestAccessError('ゲストの制限・自動退出に必要なBot権限が不足しています。');
      const role = await this.ensureRole(guild, voiceChannelId);
      const session = { id: randomUUID(), inviterId: inviter.id, voiceChannelId, roleId: role.id,
        createdAt: Date.now(), inviteExpiresAt: Date.now() + GUEST_INVITE_AGE * 1000, status: 'preparing', overwrites: {} };
      let invite;
      try {
        invite = await this.client.rest.post(Routes.channelInvites(voiceChannelId), {
          body: { max_age: GUEST_INVITE_AGE, max_uses: 1, temporary: false, unique: true, role_ids: [role.id] },
          reason: `VC限定ゲスト招待（依頼 ${inviter.id}）`,
        });
        if (!invite.code || invite.channel?.id !== voiceChannelId || !invite.roles?.some(r => r.id === role.id)) {
          throw new GuestAccessError('ゲスト用ロールの自動付与を確認できず、招待を取り消しました。');
        }
        session.inviteCode = invite.code; session.status = 'pending';
        this.store.data.pendingInvites[invite.code] = session; await this.store.save();
        return session;
      } catch (e) {
        if (invite?.code) await this.revokeInvite({ inviteCode: invite.code });
        if (invite?.code) delete this.store.data.pendingInvites[invite.code];
        await this.store.save(); throw e;
      }
    });
  }
  async revokeInvite(session) {
    if (!session.inviteCode) return;
    try { await this.client.rest.delete(Routes.invite(session.inviteCode), { reason: 'ゲスト招待の終了・取り消し' }); }
    catch (e) { if (e.code !== 10006) throw e; }
  }
  async restrictMember(member, session) {
    if (!ownsGuestMembership(session, member)) throw new GuestAccessError('ゲスト参加の在籍情報が変わったため操作を中止しました。');
    // Other role allows beat a role deny. Member-specific denies prevent those
    // roles (including another bot's auto-role) from opening unrelated channels.
    for (const channel of (await member.guild.channels.fetch()).values()) {
      if (!channel?.permissionOverwrites || channel.isThread()) continue;
      const current = channel.permissionOverwrites.cache.get(member.id);
      if (!Object.hasOwn(session.overwrites, channel.id)) {
        session.overwrites[channel.id] = current ? { allow: current.allow.bitfield.toString(), deny: current.deny.bitfield.toString() } : null;
        await this.store.save();
      }
      const patch = guestPermissions(channel.id === session.voiceChannelId);
      if (!matchesOverwrite(current, patch)) await channel.permissionOverwrites.edit(member.id, patch, 'ゲスト本人は指定VC以外を閲覧不可');
    }
    const removable = member.roles.cache.filter(r => r.id !== member.guild.id && r.id !== session.roleId && !r.managed);
    if (removable.size) await member.roles.remove([...removable.keys()], 'ゲストには通常認証・管理ロールを付与しない');
    const fresh = await this.freshMember(member.guild, member.id);
    if (!fresh || !ownsGuestMembership(session, fresh)) throw new GuestAccessError('ゲストの在籍が変わりました。');
    if (fresh.permissions.has(P.Administrator)) throw new GuestAccessError('ゲストに管理者権限があるため安全に制限できません。');
    if (!fresh.roles.cache.has(session.roleId)) await fresh.roles.add(session.roleId, 'VC限定ゲスト');
    const flags = fresh.flags?.bitfield ?? 0;
    if (fresh.pending && !(Number(flags) & 4)) await fresh.edit({ flags: Number(flags) | 4, reason: 'ゲストはVC限定・通常入室認証を省略' });
  }
  async handleJoin(member) {
    if (isNativeGuest(member)) return true;
    if (member.guild.id !== GUEST_GUILD_ID || member.user.bot || member.id === GUEST_OWNER_ID) return false;
    return this.serial(`user:${member.id}`, async () => {
      let session = this.store.data.sessions[member.id];
      if (session?.status === 'active' && !ownsGuestMembership(session, member)) {
        await this.endSession(member.guild, session, '前回のゲスト参加は終了しました');
      }
      if (session && !['pending', 'active'].includes(session.status)) {
        if (Object.keys(session.overwrites || {}).length) await this.cleanupOverwrites(member.guild, session);
        delete this.store.data.sessions[member.id]; await this.store.save(); session = null;
      }
      let newlyClaimed = false;
      if (!session && Object.keys(this.store.data.pendingInvites).length) {
        // Community invites grant the selected role on acceptance. The gateway
        // member payload can arrive before the role is visible to a REST fetch.
        for (let attempt = 0; attempt < 4; attempt++) {
          const candidate = Object.values(this.store.data.pendingInvites).find(p => p.status === 'pending'
            && p.createdAt <= member.joinedTimestamp && member.joinedTimestamp <= p.inviteExpiresAt
            && member.roles.cache.has(p.roleId));
          if (candidate) {
            session = await this.serial('claim', async () => {
              if (this.store.data.sessions[member.id] || this.store.data.pendingInvites[candidate.inviteCode] !== candidate) return this.store.data.sessions[member.id];
              candidate.userId = member.id; candidate.joinedAt = member.joinedTimestamp; candidate.status = 'active';
              delete this.store.data.pendingInvites[candidate.inviteCode];
              this.store.data.sessions[member.id] = candidate; await this.store.save();
              return candidate;
            });
            if (session) {
              newlyClaimed = Boolean(session.status === 'active' && session.userId === member.id);
              break;
            }
            continue;
          }
          if (attempt < 3) { await this.delay(300); member = await this.freshMember(member.guild, member.id) || member; }
        }
      }
      if (!session || !['pending', 'active'].includes(session.status)) return false;
      if (ownsGuestMembership(session, member)) {
        if (newlyClaimed) {
          try { await this.restrictMember(member, session); }
          catch (e) {
            await this.reportError('ゲストの閲覧制限', e);
            await this.endSession(member.guild, session, '閲覧範囲を安全に制限できないためゲスト参加を終了');
          }
        }
        return true;
      }
      if (session.status !== 'pending' || member.joinedTimestamp < session.createdAt || member.joinedTimestamp > session.inviteExpiresAt) return false;
      session.joinedAt = member.joinedTimestamp; session.status = 'active';
      if (member.voice?.channelId === session.voiceChannelId) session.connectedAt = Date.now();
      await this.store.save();
      try { await this.restrictMember(member, session); }
      catch (e) {
        await this.reportError('ゲストの閲覧制限', e);
        await this.endSession(member.guild, session, '閲覧範囲を安全に制限できないためゲスト参加を終了');
      }
      return true;
    });
  }
  async cleanupOverwrites(guild, session) {
    for (const [channelId, original] of Object.entries(session.overwrites || {})) {
      const channel = await guild.channels.fetch(channelId).catch(e => { if (e.code === 10003) return null; throw e; });
      const current = channel?.permissionOverwrites?.cache.get(session.userId);
      if (current) {
        const allow = (current.allow.bitfield & ~MANAGED_BITS) | (BigInt(original?.allow || 0) & MANAGED_BITS);
        const deny = (current.deny.bitfield & ~MANAGED_BITS) | (BigInt(original?.deny || 0) & MANAGED_BITS);
        if (!allow && !deny && !original) await channel.permissionOverwrites.delete(session.userId, '終了したゲスト本人の制限を整理');
        else await this.client.rest.put(Routes.channelPermission(channel.id, session.userId), { body: {
          id: session.userId, type: 1, allow: allow.toString(), deny: deny.toString(),
        }, reason: 'ゲスト参加前の個別権限に復元' });
      }
      delete session.overwrites[channelId]; await this.store.save();
    }
  }
  async endSession(guild, session, reason) {
    const member = await this.freshMember(guild, session.userId);
    if (member) {
      if (ownsGuestMembership(session, member)) await member.kick(reason);
      // A rejoined or otherwise changed member must never be kicked based on
      // an old guest session. We still revoke the old invite and restore ACLs.
    }
    session.status = 'closed'; session.closedAt = Date.now(); session.closeReason = reason;
    await this.store.save(); await this.revokeInvite(session); await this.cleanupOverwrites(guild, session);
  }
  async handleRemove(member) {
    if (member.guild?.id !== GUEST_GUILD_ID) return false;
    const session = this.store.data.sessions[member.id];
    if (!session || !['pending', 'active'].includes(session.status)) return false;
    return this.serial(`user:${member.id}`, async () => {
      await this.endSession(member.guild, session, 'ゲストがサーバーを退出');
      return true;
    });
  }
  async sweep() {
    return this.serial('sweep', async () => {
      const guild = this.client.guilds.cache.get(GUEST_GUILD_ID); if (!guild) return;
      await this.serial('permissions', async () => {
        const now = Date.now();
        const roles = await guild.roles.fetch();
        const savedIds = new Set(Object.values(this.store.data.roles).map(roleEntry).map(entry => entry.id).filter(Boolean));
        let rolesChanged = false;
        for (const role of roles.values()) {
          if (!role.name?.startsWith(GUEST_ROLE_PREFIX)) continue;
          const saved = Object.values(this.store.data.roles).map(roleEntry).find(entry => entry.id === role.id);
          const isUntrackedDuplicate = !savedIds.has(role.id);
          const isExpired = now - roleCreatedAt(role, saved?.createdAt) >= GENERATED_ROLE_TTL_MS;
          if (!isUntrackedDuplicate && !isExpired) continue;
          if (!role.editable) {
            await this.reportError('ゲスト用ロールの自動削除', new Error(`ロールを削除できません: ${role.name} (${role.id})`));
            continue;
          }
          await role.delete(isUntrackedDuplicate ? '保存情報から外れた重複ゲスト用ロールを自動削除' : '生成から6時間が経過したゲスト用ロールを自動削除');
          for (const [voiceId, value] of Object.entries(this.store.data.roles)) {
            if (roleEntry(value).id === role.id) { delete this.store.data.roles[voiceId]; rolesChanged = true; }
          }
        }
        for (const [voiceId, value] of Object.entries(this.store.data.roles)) {
          if (!roles.has(roleEntry(value).id)) { delete this.store.data.roles[voiceId]; rolesChanged = true; }
        }
        if (rolesChanged) await this.store.save();
      });
      for (const [code, session] of Object.entries(this.store.data.pendingInvites)) {
        if (Date.now() <= session.inviteExpiresAt) continue;
        await this.revokeInvite(session);
        delete this.store.data.pendingInvites[code]; await this.store.save();
      }
      for (const session of Object.values(this.store.data.sessions)) {
        if (session.status === 'pending') {
          const member = await this.freshMember(guild, session.userId);
          if (member) { await this.handleJoin(member); continue; }
          if (Date.now() > session.inviteExpiresAt) { await this.revokeInvite(session); session.status = 'expired'; await this.store.save(); }
        } else if (session.status === 'active') {
          await this.serial(`user:${session.userId}`, async () => {
            const member = await this.freshMember(guild, session.userId);
            if (!member) return this.endSession(guild, session, 'ゲストがサーバーを退出');
            if (!ownsGuestMembership(session, member)) return;
            if (member.voice.channelId === session.voiceChannelId) {
              session.connectedAt ||= Date.now(); session.disconnectedAt = null;
            } else if (session.connectedAt) session.disconnectedAt ||= Date.now();
            await this.store.save();
            const reason = guestExitReason(session, member.voice.channelId);
            if (reason) await this.endSession(guild, session, reason);
          });
        } else if (session.status === 'closed' && Object.keys(session.overwrites || {}).length) await this.cleanupOverwrites(guild, session);
      }
    });
  }
  registerEvents() {
    this.client.on(Events.VoiceStateUpdate, (_old, state) => {
      if (!this.ready || state.guild.id !== GUEST_GUILD_ID) return;
      const session = this.store.data.sessions[state.id];
      if (!ownsGuestMembership(session, state.member)) return;
      this.serial(`user:${state.id}`, async () => {
        if (state.channelId === session.voiceChannelId) { session.connectedAt ||= Date.now(); session.disconnectedAt = null; }
        else if (session.connectedAt) session.disconnectedAt ||= Date.now();
        await this.store.save();
      }).catch(e => this.reportError('ゲストVC状態', e));
    });
    this.client.on(Events.GuildMemberUpdate, (old, member) => {
      const session = this.store.data.sessions[member.id];
      if (!this.ready || !ownsGuestMembership(session, member) || old.roles.cache.equals(member.roles.cache)) return;
      this.serial(`user:${member.id}`, () => this.restrictMember(member, session)).catch(e => this.reportError('ゲストロールの維持', e));
    });
    const updateChannels = channel => {
      if (!this.ready || channel.guild?.id !== GUEST_GUILD_ID) return;
      clearTimeout(this.channelTimer);
      this.channelTimer = setTimeout(async () => {
        try {
          for (const voiceId of Object.keys(this.store.data.roles)) await this.ensureRole(channel.guild, voiceId);
          for (const session of Object.values(this.store.data.sessions).filter(s => s.status === 'active')) {
            const member = await this.freshMember(channel.guild, session.userId);
            if (ownsGuestMembership(session, member)) await this.serial(`user:${member.id}`, () => this.restrictMember(member, session));
          }
        } catch (e) { await this.reportError('ゲストの新規チャンネル制限', e); }
      }, 3000); this.channelTimer.unref();
    };
    this.client.on(Events.ChannelCreate, updateChannels);
    this.client.on(Events.ChannelUpdate, (_old, channel) => updateChannels(channel));
  }
}
