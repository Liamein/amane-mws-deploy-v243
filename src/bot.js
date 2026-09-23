import { ActionRowBuilder, ActivityType, AttachmentBuilder, AuditLogEvent, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, Client, EmbedBuilder, Events, GatewayIntentBits, ModalBuilder, OverwriteType, Partials, PermissionFlagsBits, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { AssetStorageStore } from './asset-storage.js';
import { readFile, writeFile } from 'node:fs/promises';
import { createMathChallenge } from './captcha.js';
import { CommandAccessStore, isPrimaryBotOwner } from './command-access.js';
import { DmSupportStore } from './dm-support.js';
import { DmHistoryStore } from './dm-history.js';
import { InstallConsentStore } from './install-consents.js';
import { InviteAccessStore } from './invite-access.js';
import { InvitePanel, VANITY_URL } from './invite-panel.js';
import { GuestAccess } from './guest-access.js';
import { ActivityStore, DAY_MS, INACTIVITY_KICK_DAYS, INACTIVITY_WARNING_DAYS, isInactivityKickDue, isInactivityMonitoringTarget, reachedInactivityDay } from './activity.js';
import { VoiceMuteGuard } from './voice-mute-guard.js';
import { loadConfig } from './config.js';
import { findModerationViolation, ModerationStore, normalizedMessage } from './moderation.js';
import { calculateMbti, MBTI_QUESTIONS, MBTI_TYPES, mbtiRoleName, mbtiType } from './mbti.js';
import { MBTI_DAILY_LIMIT, MbtiAttemptStore, tokyoDay } from './mbti-attempts.js';
import { MbtiPanelStore } from './mbti-panels.js';
import { cleanupMediaTempCache, handleMediaConverterInteraction, isMediaConverterInteraction, publishMediaConverterPanel } from './media-converter.js';
import { RecruitmentStore } from './recruitment.js';
import { PurchaseTicketStore } from './purchase-tickets.js';
import { ServerSettingsStore } from './server-settings.js';
import { retryRecoverable, shouldRecoverGateway, shouldRunMaintenance } from './self-healing.js';
import { chooseRandom, formatDuration, parseChoices } from './utils.js';
import { DEFAULT_VERIFICATION_DM_MESSAGE, VerificationSettingsStore } from './verification-settings.js';
import { shouldImmediatelyForwardForumUpload } from './forum-upload.js';
import { createErrorDeduper } from './error-deduper.js';
import { globalCommands } from './commands.js';

const config = loadConfig();
const gatewayIntents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildInvites, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent];
const discord = new Client({ intents: gatewayIntents, partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User] });
const startedAt = Date.now();
const polls = new Map();
const commandAccessStore = new CommandAccessStore(new URL('../data/command-access.json', import.meta.url), config.commandOwnerIds);
const dmSupportStore = new DmSupportStore(new URL('../data/dm-support.json', import.meta.url));
const dmHistoryStore = new DmHistoryStore(new URL('../data/dm-history.json', import.meta.url));
discord.dmHistoryStore = dmHistoryStore;
const assetStorageStore = new AssetStorageStore(new URL('../data/asset-storage.json', import.meta.url));
const installConsentStore = new InstallConsentStore(new URL('../data/install-consents.json', import.meta.url));
const inviteAccessStore = new InviteAccessStore(new URL('../data/invite-access.json', import.meta.url));
const activityStore = new ActivityStore(new URL('../data/activity.json', import.meta.url));
const moderationStore = new ModerationStore(new URL('../data/moderation.json', import.meta.url));
const recruitmentStore = new RecruitmentStore(new URL('../data/recruitment.json', import.meta.url));
const purchaseTicketStore = new PurchaseTicketStore(new URL('../data/purchase-tickets.json', import.meta.url));
const mbtiAttemptStore = new MbtiAttemptStore(new URL('../data/mbti-attempts.json', import.meta.url));
const mbtiPanelStore = new MbtiPanelStore(new URL('../data/mbti-panels.json', import.meta.url));
const verificationSettingsStore = new VerificationSettingsStore(new URL('../data/verification-settings.json', import.meta.url));
const serverSettingsStore = new ServerSettingsStore(new URL('../data/server-settings.json', import.meta.url));
const verificationChallenges = new Map();
const mbtiSessions = new Map();
const messageHistory = new Map();
const voiceMuteGuard = new VoiceMuteGuard();
const voiceMuteDisconnecting = new Set();
const inactivityKickContexts = new Set();
const forumUploadsInFlight = new Set();
let inactivityTimer;
let dmHistoryTimer;
let voiceMuteTimer;
let licenseTimer;
let panelRepairTimer;
let operationsDigestTimer;
let selfHealingTimer;
const selfHealingState = {
  inFlight: new Set(),
  lastCacheCleanupAt: 0,
  lastPanelRepairAt: 0,
  gatewayUnavailableSince: startedAt,
  lastGatewayRecoveryAt: 0,
  gatewayRestartRequested: false,
  lastGatewayReconnectLogAt: 0,
  lastFailureReportedAt: new Map(),
  scheduled: new Set(),
};

const WELCOME_MESSAGES = [
  '認証ゲートを通過しました。ようこそ！',
  '扉が開きました。AmAで楽しい時間をどうぞ！',
  '認証成功！ 新しい仲間の参加を歓迎します。',
  'チェック完了。これでサーバーを楽しめます！',
  'ようこそ！ コミュニティでの時間を楽しんでください。',
];
const AMA_GUILD_ID = '1414606962846601302';
const MBTI_CUSTOM_EMOJIS = {
  sparkle: '<a:SXFAnyaSuperYay:1519043439323381960>',
  start: { id: '1519043206203965440', name: 'CBuwu', animated: true },
  cheer: '<a:hanyaCheer:1538143940484534322>',
  welcome: '<a:nekolove:1517284982257877184>',
};
const REGISTERED_USER_COMMANDS = new Set(['help', 'ping', 'uptime', 'user', '機能要望']);
const errorDeduper = createErrorDeduper();
const PURCHASE_PLANS = Object.freeze({ monthly: { label: '1か月', price: '300円' }, quarterly: { label: '3か月', price: '600円' }, halfyear: { label: '6か月', price: '1,200円' }, lifetime: { label: '永久利用権', price: '3,000円' } });
const PURCHASE_LOG_CHANNEL_ID = '1417192073026605057';
const INACTIVITY_LOG_CHANNEL_ID = '1414606963920338951';
// Keep operational summaries in their dedicated channel.
const OPERATIONS_DIGEST_CHANNEL_ID = '1543158103330267216';
const PURCHASE_DAILY_BUTTON_LIMIT = 3;
const LICENSE_PLANS = Object.freeze({
  monthly: { label: '1か月', durationMs: 30 * 24 * 60 * 60 * 1_000 },
  quarterly: { label: '3か月', durationMs: 90 * 24 * 60 * 60 * 1_000 },
  halfyear: { label: '6か月', durationMs: 180 * 24 * 60 * 60 * 1_000 },
  lifetime: { label: '永久', durationMs: null },
  manual: { label: '期限なし（手動）', durationMs: null },
});
const LICENSE_EXPIRY_CHECK_INTERVAL_MS = 60 * 60 * 1_000;
const PANEL_REPAIR_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const OPERATIONS_DIGEST_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const SELF_HEALING_INTERVAL_MS = 5 * 60 * 1_000;
const SELF_HEALING_PANEL_INTERVAL_MS = 30 * 60 * 1_000;
const SELF_HEALING_CACHE_INTERVAL_MS = 60 * 60 * 1_000;
const GATEWAY_RECOVERY_GRACE_MS = 2 * 60 * 1_000;
const GATEWAY_RECOVERY_COOLDOWN_MS = 5 * 60 * 1_000;
const GATEWAY_PROCESS_RESTART_MS = 10 * 60 * 1_000;
const GATEWAY_RECONNECT_LOG_INTERVAL_MS = 5 * 60 * 1_000;
const INVITE_ACCESS_GUILD_ID = '1414606962846601302';
const INVITE_ACCESS_CHANNEL_ID = '1543522630584369243';
const INVITE_ACCESS_CODE = 'DYjtfBm2ec';
const INVITE_ACCESS_LEGACY_ROLE_ID = '1417565680038969344';
const INVITE_ACCESS_ROLE_NAME = '購入チャンネル閲覧｜招待限定';
const USAGE_ACCESS_INVITE_URL = 'https://discord.gg/DYjtfBm2ec';
const ASSET_STORAGE_PANEL_CHANNEL_ID = '1543393706537918585';
const ASSET_STORAGE_CATEGORY_ID = '1543393587616817162';

function requirePermission(interaction, permission) {
  if (!interaction.memberPermissions?.has(permission)) throw new Error('この操作を実行する権限がありません。');
}

function commandAccessLevel(interaction) {
  if (commandAccessStore.isOwner(interaction.user.id)) return 'owner';
  if (!commandAccessStore.isRegistered(interaction.user.id)) throw new Error('このBotのコマンドは登録済みユーザーだけが実行できます。');
  if (!REGISTERED_USER_COMMANDS.has(interaction.commandName)) throw new Error('登録済みユーザーは確認系コマンドのみ利用できます。管理操作は登録管理者へ依頼してください。');
  return 'registered';
}

function requirePrimaryBotOwner(interaction) {
  if (!isPrimaryBotOwner(interaction.user.id)) throw new Error('このコマンドはBot所有者だけが実行できます。');
}

async function requireAssetPanelAccess(interaction) {
  if (!interaction.inGuild()) throw new Error('アセットの保存はサーバー内の保管パネルから実行してください。');
  // 通常はGatewayキャッシュだけで判定する。利用者が同時に操作しても、毎回REST取得を
  // 待ってDiscordの3秒応答期限を消費しない。キャッシュ欠落時だけ取得する。
  const panelChannel = interaction.guild.channels.cache.get(ASSET_STORAGE_PANEL_CHANNEL_ID)
    || await interaction.guild.channels.fetch(ASSET_STORAGE_PANEL_CHANNEL_ID).catch(() => null);
  if (!panelChannel?.isTextBased()) throw new Error('アセット保管パネルのチャンネルが利用できません。');
  const member = interaction.member?.user
    ? interaction.member
    : interaction.guild.members.cache.get(interaction.user.id)
      || await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member || !panelChannel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)) throw new Error('アセットの保存は、保管パネルを閲覧できるユーザーだけが実行できます。');
}

function buildUsageAccessNotice() {
  return {
    ephemeral: true,
    embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🔐 あまねの利用権について').setDescription('あまねの機能を利用するには、利用権の購入とユーザーID登録が必要です。\n下のリンクから参加し、購入手続きを行ってください。')
      .addFields({ name: '📌 購入・参加リンク', value: `[利用権購入サーバーへ参加する](${USAGE_ACCESS_INVITE_URL})` }, { name: '利用開始まで', value: '参加後、利用権購入チャンネルで希望プランを選択してください。管理者確認後にユーザーIDへ利用権を付与します。' })
      .setFooter({ text: 'このコマンドは購入案内のみで、Botの機能操作はできません。' })],
  };
}

function requireBotPermission(interaction, permission, message) {
  if (!interaction.guild.members.me.permissions.has(permission)) throw new Error(message);
}

async function getTextChannel(channelId) {
  const channel = discord.channels.cache.get(channelId) || await discord.channels.fetch(channelId).catch(() => null);
  return channel?.isTextBased() ? channel : null;
}

function isUnknownMessage(error) { return Number(error?.code) === 10_008; }

async function fetchOwnedPanelMessage(channel, messageId) {
  if (!messageId) return null;
  try {
    const message = await channel.messages.fetch(messageId);
    if (message.author.id !== discord.user.id) throw new Error('登録済みパネルの投稿者がBotではありません。安全のため上書きしません。');
    return message;
  } catch (error) {
    if (isUnknownMessage(error)) return null;
    throw error;
  }
}

function buildInstallConsentPanel(guild) {
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('🛡️ あまね — 利用前の確認')
    .setDescription('このBotを利用する前に、サーバー管理者は以下をご確認ください。')
    .addFields(
      { name: '🚫 禁止事項', value: '荒らし・スパム・不正利用、他者の権利やプライバシーを侵害する利用は禁止です。' },
      { name: '🔐 コマンド利用', value: '登録済みユーザーだけがコマンドを実行できます。登録管理者は全コマンド、登録済みユーザーは確認系コマンドを利用できます。' },
      { name: '✅ 同意', value: 'サーバー管理者が下のボタンを押すと、ルールへの同意とインストール完了を記録します。' },
    ).setFooter({ text: 'あまね • サーバー管理者のみ同意できます' });
  const iconUrl = guild.iconURL({ size: 512 });
  if (iconUrl) embed.setThumbnail(iconUrl);
  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`install-consent:agree:${guild.id}`).setLabel('ルールに同意して利用を開始').setEmoji('✅').setStyle(ButtonStyle.Success))],
  };
}

function buildExternalSetupPanel(guild, installer) {
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('🛡️ あまね — 管理者セットアップ')
    .setDescription('このチャンネルは、サーバー管理者だけが利用できるあまねの初期セットアップ・操作・ログ用チャンネルです。')
    .addFields(
      { name: '📌 利用ルール', value: '荒らし・スパム・不正利用、他者の権利やプライバシーを侵害する利用は禁止です。' },
      { name: '🔐 利用権', value: '登録管理者は全コマンド、登録済みユーザーは確認系コマンドのみ実行できます。`/command-access` で利用者を管理できます。' },
      { name: '🧰 操作開始', value: '`/help` で使えるコマンドを確認できます。一般チャンネルでコマンドが拒否される場合も、このチャンネルから操作できます。' },
      { name: '📋 導入ログ', value: `サーバーID: \`${guild.id}\`\n追加者: ${installer.user ? `${installer.user}（\`${installer.user.id}\`）` : '取得できませんでした'}\n取得状況: ${installer.detail.slice(0, 500)}` },
    ).setFooter({ text: 'あまね • サーバー管理者専用' }).setTimestamp();
  const iconUrl = guild.iconURL({ size: 512 });
  if (iconUrl) embed.setThumbnail(iconUrl);
  return { embeds: [embed] };
}

function buildInstallConsentCompletePanel(guild, userId) {
  const embed = new EmbedBuilder().setColor(0x57f287).setTitle('✅ あまねの利用開始を記録しました')
    .setDescription(`サーバー管理者 <@${userId}> が利用ルールに同意しました。`)
    .addFields({ name: 'サポート・利用権', value: '[AmAサーバーに参加する](https://discord.com/invite/ama-ama) から管理者へお問い合わせください。' })
    .setFooter({ text: `サーバーID: ${guild.id}` }).setTimestamp();
  const iconUrl = guild.iconURL({ size: 512 });
  if (iconUrl) embed.setThumbnail(iconUrl);
  return { embeds: [embed], components: [] };
}

function buildVerificationPanel(role, accessChannel = null) {
  const accessNotice = accessChannel ? `\n\n🔓 認証後に ${accessChannel} を閲覧できるよう設定しました。` : '';
  return {
    embeds: [new EmbedBuilder().setColor(0xf28ac0).setTitle('📜 サーバールール・認証')
      .setDescription(`╭─ **安心して交流するために** ─╮\n下のルールを確認し、同意として認証を完了してください。\n╰────────────────────╯${accessNotice}`)
      .addFields(
        { name: '🤖 01｜Botによる管理', value: 'このサーバーはBotが安全管理を行っています。', inline: false },
        { name: '🚫 02｜荒らし・迷惑行為は禁止', value: '荒らし・スパムなどはNGです。Botが検知して自動対応し、繰り返し・重大な違反は退出処理の対象になります。', inline: false },
        { name: '⏳ 03｜30日間の非アクティブ', value: '30日間活動が確認できない場合は、Botが自動で退出処理を行います。', inline: false },
        { name: '🤝 04｜お互いを尊重', value: 'みんなが安心して仲良く過ごせるよう、思いやりを持って交流してください。', inline: false },
        { name: '✅ 認証を完了する', value: `下のボタンから計算式に答えると、認証ロール ${role} が付与されます。`, inline: false },
      ).setFooter({ text: 'サーバールール 2026-09-04 • 認証の有効時間は5分です。' })],
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`verify:start:${role.id}`).setLabel('ルールに同意して認証').setStyle(ButtonStyle.Success).setEmoji('✅'))],
  };
}

function renderVerificationDm(settings, guild, role) {
  return (settings.dmMessage || DEFAULT_VERIFICATION_DM_MESSAGE).replaceAll('{server}', guild.name).replaceAll('{role}', role.name);
}

async function sendTrackedDm(recipient, payload) {
  const message = await recipient.send(payload);
  await dmHistoryStore.track(message);
  return message;
}

async function sendVerificationDm(member, { force = false } = {}) {
  if (guestAccess.isGuest(member)) return false;
  const settings = verificationSettingsStore.get(member.guild.id);
  if (!settings || (!force && !settings.dmEnabled)) return false;
  const role = await member.guild.roles.fetch(settings.roleId).catch(() => null);
  if (!role) throw new Error('認証DM用のロールが見つかりません。認証パネルを作り直してください。');
  await sendTrackedDm(member, {
    embeds: [new EmbedBuilder().setColor(0xf28ac0).setTitle(`ようこそ、${member.guild.name}へ`).setDescription(renderVerificationDm(settings, member.guild, role)).setFooter({ text: 'DMを受信できない場合は、サーバー内の認証パネルを利用してください。' })],
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`verify:dm-start:${member.guild.id}:${role.id}`).setLabel('DMで認証を開始').setStyle(ButtonStyle.Success).setEmoji('🛡️'))],
  });
  return true;
}

async function getInstallPanelChannel(guild) {
  const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!botMember) return null;
  const channels = await guild.channels.fetch().catch(() => new Map());
  const candidates = [guild.systemChannel, ...channels.values()];
  return candidates.find((channel, index, all) => channel && all.indexOf(channel) === index && channel.isTextBased?.() && channel.isSendable?.() && channel.permissionsFor(botMember)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) || null;
}

async function ensureExternalSetupChannel(guild, installer) {
  const previous = installConsentStore.get(guild.id) || {};
  const existingLogChannelId = previous.logChannelId || previous.setupChannelId;
  if (existingLogChannelId) {
    const existing = await getTextChannel(existingLogChannelId);
    if (existing?.isSendable()) return existing;
  }
  const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!botMember?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    // 権限がない外部サーバーではチャンネル作成を行わない。これは導入先の設定であり、
    // Botの障害ではないためエラー通知・再試行の対象にしない。
    return null;
  }
  const roles = await guild.roles.fetch();
  const administrators = [...roles.values()].filter((role) => role.id !== guild.id && role.permissions.has(PermissionFlagsBits.ManageGuild));
  const accessPermissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.UseApplicationCommands];
  const overwrites = [
    { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    { id: guild.ownerId, type: OverwriteType.Member, allow: accessPermissions },
    { id: botMember.id, type: OverwriteType.Member, allow: [...accessPermissions, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.EmbedLinks] },
    ...administrators.map((role) => ({ id: role.id, type: OverwriteType.Role, allow: accessPermissions })),
  ];
  const channel = await guild.channels.create({
    name: 'あまね-管理ログ',
    type: ChannelType.GuildText,
    topic: 'あまねの利用ルール・管理者用セットアップ・導入ログ',
    permissionOverwrites: overwrites,
    reason: 'あまねの導入時管理者セットアップ',
  });
  installConsentStore.recordPanel(guild.id, { logChannelId: channel.id, logChannelCreatedAt: Date.now() });
  await installConsentStore.save();
  await channel.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📒 あまね — 管理ログ').setDescription('このチャンネルは、あまねの導入・エラー・管理操作の記録専用です。\n**Botコマンドは登録済みユーザーIDだけが実行できます。**')
    .addFields({ name: '導入日時', value: `<t:${Math.floor(Date.now() / 1_000)}:F>` }, { name: '導入者', value: installer.user ? `${installer.user}（\`${installer.user.id}\`）` : installer.detail })
    .setFooter({ text: 'あまね • 管理者専用' }).setTimestamp()] });
  return channel;
}

async function getInstallingUser(guild) {
  const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!botMember?.permissions.has(PermissionFlagsBits.ViewAuditLog)) return { user: null, detail: 'Botに「監査ログを表示」権限がないため取得できませんでした。' };
  try {
    const auditLogs = await guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 10 });
    const entry = [...auditLogs.entries.values()].find((item) => item.targetId === discord.user.id || item.target?.id === discord.user.id);
    if (!entry?.executor) return { user: null, detail: 'Bot追加の監査ログが見つかりませんでした。' };
    return { user: entry.executor, detail: 'Discord監査ログのBot追加記録から取得しました。' };
  } catch (error) {
    return { user: null, detail: `監査ログを取得できませんでした: ${error.message.slice(0, 300)}` };
  }
}

async function sendInstallLog({ guild, installer, panelChannel, acceptedByUserId = null }) {
  if (!config.botInstallLogChannelId) return;
  const channel = await getTextChannel(config.botInstallLogChannelId);
  if (!channel?.isSendable()) return;
  const title = acceptedByUserId ? '✅ 外部サーバーの利用ルールに同意されました' : '📥 Botが外部サーバーに追加されました';
  const description = acceptedByUserId ? `**${guild.name}** で利用開始が記録されました。` : `**${guild.name}** にあまねが追加されました。`;
  const fields = [
    { name: 'サーバーID', value: `\`${guild.id}\``, inline: true },
    { name: 'サーバー所有者ID', value: `\`${guild.ownerId}\``, inline: true },
    { name: 'メンバー数', value: String(guild.memberCount), inline: true },
    { name: 'インストール実行者', value: installer.user ? `${installer.user}（\`${installer.user.id}\`）` : '取得できませんでした' },
    { name: '取得状況', value: installer.detail.slice(0, 1_000) },
    { name: 'サーバー作成日', value: `<t:${Math.floor(guild.createdTimestamp / 1_000)}:F>`, inline: true },
    { name: '認証レベル', value: String(guild.verificationLevel), inline: true },
    { name: 'システムチャンネル', value: guild.systemChannel ? `${guild.systemChannel}（\`${guild.systemChannel.id}\`）` : '未設定' },
    { name: '同意UI', value: panelChannel ? `${panelChannel} に投稿` : '投稿先を見つけられませんでした' },
  ];
  if (acceptedByUserId) fields.push({ name: '同意した管理者', value: `<@${acceptedByUserId}>（\`${acceptedByUserId}\`）` });
  if (guild.features.length) fields.push({ name: 'サーバー機能', value: guild.features.join(', ').slice(0, 1_000) });
  const embed = new EmbedBuilder().setColor(acceptedByUserId ? 0x57f287 : 0x5865f2).setTitle(title).setDescription(description).addFields(fields).setTimestamp();
  const iconUrl = guild.iconURL({ size: 512 });
  if (iconUrl) embed.setThumbnail(iconUrl);
  await channel.send({ embeds: [embed] });
}

async function getManagementLogChannel() {
  if (!config.dmLogChannelId) return null;
  const channel = await getTextChannel(config.dmLogChannelId);
  return channel?.isSendable() ? channel : null;
}

async function getBotInstallLogChannel() {
  if (!config.botInstallLogChannelId) return null;
  const channel = await getTextChannel(config.botInstallLogChannelId);
  return channel?.isSendable() ? channel : null;
}

async function writeManagementDmLog(interaction, recipient) {
  const channel = await getManagementLogChannel();
  if (!channel) return;
  await channel.send({ embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('📨 管理DMを送信しました').setDescription('指定ユーザーへのDM送信に成功しました。')
    .addFields(
      { name: '送信者', value: `${interaction.user}（\`${interaction.user.id}\`）`, inline: true },
      { name: '送信先', value: `${recipient}（\`${recipient.id}\`）`, inline: true },
      { name: '送信元サーバー', value: `${interaction.guild.name}（\`${interaction.guild.id}\`）` },
    ).setTimestamp()] });
}

function buildDmSupportButtons(userId, disabled = false) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dm-support:reply:${userId}`).setLabel('このDMに返信').setEmoji('💬').setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`dm-support:close:${userId}`).setLabel('強制終了').setEmoji('🔒').setStyle(ButtonStyle.Danger).setDisabled(disabled),
  )];
}

async function deleteIncomingDm(message) {
  try {
    await message.delete();
  } catch (error) {
    await writeCentralAuditLog({
      title: '受信DMの削除エラー',
      description: error.message?.slice(0, 1_000) || '不明なエラー',
      fields: [{ name: '送信者ID', value: `\`${message.author.id}\`` }, { name: 'メッセージID', value: `\`${message.id}\`` }],
      color: 0xed4245,
    });
  }
}

async function logIncomingDm(message) {
  if (message.author.bot) return;
  if (dmSupportStore.isClosed(message.author.id)) return deleteIncomingDm(message);
  const channel = await getManagementLogChannel();
  if (!channel) return;
  const attachmentList = [...message.attachments.values()];
  const attachments = attachmentList.map((attachment) => `[${attachment.name || 'file'}](${attachment.url})`).join('\n');
  const originalText = message.content?.length ? message.content : '（テキストなし）';
  await channel.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('💌 ユーザーDMを受信しました').setDescription(originalText)
    .setThumbnail(message.author.displayAvatarURL({ size: 128 }))
    .addFields(
      { name: '👤 送信者', value: `${message.author}（\`${message.author.id}\`）` },
      ...(attachments ? [{ name: '📎 添付・URL（原本）', value: attachments.slice(0, 1_000) }] : []),
    ).setFooter({ text: '下のボタンで返信、またはこのDM対応を強制終了できます。' }).setTimestamp()], components: buildDmSupportButtons(message.author.id), allowedMentions: { parse: [] } });
  if (attachmentList.length) {
    try {
      await channel.send({ content: '📦 **受信した添付ファイル（原本）**', files: attachmentList.map((attachment) => new AttachmentBuilder(attachment.url, { name: attachment.name || 'attachment' })), allowedMentions: { parse: [] } });
    } catch (error) {
      await reportRuntimeError('DM添付ファイルのログ転送', error, [{ name: '送信者ID', value: `\`${message.author.id}\`` }]);
    }
  }
  await deleteIncomingDm(message);
}

async function mirrorForumUpload(message) {
  if (!message.guild || message.author.bot || !message.attachments.size) return;
  if (forumUploadsInFlight.has(message.id)) return;
  forumUploadsInFlight.add(message.id);
  // フォーラムの添付は必ず投稿スレッドに届く。保管パネルで作成したものに限らず、
  // 全フォーラムで同じ保管規則を適用する。起動直後に親がキャッシュにない場合も
  // 取得して判定するため、新規フォーラムも設定待ちにならない。
  try {
    const forumParent = message.channel?.parent || (message.channel?.parentId && await message.guild.channels.fetch(message.channel.parentId).catch(() => null));
    const isForumThread = message.channel?.isThread?.() && forumParent?.type === ChannelType.GuildForum;
    if (!isForumThread) return;

  // 分割ZIP（.zip.001 等）を含め、拡張子では除外しない。各Discordメッセージを
  // 1保管単位として処理するため、500MB超のファイルを複数投稿に分けても漏れない。
    const storageFiles = [...message.attachments.values()];
    if (!shouldImmediatelyForwardForumUpload(storageFiles)) return;
    // 全添付は種類・容量・個数に関係なくDiscordのメッセージ転送を使用する。
    // CDNからの再取得・再アップロードを行わないため、分割ZIP、画像、動画も
    // 待ち時間を増やさず、添付の並びを保ったまま転送できる。
    const mirroredMessage = await message.forward(message.channel);
    // Discordが新しいメッセージを返した場合だけ原本を削除する。転送・再送付が
    // 失敗したときに利用者のファイルまで失われる状態を防ぐ。
    if (!mirroredMessage?.id || mirroredMessage.id === message.id) throw new Error('Discordから転送完了を確認できませんでした。');
    if (message.deletable) await message.delete();
    else await reportRuntimeError('フォーラム元投稿の削除', new Error('Botにメッセージ管理権限がありません。'), [{ name: '元メッセージID', value: `\`${message.id}\`` }]);
  } catch (error) {
    await reportRuntimeError('フォーラム添付の保管', error, [{ name: '元メッセージID', value: `\`${message.id}\`` }]);
  } finally {
    forumUploadsInFlight.delete(message.id);
  }
}

async function createExternalInstallConsent(guild) {
  if (tracksGuild(guild)) return;
  const previous = installConsentStore.get(guild.id);
  // 導入済みサーバーは起動ごとにセットアップを繰り返さない。
  // 管理権限がない場合も初回の導入記録だけ残して終了する。
  if (previous?.installedAt) return;
  const installer = await getInstallingUser(guild);
  const logChannel = await ensureExternalSetupChannel(guild, installer);
  installConsentStore.recordPanel(guild.id, {
    logChannelId: logChannel?.id || previous?.logChannelId || previous?.setupChannelId || null,
    installerUserId: installer.user?.id || previous?.installerUserId || null,
    installerAuditDetail: installer.detail,
    installedAt: previous?.installedAt || Date.now(),
  });
  await installConsentStore.save();
  await sendInstallLog({ guild, installer, panelChannel: logChannel });
}

async function writeCentralAuditLog({ title, description, fields = [], color = 0x5865f2 }) {
  // 全サーバー共通で、Botの内部エラーや監査記録は専用のログ管理チャンネルだけへ送る。
  const channel = await getTextChannel(PURCHASE_LOG_CHANNEL_ID);
  if (!channel) return;
  await channel.send({ embeds: [new EmbedBuilder().setColor(color).setTitle(`🔎 ${title}`).setDescription(description).addFields(fields).setTimestamp()] });
}

function isStaleInteractionResponse(error) {
  // Discord は一つの操作に一度だけ応答できます。二重稼働からの移行直後や、
  // ユーザーが画面を長く開いた場合の 10062 / 40060 は復旧不能な通知であり、
  // 実行障害として中央ログを埋めない。
  return [10_062, 40_060].includes(Number(error?.code));
}

async function reportRuntimeError(scope, error, fields = []) {
  if (isStaleInteractionResponse(error)) {
    console.warn(`${scope}: すでに応答済み、または期限切れのDiscord操作を受信しました。`);
    return;
  }
  // 一部の外部ライブラリは Error ではないオブジェクトを reject する。
  // String(error) の "[object Object]" をログへ残さず、利用者が判断できる要約にする。
  const detail = [error?.stack, error?.message, error?.stderr, error?.cause?.message, error?.cause?.stderr, error?.mediaDetails]
    .find((value) => typeof value === 'string' && value.trim());
  const fallback = error && typeof error === 'object'
    ? [error.name, error.code, error.statusCode || error.status].filter(Boolean).join(' ') || '詳細を取得できない外部エラー'
    : String(error);
  const description = (detail || fallback).slice(0, 3_800);
  console.error(`${scope}:`, error);
  if (!errorDeduper.shouldNotify(scope, error).notify) return;
  await writeCentralAuditLog({ title: `エラー — ${scope}`, description, fields, color: 0xed4245 }).catch(() => {});
}

async function runStartupTask(scope, operation, { timeoutMs = 20_000, fallback = undefined } = {}) {
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${scope} が ${timeoutMs / 1_000} 秒以内に完了しませんでした。`)), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } catch (error) {
    reportRuntimeError(scope, error).catch(() => {});
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}

function isRecoverableSelfHealingError(error) {
  // 権限・投稿先削除などはBotの再試行で改善しないため、管理者の設定を待つ。
  return ![10_003, 50_001, 50_013].includes(Number(error?.code));
}

async function runSelfHealingTask(target, operation, { attempts = 2 } = {}) {
  if (selfHealingState.inFlight.has(target)) return false;
  selfHealingState.inFlight.add(target);
  try {
    await retryRecoverable(operation, {
      attempts,
      delayMs: 1_000,
      isRecoverable: isRecoverableSelfHealingError,
    });
    selfHealingState.lastFailureReportedAt.delete(target);
    return true;
  } catch (error) {
    // 同じ復旧不能エラーを短時間に繰り返し投稿せず、30分ごとに要点だけ残す。
    const now = Date.now();
    const lastReportedAt = selfHealingState.lastFailureReportedAt.get(target) || 0;
    if (now - lastReportedAt >= 30 * 60 * 1_000) {
      selfHealingState.lastFailureReportedAt.set(target, now);
      await reportRuntimeError(`自動復旧 — ${target}`, error);
    }
    return false;
  } finally {
    selfHealingState.inFlight.delete(target);
  }
}

async function recoverDiscordGateway() {
  const now = Date.now();
  if (!discord.isReady() && !selfHealingState.gatewayUnavailableSince) {
    selfHealingState.gatewayUnavailableSince = now;
  }
  if (!shouldRecoverGateway({
    isReady: discord.isReady(),
    now,
    unavailableSince: selfHealingState.gatewayUnavailableSince,
    lastRecoveryAt: selfHealingState.lastGatewayRecoveryAt,
    graceMs: GATEWAY_RECOVERY_GRACE_MS,
    cooldownMs: GATEWAY_RECOVERY_COOLDOWN_MS,
  })) return false;

  selfHealingState.lastGatewayRecoveryAt = now;
  // discord.js already owns shard reconnection. A second login() competes with
  // that state machine and can cause another reconnect loop.
  if (now - selfHealingState.gatewayUnavailableSince < GATEWAY_PROCESS_RESTART_MS
    || selfHealingState.gatewayRestartRequested) return false;
  selfHealingState.gatewayRestartRequested = true;
  console.error('Discord Gatewayが10分以上復旧しないため、Botプロセスを1回だけ再起動します。');
  setTimeout(() => process.exit(75), 1_000).unref();
  return true;
}

async function runSelfHealingCycle({ target = 'all' } = {}) {
  const now = Date.now();
  const gatewayRecovered = await recoverDiscordGateway();
  if (!discord.isReady()) return { gatewayRecovered, panels: false, cache: false };

  let panels = false;
  let cache = false;
  const wantsPanels = ['all', 'panel', 'media'].includes(target);
  const wantsCache = ['all', 'cache', 'media'].includes(target);
  const forceTargetRepair = target !== 'all';
  if (wantsPanels && (forceTargetRepair || shouldRunMaintenance({ now, lastRunAt: selfHealingState.lastPanelRepairAt, intervalMs: SELF_HEALING_PANEL_INTERVAL_MS }))) {
    panels = await runSelfHealingTask('パネル', async () => {
      await repairManagedPanels();
      await publishMediaConverterPanel(discord);
    });
    if (panels) selfHealingState.lastPanelRepairAt = Date.now();
  }
  if (wantsCache && (forceTargetRepair || shouldRunMaintenance({ now, lastRunAt: selfHealingState.lastCacheCleanupAt, intervalMs: SELF_HEALING_CACHE_INTERVAL_MS }))) {
    cache = await runSelfHealingTask('変換キャッシュ', cleanupMediaTempCache);
    if (cache) selfHealingState.lastCacheCleanupAt = Date.now();
  }
  return { gatewayRecovered, panels, cache };
}

function requestSelfHealing(target = 'all', delayMs = 0) {
  if (selfHealingState.scheduled.has(target)) return;
  selfHealingState.scheduled.add(target);
  setTimeout(() => {
    selfHealingState.scheduled.delete(target);
    runSelfHealingCycle({ target }).catch((error) => reportRuntimeError(`自動復旧監視 — ${target}`, error));
  }, delayMs).unref?.();
}

function startSelfHealingMonitor() {
  if (selfHealingTimer) return;
  selfHealingTimer = setInterval(() => runSelfHealingCycle().catch((error) => reportRuntimeError('自動復旧監視', error)), SELF_HEALING_INTERVAL_MS);
}

discord.reportRuntimeError = reportRuntimeError;
const guestAccess = new GuestAccess(discord, { reportError: reportRuntimeError });
guestAccess.registerEvents();
const invitePanel = new InvitePanel(discord, { reportError: reportRuntimeError, guestAccess });
invitePanel.registerEvents();

function buildRecruitmentPanel(panel) {
  return {
    embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`📣 ${panel.title}`).setDescription(panel.description).addFields({ name: '応募方法', value: panel.applyInstruction }).setFooter({ text: panel.detailsText })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`recruitment:apply:${panel.id}`).setLabel(panel.applyLabel).setStyle(ButtonStyle.Success).setEmoji('✉️'),
      new ButtonBuilder().setCustomId(`recruitment:details:${panel.id}`).setLabel(panel.detailsLabel).setStyle(ButtonStyle.Secondary).setEmoji('🔎'),
    )],
  };
}

function buildPurchasePanel() {
  return {
    embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🎫 あまね — Bot利用権購入')
      .setDescription('## 購入チケットを作成する\n**希望するプランを選択してください。**\n選択後、あなただけが見られる個別チケットを作成し、管理者が利用開始までご案内します。')
      .addFields(
        { name: '💳 料金表', value: '🟦 **1か月**　`300円`\n🟪 **3か月**　`600円`（1か月分お得）\n🟩 **6か月**　`1,200円`（2か月分お得）\n🟨 **永久利用権**　`3,000円`' },
        { name: '🧾 購入の流れ', value: '**①** 下のボタンからプランを選ぶ\n**②** PayPay決済URL・プラン・DiscordユーザーIDを入力して実行\n**③** チケットが開かれるので、管理者の対応までお待ちください。' },
        { name: '⚠️ 注意事項', value: '• **PayPayマネーライト**で送金する場合は、プラン料金に **+¥100** を加算してください。\n• 入力したURL・プラン・DiscordユーザーIDを確認してから送信してください。\n• 誤ってチケットを作成した場合は、チケット内の削除ボタンを使用できます。' },
      ).setFooter({ text: 'あまね • 利用権サポート' })],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('purchase:create:monthly').setLabel('1か月 • 300円').setEmoji('🟦').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('purchase:create:quarterly').setLabel('3か月 • 600円').setEmoji('🟪').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('purchase:create:halfyear').setLabel('6か月 • 1,200円').setEmoji('🟩').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('purchase:create:lifetime').setLabel('永久 • 3,000円').setEmoji('🟨').setStyle(ButtonStyle.Secondary),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('purchase:guide:user-id').setLabel('DiscordユーザーIDとは？').setEmoji('❔').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('purchase:inquiry').setLabel('問い合わせ').setEmoji('💬').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

async function publishPurchasePanel(guild, settings) {
  const channel = settings.panelChannelId && await getTextChannel(settings.panelChannelId);
  if (!channel?.isSendable()) throw new Error('利用権購入パネルの投稿先チャンネルに送信できません。');
  const existing = await fetchOwnedPanelMessage(channel, settings.panelMessageId);
  if (existing) return existing.edit(buildPurchasePanel());
  const panel = await channel.send(buildPurchasePanel());
  purchaseTicketStore.update(guild.id, { panelMessageId: panel.id });
  await purchaseTicketStore.save();
  return panel;
}

function formatPurchaseTicketMessage(template, { user, plan, ownerId }) {
  return template.replaceAll('{user}', `${user}`).replaceAll('{userId}', user.id).replaceAll('{plan}', plan.label).replaceAll('{price}', plan.price).replaceAll('{owner}', `<@${ownerId}>`);
}

function buildPurchaseConfirmationModal(planId) {
  const plan = PURCHASE_PLANS[planId];
  if (!plan) throw new Error('購入プランが見つかりません。');
  return new ModalBuilder().setCustomId(`purchase:confirm:${planId}`).setTitle('利用権購入の確認').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reference-url').setLabel('PayPay決済URL（正式な加盟店リンク）').setPlaceholder('https://example.com/').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(500)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('plan').setLabel('選択したプラン（変更しないでください）').setValue(`${plan.label}（${plan.price}）`).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('user-id').setLabel('DiscordユーザーID').setPlaceholder('例: 1030896490379476992').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20)),
  );
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function purchaseOwnerMentions() { return [...config.commandOwnerIds].map((id) => `<@${id}>`).join(' '); }

async function writePurchaseTicketLog({ title, description, fields = [], color = 0x5865f2, content = null }) {
  const channel = await getTextChannel(PURCHASE_LOG_CHANNEL_ID);
  if (!channel?.isSendable()) {
    console.warn(`利用権購入ログチャンネルに送信できません (${PURCHASE_LOG_CHANNEL_ID})`);
    return;
  }
  await channel.send({ content, allowedMentions: content ? { users: [...config.commandOwnerIds] } : undefined, embeds: [new EmbedBuilder().setColor(color).setTitle(`🎫 ${title}`).setDescription(description.slice(0, 4_000)).addFields(fields.slice(0, 25)).setTimestamp()] });
}

function inviteUsesByCode(invites) {
  return Object.fromEntries(invites.map((invite) => [invite.code, invite.uses || 0]));
}

async function refreshInviteAccessSnapshot(guild) {
  const settings = inviteAccessStore.get(guild.id);
  if (!settings.enabled) return;
  const invites = await guild.invites.fetch();
  inviteAccessStore.update(guild.id, { inviteUses: inviteUsesByCode([...invites.values()]), snapshotAt: new Date().toISOString() });
  await inviteAccessStore.save();
}

async function restrictInviteRoleToPurchaseChannel(guild, settings) {
  const role = settings.roleId && await guild.roles.fetch(settings.roleId).catch(() => null);
  if (!role) throw new Error('指定招待リンク用の閲覧ロールが見つかりません。');
  const channels = await guild.channels.fetch();
  for (const channel of channels.values()) {
    if (!channel?.permissionOverwrites?.edit) continue;
    if (channel.id === settings.channelId) await channel.permissionOverwrites.edit(role.id, { ViewChannel: true }, '指定招待リンク参加者へ購入チャンネルだけを表示');
    else await channel.permissionOverwrites.edit(role.id, { ViewChannel: false }, '指定招待リンク参加者には購入チャンネル以外を非表示');
  }
}

async function configureInviteLimitedPurchaseAccess(guild) {
  if (guild.id !== INVITE_ACCESS_GUILD_ID) return;
  const settings = inviteAccessStore.get(guild.id);
  const channel = await guild.channels.fetch(INVITE_ACCESS_CHANNEL_ID).catch(() => null);
  if (!channel?.isTextBased()) throw new Error('利用権購入チャンネルが見つかりません。');
  const legacyRole = await guild.roles.fetch(INVITE_ACCESS_LEGACY_ROLE_ID).catch(() => null);
  if (!legacyRole) throw new Error('既存メンバーの閲覧権ロールが見つかりません。');
  let inviteRole = settings.roleId && await guild.roles.fetch(settings.roleId).catch(() => null);
  if (!inviteRole) inviteRole = await guild.roles.create({ name: INVITE_ACCESS_ROLE_NAME, permissions: 0n, hoist: false, mentionable: false, reason: '指定招待リンク経由の利用権購入チャンネル閲覧用' });

  const members = await guild.members.fetch();
  const grandfatheredMembers = [...members.values()].filter((member) => !member.user.bot && member.roles.cache.has(legacyRole.id));
  const existingOverwrites = channel.permissionOverwrites.cache;
  const requiredMemberOverwrites = grandfatheredMembers.filter((member) => !existingOverwrites.has(member.id)).length;
  const requiredRoleOverwrite = existingOverwrites.has(inviteRole.id) ? 0 : 1;
  const legacyOverwriteRemoved = existingOverwrites.has(legacyRole.id) ? 1 : 0;
  if (existingOverwrites.size + requiredMemberOverwrites + requiredRoleOverwrite - legacyOverwriteRemoved > 100) throw new Error('既存メンバーの閲覧状態を維持するためのチャンネル権限枠が不足しています。');

  for (const member of grandfatheredMembers) await channel.permissionOverwrites.edit(member.id, { ViewChannel: true }, '既存メンバーの利用権購入チャンネル閲覧を維持');
  await channel.permissionOverwrites.edit(inviteRole.id, { ViewChannel: true }, '指定招待リンク参加者に利用権購入チャンネル閲覧を付与');
  await channel.permissionOverwrites.delete(legacyRole.id, '新規参加者は指定招待リンク経由だけに限定');
  const invites = await guild.invites.fetch();
  inviteAccessStore.update(guild.id, {
    enabled: true,
    inviteCode: INVITE_ACCESS_CODE,
    channelId: channel.id,
    roleId: inviteRole.id,
    legacyRoleId: legacyRole.id,
    inviteUses: inviteUsesByCode([...invites.values()]),
    configuredAt: new Date().toISOString(),
  });
  await inviteAccessStore.save();
  await restrictInviteRoleToPurchaseChannel(guild, inviteAccessStore.get(guild.id));
  await writePurchaseTicketLog({ title: '招待限定の閲覧設定を有効化', description: `既存の閲覧可能メンバーは変更せず、指定招待リンク経由の新規参加者だけに購入チャンネルの閲覧権を付与します。`, content: purchaseOwnerMentions(), fields: [{ name: '招待リンク', value: `https://discord.gg/${INVITE_ACCESS_CODE}` }, { name: '付与ロール', value: `${inviteRole}（\`${inviteRole.id}\`）` }, { name: '対象チャンネル', value: `${channel}（\`${channel.id}\`）` }, { name: '既存閲覧を維持したメンバー数', value: String(grandfatheredMembers.length), inline: true }], color: 0x57f287 });
}

async function grantInviteLimitedPurchaseAccess(member) {
  const settings = inviteAccessStore.get(member.guild.id);
  if (!settings.enabled || !settings.inviteCode || !settings.roleId) return false;
  const invites = await member.guild.invites.fetch();
  const currentUses = inviteUsesByCode([...invites.values()]);
  const previousUses = settings.inviteUses?.[settings.inviteCode] || 0;
  const usedTargetInvite = (currentUses[settings.inviteCode] || 0) > previousUses;
  inviteAccessStore.update(member.guild.id, { inviteUses: currentUses, snapshotAt: new Date().toISOString() });
  await inviteAccessStore.save();
  if (!usedTargetInvite) return false;
  const role = await member.guild.roles.fetch(settings.roleId).catch(() => null);
  if (!role) throw new Error('指定招待リンク用の閲覧ロールが見つかりません。');
  await member.roles.add(role, `指定招待リンク ${settings.inviteCode} 経由で参加`);
  await writePurchaseTicketLog({ title: '招待限定の閲覧権を付与', description: `${member} が指定招待リンクから参加したため、購入チャンネルの閲覧権を付与しました。`, content: purchaseOwnerMentions(), fields: [{ name: 'ユーザーID', value: `\`${member.id}\``, inline: true }, { name: '招待リンク', value: `https://discord.gg/${settings.inviteCode}` }, { name: '付与ロール', value: `${role}（\`${role.id}\`）` }], color: 0x57f287 });
  return true;
}

async function sendInvitePurchaseDm(member) {
  await sendTrackedDm(member, { embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🎫 あまね — 利用権購入のご案内')
    .setDescription('指定招待リンクからの参加を確認しました。\n認証は必要ありません。利用権購入は、サーバー内の <#1543522630584369243> をご確認ください。')
    .setFooter({ text: 'あまね • 招待限定のご案内' })] });
}

async function consumePurchaseButtonUse(guildId, userId) {
  const settings = purchaseTicketStore.get(guildId);
  const now = Date.now();
  const today = tokyoDay(now);
  const previous = (settings.buttonUses?.[userId] || []).filter((timestamp) => tokyoDay(timestamp) === today);
  if (previous.length >= PURCHASE_DAILY_BUTTON_LIMIT) throw new Error(`購入・問い合わせボタンは1日に${PURCHASE_DAILY_BUTTON_LIMIT}回まで使用できます。日付が変わってから再度お試しください。`);
  purchaseTicketStore.update(guildId, { buttonUses: { ...(settings.buttonUses || {}), [userId]: [...previous, now] } });
  await purchaseTicketStore.save();
  return PURCHASE_DAILY_BUTTON_LIMIT - previous.length - 1;
}

async function findOpenPurchaseTicket(guild, userId, type = 'purchase') {
  const settings = purchaseTicketStore.get(guild.id);
  const ticket = purchaseTicketStore.ticketForUser(guild.id, userId, type);
  if (!ticket) return null;
  const channel = await guild.channels.fetch(ticket.channelId).catch(() => null);
  if (channel) return ticket;
  purchaseTicketStore.update(guild.id, { tickets: { ...settings.tickets, [ticket.channelId]: { ...ticket, status: 'deleted', deletedAt: new Date().toISOString(), deletedReason: 'channel-not-found' } } });
  await purchaseTicketStore.save();
  return null;
}

function buildPurchaseTicketMessage({ interaction, plan, referenceUrl, declaredUserId, template, ownerId }) {
  const ownerMentions = purchaseOwnerMentions();
  return {
    content: `${ownerMentions}\n🕒 ${interaction.user} さん、**管理者が応答するまでしばらくお待ちください。**`,
    embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🎫 利用権購入チケット')
      .setDescription(formatPurchaseTicketMessage(template, { user: interaction.user, plan, ownerId }))
      .addFields(
        { name: '🧾 選択プラン', value: `**${plan.label}**（${plan.price}）`, inline: true },
        { name: '👤 登録するDiscordユーザーID', value: `\`${declaredUserId}\``, inline: true },
        { name: '🔗 確認用URL', value: `[URLを開く](${referenceUrl})` },
        { name: '📜 利用規約 — 同意が必要', value: '• 送金金額が選択プランと異なる場合、確認・対応に時間がかかることがあります。\n• **購入者都合による返金は原則お受けできません。**\n• 下の「利用規約に同意する」を押すと、管理者による確認へ進みます。' },
      )
      .setFooter({ text: '内容を確認後、利用規約への同意または不同意を選択してください。' })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('purchase:terms:agree').setLabel('利用規約に同意する').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('purchase:terms:decline').setLabel('同意しない').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('purchase:delete').setLabel('チケットを削除').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
    )],
    allowedMentions: { users: [interaction.user.id, ...config.commandOwnerIds] },
  };
}

async function createPurchaseTicket(interaction, planId, { referenceUrl, declaredUserId }) {
  const plan = PURCHASE_PLANS[planId];
  if (!plan) throw new Error('購入プランが見つかりません。');
  const settings = purchaseTicketStore.get(interaction.guild.id);
  const existing = await findOpenPurchaseTicket(interaction.guild, interaction.user.id);
  if (existing) return interaction.editReply({ content: `すでに購入チケットがあります: <#${existing.channelId}>` });
  const ownerId = [...config.commandOwnerIds][0];
  let category = settings.categoryId && await interaction.guild.channels.fetch(settings.categoryId).catch(() => null);
  if (!category) {
    category = await interaction.guild.channels.create({ name: '🎫｜利用権チケット', type: ChannelType.GuildCategory });
    purchaseTicketStore.update(interaction.guild.id, { categoryId: category.id });
  }
  const ticket = await interaction.guild.channels.create({
    name: `ticket-${planId}-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9\-]/g, '-').slice(0, 90),
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: [
      { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: discord.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] },
      { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
      ...[...config.commandOwnerIds].map((id) => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] })),
    ],
  });
  const latest = purchaseTicketStore.get(interaction.guild.id);
  purchaseTicketStore.addTicket(interaction.guild.id, { channelId: ticket.id, userId: interaction.user.id, declaredUserId, referenceUrl, planId, type: 'purchase', termsStatus: 'pending', status: 'open', createdAt: new Date().toISOString() });
  await purchaseTicketStore.save();
  await ticket.send(buildPurchaseTicketMessage({ interaction, plan, referenceUrl, declaredUserId, template: latest.ticketMessage, ownerId }));
  await writePurchaseTicketLog({ title: '購入チケットを作成', description: `${interaction.user} が利用権購入チケットを作成しました。`, content: purchaseOwnerMentions(), fields: [{ name: 'チケット', value: `${ticket}（\`${ticket.id}\`）` }, { name: 'PayPay決済URL', value: `[URLを開く](${referenceUrl})` }, { name: 'プラン', value: `${plan.label}（${plan.price}）`, inline: true }, { name: 'DiscordユーザーID', value: `\`${declaredUserId}\``, inline: true }], color: 0x57f287 });
  return interaction.editReply({ content: `✅ 個別の購入チケットを作成しました: ${ticket}` });
}

async function createPurchaseInquiryTicket(interaction) {
  const settings = purchaseTicketStore.get(interaction.guild.id);
  const existing = await findOpenPurchaseTicket(interaction.guild, interaction.user.id, 'inquiry');
  if (existing) return interaction.editReply({ content: `すでに問い合わせチケットがあります: <#${existing.channelId}>` });
  let category = settings.categoryId && await interaction.guild.channels.fetch(settings.categoryId).catch(() => null);
  if (!category) {
    category = await interaction.guild.channels.create({ name: '🎫｜利用権チケット', type: ChannelType.GuildCategory });
    purchaseTicketStore.update(interaction.guild.id, { categoryId: category.id });
  }
  const ticket = await interaction.guild.channels.create({
    name: `inquiry-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9\-]/g, '-').slice(0, 90),
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: [
      { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: discord.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] },
      { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
      ...[...config.commandOwnerIds].map((id) => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] })),
    ],
  });
  purchaseTicketStore.addTicket(interaction.guild.id, { channelId: ticket.id, userId: interaction.user.id, type: 'inquiry', status: 'open', createdAt: new Date().toISOString() });
  await purchaseTicketStore.save();
  await ticket.send({
    content: `${[...config.commandOwnerIds].map((id) => `<@${id}>`).join(' ')}\n🕒 ${interaction.user} さん、**管理者が応答するまでしばらくお待ちください。**`,
    embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('💬 利用権についての問い合わせ')
      .setDescription('内容をこのチャンネルへ送信してください。管理者が確認後にご案内します。')
      .setFooter({ text: '誤って作成した場合は下のボタンから削除できます。' })],
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('purchase:delete').setLabel('チケットを削除').setEmoji('🗑️').setStyle(ButtonStyle.Danger))],
    allowedMentions: { users: [interaction.user.id, ...config.commandOwnerIds] },
  });
  await writePurchaseTicketLog({ title: '問い合わせチケットを作成', description: `${interaction.user} が利用権についての問い合わせチケットを作成しました。`, fields: [{ name: 'チケット', value: `${ticket}（\`${ticket.id}\`）` }, { name: 'ユーザーID', value: `\`${interaction.user.id}\`` }], color: 0x57f287 });
  return interaction.editReply({ content: `✅ 問い合わせチケットを作成しました: ${ticket}` });
}

const ASSET_CATEGORIES = Object.freeze({
  avatar: { label: 'アバター', emoji: '🧍' },
  clothing: { label: '服・衣装', emoji: '👕' },
  hair: { label: '髪', emoji: '💇' },
  shader: { label: 'シェーダー', emoji: '✨' },
});

const ASSET_FORUM_DEFAULT_NAMES = Object.freeze({
  avatar: 'アバター',
  clothing: '洋服',
  hair: '髪',
  shader: 'シェーダー',
});

// 既存の4つの標準フォーラム。クラウドへ移行した際に data の対応IDが
// 欠落・古い値になっても、保存パネルから安全に復旧できるようにする。
const ASSET_FORUM_DEFAULT_CHANNEL_IDS = Object.freeze({
  avatar: '1543399071740461179',
  clothing: '1543399073418321984',
  hair: '1543399074923810926',
  shader: '1543399076308062258',
});
const ASSET_FORUM_RECOVERY_CHANNEL_IDS = Object.freeze(['1543556347793244170', '1546914503709556908']);

async function resolveAssetForumCategory(guild, panelChannel, selectedCategory, settings) {
  const candidates = [selectedCategory?.id, panelChannel?.parentId, ...Object.values(settings.categoryChannelIds || {})]
    .filter(Boolean);
  for (const candidate of candidates) {
    const channel = await guild.channels.fetch(candidate).catch(() => null);
    if (channel?.type === ChannelType.GuildCategory) return channel;
    if (channel?.parentId) {
      const parent = await guild.channels.fetch(channel.parentId).catch(() => null);
      if (parent?.type === ChannelType.GuildCategory) return parent;
    }
  }
  const defaultCategory = await guild.channels.fetch(ASSET_STORAGE_CATEGORY_ID).catch(() => null);
  if (defaultCategory?.type === ChannelType.GuildCategory) return defaultCategory;
  throw new Error('フォーラムを作成するカテゴリを選択してください。');
}

async function createAssetForum(guild, categoryId, parentCategory, name = ASSET_FORUM_DEFAULT_NAMES[categoryId]) {
  const category = ASSET_CATEGORIES[categoryId];
  if (!category) throw new Error('保存カテゴリが正しくありません。');
  return guild.channels.create({
    name: name.slice(0, 100),
    type: ChannelType.GuildForum,
    parent: parentCategory.id,
    reason: `あまねのアセット保存先: ${category.label}`,
  });
}

async function ensureAssetForums(guild, parentCategory, settings) {
  const categoryChannelIds = { ...(settings.categoryChannelIds || {}) };
  for (const categoryId of Object.keys(ASSET_CATEGORIES)) {
    const configuredId = categoryChannelIds[categoryId];
    const fallbackId = ASSET_FORUM_DEFAULT_CHANNEL_IDS[categoryId];
    let existing = configuredId && await guild.channels.fetch(configuredId).catch(() => null);
    if (existing?.type !== ChannelType.GuildForum && fallbackId && fallbackId !== configuredId) {
      existing = await guild.channels.fetch(fallbackId).catch(() => null);
    }
    if (existing?.type === ChannelType.GuildForum) {
      categoryChannelIds[categoryId] = existing.id;
      continue;
    }
    const forum = await createAssetForum(guild, categoryId, parentCategory);
    categoryChannelIds[categoryId] = forum.id;
  }
  return categoryChannelIds;
}

async function reconcileAssetStorageForums(guild, settings, panelChannel) {
  const parentCategory = await resolveAssetForumCategory(guild, panelChannel, null, settings);
  const categoryChannelIds = await ensureAssetForums(guild, parentCategory, settings);
  const changed = Object.entries(categoryChannelIds).some(([categoryId, channelId]) => settings.categoryChannelIds?.[categoryId] !== channelId);
  const updated = changed ? assetStorageStore.configure(guild.id, { categoryChannelIds }) : settings;
  if (changed) await assetStorageStore.save();
  return updated;
}

function buildAssetStoragePanel(settings) {
  const destinations = Object.entries(ASSET_CATEGORIES).map(([id, category]) => `${category.emoji} **${category.label}**`).join('　');
  const customDestinations = (settings.customForumChannelIds || []).map((channelId) => `<#${channelId}>`).join('　') || 'なし';
  return {
    embeds: [new EmbedBuilder().setColor(0x7b61ff).setTitle('🗃️ 正規アセット保管庫')
      .setDescription('╭─ **アセット保存チケット** ─╮\n対応アバター・カテゴリを選び、必要に応じて公式BOOTH URLを記録してフォーラム投稿を作成します。\n╰──────────────────╯')
      .addFields(
        { name: '📌 保存カテゴリ', value: destinations },
        { name: '➕ 追加済み保管フォーラム', value: customDestinations },
        { name: '🧩 対応アバター', value: settings.avatars.map((avatar) => `・${avatar}`).join('\n').slice(0, 1_000) || '保存時にアバター名を入力' },
        { name: '⚖️ 保管ルール', value: 'ご自身が作成・購入、または再配布を明示的に許可されたファイルだけを保存してください。外部サイトからの自動取得・転載は行いません。' },
        { name: '📎 フォーラム添付の保管', value: 'すべてのフォーラム投稿の添付を自動保管します。100MB以下はBotが同じ投稿へ再送付し、100MB超を含む投稿はDiscordの転送として保管後、元投稿を削除します。分割ZIP（例: `.zip.001`）も各ファイルをそのまま処理します。' },
        { name: '🛠️ 保存先の自動確認', value: '保存を開始するたびに、アバター・洋服・髪・シェーダーの保存先フォーラムを再照合します。設定が古い場合も、利用可能な既存フォーラムへ自動で復旧します。' },
        { name: '➕ 新しい保管フォーラム', value: '「保管フォーラムを作成」から名前を入力すると、このカテゴリ内に作成され、すぐにファイル保管の対象になります。作成はチャンネル管理権限を持つ管理者だけが行えます。' },
      ).setFooter({ text: 'あまね • 正規保有アセット管理' })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('asset:start').setLabel('アセットを保存する').setStyle(ButtonStyle.Primary).setEmoji('🗃️'),
      new ButtonBuilder().setCustomId('asset:forum:create').setLabel('保管フォーラムを作成').setStyle(ButtonStyle.Secondary).setEmoji('➕'),
    )],
  };
}

async function recoverAssetCustomForums(guild, settings) {
  if (!guild.channels.cache.has(ASSET_STORAGE_PANEL_CHANNEL_ID)) return settings;
  const recoveredIds = ASSET_FORUM_RECOVERY_CHANNEL_IDS.filter((id) => guild.channels.cache.get(id)?.type === ChannelType.GuildForum);
  const customForumChannelIds = [...new Set([...(settings.customForumChannelIds || []), ...recoveredIds])];
  if (customForumChannelIds.length === (settings.customForumChannelIds || []).length) return settings;
  const updated = assetStorageStore.configure(guild.id, { customForumChannelIds });
  await assetStorageStore.save();
  return updated;
}

async function assetCategoryOptions(guild, settings, member) {
  const standardOptions = Object.entries(ASSET_CATEGORIES).map(([value, category]) => ({ label: category.label, value, emoji: category.emoji, description: `${category.label}用の保存先を選びます` }));
  // パネルから追加したフォーラムも、通常カテゴリと同じ選択画面から選べるようにする。
  // すでに削除された保存先は候補に出さず、選択後の失敗を防止する。
  const customOptions = (settings.customForumChannelIds || []).map((forumId) => {
    const forum = guild.channels.cache.get(forumId);
    if (forum?.type !== ChannelType.GuildForum || !forum.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)) return null;
    return {
      label: `追加: ${forum.name}`.slice(0, 100),
      value: `forum-${forum.id}`,
      emoji: '📁',
      description: '追加した保管フォーラムへ保存します',
    };
  }).filter(Boolean);
  return [...standardOptions, ...customOptions].slice(0, 25);
}

function resolveAssetDestination(settings, destinationId) {
  const category = ASSET_CATEGORIES[destinationId];
  if (category) return { categoryId: destinationId, ...category, forumId: settings.categoryChannelIds?.[destinationId], avatarRequired: destinationId !== 'shader' };
  const customForumId = destinationId.startsWith('forum-') ? destinationId.slice('forum-'.length) : null;
  if (customForumId && (settings.customForumChannelIds || []).includes(customForumId)) {
    return { categoryId: destinationId, label: '追加フォーラム', emoji: '📁', forumId: customForumId, avatarRequired: false };
  }
  return null;
}

function parseAvatarList(value) {
  const avatars = [...new Set(value.split('|').map((avatar) => avatar.trim()).filter(Boolean))];
  if (!avatars.length || avatars.length > 25 || avatars.some((avatar) => avatar.length > 100)) throw new Error('対応アバターは1〜25件、各100文字以内で `|` 区切りにしてください。');
  return avatars;
}

function parseOptionalAvatarList(value, fallback) {
  if (!value?.trim()) return fallback;
  return parseAvatarList(value);
}

function isOfficialBoothUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'booth.pm' || url.hostname.endsWith('.booth.pm'));
  } catch {
    return false;
  }
}

function buildAssetSaveModal(categoryId, avatarIndex = null, { avatarRequired = categoryId !== 'shader' } = {}) {
  const customAvatar = avatarIndex === null;
  const fields = [
    ...(customAvatar ? [new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('avatar').setLabel(avatarRequired ? '対応アバター名' : '対応アバター名（任意）').setPlaceholder(avatarRequired ? '例: 桔梗' : '共通アセットの場合は空欄で可').setStyle(TextInputStyle.Short).setRequired(avatarRequired).setMaxLength(100))] : []),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('商品・アセット名').setPlaceholder('例: Sample Outfit').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('booth-url').setLabel('公式BOOTH商品URL（任意）').setPlaceholder('https://booth.pm/ja/items/1234567').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(500)),
  ];
  return new ModalBuilder().setCustomId(`asset:save:${categoryId}:${customAvatar ? 'custom' : avatarIndex}`).setTitle('アセット情報を登録').addComponents(fields);
}

function buildAssetForumCreateModal() {
  return new ModalBuilder().setCustomId('asset:forum:create').setTitle('保管フォーラムを作成').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('フォーラム名').setPlaceholder('例: アバター追加分').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(100)),
  );
}

async function createCustomAssetForum(guild, panelChannel, settings, name) {
  const parentCategory = await resolveAssetForumCategory(guild, panelChannel, null, settings);
  const forum = await guild.channels.create({
    name: name.trim().slice(0, 100),
    type: ChannelType.GuildForum,
    parent: parentCategory.id,
    reason: 'あまねの保管パネルから作成された追加フォーラム',
  });
  const customForumChannelIds = [...new Set([...(settings.customForumChannelIds || []), forum.id])];
  const updated = assetStorageStore.configure(guild.id, { customForumChannelIds });
  await assetStorageStore.save();
  await publishAssetStoragePanel(guild, updated);
  return forum;
}

async function publishAssetStoragePanel(guild, settings) {
  const channel = await getTextChannel(settings.panelChannelId);
  if (!channel?.isSendable()) throw new Error('アセット保存パネルの投稿先チャンネルに送信できません。');
  const existing = await fetchOwnedPanelMessage(channel, settings.panelMessageId);
  if (existing) {
    await existing.edit(buildAssetStoragePanel(settings));
    return existing;
  }
  const message = await channel.send(buildAssetStoragePanel(settings));
  assetStorageStore.configure(guild.id, { panelMessageId: message.id });
  await assetStorageStore.save();
  return message;
}

async function createAssetStorageThread(interaction, { categoryId, avatar, name, boothUrl }) {
  let settings = assetStorageStore.get(interaction.guild.id);
  let destination = resolveAssetDestination(settings, categoryId);
  if (!destination) throw new Error('保存カテゴリが正しくありません。');
  const panelChannel = settings.panelChannelId && await interaction.guild.channels.fetch(settings.panelChannelId).catch(() => null);
  // 追加フォーラムを選んだ場合は、無関係な標準フォーラムの復旧処理を行わない。
  if (ASSET_CATEGORIES[categoryId]) {
    try {
      settings = await reconcileAssetStorageForums(interaction.guild, settings, panelChannel);
      destination = resolveAssetDestination(settings, categoryId);
    } catch (error) {
      if (error?.code === 50013 || error?.status === 403) {
        throw new Error('保存先フォーラムを復旧できません。Botに「チャンネルを管理」と「チャンネルを見る」権限を付与してください。');
      }
      throw error;
    }
  }
  const parent = discord.channels.cache.get(destination.forumId) || await discord.channels.fetch(destination.forumId).catch(() => null);
  if (parent?.type !== ChannelType.GuildForum) throw new Error(`${destination.label}の保存先フォーラムを利用できません。設定を確認してください。`);
  const asset = {
    id: crypto.randomUUID().slice(0, 12),
    name,
    boothUrl,
    categoryId,
    avatar,
    expectedFiles: [],
    createdByUserId: interaction.user.id,
    createdAt: Date.now(),
  };
  const thread = await parent.threads.create({
    // フォーラム一覧では商品名をそのまま見せ、本文のBOOTHプレビューを主役にする。
    name: name.slice(0, 100),
    autoArchiveDuration: 10_080,
    reason: `あまねの正規アセット保管: ${name}`,
    ...(parent.type === ChannelType.GuildForum ? { message: buildAssetThreadMessage(destination, asset) } : {}),
  });
  asset.threadId = thread.id;
  assetStorageStore.addAsset(interaction.guild.id, asset);
  await assetStorageStore.save();
  if (parent.type !== ChannelType.GuildForum) await thread.send(buildAssetThreadMessage(destination, asset));
  return thread;
}

function buildAssetThreadMessage(category, asset) {
  // Discord標準のURLプレビューを使うため、ここでは独自Embedを重ねない。
  // フォーラムカードにもBOOTHのサムネイルがそのまま表示される。
  return {
    content: asset.boothUrl || `**${asset.name}**\n> 公式BOOTH URLは未登録です。`,
    allowedMentions: { parse: [] },
  };
}

function buildMbtiPanel(panel = {}, guildId = null) {
  const custom = guildId === AMA_GUILD_ID ? MBTI_CUSTOM_EMOJIS : null;
  const title = panel.title || '✨ MBTI タイプチェック';
  const description = panel.description || '20問の質問に5段階で答えると、あなたの回答傾向に合ったMBTIタイプとサーバー内ロールを受け取れます。';
  return {
    embeds: [new EmbedBuilder().setColor(0xc36bff).setTitle(title).setDescription(`## あなたの考え方をチェック\n${description}`)
      .addFields(
        { name: '🧭 4つの傾向', value: '外向 E / 内向 I　•　感覚 S / 直観 N\n思考 T / 感情 F　•　判断 J / 知覚 P' },
        { name: '🎲 回答方法', value: '**全20問・5段階回答**\n左右の説明を読み、自分に近いボタンを選んでください。質問の順番は毎回変わります。' },
        { name: '↩️ 見直し・再開', value: '「ひとつ戻る」で回答を修正できます。画面を閉じた場合は、下のボタンから進行中の診断を再開・リセットできます（有効期限内）。' },
        { name: '📩 結果と回数', value: `結果は本人DMにも届きます。診断は日本時間で**1日${MBTI_DAILY_LIMIT}回まで**です。` },
      ).setFooter({ text: '所要時間: 約3〜5分　•　自己理解のための簡易チェックです' })],
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('mbti:start').setLabel('診断を始める・再開する').setStyle(ButtonStyle.Primary).setEmoji(custom?.start || '🧭'))],
  };
}

function buildMbtiQuestion(session) {
  const question = session.questions[session.index];
  const number = session.index + 1;
  const progress = `${'▰'.repeat(Math.ceil(number / 2))}${'▱'.repeat(10 - Math.ceil(number / 2))}`;
  const custom = session.guildId === AMA_GUILD_ID ? MBTI_CUSTOM_EMOJIS.start : '🧭';
  const questionPanel = [
    '╭─ ❔ **質問** ─────────────────',
    `**${question.emoji} ${question.prompt}**`,
    '╰──────────────────────────',
  ].join('\n');
  return {
    embeds: [new EmbedBuilder().setColor(0xc36bff).setTitle(`🧠 MBTIチェック　${number}/${MBTI_QUESTIONS.length}`).setDescription(questionPanel)
      .addFields(
        { name: '◀ 左側', value: question.left.label, inline: true },
        { name: '▶ 右側', value: question.right.label, inline: true },
        { name: '🎚️ 選び方', value: '自分に近い方向と程度を、下の5段階から選択してください。迷ったら「中立」を選べます。\n------------' },
      )
      .setFooter({ text: `進行状況　${progress}　${number}/${MBTI_QUESTIONS.length}　•　戻るボタンで回答を修正できます` })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mbti:answer:${session.id}:1`).setLabel('← とても近い').setStyle(ButtonStyle.Primary).setEmoji(custom),
      new ButtonBuilder().setCustomId(`mbti:answer:${session.id}:2`).setLabel('← やや近い').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`mbti:answer:${session.id}:3`).setLabel('中立').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`mbti:answer:${session.id}:4`).setLabel('やや近い →').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`mbti:answer:${session.id}:5`).setLabel('とても近い →').setStyle(ButtonStyle.Primary).setEmoji(custom),
    ), new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mbti:back:${session.id}`).setLabel('ひとつ戻る').setStyle(ButtonStyle.Danger).setEmoji('↩️').setDisabled(session.index === 0),
    )],
  };
}

function buildMbtiResumePrompt(session) {
  return {
    embeds: [new EmbedBuilder().setColor(0xc36bff).setTitle('🧠 進行中のMBTI診断があります')
      .setDescription(`現在 **${session.index}/${session.questions.length}問** まで回答済みです。\n削除した診断画面も、ここから安全に再表示できます。`)
      .addFields({ name: '選択してください', value: '「続きから再開」は回答状況を保持します。\n「最初からやり直す」は回答をリセットし、1問目から開始します。' })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mbti:resume:${session.id}`).setLabel('続きから再開').setEmoji('▶️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`mbti:reset:${session.id}`).setLabel('最初からやり直す').setEmoji('🔄').setStyle(ButtonStyle.Danger),
    )],
  };
}

function responseCadence(answerTimes) {
  const averageMs = answerTimes.reduce((sum, value) => sum + value, 0) / Math.max(answerTimes.length, 1);
  if (averageMs < 2_000) return { label: '早め', detail: '回答がかなり速かったため、結果を参考にしつつ必要ならもう一度落ち着いて回答してください。' };
  if (averageMs > 20_000) return { label: 'じっくり', detail: '各設問を十分に考えて回答した記録です。' };
  return { label: '標準', detail: '自然なペースで回答した記録です。' };
}

function buildMbtiResult(type, role, cadence = null) {
  const cadenceField = cadence ? [{ name: '⏱️ 回答ペース', value: `**${cadence.label}** — ${cadence.detail}` }] : [];
  return {
    embeds: [new EmbedBuilder().setColor(type.color).setTitle(`✨ あなたのMBTIタイプ: ${type.code}`).setDescription(`╭─ **${type.title}** ─╮\n${type.description}\n╰────────────────╯`)
      .addFields(
        { name: '🏷️ 付与ロール', value: role.toString(), inline: true },
        { name: '💡 楽しみ方', value: '同じタイプのメンバー探しや、プロフィールでの交流に活用できます。', inline: true },
        ...cadenceField,
      ).setFooter({ text: '結果は自己理解のための傾向です。医学的・心理学的な診断ではありません。' })],
    components: [],
  };
}

function buildMbtiWelcomePanel(member, type, role) {
  return {
    allowedMentions: { users: [member.id], roles: [] },
    embeds: [new EmbedBuilder().setColor(type.color).setTitle(`${member.guild.id === AMA_GUILD_ID ? `${MBTI_CUSTOM_EMOJIS.welcome} ` : ''}🎉 MBTIタイプが決まりました！`)
      .setDescription(`${member} さんは **${role.name}** でした！\n\n同じタイプのメンバーとも、ぜひ交流してみてください。`)
      .addFields(
        { name: 'MBTIタイプ', value: `**${type.code}** — ${type.title}`, inline: true },
        { name: '付与ロール', value: role.name, inline: true },
      ).setThumbnail(member.user.displayAvatarURL({ size: 256 })).setFooter({ text: 'あまね • MBTI タイプチェック' }).setTimestamp()],
  };
}

async function sendMbtiWelcome(member, type, role) {
  if (!config.mbtiWelcomeChannelId) return;
  const channel = await getTextChannel(config.mbtiWelcomeChannelId);
  if (!channel?.isSendable()) {
    console.warn('MBTI歓迎パネルの投稿先チャンネルが見つからないか、送信できません。');
    return;
  }
  await channel.send(buildMbtiWelcomePanel(member, type, role));
}

async function sendMbtiResultDm(member, type, role, cadence) {
  const result = buildMbtiResult(type, role, cadence);
  if (member.guild.id === AMA_GUILD_ID) result.embeds[0].setTitle(`${MBTI_CUSTOM_EMOJIS.cheer} ${result.embeds[0].data.title}`);
  await sendTrackedDm(member, { ...result, allowedMentions: { users: [], roles: [] } });
}

async function sendMbtiResultLog(member, type, role, cadence) {
  const channel = await getBotInstallLogChannel();
  if (!channel) return;
  await channel.send({ embeds: [new EmbedBuilder().setColor(type.color).setTitle('🧠 MBTI診断結果')
    .setDescription(`${member} さんがMBTI診断を完了しました。`)
    .addFields(
      { name: 'ユーザー', value: `${member.user.tag}（\`${member.id}\`）`, inline: true },
      { name: '結果', value: `**${type.code}｜${type.title}**`, inline: true },
      { name: 'ロール', value: role.toString(), inline: true },
      { name: '回答ペース', value: cadence.label, inline: true },
    ).setThumbnail(member.user.displayAvatarURL({ size: 128 })).setTimestamp()], allowedMentions: { users: [], roles: [] } });
}

async function ensureMbtiRoles(guild) {
  const botMember = guild.members.me || await guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error('MBTIロールを付与するには、Botに「ロールを管理」権限が必要です。');
  const roles = await guild.roles.fetch();
  const result = new Map();
  const missing = [];
  for (const type of MBTI_TYPES) {
    const role = roles.find((candidate) => candidate.name === `${type.code}｜${type.title}` || candidate.name === mbtiRoleName(type.code));
    if (!role) { missing.push(`${type.code}｜${type.title}`); continue; }
    if (role.managed || role.position >= botMember.roles.highest.position) throw new Error(`${role.name} をBotより下位に配置してください。`);
    result.set(type.code, role);
  }
  if (missing.length) throw new Error(`MBTIロールが不足しています: ${missing.join('、')}`);
  return result;
}

async function refreshMbtiPanel(guild, { recreateMissing = false, updateExisting = true } = {}) {
  const settings = mbtiPanelStore.get(guild.id);
  if (!settings.channelId || !settings.messageId) throw new Error('更新するMBTI診断パネルが未登録です。先に `/mbti-panel create` を実行してください。');
  const channel = await getTextChannel(settings.channelId);
  if (!channel?.isSendable()) throw new Error('MBTI診断パネルの投稿先チャンネルに送信できません。');
  const message = await fetchOwnedPanelMessage(channel, settings.messageId);
  if (message) {
    if (updateExisting) await message.edit(buildMbtiPanel(settings, guild.id));
    return { channel, message, repaired: false };
  }
  if (!recreateMissing) throw new Error('投稿済みMBTI診断パネルが見つかりません。`/mbti-panel create` で作り直してください。');
  const recreated = await channel.send(buildMbtiPanel(settings, guild.id));
  mbtiPanelStore.setPanel(guild.id, channel.id, recreated.id);
  await mbtiPanelStore.save();
  return { channel, message: recreated, repaired: true };
}

function createMbtiSession(guildId, userId) {
  const questions = [...MBTI_QUESTIONS];
  for (let index = questions.length - 1; index > 0; index -= 1) {
    const replacement = Math.floor(Math.random() * (index + 1));
    [questions[index], questions[replacement]] = [questions[replacement], questions[index]];
  }
  return { id: crypto.randomUUID().slice(0, 12), guildId, userId, index: 0, answers: [], answerTimes: [], questions, questionShownAt: Date.now(), expiresAt: Date.now() + 15 * 60_000 };
}

async function startMbtiCheck(interaction) {
  if (!interaction.inGuild()) throw new Error('MBTIタイプチェックはサーバー内のパネルから利用してください。');
  const active = [...mbtiSessions.values()].find((entry) => entry.guildId === interaction.guildId && entry.userId === interaction.user.id && entry.expiresAt > Date.now());
  if (active) return interaction.reply({ ephemeral: true, ...buildMbtiResumePrompt(active) });
  if (!mbtiAttemptStore.canStart(interaction.user.id)) return interaction.reply({ ephemeral: true, content: `MBTI診断は日本時間で1日${MBTI_DAILY_LIMIT}回までです。明日になってからもう一度お試しください。` });
  mbtiAttemptStore.record(interaction.user.id);
  await mbtiAttemptStore.save();
  const session = createMbtiSession(interaction.guildId, interaction.user.id);
  mbtiSessions.set(session.id, session);
  return interaction.reply({ ephemeral: true, ...buildMbtiQuestion(session) });
}

async function resumeMbtiCheck(interaction) {
  const [, , sessionId] = interaction.customId.split(':');
  const session = mbtiSessions.get(sessionId);
  if (!session || session.userId !== interaction.user.id || session.guildId !== interaction.guildId || session.expiresAt < Date.now()) {
    mbtiSessions.delete(sessionId);
    return interaction.update({ content: '進行中の診断は期限切れです。パネルから新しく開始してください。', embeds: [], components: [] });
  }
  session.questionShownAt = Date.now();
  return interaction.update(buildMbtiQuestion(session));
}

async function resetMbtiCheck(interaction) {
  const [, , sessionId] = interaction.customId.split(':');
  const current = mbtiSessions.get(sessionId);
  if (!current || current.userId !== interaction.user.id || current.guildId !== interaction.guildId || current.expiresAt < Date.now()) {
    mbtiSessions.delete(sessionId);
    return interaction.update({ content: '進行中の診断は期限切れです。パネルから新しく開始してください。', embeds: [], components: [] });
  }
  mbtiSessions.delete(sessionId);
  const session = createMbtiSession(interaction.guildId, interaction.user.id);
  mbtiSessions.set(session.id, session);
  return interaction.update(buildMbtiQuestion(session));
}

async function answerMbtiQuestion(interaction) {
  const [, , sessionId, choice] = interaction.customId.split(':');
  const session = mbtiSessions.get(sessionId);
  if (!session || session.userId !== interaction.user.id || session.guildId !== interaction.guildId || session.expiresAt < Date.now()) {
    mbtiSessions.delete(sessionId);
    return interaction.reply({ ephemeral: true, content: 'このMBTIチェックは有効期限が切れました。パネルからもう一度開始してください。' });
  }
  if (session.completing) return interaction.reply({ ephemeral: true, content: '診断結果を処理中です。そのままお待ちください。' });
  if (!['1', '2', '3', '4', '5'].includes(choice)) throw new Error('回答内容が正しくありません。');
  session.answerTimes.push(Math.max(0, Date.now() - session.questionShownAt));
  session.answers.push(choice);
  session.index += 1;
  if (session.index < session.questions.length) {
    session.questionShownAt = Date.now();
    return interaction.update(buildMbtiQuestion(session));
  }

  // ロール取得や付与はDiscord API通信を伴うため、20問目だけは先に操作を受理する。
  // これにより3秒のInteraction応答期限を超えても結果画面を確実に更新できる。
  session.completing = true;
  try {
    await interaction.deferUpdate();
    const code = calculateMbti(session.answers, session.questions);
    const type = mbtiType(code);
    const cadence = responseCadence(session.answerTimes);
    const roles = await ensureMbtiRoles(interaction.guild);
    const targetRole = roles.get(code);
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const oldMbtiRoles = [...roles.values()].filter((role) => role.id !== targetRole.id && member.roles.cache.has(role.id));
    if (oldMbtiRoles.length) await member.roles.remove(oldMbtiRoles, 'MBTIタイプチェックの結果更新');
    await member.roles.add(targetRole, 'MBTIタイプチェックの結果付与');
    await interaction.editReply(buildMbtiResult(type, targetRole, cadence));
    mbtiSessions.delete(sessionId);
    await sendMbtiResultDm(member, type, targetRole, cadence).catch((error) => console.warn(`MBTI結果DMを送れませんでした (${member.user.tag}):`, error.message));
    await sendMbtiResultLog(member, type, targetRole, cadence).catch((error) => console.warn(`MBTI結果ログを送れませんでした (${member.user.tag}):`, error.message));
  } catch (error) {
    // 一時的な通信・権限エラーなら、最後の回答だけを戻して診断を再開可能にする。
    session.completing = false;
    session.index -= 1;
    session.answers.pop();
    session.answerTimes.pop();
    session.questionShownAt = Date.now();
    throw error;
  }
}

async function backMbtiQuestion(interaction) {
  const [, , sessionId] = interaction.customId.split(':');
  const session = mbtiSessions.get(sessionId);
  if (!session || session.userId !== interaction.user.id || session.guildId !== interaction.guildId || session.expiresAt < Date.now()) {
    mbtiSessions.delete(sessionId);
    return interaction.reply({ ephemeral: true, content: 'このMBTIチェックは有効期限が切れました。パネルからもう一度開始してください。' });
  }
  if (session.index === 0) return interaction.reply({ ephemeral: true, content: '最初の質問です。戻ることはできません。' });
  session.index -= 1;
  session.answers.pop();
  session.answerTimes.pop();
  session.questionShownAt = Date.now();
  return interaction.update(buildMbtiQuestion(session));
}

function validateOptionalHttpsUrl(value, label) {
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label}は HTTPS URL で指定してください。`); }
  if (url.protocol !== 'https:') throw new Error(`${label}は HTTPS URL で指定してください。`);
  return url.toString();
}

async function writeMemberLog(member, joined) {
  const settings = serverSettingsStore.get(member.guild.id);
  if (!settings.memberLogChannelId) return;
  const channel = await getTextChannel(settings.memberLogChannelId);
  if (!channel) return;
  const title = joined ? '📥 メンバーが入室しました' : '📤 メンバーが退出しました';
  const color = joined ? 0x57f287 : 0xed4245;
  await channel.send({ embeds: [new EmbedBuilder().setColor(color).setTitle(title).setThumbnail(member.user.displayAvatarURL({ size: 256 })).addFields(
    { name: 'ユーザー', value: `${member.user}（${member.user.tag}）` },
    { name: 'ユーザーID', value: member.user.id, inline: true },
    { name: 'アカウント作成日', value: `<t:${Math.floor(member.user.createdTimestamp / 1_000)}:F>`, inline: true },
    { name: joined ? '入室日時' : '在籍開始日時', value: `<t:${Math.floor((joined ? Date.now() : member.joinedTimestamp || Date.now()) / 1_000)}:F>`, inline: true },
  ).setTimestamp()] });
}

function readWholeNumber(value, label, min, max) {
  if (!/^\d+$/.test(value.trim())) throw new Error(`${label}は整数で入力してください。`);
  const parsed = Number(value);
  if (parsed < min || parsed > max) throw new Error(`${label}は${min}〜${max}の範囲で入力してください。`);
  return parsed;
}

async function getVerifiedMember(guildId, userId) {
  const guild = await discord.guilds.fetch(guildId);
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) throw new Error('サーバーに在籍していないため認証できません。');
  if (guestAccess.isGuest(member)) throw new Error('VCゲストは認証不要です。認証ロールの付与は行いません。');
  return { guild, member };
}

async function beginVerification(interaction, { guildId, roleId }) {
  const { guild, member } = await getVerifiedMember(guildId, interaction.user.id);
  const role = await guild.roles.fetch(roleId).catch(() => null);
  if (!role || role.managed) throw new Error('認証用ロールが見つからないか、付与できないロールです。');
  const botMember = guild.members.me || await guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error('Botに「ロールを管理」権限がありません。');
  if (role.position >= botMember.roles.highest.position) throw new Error('認証ロールをBotの最高ロールより下位に移動してください。');
  if (member.roles.cache.has(role.id)) return interaction.reply({ ephemeral: interaction.inGuild(), content: `すでに ${role} を持っています。` });

  const challenge = createMathChallenge();
  const challengeId = crypto.randomUUID().slice(0, 12);
  verificationChallenges.set(challengeId, { answer: challenge.answer, guildId: guild.id, roleId: role.id, userId: interaction.user.id, expiresAt: Date.now() + 5 * 60_000 });
  return interaction.reply({
    ...(interaction.inGuild() ? { ephemeral: true } : {}),
    embeds: [new EmbedBuilder().setColor(0xf28ac0).setTitle('🛡️ 認証チャレンジ').setDescription(`次の計算式の答えを選んでください。\n\n## ${challenge.question}\n\n制限時間は5分です。`).setFooter({ text: '正しい答えを1つ選んでください' })],
    components: [new ActionRowBuilder().addComponents(challenge.choices.map((choice) => new ButtonBuilder().setCustomId(`verify:choice:${challengeId}:${choice}`).setLabel(String(choice)).setStyle(ButtonStyle.Secondary)))],
  });
}

async function completeVerification(interaction, challenge) {
  const { guild, member } = await getVerifiedMember(challenge.guildId, interaction.user.id);
  const role = await guild.roles.fetch(challenge.roleId).catch(() => null);
  if (!role) throw new Error('付与対象ロールが見つかりません。');
  const botMember = guild.members.me || await guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error('Botに「ロールを管理」権限がありません。');
  if (role.position >= botMember.roles.highest.position) throw new Error('付与ロールをBotの最高ロールより下位に移動してください。');
  await member.roles.add(role);
  await writeCentralAuditLog({ title: '認証ロール付与', description: `**${guild.name}** で認証ロールを付与しました。`, fields: [{ name: 'ユーザーID', value: member.id, inline: true }, { name: 'ロール', value: role.toString(), inline: true }], color: 0x57f287 });
  return interaction.reply({
    ...(interaction.inGuild() ? { ephemeral: true } : {}),
    embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('🎉 認証成功！').setDescription(`${chooseRandom(WELCOME_MESSAGES)}\n\n${role} を付与しました。サーバーのチャンネルをお楽しみください！`).setFooter({ text: guild.name })],
  });
}

// Cloud hosts may run without a DISCORD_GUILD_ID environment variable.
// The fixed primary guild remains eligible for panels, logs, and updates in
// that case; external servers are still excluded.
function tracksGuild(guild) {
  return Boolean(guild) && (guild.id === config.discordGuildId || guild.id === AMA_GUILD_ID);
}

function formatLicenseExpiry(expiresAt) {
  return expiresAt ? `<t:${Math.floor(expiresAt / 1_000)}:D>（<t:${Math.floor(expiresAt / 1_000)}:R>）` : '期限なし';
}

async function expireDueLicenses() {
  const expired = commandAccessStore.expireDue();
  if (!expired.length) return expired;
  await commandAccessStore.save();
  await Promise.all(expired.map(async ({ userId }) => {
    const user = await discord.users.fetch(userId).catch(() => null);
    if (!user) return;
    await sendTrackedDm(user, { embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('🔒 あまねの利用権が終了しました')
      .setDescription('利用権の期限を過ぎたため、Botのコマンド利用を停止しました。更新をご希望の場合は、利用権購入窓口からお手続きください。')
      .setFooter({ text: '更新後は自動的に利用を再開できます。' })], allowedMentions: { parse: [] } }).catch((error) => console.warn(`利用権終了DMを送信できません (${userId}):`, error.message));
  }));
  await writeCentralAuditLog({
    title: '利用権の期限切れを自動処理',
    description: `${expired.length}件の期限切れ利用権を解除しました。`,
    fields: expired.slice(0, 20).map(({ userId, expiresAt }) => ({ name: '対象ユーザーID', value: `\`${userId}\`\n期限: ${formatLicenseExpiry(expiresAt)}`, inline: true })),
    color: 0xfee75c,
  });
  return expired;
}

async function repairManagedPanels() {
  // A managed panel is a living UI, not a one-off post.  Earlier versions only
  // recreated messages that had disappeared, which left old buttons and copy
  // behind when the message itself still existed.  Always render the current
  // payload into Bot-owned messages and recreate only when the tracked message
  // cannot be found.
  const summary = { updated: 0, recreated: 0, unavailable: 0 };
  const inspect = async (operation) => {
    try {
      const outcome = await operation();
      summary[outcome === 'recreated' ? 'recreated' : 'updated'] += 1;
    } catch (error) {
      summary.unavailable += 1;
      console.warn('パネル自己修復を保留しました:', error.message);
    }
  };

  for (const guild of discord.guilds.cache.values()) {
    const mbti = mbtiPanelStore.get(guild.id);
    if (mbti.channelId && mbti.messageId) await inspect(async () => ((await refreshMbtiPanel(guild, { recreateMissing: true, updateExisting: true })).repaired ? 'recreated' : 'updated'));

    const assets = assetStorageStore.get(guild.id);
    if (assets.panelChannelId) await inspect(async () => {
      const channel = await getTextChannel(assets.panelChannelId);
      if (!channel?.isSendable()) throw new Error('アセット保存パネルの投稿先を利用できません。');
      const message = await fetchOwnedPanelMessage(channel, assets.panelMessageId);
      await publishAssetStoragePanel(guild, assets);
      return message ? 'updated' : 'recreated';
    });

    const purchase = purchaseTicketStore.get(guild.id);
    if (purchase.panelChannelId) await inspect(async () => {
      const channel = await getTextChannel(purchase.panelChannelId);
      if (!channel?.isSendable()) throw new Error('利用権購入パネルの投稿先を利用できません。');
      const message = await fetchOwnedPanelMessage(channel, purchase.panelMessageId);
      await publishPurchasePanel(guild, purchase);
      return message ? 'updated' : 'recreated';
    });

    const verification = verificationSettingsStore.get(guild.id);
    if (verification?.panelChannelId) await inspect(async () => {
      const channel = await getTextChannel(verification.panelChannelId);
      if (!channel?.isSendable()) throw new Error('認証パネルの投稿先を利用できません。');
      const message = await fetchOwnedPanelMessage(channel, verification.panelMessageId);
      const role = await guild.roles.fetch(verification.roleId).catch(() => null);
      if (!role) throw new Error('認証パネルの付与ロールが見つかりません。');
      if (message) {
        await message.edit(buildVerificationPanel(role));
        return 'updated';
      }
      const recreated = await channel.send(buildVerificationPanel(role));
      verificationSettingsStore.set(guild.id, role.id, { panelChannelId: channel.id, panelMessageId: recreated.id });
      await verificationSettingsStore.save();
      return 'recreated';
    });

  }
  const mainGuild = discord.guilds.cache.get(config.discordGuildId) || discord.guilds.cache.get(AMA_GUILD_ID);
  if (mainGuild) {
    const settings = serverSettingsStore.get(mainGuild.id);
    serverSettingsStore.markPanelRepair(mainGuild.id, { summary: `${summary.updated}更新 / ${summary.recreated}再作成 / ${summary.unavailable}要確認` });
    await serverSettingsStore.save();
  }
  return summary;
}

async function sendOperationsDigest({ force = false, panelSummary = null } = {}) {
  // Keep the operations notice available even when a legacy cloud environment
  // does not yet have DISCORD_GUILD_ID configured.
  const guild = discord.guilds.cache.get(config.discordGuildId) || discord.guilds.cache.get(AMA_GUILD_ID);
  if (!guild) return false;
  const settings = serverSettingsStore.get(guild.id);
  if (!force && settings.lastOperationsDigestAt && Date.now() - settings.lastOperationsDigestAt < OPERATIONS_DIGEST_INTERVAL_MS) return false;
  const channel = await getTextChannel(OPERATIONS_DIGEST_CHANNEL_ID);
  if (!channel?.isSendable()) return false;
  const now = Date.now();
  const licenses = commandAccessStore.listDetails(now).filter((license) => !license.owner);
  const expiringSoon = licenses.filter((license) => license.expiresAt && license.expiresAt - now <= 7 * DAY_MS).length;
  const active = licenses.filter((license) => license.active).length;
  const activeTickets = Object.values(purchaseTicketStore.get(guild.id).tickets).filter((ticket) => ticket.status === 'open').length;
  const repair = panelSummary || settings.lastPanelRepairSummary || '未実行';
  const payload = { embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📊 あまね — 運用ダイジェスト')
    .setDescription('定期監視の結果です。個別のユーザー内容・DM本文・購入情報は含めません。')
    .addFields(
      { name: '🟢 稼働状態', value: `Gateway接続中｜応答遅延: ${discord.ws.ping >= 0 ? `${discord.ws.ping}ms` : '測定中'}` },
      { name: '🧩 パネル自己修復', value: repair },
      { name: '🔐 利用権', value: `有効 ${active}件｜7日以内の期限 ${expiringSoon}件\n期限確認: 1時間ごと` },
      { name: '🎫 対応待ちチケット', value: `${activeTickets}件`, inline: true },
      { name: '🧹 自動保守', value: 'DM履歴の定期削除・変換キャッシュ削除・状態パネル更新を継続中' },
    ).setFooter({ text: '次回の運用ダイジェストは約24時間後です。' }).setTimestamp(now)], allowedMentions: { parse: [] } };
  // 運用ダイジェストも管理対象パネルとして同じ投稿を更新する。起動のたびに
  // 新しい通知を増やさず、直近のBot投稿がある場合だけ安全に上書きする。
  const recent = await channel.messages.fetch({ limit: 100 });
  const existing = [...recent.values()].find((message) => message.author.id === discord.user.id && message.embeds[0]?.title === '📊 あまね — 運用ダイジェスト');
  if (existing) await existing.edit(payload);
  else await channel.send(payload);
  serverSettingsStore.markOperationsDigest(guild.id, now);
  await serverSettingsStore.save();
  return true;
}

function isVoiceMuteExempt(member, guild) {
  return !member
    || member.user.bot
    || member.id === guild.ownerId
    || member.permissions.has(PermissionFlagsBits.Administrator);
}

function observeVoiceMute(state) {
  const member = state?.member;
  const guild = state?.guild;
  if (!tracksGuild(guild) || isVoiceMuteExempt(member, guild)) {
    if (guild && member) voiceMuteGuard.clear(guild.id, member.id);
    return;
  }
  voiceMuteGuard.observe({
    guildId: guild.id,
    userId: member.id,
    channelId: state.channelId,
    selfMute: state.selfMute,
    serverMute: state.serverMute,
  });
}

async function enforceVoiceMuteDisconnects() {
  for (const candidate of voiceMuteGuard.due()) {
    const guild = discord.guilds.cache.get(candidate.guildId);
    if (!tracksGuild(guild)) {
      voiceMuteGuard.clear(candidate.guildId, candidate.userId);
      continue;
    }
    const lockKey = `${candidate.guildId}:${candidate.userId}`;
    if (voiceMuteDisconnecting.has(lockKey)) continue;
    const member = await guild.members.fetch(candidate.userId).catch(() => null);
    if (isVoiceMuteExempt(member, guild)) {
      voiceMuteGuard.clear(candidate.guildId, candidate.userId);
      continue;
    }
    const voice = member.voice;
    if (!voice.channelId || !(voice.selfMute || voice.serverMute)) {
      voiceMuteGuard.clear(candidate.guildId, candidate.userId);
      continue;
    }
    const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (!botMember || !voice.channel.permissionsFor(botMember)?.has(PermissionFlagsBits.MoveMembers)) {
      voiceMuteGuard.clear(candidate.guildId, candidate.userId);
      await reportRuntimeError('VCミュート自動切断', new Error('Botに対象VCの「メンバーを移動」権限がありません。'), [{ name: '対象ユーザーID', value: `\`${candidate.userId}\`` }, { name: 'VC', value: `${voice.channel}` }]);
      continue;
    }
    voiceMuteDisconnecting.add(lockKey);
    try {
      const voiceChannelName = voice.channel.name;
      try {
        await sendTrackedDm(member, {
          embeds: [new EmbedBuilder().setColor(0xfaa61a).setTitle('🔇 VCから自動で切断しました')
            .setDescription(`**${guild.name}** の **${voiceChannelName}** で、ミュート状態が30分間継続したためVCから切断しました。\n\n再参加は可能です。`)
            .setFooter({ text: 'あまね • VCミュート自動切断' }).setTimestamp()],
        });
      } catch (error) {
        console.warn(`VC自動切断前のDMを送れませんでした (${member.user.tag}):`, error.message);
      }
      await voice.disconnect('VC内で30分間ミュートが継続したため、自動で切断しました。');
      voiceMuteGuard.clear(candidate.guildId, candidate.userId);
      await writeCentralAuditLog({
        title: 'VCミュート自動切断',
        description: `**${guild.name}** で30分間ミュートが継続したため、VCから切断しました。`,
        fields: [
          { name: '対象ユーザー', value: `${member}（\`${member.id}\`）`, inline: true },
          { name: 'VC', value: voiceChannelName, inline: true },
          { name: 'ミュート開始', value: `<t:${Math.floor(candidate.since / 1_000)}:F>` },
        ],
        color: 0xfaa61a,
      });
    } catch (error) {
      voiceMuteGuard.clear(candidate.guildId, candidate.userId);
      await reportRuntimeError('VCミュート自動切断', error, [{ name: '対象ユーザーID', value: `\`${candidate.userId}\`` }, { name: 'VC', value: `${voice.channel}` }]);
    } finally {
      voiceMuteDisconnecting.delete(lockKey);
    }
  }
}

function seedVoiceMuteGuard(guild) {
  if (!tracksGuild(guild)) return;
  for (const state of guild.voiceStates.cache.values()) observeVoiceMute(state);
}

async function recordActivity(guild, user) {
  if (!tracksGuild(guild) || !user || user.bot) return;
  activityStore.touch(guild.id, user.id);
  await activityStore.save();
}

function inactivityKickKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

async function writeInactivityKickLog(member, activity) {
  const channel = await getTextChannel(INACTIVITY_LOG_CHANNEL_ID);
  if (!channel?.isSendable()) throw new Error(`非アクティブ退出ログの送信先 ${INACTIVITY_LOG_CHANNEL_ID} が利用できません。`);
  await channel.send({
    allowedMentions: { parse: [] },
    embeds: [new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('📤 非アクティブのため退出しました')
      .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
      .setDescription(`${member.user} は${INACTIVITY_KICK_DAYS}日間アクティブが確認できなかったため、自動的に退出しました。再入室は可能です。`)
      .addFields(
        { name: 'ユーザー', value: `${member.user.tag}（\`${member.id}\`）` },
        { name: '最終アクティブ', value: `<t:${Math.floor(activity.lastActiveAt / 1_000)}:F>`, inline: true },
        { name: '再参加', value: `[カスタムリンクを開く](${VANITY_URL})`, inline: true },
      )
      .setFooter({ text: 'あまね • 非アクティブ自動管理' })
      .setTimestamp()],
  });
}

function historyKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function getMessageHistory(guildId, userId, now = Date.now()) {
  const key = historyKey(guildId, userId);
  const history = (messageHistory.get(key) || []).filter((entry) => now - entry.at <= 10 * 60_000);
  messageHistory.set(key, history);
  return history;
}

async function writeModerationLog(message, type, action) {
  const logChannelId = moderationStore.get(message.guild.id).logChannelId;
  if (!logChannelId) return;
  const logChannel = message.guild.channels.cache.get(logChannelId);
  if (!logChannel?.isTextBased()) return;
  const preview = message.content.replaceAll(/`/g, '｀').slice(0, 500) || '（メッセージ本文を取得できません）';
  try {
    await logChannel.send({ embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('🛡️ 自動モデレーション').addFields(
      { name: '理由', value: type, inline: true },
      { name: '処置', value: action, inline: true },
      { name: '対象', value: `${message.author}（${message.author.tag}）`, inline: true },
      { name: 'チャンネル', value: `${message.channel}`, inline: true },
      { name: 'メッセージ', value: `\`\`\`${preview}\`\`\`` },
    ).setTimestamp()] });
  } catch (error) {
    console.error('モデレーションログ送信失敗:', error.message);
  }
}

async function handleModeration(message) {
  if (!tracksGuild(message.guild) || message.author.bot || !message.member) return;
  const now = Date.now();
  const config = moderationStore.get(message.guild.id);
  const history = getMessageHistory(message.guild.id, message.author.id, now);
  const mentionCount = message.mentions.users.size + message.mentions.roles.size + (message.mentions.everyone ? 1 : 0);
  const violation = findModerationViolation({ content: message.content, mentionCount, history, config, now });
  if (!violation) {
    history.push({ at: now, normalized: normalizedMessage(message.content), message });
    return;
  }

  const messagesToDelete = [...violation.entries.map((entry) => entry.message), message];
  const uniqueMessages = [...new Map(messagesToDelete.map((item) => [item.id, item])).values()];
  await Promise.all(uniqueMessages.map((item) => item.deletable ? item.delete().catch((error) => console.error('違反メッセージの削除に失敗しました:', error.message)) : undefined));
  messageHistory.delete(historyKey(message.guild.id, message.author.id));
  const offenseCount = moderationStore.recordOffense(message.guild.id, message.author.id, now);
  await moderationStore.save();
  let action = `${offenseCount}回目の違反`;
  if (offenseCount === 1) {
    action = `10分タイムアウト（1回目 / 90日でリセット）`;
    if (message.member.moderatable) {
      try { await message.member.timeout(config.timeoutMs, `自動モデレーション: ${violation.type}（1回目）`); }
      catch (error) { action = `タイムアウト失敗（1回目）: ${error.message}`; }
    } else action = 'タイムアウト不可（1回目）';
  } else if (offenseCount === 2) {
    action = 'Kick（2回目）';
    if (message.member.kickable) {
      try { await message.member.kick(`自動モデレーション: ${violation.type}（2回目）`); }
      catch (error) { action = `Kick失敗（2回目）: ${error.message}`; }
    } else action = 'Kick不可（2回目）';
  } else {
    action = `BAN（${offenseCount}回目）`;
    if (message.member.bannable) {
      try { await message.member.ban({ deleteMessageSeconds: 0, reason: `自動モデレーション: ${violation.type}（${offenseCount}回目）` }); }
      catch (error) { action = `BAN失敗（${offenseCount}回目）: ${error.message}`; }
    } else action = `BAN不可（${offenseCount}回目）`;
  }
  await writeModerationLog(message, violation.type, action);
  await writeCentralAuditLog({ title: '自動モデレーション実行', description: `**${message.guild.name}** でBotが自動処置を実行しました。`, fields: [{ name: '理由', value: violation.type, inline: true }, { name: '処置', value: action, inline: true }, { name: '対象ユーザーID', value: message.author.id, inline: true }], color: 0xed4245 });
}

function isInactivityExempt(member, guild) {
  return !isInactivityMonitoringTarget({ userId: member.id, ownerId: guild.ownerId, isBot: member.user.bot });
}

async function seedGuildActivity(guild) {
  if (!tracksGuild(guild)) return;
  let changed = false;
  try {
    const monitoredUserIds = new Set();
    let after;
    while (true) {
      const members = await retryRecoverable(
        () => guild.members.list({ limit: 1_000, ...(after ? { after } : {}) }),
        { attempts: 4, delayMs: 3_000 },
      );
      for (const member of members.values()) {
        if (isInactivityExempt(member, guild)) continue;
        monitoredUserIds.add(member.id);
        changed = activityStore.ensure(guild.id, member.id) || changed;
      }
      if (members.size < 1_000) break;
      after = [...members.keys()].at(-1);
      if (!after) break;
    }
    for (const activity of activityStore.entries(guild.id)) {
      if (!monitoredUserIds.has(activity.userId)) changed = activityStore.remove(guild.id, activity.userId) || changed;
    }
    if (changed) await activityStore.save();
  } catch (error) {
    console.error(`非アクティブ監視の初期化に失敗しました (${guild.name}):`, error.message);
  }
}

async function runInactivityCheck(guild) {
  if (!config.inactivityAutomationEnabled || !tracksGuild(guild)) return;
  const botMember = guild.members.me;
  if (!botMember?.permissions.has(PermissionFlagsBits.KickMembers)) {
    console.error('非アクティブKickを実行できません: Botに「メンバーをKick」権限がありません。');
    return;
  }

  let changed = false;
  for (const activity of activityStore.entries(guild.id)) {
    if (!reachedInactivityDay(activity.lastActiveAt, INACTIVITY_WARNING_DAYS[0])) continue;
    let member;
    try {
      member = await guild.members.fetch(activity.userId);
    } catch {
      changed = activityStore.remove(guild.id, activity.userId) || changed;
      continue;
    }
    if (isInactivityExempt(member, guild)) continue;

    const warningDay = [...INACTIVITY_WARNING_DAYS].reverse().find((day) => reachedInactivityDay(activity.lastActiveAt, day) && !activity.notifiedDays.includes(day));
    if (warningDay) {
      const daysUntilKick = INACTIVITY_KICK_DAYS - warningDay;
      try {
        await sendTrackedDm(member, {
          embeds: [new EmbedBuilder()
            .setColor(0xfaa61a)
            .setTitle('⚠️ 非アクティブによる自動退出の事前案内')
            .setDescription(`AmAサーバーで${warningDay}日間の活動が確認できません。あと${daysUntilKick}日以内に活動がない場合、サーバーから自動的にKickされます。`)
            .addFields({ name: '活動として記録される操作', value: 'メッセージ送信 / メッセージへのリアクション / VCへの参加・状態変更 / Botコマンド・パネル操作' })
            .setFooter({ text: 'いずれかの操作を行うと15日間のカウントがリセットされます。' })
            .setTimestamp()],
        });
      } catch (error) {
        console.warn(`非アクティブDMを送れませんでした (${member.user.tag}):`, error.message);
      }
      changed = activityStore.markNotified(guild.id, activity.userId, warningDay) || changed;
      continue;
    }

    if (isInactivityKickDue(activity)) {
      if (!member.kickable) {
        console.error(`非アクティブKickを実行できません: ${member.user.tag} よりBotロールを上位に配置してください。`);
        continue;
      }
      try {
        await sendTrackedDm(member, {
          embeds: [new EmbedBuilder()
            .setColor(0xed4245)
            .setTitle('📤 非アクティブのためサーバーから退出しました')
            .setDescription(`AmAサーバーで${INACTIVITY_KICK_DAYS}日間の活動が確認できなかったため、自動的に退出しました。Kickは参加禁止ではないため、下のカスタムリンクからいつでも再参加できます。`)
            .addFields({ name: '再参加リンク', value: `[AmAへ再参加する](${VANITY_URL})` })
            .setFooter({ text: '再参加後、活動カウントは新しく開始されます。' })
            .setTimestamp()],
        });
      }
      catch (error) { console.warn(`Kick前DMを送れませんでした (${member.user.tag}):`, error.message); }
      const kickKey = inactivityKickKey(guild.id, member.id);
      inactivityKickContexts.add(kickKey);
      try {
        await member.kick(`${INACTIVITY_KICK_DAYS}日間アクティブではなかったため`);
        activityStore.remove(guild.id, activity.userId);
        changed = true;
        await writeInactivityKickLog(member, activity).catch((error) => reportRuntimeError('非アクティブ退出ログ', error, [{ name: '対象ユーザーID', value: `\`${member.id}\`` }]));
        console.log(`非アクティブKick: ${member.user.tag}`);
      } catch (error) {
        inactivityKickContexts.delete(kickKey);
        console.error(`非アクティブKickに失敗しました (${member.user.tag}):`, error.message);
      }
      setTimeout(() => inactivityKickContexts.delete(kickKey), 60_000).unref();
      continue;
    }
  }
  if (changed) await activityStore.save();
}

async function handleCommand(interaction) {
  const accessLevel = commandAccessLevel(interaction);
  const { commandName } = interaction;
  if (commandName === 'help') {
    const commands = accessLevel === 'owner'
      ? '🧭 **確認**　`/ping` `/uptime` `/user`\n📣 **投稿**　`/announce` `/poll` `/send-dm`\n🛡️ **管理**　`/clear` `/mod-config` `/inactivity-status`\n✨ **パネル**　`/verification-panel` `/mbti-panel` `/asset-storage` `/利用権購入`\n⚙️ **設定**　`/command-access` `/server-log-config`'
      : '🧭 **確認コマンド**　`/ping` `/uptime` `/user`';
    return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🧭 あまね・コマンドガイド').setDescription(`╭─ **使えるコマンド** ─╮\n${commands}\n╰────────────────╯\n\n${accessLevel === 'owner' ? '✅ あなたは登録管理者です。すべてのコマンドを利用できます。' : '🔐 登録済みユーザーは確認系コマンドを利用できます。'}`).setFooter({ text: '各コマンドを選ぶと日本語の入力説明が表示されます。' })] });
  }
  if (commandName === 'command-access') {
    requirePrimaryBotOwner(interaction);
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'list') {
      const users = commandAccessStore.listDetails();
      const description = users.map((license) => {
        const plan = LICENSE_PLANS[license.planId]?.label || '手動登録';
        const owner = license.owner ? '　（登録管理者）' : '';
        return `<@${license.userId}>　\`${license.userId}\`${owner}\n> ${plan}｜${formatLicenseExpiry(license.expiresAt)}`;
      }).join('\n').slice(0, 3_900) || '登録済みユーザーはいません。';
      return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🔐 利用権・コマンド利用登録').setDescription(description).setFooter({ text: `有効な登録者: ${users.length}人｜期限切れは1時間ごとに自動解除` })] });
    }
    const user = interaction.options.getUser('user', true);
    if (subcommand === 'register') {
      const planId = interaction.options.getString('plan') || 'manual';
      const plan = LICENSE_PLANS[planId];
      if (!plan) throw new Error('利用権プランが正しくありません。');
      const { license } = commandAccessStore.grantLicense(user.id, { planId, durationMs: plan.durationMs });
      await commandAccessStore.save();
      await writeCentralAuditLog({ title: '利用権を付与・更新', description: `${interaction.user} が利用権を付与または更新しました。`, fields: [{ name: 'ユーザーID', value: user.id, inline: true }, { name: 'プラン', value: plan.label, inline: true }, { name: '利用期限', value: formatLicenseExpiry(license.expiresAt) }] });
      return interaction.reply({ ephemeral: true, content: `✅ ${user} の利用権を **${plan.label}** として登録しました。\n期限: ${formatLicenseExpiry(license.expiresAt)}` });
    }
    if (!commandAccessStore.unregister(user.id)) throw new Error('登録管理者は解除できないか、そのユーザーは未登録です。');
    await commandAccessStore.save();
    await writeCentralAuditLog({ title: 'コマンド利用者を登録解除', description: `${interaction.user} が ${user} の登録を解除しました。`, fields: [{ name: 'ユーザーID', value: user.id }] });
    return interaction.reply({ ephemeral: true, content: `✅ ${user} のコマンド利用登録を解除しました。` });
  }
  if (commandName === '利用権購入') {
    requirePrimaryBotOwner(interaction);
    requirePermission(interaction, PermissionFlagsBits.ManageGuild);
    const subcommand = interaction.options.getSubcommand();
    const settings = purchaseTicketStore.get(interaction.guild.id);
    if (subcommand === '状態') {
      const openTickets = Object.values(settings.tickets).filter((ticket) => ticket.status === 'open').length;
      return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🎫 利用権購入の設定')
        .addFields({ name: '購入パネル', value: settings.panelChannelId ? `<#${settings.panelChannelId}>` : '未設置' }, { name: 'チケットカテゴリ', value: settings.categoryId ? `<#${settings.categoryId}>` : '未作成' }, { name: '開設中チケット', value: `${openTickets}件`, inline: true }, { name: '案内文', value: settings.ticketMessage.slice(0, 1_000) })] });
    }
    if (subcommand === '案内文') {
      const message = interaction.options.getString('内容', true);
      purchaseTicketStore.update(interaction.guild.id, { ticketMessage: message });
      await purchaseTicketStore.save();
      return interaction.reply({ ephemeral: true, content: '✅ これから作成される個別チケットの案内文を更新しました。' });
    }
    let channel = settings.panelChannelId && await interaction.guild.channels.fetch(settings.panelChannelId).catch(() => null);
    if (!channel?.isTextBased()) {
      channel = interaction.guild.channels.cache.find((candidate) => candidate.type === ChannelType.GuildText && candidate.name === 'bot利用権購入') || null;
      channel ||= await interaction.guild.channels.create({ name: 'bot利用権購入', type: ChannelType.GuildText, topic: 'あまね Bot利用権の購入・サポート窓口' });
      purchaseTicketStore.update(interaction.guild.id, { panelChannelId: channel.id, panelMessageId: null });
      await purchaseTicketStore.save();
    }
    const panel = await publishPurchasePanel(interaction.guild, purchaseTicketStore.get(interaction.guild.id));
    return interaction.reply({ ephemeral: true, content: `✅ 利用権購入パネルを ${channel} に設置しました。` });
  }
  if (commandName === 'ping') return interaction.reply(`🏓 Pong! ${discord.ws.ping}ms`);
  if (commandName === 'uptime') return interaction.reply(`⏱️ 稼働時間: ${formatDuration(Date.now() - startedAt)}`);
  if (commandName === 'user') {
    const user = interaction.options.getUser('member') || interaction.user;
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(user.username).setThumbnail(user.displayAvatarURL()).addFields({ name: 'ユーザーID', value: user.id }, { name: '作成日', value: `<t:${Math.floor(user.createdTimestamp / 1_000)}:D>` })] });
  }
  if (commandName === 'poll') {
    const options = parseChoices(interaction.options.getString('options', true));
    const pollId = crypto.randomUUID().slice(0, 8);
    polls.set(pollId, { options, votes: new Map() });
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📊 投票').setDescription(interaction.options.getString('question', true)).setFooter({ text: '同じ選択肢をもう一度押すと投票を取り消せます。' })], components: [new ActionRowBuilder().addComponents(options.map((option, index) => new ButtonBuilder().setCustomId(`poll:${pollId}:${index}`).setLabel(`${option} (0)`).setStyle(ButtonStyle.Primary)))] });
  }
  if (commandName === 'clear') { requirePermission(interaction, PermissionFlagsBits.ManageMessages); const deleted = await interaction.channel.bulkDelete(interaction.options.getInteger('count', true), true); return interaction.reply({ ephemeral: true, content: `${deleted.size}件のメッセージを削除しました。` }); }
  if (commandName === 'announce') {
    requirePermission(interaction, PermissionFlagsBits.ManageGuild);
    const channel = interaction.options.getChannel('channel', true);
    if (!channel.isTextBased()) throw new Error('送信先にはテキストチャンネルを指定してください。');
    await channel.send({ content: interaction.options.getString('text', true), allowedMentions: { parse: [] } });
    await writeCentralAuditLog({ title: 'お知らせ送信', description: `${interaction.user} が ${channel} にお知らせを送信しました。`, fields: [{ name: '対象サーバー', value: `${interaction.guild.name}（${interaction.guild.id}）` }] });
    return interaction.reply({ ephemeral: true, content: `✅ ${channel} にお知らせを送信しました。` });
  }
  if (commandName === 'send-dm') {
    requirePrimaryBotOwner(interaction);
    requirePermission(interaction, PermissionFlagsBits.ManageGuild);
    const user = interaction.options.getUser('user', true);
    const url = interaction.options.getString('url');
    if (url) {
      let parsed;
      try { parsed = new URL(url); } catch { throw new Error('URLは http:// または https:// で指定してください。'); }
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('URLは http:// または https:// で指定してください。');
    }
    const attachment = interaction.options.getAttachment('file');
    const content = [interaction.options.getString('text', true), url].filter(Boolean).join('\n');
    try {
      await sendTrackedDm(user, { content, ...(attachment ? { files: [attachment.url] } : {}), allowedMentions: { parse: [] } });
    } catch {
      throw new Error('DMを送信できませんでした。相手がDMを拒否している可能性があります。');
    }
    dmSupportStore.reopen(user.id);
    await dmSupportStore.save();
    await writeCentralAuditLog({ title: '管理DM送信', description: `${interaction.user} が ${user} にDMを送信しました。`, fields: [{ name: '送信元サーバー', value: `${interaction.guild.name}（${interaction.guild.id}）` }] });
    await writeManagementDmLog(interaction, user);
    return interaction.reply({ ephemeral: true, content: `✅ ${user} にDMを送信しました。` });
  }
  if (commandName === 'server-log-config') {
    requirePermission(interaction, PermissionFlagsBits.ManageGuild);
    const channel = interaction.options.getChannel('channel', true);
    if (!channel.isTextBased()) throw new Error('送信先にはテキストチャンネルを指定してください。');
    serverSettingsStore.setMemberLogChannel(interaction.guild.id, channel.id);
    await serverSettingsStore.save();
    return interaction.reply({ ephemeral: true, content: `✅ 入退室ログを ${channel} に記録します。` });
  }
  if (commandName === 'verification-panel') {
    requirePrimaryBotOwner(interaction);
    requirePermission(interaction, PermissionFlagsBits.ManageGuild);
    const subcommand = interaction.options.getSubcommand();
    const currentSettings = verificationSettingsStore.get(interaction.guild.id);
    if (subcommand === 'status') {
      if (!currentSettings) return interaction.reply({ ephemeral: true, content: '認証は未設定です。`/verification-panel create` で作成してください。' });
      return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(0xf28ac0).setTitle('🛡️ 認証設定').addFields(
        { name: '認証ロール', value: `<@&${currentSettings.roleId}>` },
        { name: '入室時DM', value: currentSettings.dmEnabled ? 'オン' : 'オフ', inline: true },
        { name: 'DM本文', value: `\`\`\`\n${currentSettings.dmMessage.slice(0, 900)}\n\`\`\`` },
      )] });
    }
    if (subcommand === 'dm-settings') {
      if (!currentSettings) throw new Error('認証が未設定です。先に `/verification-panel create` を実行してください。');
      const message = interaction.options.getString('message');
      verificationSettingsStore.updateDm(interaction.guild.id, { dmEnabled: interaction.options.getBoolean('enabled', true), ...(message ? { dmMessage: message } : {}) });
      await verificationSettingsStore.save();
      return interaction.reply({ ephemeral: true, content: `✅ 入室時の認証DMを${interaction.options.getBoolean('enabled', true) ? 'オン' : 'オフ'}にしました。${message ? '本文も更新しました。' : ''}` });
    }
    if (subcommand === 'test-dm') {
      if (!currentSettings) throw new Error('認証が未設定です。先に `/verification-panel create` を実行してください。');
      try { await sendVerificationDm(await interaction.guild.members.fetch(interaction.user.id), { force: true }); } catch { throw new Error('テストDMを送信できませんでした。DiscordのDM受信設定を確認してください。'); }
      return interaction.reply({ ephemeral: true, content: '✅ 現在の認証DMをあなたへテスト送信しました。' });
    }
    requireBotPermission(interaction, PermissionFlagsBits.ManageRoles, 'Botに「ロールを管理」権限がありません。');
    const role = interaction.options.getRole('role', true);
    if (role.managed) throw new Error('連携管理されているロールは付与できません。');
    if (role.position >= interaction.guild.members.me.roles.highest.position) throw new Error('付与ロールをBotの最高ロールより下位に移動してください。');
    const panelChannel = interaction.options.getChannel('panel-channel', true);
    if (!panelChannel.isTextBased() || !panelChannel.isSendable() || !panelChannel.permissionsFor(interaction.guild.members.me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) throw new Error(`${panelChannel} にはBotの「チャンネルを見る」「メッセージを送る」「リンクを埋め込み」権限が必要です。`);
    const accessChannel = interaction.options.getChannel('access-channel');
    if (accessChannel) {
      requireBotPermission(interaction, PermissionFlagsBits.ManageChannels, 'チャンネル閲覧を設定するには、Botに「チャンネルを管理」権限が必要です。');
      if (!accessChannel.permissionOverwrites || !accessChannel.permissionsFor(interaction.guild.members.me)?.has(PermissionFlagsBits.ManageChannels)) throw new Error(`${accessChannel} へのBotアクセスがありません。Botロールに「チャンネルを見る」と「チャンネルを管理」を許可してください。`);
      await accessChannel.permissionOverwrites.edit(interaction.guild.roles.everyone, { ViewChannel: false });
      await accessChannel.permissionOverwrites.edit(role, { ViewChannel: true });
    }
    const panelMessage = await panelChannel.send(buildVerificationPanel(role, accessChannel));
    verificationSettingsStore.set(interaction.guild.id, role.id, { dmEnabled: interaction.options.getBoolean('dm-enabled') ?? currentSettings?.dmEnabled ?? true, panelChannelId: panelChannel.id, panelMessageId: panelMessage.id });
    await verificationSettingsStore.save();
    return interaction.reply({ ephemeral: true, content: `✅ 認証パネルを ${panelChannel} に投稿しました。入室時DMは${verificationSettingsStore.get(interaction.guild.id).dmEnabled ? 'オン' : 'オフ'}です。` });
  }
  if (commandName === '機能要望') {
    if (accessLevel !== 'owner' && !commandAccessStore.isRegistered(interaction.user.id)) throw new Error('このコマンドは利用権を持つ登録済みユーザーだけが実行できます。');
    const request = interaction.options.getString('内容', true).trim();
    const owner = await discord.users.fetch('1030896490379476992');
    try {
      await sendTrackedDm(owner, { embeds: [new EmbedBuilder().setColor(0x8b78ee).setTitle('💡 機能要望が届きました')
        .setDescription(request).addFields(
          { name: 'リクエストしたユーザー', value: `${interaction.user}（\`${interaction.user.id}\`）` },
          { name: '送信元', value: interaction.guild ? `${interaction.guild.name}（\`${interaction.guild.id}\`）` : 'DM' },
        ).setTimestamp()], allowedMentions: { parse: [] } });
    } catch {
      throw new Error('所有者へのDMを送信できませんでした。所有者のDM受信設定を確認してください。');
    }
    return interaction.reply({ ephemeral: true, content: '✅ 機能要望を所有者へ送信しました。ご協力ありがとうございます。' });
  }
  if (commandName === 'mbti-panel') {
    requirePermission(interaction, PermissionFlagsBits.ManageGuild);
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'create') {
      await ensureMbtiRoles(interaction.guild);
      const channel = interaction.options.getChannel('channel', true);
      if (!channel.isTextBased() || !channel.isSendable()) throw new Error('投稿先には、Botが送信できるテキストチャンネルを指定してください。');
      const message = await channel.send(buildMbtiPanel(mbtiPanelStore.get(interaction.guild.id), interaction.guild.id));
      mbtiPanelStore.setPanel(interaction.guild.id, channel.id, message.id);
      await mbtiPanelStore.save();
      return interaction.reply({ ephemeral: true, content: `✅ MBTI診断パネルを ${channel} に投稿しました。ロールは新規作成していません。` });
    }
    if (subcommand === 'edit') {
      const title = interaction.options.getString('title');
      const description = interaction.options.getString('description');
      if (!title && !description) throw new Error('見出しまたは説明文を入力してください。');
      mbtiPanelStore.updateText(interaction.guild.id, { ...(title ? { title } : {}), ...(description ? { description } : {}) });
      await mbtiPanelStore.save();
    }
    const { channel } = await refreshMbtiPanel(interaction.guild);
    return interaction.reply({ ephemeral: true, content: `✅ MBTI診断パネルを${subcommand === 'edit' ? '編集・' : ''}更新しました。投稿先: ${channel}` });
  }
  if (commandName === 'recruitment-panel') {
    requirePermission(interaction, PermissionFlagsBits.ManageGuild);
    const notifyChannel = interaction.options.getChannel('notify-channel', true);
    if (!notifyChannel.isTextBased()) throw new Error('応募通知先にはテキストチャンネルを指定してください。');
    const panel = recruitmentStore.create({ guildId: interaction.guild.id, sourceChannelId: interaction.channel.id, notifyChannelId: notifyChannel.id, title: interaction.options.getString('title', true), description: interaction.options.getString('description', true), applyLabel: interaction.options.getString('apply-label') || undefined, detailsLabel: interaction.options.getString('details-label') || undefined });
    await recruitmentStore.save();
    await interaction.reply(buildRecruitmentPanel(panel));
    const message = await interaction.fetchReply();
    recruitmentStore.update(panel.id, { messageId: message.id });
    await recruitmentStore.save();
    return interaction.followUp({ ephemeral: true, content: `✅ 募集パネルを作成しました。パネルID: \`${panel.id}\`\n文章やボタン名は \`/recruitment-edit\` で後から編集できます。` });
  }
  if (commandName === 'recruitment-edit') {
    requirePermission(interaction, PermissionFlagsBits.ManageGuild);
    const panelId = interaction.options.getString('panel-id', true);
    const panel = recruitmentStore.get(panelId);
    if (!panel || panel.guildId !== interaction.guild.id) throw new Error('このサーバーの募集パネルが見つかりません。');
    const notifyChannel = interaction.options.getChannel('notify-channel');
    if (notifyChannel && !notifyChannel.isTextBased()) throw new Error('応募通知先にはテキストチャンネルを指定してください。');
    const updated = recruitmentStore.update(panel.id, {
      title: interaction.options.getString('title'),
      description: interaction.options.getString('description'),
      applyLabel: interaction.options.getString('apply-label'),
      detailsLabel: interaction.options.getString('details-label'),
      applyInstruction: interaction.options.getString('apply-instruction'),
      detailsText: interaction.options.getString('details-text'),
      successMessage: interaction.options.getString('success-message'),
      messageLabel: interaction.options.getString('message-label'),
      messagePlaceholder: interaction.options.getString('message-placeholder'),
      notifyChannelId: notifyChannel?.id,
    });
    await recruitmentStore.save();
    const sourceChannel = await getTextChannel(updated.sourceChannelId);
    if (!updated.messageId || !sourceChannel?.isSendable()) return interaction.reply({ ephemeral: true, content: `✅ 設定を保存しました。旧パネルの投稿メッセージを取得できないため、\`/recruitment-panel\` で新しいパネルを作成してください。` });
    const message = await sourceChannel.messages.fetch(updated.messageId).catch(() => null);
    if (!message) return interaction.reply({ ephemeral: true, content: '✅ 設定を保存しました。元の募集メッセージが見つからないため、新しいパネルを作成してください。' });
    await message.edit(buildRecruitmentPanel(updated));
    return interaction.reply({ ephemeral: true, content: `✅ 募集パネル \`${updated.id}\` を更新しました。` });
  }
  if (commandName === 'inactivity-status') {
    requirePermission(interaction, PermissionFlagsBits.ManageGuild);
    const user = interaction.options.getUser('member', true);
    const activity = activityStore.get(interaction.guild.id, user.id);
    if (!activity) return interaction.reply({ ephemeral: true, content: `${user} の活動記録はまだありません。` });
    const elapsedDays = Math.floor((Date.now() - activity.lastActiveAt) / DAY_MS);
    return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(0xf28ac0).setTitle(`${user.username} の最終アクティブ`).setDescription(`<t:${Math.floor(activity.lastActiveAt / 1_000)}:F>（${elapsedDays}日経過）`).setFooter({ text: `DM送信済み: ${activity.notifiedDays.length ? activity.notifiedDays.map((day) => `${day}日`).join(' / ') : 'なし'}` })] });
  }
  if (commandName === 'mod-config') {
    requirePermission(interaction, PermissionFlagsBits.ManageGuild);
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'log') {
      const channel = interaction.options.getChannel('channel', true);
      if (!channel.isTextBased()) throw new Error('ログ先にはテキストチャンネルを指定してください。');
      moderationStore.setLogChannel(interaction.guild.id, channel.id);
      await moderationStore.save();
      return interaction.reply({ ephemeral: true, content: `モデレーションログを ${channel} に記録します。` });
    }
    if (subcommand === 'ng-add') {
      const word = interaction.options.getString('word', true);
      if (!moderationStore.addBannedWord(interaction.guild.id, word)) return interaction.reply({ ephemeral: true, content: 'そのNGワードはすでに登録済み、または空です。' });
      await moderationStore.save();
      return interaction.reply({ ephemeral: true, content: `NGワード「${word}」を追加しました。` });
    }
    if (subcommand === 'ng-remove') {
      const word = interaction.options.getString('word', true);
      if (!moderationStore.removeBannedWord(interaction.guild.id, word)) return interaction.reply({ ephemeral: true, content: 'そのNGワードは登録されていません。' });
      await moderationStore.save();
      return interaction.reply({ ephemeral: true, content: `NGワード「${word}」を削除しました。` });
    }
    const settings = moderationStore.get(interaction.guild.id);
    if (subcommand === 'ng-list') return interaction.reply({ ephemeral: true, content: settings.bannedWords.length ? settings.bannedWords.map((word) => `• ${word}`).join('\n') : 'NGワードは未登録です。' });
    return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(0xf28ac0).setTitle('荒らし対策の設定').setDescription('下のメニューとボタンから、この画面で設定を変更できます。NGワードは従来どおり `/mod-config ng-add` と `/mod-config ng-remove` を使います。').addFields(
      { name: 'ログ先', value: settings.logChannelId ? `<#${settings.logChannelId}>` : '未設定' },
      { name: '連投', value: `${settings.spam.maxMessages}件 / ${settings.spam.windowMs / 1_000}秒` },
      { name: '同一文連投', value: `${settings.duplicate.maxMessages}件 / ${settings.duplicate.windowMs / 60_000}分` },
      { name: 'メンション爆撃', value: `${settings.mentions.maxMentions}件以上` },
      { name: '処置', value: `違反メッセージ削除 + ${settings.timeoutMs / 60_000}分タイムアウト` },
      { name: 'NGワード数', value: String(settings.bannedWords.length) },
    )], components: [
      new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('mod:log-channel').setPlaceholder('モデレーションログの送信先を選択').setMinValues(1).setMaxValues(1)),
      new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('mod:edit-settings').setLabel('検知条件・ペナルティを変更').setStyle(ButtonStyle.Primary).setEmoji('⚙️')),
    ] });
  }
}

discord.once(Events.ClientReady, async (client) => {
  client.user.setPresence({ activities: [{ name: 'このBotの利用権取得はbioのリンクから', type: ActivityType.Playing }], status: 'online' });
  await commandAccessStore.load();
  await dmSupportStore.load();
  await dmHistoryStore.load();
  await assetStorageStore.load();
  await installConsentStore.load();
  await inviteAccessStore.load();
  await activityStore.load();
  await moderationStore.load();
  await recruitmentStore.load();
  await purchaseTicketStore.load();
  await mbtiAttemptStore.load();
  await mbtiPanelStore.load();
  await serverSettingsStore.load();
  const commandsSynced = await runStartupTask('Discordコマンド同期', async () => {
    await client.application.commands.set(globalCommands);
    if (config.discordGuildId) await client.guilds.fetch(config.discordGuildId).then((guild) => guild.commands.set([]));
    return true;
  }, { fallback: false });
  if (commandsSynced) console.log('Discord application commands synchronized.');
  await verificationSettingsStore.load();
  console.log('Discord core services are ready.');
  await runStartupTask('VC限定ゲスト機能の初期設定', () => guestAccess.start());
  void invitePanel.start()
    .then(() => console.log('Invite panel is ready.'))
    .catch((error) => reportRuntimeError('招待パネルの初期設定', error));
  const initialPanelRepair = await repairManagedPanels();
  selfHealingState.lastPanelRepairAt = Date.now();
  await publishMediaConverterPanel(client).catch((error) => console.warn(`メディア変換パネルを更新できません:`, error.message));
  await cleanupMediaTempCache().catch((error) => reportRuntimeError('変換キャッシュの削除', error));
  selfHealingState.lastCacheCleanupAt = Date.now();
  await dmHistoryStore.cleanup(client).catch((error) => reportRuntimeError('DM履歴の定期削除', error));
  dmHistoryTimer = setInterval(() => dmHistoryStore.cleanup(client).catch((error) => reportRuntimeError('DM履歴の定期削除', error)), 60 * 60 * 1_000);
  const inviteAccessGuild = client.guilds.cache.get(INVITE_ACCESS_GUILD_ID);
  if (inviteAccessGuild) {
    const inviteAccessSettings = inviteAccessStore.get(inviteAccessGuild.id);
    if (!inviteAccessSettings.enabled) await configureInviteLimitedPurchaseAccess(inviteAccessGuild).catch((error) => console.error(`招待限定の閲覧設定に失敗しました:`, error.message));
    else {
      await restrictInviteRoleToPurchaseChannel(inviteAccessGuild, inviteAccessSettings).catch((error) => console.error(`招待限定のチャンネル制限に失敗しました:`, error.message));
      await refreshInviteAccessSnapshot(inviteAccessGuild).catch((error) => console.error(`招待利用回数の同期に失敗しました:`, error.message));
    }
  }
  for (const guild of client.guilds.cache.values()) await createExternalInstallConsent(guild).catch((error) => console.error(`外部サーバーの同意UI投稿に失敗しました (${guild.name}):`, error.message));
  await expireDueLicenses().catch((error) => reportRuntimeError('利用権期限の確認', error));
  licenseTimer = setInterval(() => expireDueLicenses().catch((error) => reportRuntimeError('利用権期限の確認', error)), LICENSE_EXPIRY_CHECK_INTERVAL_MS);
  // パネル・変換パネル・キャッシュは対象限定の自己復旧監視でまとめて保守する。
  startSelfHealingMonitor();
  await sendOperationsDigest({ force: true, panelSummary: `${initialPanelRepair.updated}更新 / ${initialPanelRepair.recreated}再作成 / ${initialPanelRepair.unavailable}要確認` }).catch((error) => reportRuntimeError('運用ダイジェスト', error));
  operationsDigestTimer = setInterval(() => sendOperationsDigest().catch((error) => reportRuntimeError('運用ダイジェスト', error)), OPERATIONS_DIGEST_INTERVAL_MS);
  const amaGuild = client.guilds.cache.get(AMA_GUILD_ID);
  if (amaGuild) seedVoiceMuteGuard(amaGuild);
  voiceMuteTimer = setInterval(() => enforceVoiceMuteDisconnects().catch((error) => reportRuntimeError('VCミュート監視', error)), 15_000);
  if (config.inactivityAutomationEnabled) {
    const runInactivityCycle = async (guild) => {
      await seedGuildActivity(guild);
      await runInactivityCheck(guild);
    };
    for (const guild of client.guilds.cache.values()) await runInactivityCycle(guild);
    inactivityTimer = setInterval(() => Promise.all([...client.guilds.cache.values()].map(runInactivityCycle)).catch((error) => console.error('非アクティブ監視エラー:', error)), 60 * 60 * 1_000);
  }
  console.log(`${client.user.tag} として起動しました。接続サーバー: ${[...client.guilds.cache.values()].map((guild) => `${guild.name} (${guild.id})`).join(', ')}`);
});

discord.on(Events.Error, (error) => {
  reportRuntimeError('Discord接続', error);
  requestSelfHealing('communication', GATEWAY_RECOVERY_GRACE_MS);
});
discord.on(Events.ShardReady, (shardId) => {
  selfHealingState.gatewayUnavailableSince = 0;
  selfHealingState.gatewayRestartRequested = false;
  // destroy() を含む旧復旧処理で失われたREST認証も、接続確立時に必ず揃える。
  discord.token = config.discordToken;
  discord.rest.setToken(config.discordToken);
  console.log(`Discord Gateway shard ${shardId} connected.`);
});
discord.on(Events.ShardReconnecting, (shardId) => {
  if (!selfHealingState.gatewayUnavailableSince) selfHealingState.gatewayUnavailableSince = Date.now();
  const now = Date.now();
  if (now - selfHealingState.lastGatewayReconnectLogAt >= GATEWAY_RECONNECT_LOG_INTERVAL_MS) {
    selfHealingState.lastGatewayReconnectLogAt = now;
    console.warn(`Discord Gateway shard ${shardId} is reconnecting. discord.jsの標準復旧を待機します。`);
  }
});
discord.on(Events.ShardDisconnect, (event, shardId) => {
  if (!selfHealingState.gatewayUnavailableSince) selfHealingState.gatewayUnavailableSince = Date.now();
  console.error(`Discord Gateway shard ${shardId} disconnected (close code: ${event.code}).`);
  // discord.js の標準再接続を優先し、戻らない場合だけ監視側が接続を作り直す。
  requestSelfHealing('communication', GATEWAY_RECOVERY_GRACE_MS);
});
discord.on(Events.ShardError, (error, shardId) => {
  if (!selfHealingState.gatewayUnavailableSince) selfHealingState.gatewayUnavailableSince = Date.now();
  console.error(`Discord Gateway shard ${shardId} error: ${error.message}`);
});

process.on('unhandledRejection', (error) => {
  reportRuntimeError('未処理Promise', error);
  requestSelfHealing();
});
process.on('uncaughtException', (error) => {
  reportRuntimeError('未処理例外', error);
  requestSelfHealing();
});

discord.on(Events.GuildCreate, (guild) => {
  createExternalInstallConsent(guild).catch((error) => reportRuntimeError('外部サーバー追加処理', error, [{ name: 'サーバーID', value: `\`${guild.id}\`` }]));
});

discord.on(Events.MessageCreate, (message) => {
  if (!message.guild) return logIncomingDm(message).catch((error) => reportRuntimeError('DM受信ログ', error, [{ name: '送信者ID', value: `\`${message.author.id}\`` }]));
  mirrorForumUpload(message).catch((error) => reportRuntimeError('フォーラム添付の保管', error, [{ name: 'チャンネルID', value: `\`${message.channelId}\`` }]));
  recordActivity(message.guild, message.author).catch((error) => reportRuntimeError('活動記録', error));
  handleModeration(message).catch((error) => reportRuntimeError('自動モデレーション', error));
});
discord.on(Events.MessageReactionAdd, (reaction, user) => recordActivity(reaction.message.guild, user).catch((error) => reportRuntimeError('活動記録', error)));
discord.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const state = newState.member ? newState : oldState;
  observeVoiceMute(state);
  if (guestAccess.isGuest(state.member)) return;
  return recordActivity(state.guild, state.member?.user).catch((error) => reportRuntimeError('活動記録', error));
});
discord.on(Events.GuildMemberAdd, async (member) => {
  if (member.user.bot) return;
  const expectedGuest = guestAccess.isGuest(member);
  const handledGuest = await guestAccess.handleJoin(member).catch((error) => {
    reportRuntimeError('ゲスト参加の初期制限', error);
    return expectedGuest;
  });
  if (handledGuest) return;
  let isInviteLimitedMember = false;
  try { isInviteLimitedMember = await grantInviteLimitedPurchaseAccess(member); } catch (error) { console.error(`招待限定の閲覧権を付与できませんでした (${member.user.tag}):`, error.message); }
  const tasks = [isInviteLimitedMember
    ? sendInvitePurchaseDm(member).catch((error) => console.warn(`招待限定DMを送れませんでした (${member.user.tag}):`, error.message))
    : sendVerificationDm(member).catch((error) => console.warn(`入室認証DMを送れませんでした (${member.user.tag}):`, error.message))];
  if (tracksGuild(member.guild)) {
    activityStore.ensure(member.guild.id, member.id);
    tasks.push(activityStore.save(), writeMemberLog(member, true).catch((error) => console.warn(`入室ログを送れませんでした (${member.user.tag}):`, error.message)));
  }
  return Promise.all(tasks).catch((error) => console.error('入室処理エラー:', error));
});
discord.on(Events.GuildMemberRemove, async (member) => {
  if (await guestAccess.handleRemove(member).catch((error) => { reportRuntimeError('ゲスト退出の後処理', error); return false; })) return;
  if (!tracksGuild(member.guild) || member.user.bot) return;
  if (inactivityKickContexts.has(inactivityKickKey(member.guild.id, member.id))) return;
  return Promise.all([
    sendTrackedDm(member, { embeds: [new EmbedBuilder().setColor(0x99aab5).setTitle(`${member.guild.name}から退出しました`).setDescription('また参加する際は、DMまたはサーバー内の認証パネルから認証できます。')] })
      .catch((error) => console.warn(`退出DMを送れませんでした (${member.user.tag}):`, error.message)),
    writeMemberLog(member, false).catch((error) => console.warn(`退出ログを送れませんでした (${member.user.tag}):`, error.message)),
  ]);
});

discord.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.inGuild() && !guestAccess.isGuest(interaction.member)) {
      // Activity persistence must never consume Discord's short interaction
      // acknowledgement window. The store serializes and coalesces writes.
      void recordActivity(interaction.guild, interaction.user).catch((error) => reportRuntimeError('活動記録', error));
    }
    if (invitePanel.matches(interaction)) return await invitePanel.handle(interaction);
    if (interaction.inGuild() && guestAccess.isGuest(interaction.member)) return interaction.reply({ ephemeral: true, content: '🎟️ VC限定ゲストは、指定されたボイスチャンネルとそのチャットだけを利用できます。' });
    // await を省くと変換失敗がこのtry/catchを通らず、Discord接続エラーとして生の例外が記録される。
    if (isMediaConverterInteraction(interaction)) return await handleMediaConverterInteraction(interaction);
    if (interaction.isChatInputCommand() && interaction.commandName === '利用権') {
      if (!isPrimaryBotOwner(interaction.user.id)) return interaction.reply({ ephemeral: true, content: 'このコマンドはBot所有者だけが実行できます。' });
      return interaction.reply(buildUsageAccessNotice());
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('dm-support:reply:')) {
      if (!commandAccessStore.isOwner(interaction.user.id)) throw new Error('DM対応は登録管理者だけが実行できます。');
      const userId = interaction.customId.split(':')[2];
      const content = interaction.fields.getTextInputValue('content').trim();
      const user = await discord.users.fetch(userId).catch(() => null);
      if (!user) throw new Error('DM送信先ユーザーが見つかりません。');
      try { await sendTrackedDm(user, { content, allowedMentions: { parse: [] } }); } catch { throw new Error('DMを送信できませんでした。相手がDMを拒否している可能性があります。'); }
      dmSupportStore.reopen(user.id);
      await dmSupportStore.save();
      const logChannel = await getManagementLogChannel();
      await logChannel?.send({ embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('↩️ DMへ返信しました').setDescription(content.slice(0, 2_000))
        .addFields({ name: '返信先', value: `${user}（\`${user.id}\`）` }, { name: '対応者', value: `${interaction.user}（\`${interaction.user.id}\`）` }).setTimestamp()] });
      return interaction.reply({ ephemeral: true, content: `✅ ${user} へ返信しました。` });
    }
    if (interaction.isModalSubmit() && interaction.customId === 'asset:forum:create') {
      await interaction.deferReply({ ephemeral: true });
      await requireAssetPanelAccess(interaction);
      requirePermission(interaction, PermissionFlagsBits.ManageChannels);
      requireBotPermission(interaction, PermissionFlagsBits.ManageChannels, '新しい保管フォーラムを作るには、Botに「チャンネルを管理」権限が必要です。');
      const name = interaction.fields.getTextInputValue('name').trim();
      if (!name) throw new Error('フォーラム名を入力してください。');
      const settings = assetStorageStore.get(interaction.guild.id);
      const panelChannel = settings.panelChannelId && await interaction.guild.channels.fetch(settings.panelChannelId).catch(() => null);
      const forum = await createCustomAssetForum(interaction.guild, panelChannel || interaction.channel, settings, name);
      return interaction.editReply(`✅ ${forum} を作成しました。このフォーラムの投稿へ .unitypackage / .zip を添付すると、Botが同じ投稿へ再送付して元投稿を削除します。`);
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('asset:save:')) {
      await interaction.deferReply({ ephemeral: true });
      await requireAssetPanelAccess(interaction);
      const [, , categoryId, avatarIndexValue] = interaction.customId.split(':');
      const settings = assetStorageStore.get(interaction.guild.id);
      let avatar = avatarIndexValue === 'custom' ? interaction.fields.getTextInputValue('avatar').trim() : settings.avatars[Number(avatarIndexValue)];
      const destination = resolveAssetDestination(settings, categoryId);
      if (!destination || (!avatar && destination.avatarRequired) || avatar?.length > 100) throw new Error('保存セッションの情報が見つかりません。もう一度パネルから選択してください。');
      avatar ||= '共通';
      const name = interaction.fields.getTextInputValue('name').trim();
      const boothUrl = interaction.fields.getTextInputValue('booth-url').trim();
      if (boothUrl && !isOfficialBoothUrl(boothUrl)) throw new Error('BOOTH URLを入力する場合は、公式BOOTH商品ページの https:// URL を指定してください。');
      const thread = await createAssetStorageThread(interaction, { categoryId, avatar, name, boothUrl: boothUrl || null });
      return interaction.editReply(`✅ ${thread} を作成しました。スレッドに .unitypackage を添付してください。上限超過時は .zip に圧縮して再添付します。`);
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('purchase:confirm:')) {
      if (!interaction.inGuild()) throw new Error('購入チケットはサーバー内の購入パネルから作成してください。');
      const planId = interaction.customId.split(':')[2];
      const plan = PURCHASE_PLANS[planId];
      if (!plan) throw new Error('購入プランが見つかりません。もう一度パネルから選択してください。');
      const referenceUrl = interaction.fields.getTextInputValue('reference-url').trim();
      const enteredPlan = interaction.fields.getTextInputValue('plan').trim();
      const declaredUserId = interaction.fields.getTextInputValue('user-id').trim();
      if (!isHttpUrl(referenceUrl)) throw new Error('確認用URLは http:// または https:// から始まるURLを入力してください。');
      if (enteredPlan !== `${plan.label}（${plan.price}）`) throw new Error(`プラン欄は「${plan.label}（${plan.price}）」のまま送信してください。`);
      if (!/^\d{17,20}$/.test(declaredUserId)) throw new Error('DiscordユーザーIDは17〜20桁の数字で入力してください。');
      await interaction.deferReply({ ephemeral: true });
      return createPurchaseTicket(interaction, planId, { referenceUrl, declaredUserId });
    }
    if (interaction.isButton() && interaction.customId.startsWith('dm-support:reply:')) {
      if (!commandAccessStore.isOwner(interaction.user.id)) throw new Error('DM対応は登録管理者だけが実行できます。');
      const userId = interaction.customId.split(':')[2];
      return interaction.showModal(new ModalBuilder().setCustomId(`dm-support:reply:${userId}`).setTitle('DMへ返信').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('content').setLabel('返信内容').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(2_000))));
    }
    if (interaction.isButton() && interaction.customId.startsWith('dm-support:close:')) {
      if (!commandAccessStore.isOwner(interaction.user.id)) throw new Error('DM対応は登録管理者だけが実行できます。');
      const userId = interaction.customId.split(':')[2];
      const user = await discord.users.fetch(userId).catch(() => null);
      dmSupportStore.close(userId, interaction.user.id);
      await dmSupportStore.save();
      if (user) await sendTrackedDm(user, { content: '🔒 このBotとのDM対応は管理者により終了しました。新しいお問い合わせには対応できません。', allowedMentions: { parse: [] } }).catch(() => {});
      const embed = EmbedBuilder.from(interaction.message.embeds[0]).setColor(0x99aab5).setFooter({ text: `対応終了 • ${interaction.user.username}` }).setTimestamp();
      return interaction.update({ embeds: [embed], components: buildDmSupportButtons(userId, true) });
    }
    if (interaction.isButton() && interaction.customId.startsWith('purchase:create:')) {
      if (!interaction.inGuild()) throw new Error('購入チケットはサーバー内の購入パネルから作成してください。');
      await consumePurchaseButtonUse(interaction.guild.id, interaction.user.id);
      return interaction.showModal(buildPurchaseConfirmationModal(interaction.customId.split(':')[2]));
    }
    if (interaction.isButton() && interaction.customId === 'purchase:inquiry') {
      if (!interaction.inGuild()) throw new Error('問い合わせチケットはサーバー内の購入パネルから作成してください。');
      await consumePurchaseButtonUse(interaction.guild.id, interaction.user.id);
      await interaction.deferReply({ ephemeral: true });
      return createPurchaseInquiryTicket(interaction);
    }
    if (interaction.isButton() && interaction.customId.startsWith('purchase:terms:')) {
      if (!interaction.inGuild()) throw new Error('この操作は購入チケット内でのみ使用できます。');
      const choice = interaction.customId.split(':')[2];
      if (!['agree', 'decline'].includes(choice)) throw new Error('利用規約への回答が正しくありません。');
      const settings = purchaseTicketStore.get(interaction.guild.id);
      const ticketData = settings.tickets[interaction.channelId];
      if (!ticketData || (ticketData.type || 'purchase') !== 'purchase') throw new Error('購入チケットの記録が見つかりません。');
      if (interaction.user.id !== ticketData.userId) throw new Error('利用規約への回答は購入チケットの作成者だけが行えます。');
      if (ticketData.termsStatus && ticketData.termsStatus !== 'pending') throw new Error('利用規約への回答はすでに記録されています。');
      const agreed = choice === 'agree';
      purchaseTicketStore.update(interaction.guild.id, { tickets: { ...settings.tickets, [interaction.channelId]: { ...ticketData, termsStatus: agreed ? 'agreed' : 'declined', termsAnsweredAt: new Date().toISOString() } } });
      await purchaseTicketStore.save();
      const embed = EmbedBuilder.from(interaction.message.embeds[0]).setColor(agreed ? 0x57f287 : 0xed4245)
        .addFields({ name: '✅ 利用規約への回答', value: agreed ? `${interaction.user} が利用規約へ **同意しました**。管理者の確認をお待ちください。` : `${interaction.user} は利用規約へ **同意しませんでした**。`, inline: false })
        .setFooter({ text: agreed ? '利用規約への同意を記録しました。管理者の確認をお待ちください。' : '利用規約への不同意を記録しました。不要な場合はチケットを削除できます。' });
      await writePurchaseTicketLog({ title: agreed ? '利用規約へ同意' : '利用規約へ不同意', description: `${interaction.user} が購入チケット内で利用規約への回答を送信しました。`, content: agreed ? purchaseOwnerMentions() : null, fields: [{ name: 'チケットID', value: `\`${interaction.channelId}\``, inline: true }, { name: 'ユーザーID', value: `\`${interaction.user.id}\``, inline: true }], color: agreed ? 0x57f287 : 0xed4245 });
      return interaction.update({ embeds: [embed], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('purchase:delete').setLabel('チケットを削除').setEmoji('🗑️').setStyle(ButtonStyle.Danger))] });
    }
    if (interaction.isButton() && interaction.customId === 'purchase:delete') {
      if (!interaction.inGuild()) throw new Error('この操作は購入チケット内でのみ使用できます。');
      const settings = purchaseTicketStore.get(interaction.guild.id);
      const ticketData = settings.tickets[interaction.channelId];
      if (!ticketData) throw new Error('購入チケットの記録が見つかりません。');
      const isOwner = commandAccessStore.isOwner(interaction.user.id);
      if (!isOwner && interaction.user.id !== ticketData.userId) throw new Error('このチケットを削除できるのは作成者または登録管理者だけです。');
      const plan = PURCHASE_PLANS[ticketData.planId];
      purchaseTicketStore.update(interaction.guild.id, { tickets: { ...settings.tickets, [interaction.channelId]: { ...ticketData, status: 'closed', closedAt: new Date().toISOString(), closedBy: interaction.user.id } } });
      await purchaseTicketStore.save();
      await interaction.reply({ ephemeral: true, content: '🗑️ チケットを削除します。' });
      await writePurchaseTicketLog({ title: '購入チケットを削除', description: `${interaction.user} が購入チケットを削除しました。`, fields: [{ name: 'チケットID', value: `\`${interaction.channelId}\``, inline: true }, { name: '購入者ID', value: `\`${ticketData.userId}\``, inline: true }, { name: 'プラン', value: plan ? `${plan.label}（${plan.price}）` : ticketData.planId, inline: true }], color: 0x99aab5 });
      return interaction.channel.delete('利用者または管理者が購入チケットを削除しました。');
    }
    if (interaction.isButton() && interaction.customId === 'purchase:guide:user-id') {
      return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('❔ DiscordユーザーIDの確認方法')
        .setDescription('スマホ・PC共通で、Discordの **ユーザー設定 → 詳細設定 → 開発者モード** をオンにします。\nその後、自分のプロフィールを開き、メニューから **ユーザーIDをコピー** を選んでください。')
        .addFields({ name: '注意', value: 'ユーザーIDは数字だけの長い番号です。パスワードや認証コードを送る必要はありません。' })] });
    }
    if (interaction.isButton() && interaction.customId === 'asset:start') {
      await interaction.deferReply({ ephemeral: true });
      await requireAssetPanelAccess(interaction);
      const settings = await recoverAssetCustomForums(interaction.guild, assetStorageStore.get(interaction.guild.id));
      const options = await assetCategoryOptions(interaction.guild, settings, interaction.member);
      return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x7b61ff).setTitle('🗃️ アセット保存 — 1 / 2').setDescription('保存するカテゴリまたは追加フォーラムを選択してください。')], components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('asset:category').setPlaceholder('保存先を選択').addOptions(options))] });
    }
    if (interaction.isButton() && interaction.customId === 'asset:forum:create') {
      await requireAssetPanelAccess(interaction);
      requirePermission(interaction, PermissionFlagsBits.ManageChannels);
      return interaction.showModal(buildAssetForumCreateModal());
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'asset:category') {
      await requireAssetPanelAccess(interaction);
      const categoryId = interaction.values[0];
      const settings = assetStorageStore.get(interaction.guild.id);
      const destination = resolveAssetDestination(settings, categoryId);
      if (!destination) throw new Error('保存先が見つかりません。もう一度パネルから選択してください。');
      if (!settings.avatars.length) return interaction.showModal(buildAssetSaveModal(categoryId, null, destination));
      const options = settings.avatars.map((avatar, index) => ({ label: avatar.slice(0, 100), value: String(index), description: `${destination.label}として保存` }));
      return interaction.update({ embeds: [new EmbedBuilder().setColor(0x7b61ff).setTitle('🗃️ アセット保存 — 2 / 2').setDescription(`${destination.emoji} **${destination.label}** を選択しました。対応アバターを選んでください。`)], components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`asset:avatar:${categoryId}`).setPlaceholder('対応アバターを選択').addOptions(options))] });
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('asset:avatar:')) {
      await requireAssetPanelAccess(interaction);
      const categoryId = interaction.customId.slice('asset:avatar:'.length);
      const avatarIndex = Number(interaction.values[0]);
      const settings = assetStorageStore.get(interaction.guild.id);
      if (!resolveAssetDestination(settings, categoryId) || !settings.avatars[avatarIndex]) throw new Error('保存セッションの情報が見つかりません。もう一度パネルから選択してください。');
      return interaction.showModal(buildAssetSaveModal(categoryId, avatarIndex));
    }
    if (interaction.isButton() && interaction.customId.startsWith('asset:check:')) {
      await requireAssetPanelAccess(interaction);
      const asset = assetStorageStore.getAsset(interaction.guild.id, interaction.customId.split(':')[2]);
      if (!asset || interaction.channelId !== asset.threadId) throw new Error('この保存スレッドの情報が見つかりません。');
      const messages = await interaction.channel.messages.fetch({ limit: 100 });
      const uploaded = [...messages.values()].flatMap((message) => [...message.attachments.values()].map((attachment) => attachment.name.toLowerCase()));
      const unitypackages = uploaded.filter((name) => name.endsWith('.unitypackage'));
      const archives = uploaded.filter((name) => name.endsWith('.zip'));
      const complete = unitypackages.length > 0 || archives.length > 0;
      return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(complete ? 0x57f287 : 0xfaa61a).setTitle(complete ? '✅ 保管ファイルを確認しました' : '⚠️ .unitypackage が未登録です')
        .addFields(
          { name: '.unitypackage', value: `${unitypackages.length}件`, inline: true },
          { name: '.zip（圧縮保管）', value: `${archives.length}件`, inline: true },
          { name: '確認結果', value: complete ? (unitypackages.length ? '`.unitypackage` の添付を確認しました。' : '`.zip` の添付を確認しました。ZIP内部の形式はDiscord上では確認できません。') : '`.unitypackage` を添付してください。上限超過エラー時は `.zip` に圧縮して添付します。' },
        ).setFooter({ text: 'このスレッド直近100件の添付ファイルを確認しました。' })] });
    }
    if (interaction.isButton() && interaction.customId.startsWith('install-consent:agree:')) {
      const guildId = interaction.customId.split(':')[2];
      if (interaction.guildId !== guildId) return interaction.reply({ ephemeral: true, content: 'この同意パネルは別のサーバーのものです。' });
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ ephemeral: true, content: 'このボタンは「サーバーを管理」権限を持つユーザーだけが押せます。' });
      const guild = interaction.guild;
      const previous = installConsentStore.get(guild.id) || {};
      installConsentStore.accept(guild.id, interaction.user.id);
      await installConsentStore.save();
      await interaction.update(buildInstallConsentCompletePanel(guild, interaction.user.id));
      await sendInstallLog({ guild, installer: { user: previous.installerUserId ? await discord.users.fetch(previous.installerUserId).catch(() => null) : null, detail: previous.installerAuditDetail || '記録なし' }, panelChannel: interaction.channel, acceptedByUserId: interaction.user.id });
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('recruitment:submit:')) {
      const panelId = interaction.customId.split(':')[2];
      const panel = recruitmentStore.get(panelId);
      if (!panel || interaction.guildId !== panel.guildId) return interaction.reply({ ephemeral: true, content: 'この募集パネルは期限切れです。' });
      const message = interaction.fields.getTextInputValue('message').trim();
      const notifyChannel = await discord.channels.fetch(panel.notifyChannelId).catch(() => null);
      if (!notifyChannel?.isTextBased()) throw new Error('応募通知先チャンネルが見つかりません。');
      await notifyChannel.send({ embeds: [new EmbedBuilder().setColor(0x57f287).setTitle(`✉️ 募集への応募 — ${panel.title}`).addFields(
        { name: '応募者', value: `${interaction.user}（${interaction.user.tag}）` },
        { name: '応募内容', value: message.slice(0, 1_000) },
        { name: '応募元', value: `<#${panel.sourceChannelId}>` },
      ).setTimestamp()] });
      return interaction.reply({ ephemeral: true, content: panel.successMessage });
    }
    if (interaction.isModalSubmit() && interaction.customId === 'mod:save-settings') {
      requirePermission(interaction, PermissionFlagsBits.ManageGuild);
      const timeoutMinutes = readWholeNumber(interaction.fields.getTextInputValue('timeout-minutes'), 'タイムアウト時間', 1, 10_080);
      const spamMaxMessages = readWholeNumber(interaction.fields.getTextInputValue('spam-count'), '連投メッセージ数', 2, 20);
      const spamWindowSeconds = readWholeNumber(interaction.fields.getTextInputValue('spam-seconds'), '連投判定秒数', 1, 600);
      const duplicateMaxMessages = readWholeNumber(interaction.fields.getTextInputValue('duplicate-count'), '同一文の回数', 2, 20);
      const mentionMaxMentions = readWholeNumber(interaction.fields.getTextInputValue('mention-count'), 'メンション数', 1, 100);
      moderationStore.updateSettings(interaction.guild.id, { timeoutMs: timeoutMinutes * 60_000, spamMaxMessages, spamWindowMs: spamWindowSeconds * 1_000, duplicateMaxMessages, mentionMaxMentions });
      await moderationStore.save();
      return interaction.reply({ ephemeral: true, content: '✅ 荒らし対策の検知条件とペナルティを更新しました。' });
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('verify:answer:')) return interaction.reply({ ...(interaction.inGuild() ? { ephemeral: true } : {}), content: 'この認証画面は更新されました。新しい認証を開始してください。' });
    if (interaction.isChannelSelectMenu() && interaction.customId === 'mod:log-channel') {
      requirePermission(interaction, PermissionFlagsBits.ManageGuild);
      const channel = interaction.channels.first();
      if (!channel?.isTextBased()) throw new Error('ログ先にはテキストチャンネルを指定してください。');
      moderationStore.setLogChannel(interaction.guild.id, channel.id);
      await moderationStore.save();
      return interaction.reply({ ephemeral: true, content: `✅ モデレーションログを ${channel} に設定しました。` });
    }
    if (interaction.isButton() && interaction.customId === 'mbti:start') return startMbtiCheck(interaction);
    if (interaction.isButton() && interaction.customId.startsWith('mbti:answer:')) return answerMbtiQuestion(interaction);
    if (interaction.isButton() && interaction.customId.startsWith('mbti:back:')) return backMbtiQuestion(interaction);
    if (interaction.isButton() && interaction.customId.startsWith('mbti:resume:')) return resumeMbtiCheck(interaction);
    if (interaction.isButton() && interaction.customId.startsWith('mbti:reset:')) return resetMbtiCheck(interaction);
    if (interaction.isButton() && interaction.customId === 'mod:edit-settings') {
      requirePermission(interaction, PermissionFlagsBits.ManageGuild);
      const settings = moderationStore.get(interaction.guild.id);
      return interaction.showModal(new ModalBuilder().setCustomId('mod:save-settings').setTitle('荒らし対策の詳細設定').addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('timeout-minutes').setLabel('1回目のタイムアウト（分）').setStyle(TextInputStyle.Short).setValue(String(settings.timeoutMs / 60_000)).setRequired(true).setMaxLength(5)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('spam-count').setLabel('連投とみなすメッセージ数').setStyle(TextInputStyle.Short).setValue(String(settings.spam.maxMessages)).setRequired(true).setMaxLength(2)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('spam-seconds').setLabel('連投を判定する秒数').setStyle(TextInputStyle.Short).setValue(String(settings.spam.windowMs / 1_000)).setRequired(true).setMaxLength(3)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('duplicate-count').setLabel('同一文連投とみなす回数').setStyle(TextInputStyle.Short).setValue(String(settings.duplicate.maxMessages)).setRequired(true).setMaxLength(2)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('mention-count').setLabel('メンション爆撃とみなす件数').setStyle(TextInputStyle.Short).setValue(String(settings.mentions.maxMentions)).setRequired(true).setMaxLength(3)),
      ));
    }
    if (interaction.isButton() && interaction.customId.startsWith('recruitment:details:')) {
      const panel = recruitmentStore.get(interaction.customId.split(':')[2]);
      if (!panel || interaction.guildId !== panel.guildId) return interaction.reply({ ephemeral: true, content: 'この募集パネルは期限切れです。' });
      return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`📣 ${panel.title}`).setDescription(panel.description).setFooter({ text: panel.detailsText })] });
    }
    if (interaction.isButton() && interaction.customId.startsWith('recruitment:apply:')) {
      const panel = recruitmentStore.get(interaction.customId.split(':')[2]);
      if (!panel || interaction.guildId !== panel.guildId) return interaction.reply({ ephemeral: true, content: 'この募集パネルは期限切れです。' });
      return interaction.showModal(new ModalBuilder().setCustomId(`recruitment:submit:${panel.id}`).setTitle(`応募 — ${panel.title.slice(0, 34)}`).addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('message').setLabel(panel.messageLabel).setPlaceholder(panel.messagePlaceholder).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1_000))));
    }
    if (interaction.isButton() && interaction.customId.startsWith('poll:')) {
      const [, pollId, optionIndex] = interaction.customId.split(':'); const poll = polls.get(pollId);
      if (!poll) return interaction.reply({ ephemeral: true, content: 'この投票は期限切れです。' });
      const choice = Number(optionIndex); poll.votes.set(interaction.user.id, poll.votes.get(interaction.user.id) === choice ? -1 : choice);
      const totals = poll.options.map((_, index) => [...poll.votes.values()].filter((vote) => vote === index).length);
      return interaction.update({ components: [new ActionRowBuilder().addComponents(poll.options.map((option, index) => new ButtonBuilder().setCustomId(`poll:${pollId}:${index}`).setLabel(`${option} (${totals[index]})`).setStyle(ButtonStyle.Primary)))] });
    }
    if (interaction.isButton() && interaction.customId.startsWith('verify:start:')) {
      const roleId = interaction.customId.split(':')[2];
      return beginVerification(interaction, { guildId: interaction.guildId, roleId });
    }
    if (interaction.isButton() && interaction.customId.startsWith('verify:dm-start:')) {
      const [, , guildId, roleId] = interaction.customId.split(':');
      if (verificationSettingsStore.get(guildId)?.roleId !== roleId) return interaction.reply({ content: 'この認証案内は無効になりました。サーバー内の認証パネルを利用してください。' });
      return beginVerification(interaction, { guildId, roleId });
    }
    if (interaction.isButton() && interaction.customId.startsWith('verify:choice:')) {
      const [, , challengeId, selectedAnswer] = interaction.customId.split(':');
      const challenge = verificationChallenges.get(challengeId);
      verificationChallenges.delete(challengeId);
      if (!challenge || challenge.userId !== interaction.user.id || challenge.expiresAt < Date.now()) return interaction.reply({ ...(interaction.inGuild() ? { ephemeral: true } : {}), content: '認証の有効期限が切れました。もう一度認証を開始してください。' });
      if (Number(selectedAnswer) !== challenge.answer) return interaction.reply({ ...(interaction.inGuild() ? { ephemeral: true } : {}), content: '今回は違いました。もう一度「認証を開始」から挑戦してください。' });
      return completeVerification(interaction, challenge);
    }
    if (interaction.isButton() && interaction.customId.startsWith('verify:input:')) {
      return interaction.reply({ ...(interaction.inGuild() ? { ephemeral: true } : {}), content: 'この認証パネルは更新されました。「認証を開始」から新しい問題に挑戦してください。' });
    }
    if (interaction.isChatInputCommand()) await handleCommand(interaction);
    } catch (error) {
    if (isStaleInteractionResponse(error)) {
      console.warn('期限切れ、または別の実行環境が先に応答したDiscord操作を無視しました。');
      return;
    }
    const isMediaOperation = isMediaConverterInteraction(interaction);
    const payload = isMediaOperation
      ? { ephemeral: true, content: /^MP[34]変換に失敗/u.test(error?.message || '') ? `❌ ${error.message}` : '❌ 変換できませんでした。詳細は管理者へ記録しました。URL・権利設定・DM受信設定を確認して、もう一度お試しください。' }
      : { ephemeral: true, content: `実行できませんでした: ${error.message}` };
    const isPurchaseOperation = (interaction.isChatInputCommand?.() && interaction.commandName === '利用権購入') || interaction.customId?.startsWith('purchase:');
    // Discordの操作には短い初期応答期限がある。外部ログ先への通信を先に待つと、
    // 本来表示できるエラーまで「アプリケーションが応答しませんでした」になってしまう。
    // 利用者への応答を最優先し、監査ログと自動復旧は後段で行う。
    try {
      if (interaction.deferred) await interaction.editReply(payload);
      else if (interaction.replied) await interaction.followUp(payload);
      else await interaction.reply(payload);
    } catch (responseError) {
      // 多重起動・期限切れ等で既に応答済みのInteractionへ再応答しない。
      if (!isStaleInteractionResponse(responseError)) await reportRuntimeError('エラー応答の送信', responseError, [{ name: '操作ユーザーID', value: `\`${interaction.user?.id || '不明'}\`` }]);
    }
    if (isPurchaseOperation) await writePurchaseTicketLog({ title: '利用権購入エラー', description: error.message || '不明なエラー', fields: [{ name: '操作ユーザーID', value: `\`${interaction.user?.id || '不明'}\`` }, ...(interaction.guildId ? [{ name: 'サーバーID', value: `\`${interaction.guildId}\`` }] : [])], color: 0xed4245 }).catch(() => {});
    await reportRuntimeError(isMediaOperation ? 'メディア変換' : 'コマンド・UI操作', error, [
      { name: '操作ユーザーID', value: `\`${interaction.user?.id || '不明'}\`` },
      { name: '実行チャンネル', value: `\`${interaction.channelId || 'DM'}\`` },
      ...(interaction.guildId ? [{ name: 'サーバーID', value: `\`${interaction.guildId}\`` }] : []),
    ]);
    if (isMediaOperation) requestSelfHealing('media');
  }
});

try {
  // Do not make a separate REST preflight here. Shared cloud egress IPs can
  // be rate-limited by Discord even though the token is valid; discord.js
  // already handles the gateway endpoint and its retry instructions itself.
  startSelfHealingMonitor();
  console.log('Discord gateway login is starting.');
  await Promise.race([
    discord.login(config.discordToken),
    new Promise((_, reject) => setTimeout(
          () => reject(new Error('Discord gateway connection timed out after 3 minutes. The cloud service will retry the bot process.')),
          3 * 60_000,
    )),
  ]);
  console.log('Discord gateway login request was accepted.');
} catch (error) {
  console.error(`Discord startup failed: ${error.message}`);
  // 終了させず、自己復旧監視がクールダウン後にGateway接続を再作成する。
  reportRuntimeError('Discord起動', error);
  requestSelfHealing('communication', GATEWAY_RECOVERY_GRACE_MS);
}
