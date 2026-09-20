import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, EmbedBuilder, Events, PermissionFlagsBits } from 'discord.js';
import { createSingleFlight } from './single-flight.js';
import { hasCurrentInvitePanel } from './invite-panel-state.js';

export const INVITE_PANEL_GUILD_ID = '1414606962846601302';
export const INVITE_PANEL_CHANNEL_ID = '1518034512574025839';
export const INVITE_OWNER_ID = '1030896490379476992';
export const VANITY_CODE = 'ama-ama';
export const VANITY_URL = `https://discord.gg/${VANITY_CODE}`;
const LEGACY_GUEST_TTL = 24 * 60 * 60_000;
const PREFIX = 'invite-tools:';
const INVITE = PermissionFlagsBits.CreateInstantInvite;

export class InviteUserError extends Error {}

export function mayCreateInvite(userId, botId) {
  return Boolean(userId && (userId === INVITE_OWNER_ID || userId === botId));
}

export function withoutInvitePermission(permissions) { return BigInt(permissions) & ~INVITE; }

export function buildInvitePanel({ guestEnabled = false } = {}) {
  return { embeds: [new EmbedBuilder().setColor(0x8b78ee).setTitle('🔗 サーバー参加・一時ゲスト')
    .setDescription('通常参加と、一時的なVCゲストを分けて案内します。目的に合う方を選んでください。')
    .addFields(
      { name: guestEnabled ? '🎟️ ゲスト用｜VC限定・認証不要' : '🎟️ ゲスト用｜VC限定（準備中）', value: guestEnabled
        ? '参加先VCを選ぶだけで発行できます。ユーザーIDの入力は不要です。\nリンクは**発行した本人にだけ表示**され、**1時間・1回限り**有効です。受け取った人が利用できるため、共有先にはご注意ください。参加後は認証不要で、指定VCとそのチャット以外は閲覧できません。VC退出の30秒後に自動退出します。'
        : '安全なVC限定ゲスト機能を準備中です。通常の一時参加リンクで代用することはありません。' },
      { name: '🌐 通常参加｜カスタムURL', value: `誰でも利用できる通常の参加リンクです。参加後は通常のサーバー認証が必要です。\n${VANITY_URL}` },
      { name: '📌 違い', value: '通常参加はサーバー全体を利用する方向けです。\nVC限定ゲストは一時利用向けで、指定VC以外にはアクセスできません。' },
    ).setFooter({ text: '通常参加URLは公開リンクです。ゲストリンクは発行者だけに表示されますが、転送先でも使用できます。' })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}guest`).setLabel(guestEnabled ? 'VC限定ゲストを発行' : 'VC限定ゲスト：準備中').setEmoji('🎟️').setStyle(guestEnabled ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(!guestEnabled),
      new ButtonBuilder().setLabel('通常参加URLを開く').setEmoji('🌐').setStyle(ButtonStyle.Link).setURL(VANITY_URL),
    )], allowedMentions: { parse: [] } };
}

export class InvitePanelStore {
  constructor(file = new URL('../data/invite-panel.json', import.meta.url)) {
    this.file = file;
    this.data = { panelMessageId: null, guests: {}, permissionBackup: null };
    this.writing = Promise.resolve();
  }
  async load() {
    try { this.data = { ...this.data, ...JSON.parse(await readFile(this.file, 'utf8')) }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  save() {
    const snapshot = JSON.stringify(this.data, null, 2);
    this.writing = this.writing.catch(() => {}).then(async () => {
      await mkdir(new URL('.', this.file), { recursive: true });
      const temporary = new URL(`${this.file.href}.tmp`);
      await writeFile(temporary, snapshot, 'utf8');
      await rename(temporary, this.file);
    });
    return this.writing;
  }
  prune(now = Date.now()) {
    delete this.data.requests;
    this.data.guests = Object.fromEntries(Object.entries(this.data.guests || {}).filter(([, g]) => g.createdAt + LEGACY_GUEST_TTL > now));
  }
}

export class InvitePanel {
  constructor(client, { store = new InvitePanelStore(), reportError = async () => {}, guestAccess = null } = {}) {
    this.client = client;
    this.store = store;
    this.reportError = reportError;
    this.guestAccess = guestAccess;
    this.locks = new Set();
    this.ready = false;
    this.enforcing = null;
    this.startFlight = createSingleFlight();
    this.publishFlight = createSingleFlight();
    this.eventsRegistered = false;
  }
  matches(interaction) { return interaction.customId?.startsWith(PREFIX); }
  async exclusive(key, operation) {
    if (this.locks.has(key)) throw new InviteUserError('処理中です。少し待ってからもう一度お試しください。');
    this.locks.add(key);
    try { return await operation(); } finally { this.locks.delete(key); }
  }
  async requireViewer(userId) {
    const guild = this.client.guilds.cache.get(INVITE_PANEL_GUILD_ID);
    if (!guild) throw new InviteUserError('対象サーバーが利用できません。');
    const [channel, member] = await Promise.all([
      guild.channels.fetch(INVITE_PANEL_CHANNEL_ID, { force: true }),
      guild.members.fetch({ user: userId, force: true }).catch(error => {
        if (error.code === 10007) return null;
        throw error;
      }),
    ]);
    if (!member || !channel?.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)) {
      throw new InviteUserError('招待パネルのチャンネルを閲覧できる方だけが利用できます。');
    }
    return { guild, channel, member };
  }
  isCurrentPanel(message) {
    return hasCurrentInvitePanel(message, { botUserId: this.client.user?.id, guestEnabled: Boolean(this.guestAccess?.ready) });
  }
  async publish() {
    return this.publishFlight(() => this.publishOnce());
  }
  async publishOnce() {
    const channel = await this.client.channels.fetch(INVITE_PANEL_CHANNEL_ID);
    if (channel?.guildId !== INVITE_PANEL_GUILD_ID || !channel.isSendable()) throw new Error('招待パネルの投稿先が不正です。');
    let message;
    if (this.store.data.panelMessageId) {
      try { message = await channel.messages.fetch(this.store.data.panelMessageId); }
      catch (error) { if (error.code !== 10008) throw error; }
    }
    if (message && message.author.id !== this.client.user.id) throw new Error('招待パネルの作成者がBotではありません。');
    // 保存直前の停止でも、既存のBotパネルを見つけて重複投稿を避ける。
    if (!message) message = (await channel.messages.fetch({ limit: 50 })).find(m => m.author.id === this.client.user.id
      && m.components.some(row => row.components?.some(c => c.customId === `${PREFIX}guest`)));
    const panel = buildInvitePanel({ guestEnabled: Boolean(this.guestAccess?.ready) });
    if (message && this.isCurrentPanel(message)) {
      if (this.store.data.panelMessageId !== message.id) {
        this.store.data.panelMessageId = message.id;
        await this.store.save();
      }
      return { message, repaired: false };
    }
    if (message) await message.edit(panel);
    else message = await channel.send(panel);
    this.store.data.panelMessageId = message.id;
    await this.store.save();
    return { message, repaired: true };
  }
  async start() {
    return this.startFlight(() => this.startOnce());
  }
  async startOnce() {
    await this.store.load();
    this.store.prune();
    this.ready = true;
    const panel = await this.publish();
    // 権限制御はパネルの表示と独立させる。大量の権限確認が遅れても
    // 起動・操作・パネルの初期化を停止させない。
    void this.revokeLegacyGuestInvites().catch((error) => this.reportError('旧ゲスト招待の整理', error));
    void this.enforcePermissions().catch((error) => this.reportError('招待権限制御', error));
    return panel;
  }
  async revokeLegacyGuestInvites() {
    const legacy = Object.values(this.store.data.guests || {});
    for (const guest of legacy) {
      const code = guest?.code;
      if (!/^[A-Za-z0-9_-]{2,32}$/.test(code || '')) continue;
      try { await this.client.rest.delete(`/invites/${encodeURIComponent(code)}`, { reason: '旧式の通常ゲスト招待を無効化' }); }
      catch (error) { if (error.code !== 10006) throw error; }
    }
    if (legacy.length) { this.store.data.guests = {}; await this.store.save(); }
  }
  enforcePermissions() {
    if (this.enforcing) return this.enforcing;
    this.enforcing = this.applyPermissions().finally(() => { this.enforcing = null; });
    return this.enforcing;
  }
  async applyPermissions() {
    const guild = this.client.guilds.cache.get(INVITE_PANEL_GUILD_ID);
    if (!guild) return { skipped: true };
    const [roles, channels] = await Promise.all([guild.roles.fetch(), guild.channels.fetch()]);
    const botMember = await guild.members.fetchMe();
    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error('招待権限の制御にはBotのロール管理権限が必要です。');
    if (!this.store.data.permissionBackup) {
      this.store.data.permissionBackup = { savedAt: Date.now(),
        roles: [...roles.values()].map(r => ({ id: r.id, name: r.name, permissions: r.permissions.bitfield.toString() })),
        channels: [...channels.values()].filter(Boolean).map(c => ({ id: c.id, name: c.name,
          overwrites: [...(c.permissionOverwrites?.cache.values() || [])].map(o => ({ id: o.id, type: o.type, allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString() })) })),
      };
      await this.store.save();
    }
    const exceptions = []; let rolesChanged = 0; let overwritesChanged = 0;
    for (const role of roles.values()) {
      if (role.tags?.botId === this.client.user.id) continue;
      if (role.permissions.has(PermissionFlagsBits.Administrator, false)) exceptions.push({ id: role.id, name: role.name, reason: 'Administratorは招待拒否を迂回します' });
      if (!role.permissions.has(INVITE, false)) continue;
      if (!role.editable) { exceptions.push({ id: role.id, name: role.name, reason: 'ロールを編集できません' }); continue; }
      await role.setPermissions(withoutInvitePermission(role.permissions.bitfield), '招待作成は所有者とあまねBotに限定');
      rolesChanged++;
    }
    for (const channel of channels.values()) {
      if (!channel?.permissionOverwrites || channel.isThread()) continue;
      const everyone = channel.permissionOverwrites.cache.get(guild.id);
      if (!everyone?.deny.has(INVITE, false) || everyone?.allow.has(INVITE, false)) {
        await channel.permissionOverwrites.edit(guild.id, { CreateInstantInvite: false }, '一般メンバーの直接招待を禁止');
        overwritesChanged++;
      }
      for (const overwrite of [...channel.permissionOverwrites.cache.values()]) {
        if (!overwrite.allow.has(INVITE, false)) continue;
        if (overwrite.type === 1 && mayCreateInvite(overwrite.id, this.client.user.id)) continue;
        if (overwrite.type === 0 && roles.get(overwrite.id)?.tags?.botId === this.client.user.id) continue;
        await channel.permissionOverwrites.edit(overwrite.id, { CreateInstantInvite: false }, '直接招待の個別許可を解除');
        overwritesChanged++;
      }
    }
    this.store.data.lastPermissionCheck = { at: Date.now(), rolesChanged, overwritesChanged, exceptions };
    await this.store.save();
    return this.store.data.lastPermissionCheck;
  }
  registerEvents() {
    if (this.eventsRegistered) return;
    this.eventsRegistered = true;
    const schedule = value => {
      if (!this.ready || value?.guild?.id !== INVITE_PANEL_GUILD_ID) return;
      clearTimeout(this.permissionTimer);
      this.permissionTimer = setTimeout(() => this.enforcePermissions().catch(e => this.reportError('招待権限制御', e)), 2500);
      this.permissionTimer.unref();
    };
    this.client.on(Events.ChannelCreate, schedule);
    this.client.on(Events.ChannelUpdate, (_old, channel) => schedule(channel));
    this.client.on(Events.GuildRoleCreate, schedule);
    this.client.on(Events.GuildRoleUpdate, (_old, role) => schedule(role));
    this.client.on(Events.InviteCreate, invite => {
      if (!this.ready || invite.guild?.id !== INVITE_PANEL_GUILD_ID) return;
      if (!invite.inviter?.id || mayCreateInvite(invite.inviter.id, this.client.user.id)) return;
      invite.delete('所有者・あまねBot以外が発行した招待リンクの無効化').catch(e => this.reportError('未許可招待の無効化', e));
    });
  }
  async issueGuest(interaction) {
    if (!this.guestAccess?.ready) throw new InviteUserError('VC限定ゲスト機能の起動準備中です。少し待ってからお試しください。');
    await this.requireViewer(interaction.user.id);
    return interaction.editReply({ content: '🎟️ **参加先のボイスチャンネルを選択してください。**\n選んだVCとそのチャットだけを、リンクを使用した1人に許可します。リンクはあなただけに表示されます。', components: [new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder().setCustomId(`${PREFIX}guest-channel`).setPlaceholder('参加を許可するVCを選択').setChannelTypes(ChannelType.GuildVoice).setMinValues(1).setMaxValues(1),
    )] });
  }
  async selectGuestChannel(interaction) {
    if (!this.guestAccess?.ready) throw new InviteUserError('VC限定ゲスト機能の起動準備中です。');
    const { guild, member } = await this.requireViewer(interaction.user.id);
    const voice = interaction.channels.first();
    if (!voice || voice.type !== ChannelType.GuildVoice || !voice.permissionsFor(member)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])) throw new InviteUserError('自分が閲覧・接続できるVCを選択してください。');
    const session = await this.guestAccess.issue({ guild, inviter: member, voiceChannelId: voice.id });
    return interaction.editReply({ content: `✅ **VC限定ゲスト招待を発行しました。**\n参加先: <#${voice.id}>\n有効期限: <t:${Math.floor(session.inviteExpiresAt / 1000)}:R>（1回限り）\n\n🔒 この表示は発行したあなただけに見えます。ただし、リンクを受け取った人は利用できます。参加後は認証不要・指定VCとそのチャット以外は閲覧できず、VC退出から30秒後に自動退出します。\nhttps://discord.gg/${session.inviteCode}`, allowedMentions: { parse: [] }, components: [] });
  }
  async handle(interaction) {
    try {
      if (!this.ready) throw new InviteUserError('起動準備中です。少し待ってから操作してください。');
      const action = interaction.customId.slice(PREFIX.length);
      if (interaction.guildId !== INVITE_PANEL_GUILD_ID || interaction.channelId !== INVITE_PANEL_CHANNEL_ID) {
        throw new InviteUserError('指定された招待パネルのチャンネルから操作してください。');
      }
      if (action === 'guest-channel' && interaction.isChannelSelectMenu()) {
        await interaction.deferUpdate();
        return await this.selectGuestChannel(interaction);
      }
      await interaction.deferReply({ ...(interaction.inGuild() ? { ephemeral: true } : {}) });
      if (action === 'guest' && interaction.isButton()) return await this.issueGuest(interaction);
      throw new InviteUserError('この操作は利用できません。最新のパネルから操作してください。');
    } catch (error) {
      if (!(error instanceof InviteUserError)) await this.reportError('招待パネル', error).catch(() => {});
      const content = error instanceof InviteUserError ? error.message : '操作に失敗しました。Botの招待権限・送信権限を確認してください。詳細は管理ログに記録しました。';
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content }).catch(() => {});
      else await interaction.reply({ content, ...(interaction.inGuild() ? { ephemeral: true } : {}) }).catch(() => {});
    }
  }
}
