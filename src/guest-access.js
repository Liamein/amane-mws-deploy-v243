import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { ChannelType, Events, PermissionFlagsBits as P, Routes } from 'discord.js';

export const GUEST_GUILD_ID = '1414606962846601302';
export const GUEST_OWNER_ID = '1030896490379476992';
export const GUEST_INVITE_AGE = 3600;
export const GUEST_VOICE_WAIT_MS = 15 * 60_000;
export const GUEST_LEAVE_GRACE_MS = 30_000;
export class GuestAccessError extends Error {}

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
export function parseTargetUsers(csv) {
  const rows = String(csv).replace(/^\uFEFF/, '').trim().split(/\r?\n/).map(x => x.trim().replace(/^"|"$/g, ''));
  if (rows.shift() !== 'user_id' || rows.some(x => !/^\d{17,20}$/.test(x))) return [];
  return rows;
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
    this.file = file; this.data = { roles: {}, sessions: {} }; this.writing = Promise.resolve();
  }
  async load() {
    try { this.data = { ...this.data, ...JSON.parse(await readFile(this.file, 'utf8')) }; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
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
      || Object.values(this.store.data.roles).some(id => member.roles?.cache.has(id));
  }
  async start() {
    await this.store.load(); this.ready = true;
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
      if (this.store.data.roles[voiceChannelId]) {
        role = await guild.roles.fetch(this.store.data.roles[voiceChannelId]).catch(error => {
          if (error.code === 10011) return null;
          throw error;
        });
      }
      const voice = await guild.channels.fetch(voiceChannelId);
      if (voice?.type !== ChannelType.GuildVoice) throw new GuestAccessError('参加先のVCが見つかりません。');
      if (!role) {
        role = await guild.roles.create({ name: `ゲストVC｜${voice.name}`.slice(0, 100), permissions: 0n, mentionable: false, reason: 'VC限定・認証不要のゲスト用' });
        this.store.data.roles[voiceChannelId] = role.id; await this.store.save();
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
  async verifyTargetFile(code, userId) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const csv = await this.client.rest.get(`/invites/${encodeURIComponent(code)}/target-users`);
        const text = Buffer.isBuffer(csv) ? csv.toString('utf8')
          : csv instanceof ArrayBuffer ? Buffer.from(csv).toString('utf8') : typeof csv === 'string' ? csv : '';
        const ids = parseTargetUsers(text);
        if (ids.length !== 1 || ids[0] !== userId) throw new GuestAccessError('招待相手の限定を確認できなかったため、リンクを発行しません。');
        return;
      } catch (e) {
        if (e.code !== 40115 || attempt === 9) throw e;
        await this.delay(Math.min(1000 + attempt * 500, 3000));
      }
    }
  }
  async issue({ guild, inviter, voiceChannelId, userId }) {
    if (!this.ready) throw new GuestAccessError('ゲスト機能の起動準備中です。');
    if (guild.id !== GUEST_GUILD_ID || !/^\d{17,20}$/.test(userId)) throw new GuestAccessError('招待相手のDiscordユーザーIDを正しく入力してください。');
    return this.serial(`user:${userId}`, async () => {
      if (userId === GUEST_OWNER_ID || await this.freshMember(guild, userId)) throw new GuestAccessError('既存メンバーはゲストに変更できません。未参加の相手のIDを指定してください。');
      const user = await this.client.users.fetch(userId);
      if (user.bot) throw new GuestAccessError('Botアカウントはゲスト対象にできません。');
      const voice = await guild.channels.fetch(voiceChannelId);
      if (voice?.type !== ChannelType.GuildVoice || !voice.permissionsFor(inviter)?.has([P.ViewChannel, P.Connect])) throw new GuestAccessError('自分が閲覧・接続できるVCを選択してください。');
      const bot = await guild.members.fetchMe();
      if (!bot.permissions.has([P.ManageRoles, P.ManageGuild, P.KickMembers])) throw new GuestAccessError('ゲストの制限・自動退出に必要なBot権限が不足しています。');
      const old = this.store.data.sessions[userId];
      if (old && ['pending', 'active', 'preparing'].includes(old.status) && old.inviteExpiresAt > Date.now()) throw new GuestAccessError('この相手には発行済みのゲスト招待があります。');
      if (old && Object.keys(old.overwrites || {}).length) await this.cleanupOverwrites(guild, old);
      const role = await this.ensureRole(guild, voiceChannelId);
      if (await this.freshMember(guild, userId)) throw new GuestAccessError('相手がすでに参加したため、ゲスト招待を取り消しました。');
      const session = { id: randomUUID(), userId, inviterId: inviter.id, voiceChannelId, roleId: role.id,
        createdAt: Date.now(), inviteExpiresAt: Date.now() + GUEST_INVITE_AGE * 1000, status: 'preparing', overwrites: {} };
      this.store.data.sessions[userId] = session; await this.store.save();
      let invite;
      try {
        invite = await this.client.rest.post(Routes.channelInvites(voiceChannelId), {
          body: { max_age: GUEST_INVITE_AGE, max_uses: 1, temporary: false, unique: true, role_ids: [role.id] },
          files: [{ name: 'guest.csv', key: 'target_users_file', data: Buffer.from(`user_id\n${userId}\n`), contentType: 'text/csv' }],
          reason: `VC限定ゲスト招待（対象 ${userId}／依頼 ${inviter.id}）`,
        });
        session.inviteCode = invite.code; await this.store.save();
        if (!invite.code || invite.channel?.id !== voiceChannelId || !invite.roles?.some(r => r.id === role.id)) {
          throw new GuestAccessError('ゲスト用ロールの自動付与を確認できず、招待を取り消しました。');
        }
        await this.verifyTargetFile(invite.code, userId);
        session.status = 'pending'; await this.store.save();
        return session;
      } catch (e) {
        if (invite?.code) await this.revokeInvite(session);
        session.status = 'failed'; await this.store.save(); throw e;
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
      const session = this.store.data.sessions[member.id];
      if (!session || !['pending', 'active'].includes(session.status)) return false;
      if (ownsGuestMembership(session, member)) return true;
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
