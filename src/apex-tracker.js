import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

const API_BASE_URL = 'https://api.apexlegendsstatus.com';
const API_SOURCE_URL = 'https://apexlegendsstatus.com';
const REQUEST_INTERVAL_MS = 2_100;
const REQUEST_TIMEOUT_MS = 15_000;
const PANEL_USERS_PER_PAGE = 4;
const MAX_AUTO_REFRESH_USERS = 25;

export const APEX_AUTO_REFRESH_INTERVAL_MS = 5 * 60_000;
export const APEX_TRACKER_COMMAND_NAMES = Object.freeze([
  'rank',
  'rankstart',
  'rankend',
  'apex-map',
  'team',
  'apex-panel',
]);

const PLATFORM_LABELS = Object.freeze({
  PC: 'PC',
  PS4: 'PlayStation',
  X1: 'Xbox',
  SWITCH: 'Nintendo Switch',
});

const RANK_THRESHOLDS = Object.freeze([
  { name: 'Rookie', minRp: 0 },
  { name: 'Bronze', minRp: 1_000 },
  { name: 'Silver', minRp: 3_000 },
  { name: 'Gold', minRp: 5_250 },
  { name: 'Platinum', minRp: 8_250 },
  { name: 'Diamond', minRp: 12_000 },
  { name: 'Master', minRp: 16_000 },
]);

export class ApexTrackerError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'ApexTrackerError';
    this.status = status;
  }
}

function asFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function validateApexPlatform(value) {
  const platform = String(value || 'PC').trim().toUpperCase();
  if (!Object.hasOwn(PLATFORM_LABELS, platform)) {
    throw new ApexTrackerError('プラットフォームは PC / PS4 / X1 / SWITCH のいずれかで入力してください。');
  }
  return platform;
}

export function validateApexPlayerName(value) {
  const playerName = String(value || '').trim();
  if (!playerName) throw new ApexTrackerError('Apexのプレイヤー名を入力してください。');
  if (playerName.length > 100) throw new ApexTrackerError('プレイヤー名は100文字以内で入力してください。');
  return playerName;
}

function responseErrorMessage(status, body) {
  if (status === 403) return 'Apex APIキーが無効です。Bot管理者へ連絡してください。';
  if (status === 404) return 'Apexプレイヤーが見つかりませんでした。PC版は連携しているEAアカウント名、Switch版はUIDを確認してください。';
  if (status === 410) return '指定したプラットフォームをApex APIが受け付けませんでした。';
  if (status === 429) return 'Apex APIの利用上限に達しました。少し待ってから再実行してください。';
  if (status >= 500) return 'Apex APIで一時的な障害が発生しています。しばらく待ってから再実行してください。';
  const detail = typeof body?.Error === 'string' ? body.Error.slice(0, 300) : null;
  return detail ? `Apex APIからエラーが返されました: ${detail}` : `Apex APIへの接続に失敗しました（HTTP ${status}）。`;
}

export class ApexApiClient {
  constructor({ apiKey = () => process.env.APEX_API_KEY?.trim(), fetchImpl = fetch } = {}) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.lastRequestAt = 0;
    this.queue = Promise.resolve();
  }

  async request(path, searchParams) {
    const operation = async () => {
      const key = this.apiKey();
      if (!key) throw new ApexTrackerError('Apex Trackerは準備中です。Bot管理者がAPEX_API_KEYを設定する必要があります。');
      const waitMs = Math.max(0, REQUEST_INTERVAL_MS - (Date.now() - this.lastRequestAt));
      if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.lastRequestAt = Date.now();

      const requestUrl = new URL(path, API_BASE_URL);
      for (const [name, value] of Object.entries(searchParams)) requestUrl.searchParams.set(name, String(value));
      let response;
      try {
        response = await this.fetchImpl(requestUrl, {
          headers: { Authorization: key, Accept: 'application/json' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
          throw new ApexTrackerError('Apex APIが時間内に応答しませんでした。少し待ってから再実行してください。');
        }
        throw new ApexTrackerError('Apex APIへ接続できませんでした。ネットワーク状態を確認して再実行してください。');
      }

      let body;
      try {
        body = await response.json();
      } catch {
        throw new ApexTrackerError('Apex APIの応答を読み取れませんでした。', { status: response.status });
      }
      if (!response.ok || body?.Error) {
        throw new ApexTrackerError(responseErrorMessage(response.status, body), { status: response.status });
      }
      return body;
    };

    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async fetchPlayer(playerName, platform = 'PC') {
    const validName = validateApexPlayerName(playerName);
    const validPlatform = validateApexPlatform(platform);
    const body = await this.request('/bridge', {
      [validPlatform === 'SWITCH' ? 'uid' : 'player']: validName,
      platform: validPlatform,
      version: 5,
      merge: true,
    });
    const global = body?.global;
    const rank = global?.rank;
    if (!global || !rank) throw new ApexTrackerError('プレイヤーのランク情報を取得できませんでした。');
    const splitEndEpoch = asFiniteNumber(rank?.rankedSeasonMeta?.end, 0);
    const killsValue = body?.total?.kills?.value;
    return {
      playerName: String(global.name || validName),
      lookup: validName,
      platform: validateApexPlatform(global.platform || validPlatform),
      level: asFiniteNumber(global.level, 0),
      rp: asFiniteNumber(rank.rankScore, 0),
      rankName: String(rank.rankName || 'Unknown'),
      rankDivision: asFiniteNumber(rank.rankDiv, 0),
      kills: killsValue === undefined || killsValue === null ? null : Math.max(0, asFiniteNumber(killsValue, 0)),
      splitEndAt: splitEndEpoch > 0 ? splitEndEpoch * 1_000 : null,
      fetchedAt: Date.now(),
    };
  }

  async fetchRankedMap() {
    const body = await this.request('/maprotation', { version: 2 });
    const current = body?.ranked?.current;
    if (!current) throw new ApexTrackerError('現在のランクマップ情報を取得できませんでした。');
    return {
      current: String(current.map || '不明'),
      remaining: String(current.remainingTimer || '不明'),
      next: String(body?.ranked?.next?.map || '不明'),
      fetchedAt: Date.now(),
    };
  }
}

function emptyGuildData() {
  return { panelChannelId: null, panelMessageId: null, page: 0, registrations: {}, sessions: {} };
}

function normalizedStats(stats) {
  if (!stats || typeof stats !== 'object') return null;
  return {
    playerName: String(stats.playerName || ''),
    platform: Object.hasOwn(PLATFORM_LABELS, stats.platform) ? stats.platform : 'PC',
    level: asFiniteNumber(stats.level, 0),
    rp: asFiniteNumber(stats.rp, 0),
    rankName: String(stats.rankName || 'Unknown'),
    rankDivision: asFiniteNumber(stats.rankDivision, 0),
    kills: stats.kills === undefined || stats.kills === null ? null : Math.max(0, asFiniteNumber(stats.kills, 0)),
    splitEndAt: stats.splitEndAt ? asFiniteNumber(stats.splitEndAt, null) : null,
    fetchedAt: asFiniteNumber(stats.fetchedAt, 0),
  };
}

export class ApexTrackerStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { version: 1, guilds: {} };
    this.saving = Promise.resolve();
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.filePath, 'utf8'));
      this.data = saved?.guilds && typeof saved.guilds === 'object' ? saved : { version: 1, guilds: {} };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.data = { version: 1, guilds: {} };
    }
  }

  guild(guildId) {
    this.data.guilds[guildId] ||= emptyGuildData();
    const guild = this.data.guilds[guildId];
    guild.registrations ||= {};
    guild.sessions ||= {};
    return guild;
  }

  list(guildId) {
    return Object.values(this.guild(guildId).registrations)
      .map((registration) => ({ ...registration, stats: normalizedStats(registration.stats) }))
      .sort((left, right) => String(left.displayName).localeCompare(String(right.displayName), 'ja'));
  }

  getRegistration(guildId, userId) { return this.guild(guildId).registrations[userId] || null; }

  register(guildId, user, stats) {
    const guild = this.guild(guildId);
    const previous = guild.registrations[user.id];
    const lookup = stats.lookup || stats.playerName;
    if (previous && ((previous.lookup || previous.playerName) !== lookup || previous.platform !== stats.platform)) delete guild.sessions[user.id];
    guild.registrations[user.id] = {
      userId: user.id,
      displayName: user.globalName || user.username || user.id,
      playerName: stats.playerName,
      lookup,
      platform: stats.platform,
      stats,
      registeredAt: previous?.registeredAt || Date.now(),
      updatedAt: Date.now(),
      lastError: null,
    };
  }

  updateStats(guildId, userId, stats) {
    const registration = this.getRegistration(guildId, userId);
    if (!registration) return false;
    Object.assign(registration, { playerName: stats.playerName, platform: stats.platform, stats, updatedAt: Date.now(), lastError: null });
    return true;
  }

  markRefreshError(guildId, userId, message) {
    const registration = this.getRegistration(guildId, userId);
    if (!registration) return;
    registration.lastError = String(message || '更新に失敗しました。').slice(0, 300);
    registration.lastAttemptAt = Date.now();
  }

  removeRegistration(guildId, userId) {
    const guild = this.guild(guildId);
    if (!guild.registrations[userId]) return false;
    delete guild.registrations[userId];
    delete guild.sessions[userId];
    return true;
  }

  startSession(guildId, userId, stats) {
    const guild = this.guild(guildId);
    if (guild.sessions[userId]) return null;
    const session = {
      playerName: stats.playerName,
      lookup: stats.lookup || stats.playerName,
      platform: stats.platform,
      startedAt: Date.now(),
      startKills: stats.kills,
      startRp: stats.rp,
    };
    guild.sessions[userId] = session;
    return session;
  }

  getSession(guildId, userId) { return this.guild(guildId).sessions[userId] || null; }

  endSession(guildId, userId, stats) {
    const guild = this.guild(guildId);
    const session = guild.sessions[userId];
    if (!session) return null;
    delete guild.sessions[userId];
    return {
      ...session,
      endedAt: Date.now(),
      endKills: stats.kills,
      endRp: stats.rp,
      killsGained: stats.kills === null || session.startKills === null ? null : stats.kills - session.startKills,
      rpChange: stats.rp - session.startRp,
    };
  }

  setPanel(guildId, channelId, messageId) {
    Object.assign(this.guild(guildId), { panelChannelId: channelId, panelMessageId: messageId });
  }

  setPage(guildId, page) { this.guild(guildId).page = Math.max(0, Math.trunc(page)); }

  async save() {
    const write = async () => {
      await mkdir(new URL('.', this.filePath), { recursive: true });
      const temporaryPath = new URL('./apex-tracker.tmp', this.filePath);
      await writeFile(temporaryPath, JSON.stringify(this.data, null, 2), 'utf8');
      await rename(temporaryPath, this.filePath);
    };
    this.saving = this.saving.then(write, write);
    return this.saving;
  }
}

function rankDisplay(stats) {
  if (!stats) return '未取得';
  if (['Rookie', 'Master', 'Predator', 'Apex Predator'].includes(stats.rankName)) return stats.rankName;
  const divisions = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV' };
  return `${stats.rankName} ${divisions[stats.rankDivision] || stats.rankDivision || ''}`.trim();
}

function nextRankGoal(stats) {
  if (!stats) return null;
  const rankName = String(stats.rankName).toLowerCase();
  const tierIndex = RANK_THRESHOLDS.findIndex((rank) => rankName.includes(rank.name.toLowerCase()));
  if (tierIndex < 0 || tierIndex >= RANK_THRESHOLDS.length - 1) return null;
  const next = RANK_THRESHOLDS[tierIndex + 1];
  const needed = Math.max(0, next.minRp - stats.rp);
  let daily = null;
  if (stats.splitEndAt && stats.splitEndAt > Date.now()) {
    const days = Math.max(1, Math.ceil((stats.splitEndAt - Date.now()) / 86_400_000));
    daily = Math.ceil(needed / days);
  }
  return { ...next, needed, daily };
}

function userEmbed(registration) {
  const stats = normalizedStats(registration.stats);
  const goal = nextRankGoal(stats);
  const embed = new EmbedBuilder()
    .setColor(stats ? 0xda292a : 0x747f8d)
    .setTitle(stats ? `${rankDisplay(stats)}｜${stats.rp.toLocaleString('ja-JP')} RP` : '戦績を取得できていません')
    .setDescription([
      `👤 <@${registration.userId}>`,
      `🎮 **${registration.playerName}**｜${PLATFORM_LABELS[registration.platform] || registration.platform}`,
    ].join('\n'));
  if (stats) {
    embed.addFields(
      { name: 'レベル', value: stats.level ? stats.level.toLocaleString('ja-JP') : '不明', inline: true },
      { name: '累計キル', value: stats.kills !== null ? stats.kills.toLocaleString('ja-JP') : '未取得※', inline: true },
      { name: '次の目標', value: goal ? `**${goal.name}**まで ${goal.needed.toLocaleString('ja-JP')} RP${goal.daily !== null ? `\n目安 ${goal.daily.toLocaleString('ja-JP')} RP/日` : ''}` : 'Master以上／次の固定RP目標なし', inline: false },
    );
  }
  if (registration.lastError) embed.addFields({ name: '直近の更新', value: `⚠️ ${registration.lastError}` });
  embed.setFooter({ text: `更新: ${stats?.fetchedAt ? new Date(stats.fetchedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '未取得'}｜※バナーのキルトラッカーが必要` });
  return embed;
}

export function buildApexPanelPayload(store, guildId, requestedPage = null) {
  const registrations = store.list(guildId);
  const totalPages = Math.max(1, Math.ceil(registrations.length / PANEL_USERS_PER_PAGE));
  const savedPage = requestedPage ?? store.guild(guildId).page ?? 0;
  const page = Math.min(Math.max(0, savedPage), totalPages - 1);
  const visible = registrations.slice(page * PANEL_USERS_PER_PAGE, (page + 1) * PANEL_USERS_PER_PAGE);
  const header = new EmbedBuilder()
    .setColor(0xda292a)
    .setTitle('🔺 Apex Legends｜リアルタイム戦績パネル')
    .setDescription([
      '「Apexアカウントを登録」から誰でも自分のアカウントを登録・更新できます。',
      '戦績は登録直後、手動更新時、約5分ごとの自動更新で反映します。',
      `[Data provided by Apex Legends Status](${API_SOURCE_URL})（非公式API）`,
    ].join('\n'))
    .addFields({ name: '登録人数', value: `${registrations.length}人`, inline: true }, { name: '表示ページ', value: `${page + 1} / ${totalPages}`, inline: true });
  const embeds = [header, ...(visible.length ? visible.map(userEmbed) : [new EmbedBuilder().setColor(0x747f8d).setDescription('まだApexアカウントは登録されていません。下のボタンから最初の登録ができます。')])];
  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('apex:register').setLabel('Apexアカウントを登録').setEmoji('📝').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('apex:refresh-own').setLabel('自分を更新').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('apex:remove').setLabel('登録を削除').setStyle(ButtonStyle.Danger),
  );
  const pagination = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`apex:page:${Math.max(0, page - 1)}`).setLabel('前へ').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId('apex:page-label').setLabel(`${page + 1} / ${totalPages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(`apex:page:${Math.min(totalPages - 1, page + 1)}`).setLabel('次へ').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
    new ButtonBuilder().setCustomId('apex:refresh-panel').setLabel('全員を更新').setStyle(ButtonStyle.Success),
  );
  return { embeds, components: [controls, pagination], allowedMentions: { parse: [] } };
}

function playerOptions(interaction, store) {
  const suppliedName = interaction.options.getString('player');
  const suppliedPlatform = interaction.options.getString('platform');
  if (suppliedName) return { playerName: validateApexPlayerName(suppliedName), platform: validateApexPlatform(suppliedPlatform || 'PC') };
  const registration = store.getRegistration(interaction.guildId, interaction.user.id);
  if (!registration) throw new ApexTrackerError('先に戦績パネルの「Apexアカウントを登録」から登録するか、playerを指定してください。');
  return { playerName: registration.lookup || registration.playerName, platform: validateApexPlatform(suppliedPlatform || registration.platform) };
}

function statsText(stats) {
  const goal = nextRankGoal(stats);
  const lines = [
    `**${stats.playerName}**｜${PLATFORM_LABELS[stats.platform]}`,
    `現在: **${rankDisplay(stats)}**｜**${stats.rp.toLocaleString('ja-JP')} RP**`,
    `レベル: ${stats.level ? stats.level.toLocaleString('ja-JP') : '不明'}`,
    `累計キル: ${stats.kills !== null ? stats.kills.toLocaleString('ja-JP') : '未取得（バナーにキルトラッカーを装備してください）'}`,
  ];
  if (goal) lines.push(`次の目標: **${goal.name}**まで **${goal.needed.toLocaleString('ja-JP')} RP**${goal.daily !== null ? `（約${goal.daily.toLocaleString('ja-JP')} RP/日）` : ''}`);
  return lines.join('\n');
}

export class ApexTracker {
  constructor(filePath, { api = new ApexApiClient() } = {}) {
    this.store = new ApexTrackerStore(filePath);
    this.api = api;
    this.refreshingGuilds = new Set();
  }

  async load() { await this.store.load(); }
  handlesCommand(commandName) { return APEX_TRACKER_COMMAND_NAMES.includes(commandName); }
  matches(interaction) { return typeof interaction.customId === 'string' && interaction.customId.startsWith('apex:'); }

  async publishPanel(channel) {
    const guildId = channel.guild.id;
    const settings = this.store.guild(guildId);
    let message = null;
    if (settings.panelChannelId === channel.id && settings.panelMessageId) {
      message = await channel.messages.fetch(settings.panelMessageId).catch(() => null);
    }
    if (message) await message.edit(buildApexPanelPayload(this.store, guildId));
    else message = await channel.send(buildApexPanelPayload(this.store, guildId));
    this.store.setPanel(guildId, channel.id, message.id);
    await this.store.save();
    return message;
  }

  async updatePanel(guildId, client) {
    const settings = this.store.guild(guildId);
    if (!settings.panelChannelId || !settings.panelMessageId) return false;
    const channel = await client.channels.fetch(settings.panelChannelId).catch(() => null);
    if (!channel?.isTextBased()) return false;
    const message = await channel.messages.fetch(settings.panelMessageId).catch(() => null);
    if (!message) return false;
    await message.edit(buildApexPanelPayload(this.store, guildId));
    return true;
  }

  async repairPanel(guildId, client) {
    const settings = this.store.guild(guildId);
    if (!settings.panelChannelId) return false;
    const channel = await client.channels.fetch(settings.panelChannelId).catch(() => null);
    if (!channel?.isTextBased() || !channel.isSendable()) return false;
    await this.publishPanel(channel);
    return true;
  }

  async refreshRegistration(guildId, userId) {
    const registration = this.store.getRegistration(guildId, userId);
    if (!registration) throw new ApexTrackerError('Apexアカウントが登録されていません。');
    try {
      const stats = await this.api.fetchPlayer(registration.lookup || registration.playerName, registration.platform);
      this.store.updateStats(guildId, userId, stats);
      await this.store.save();
      return stats;
    } catch (error) {
      this.store.markRefreshError(guildId, userId, error.message);
      await this.store.save();
      throw error;
    }
  }

  async refreshGuild(guildId, client, { limit = MAX_AUTO_REFRESH_USERS } = {}) {
    if (this.refreshingGuilds.has(guildId)) return false;
    this.refreshingGuilds.add(guildId);
    try {
      const registrations = this.store.list(guildId)
        .sort((left, right) => Math.max(left.stats?.fetchedAt || 0, left.lastAttemptAt || 0) - Math.max(right.stats?.fetchedAt || 0, right.lastAttemptAt || 0))
        .slice(0, limit);
      for (const registration of registrations) {
        await this.refreshRegistration(guildId, registration.userId).catch(() => null);
      }
      await this.repairPanel(guildId, client);
      return true;
    } finally {
      this.refreshingGuilds.delete(guildId);
    }
  }

  async refreshAllPanels(client) {
    for (const [guildId, settings] of Object.entries(this.store.data.guilds)) {
      if (!settings.panelMessageId) continue;
      await this.refreshGuild(guildId, client).catch((error) => console.warn(`Apex戦績パネルを更新できませんでした (${guildId}): ${error.message}`));
    }
  }

  async handleCommand(interaction, client) {
    if (!interaction.inGuild()) throw new ApexTrackerError('Apex Trackerはサーバー内で使用してください。');
    if (interaction.commandName === 'apex-panel') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new ApexTrackerError('戦績パネルの設置には「サーバーの管理」権限が必要です。');
      const channel = interaction.options.getChannel('channel') || interaction.channel;
      if (!channel?.isTextBased() || !channel.isSendable()) throw new ApexTrackerError('パネルの設置先には送信可能なテキストチャンネルを指定してください。');
      await interaction.deferReply({ ephemeral: true });
      await this.publishPanel(channel);
      return interaction.editReply(`✅ Apex戦績パネルを ${channel} に設置・更新しました。`);
    }
    if (interaction.commandName === 'apex-map') {
      await interaction.deferReply();
      const rotation = await this.api.fetchRankedMap();
      return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xda292a).setTitle('🗺️ Apex ランクマップ').addFields(
        { name: '現在', value: `**${rotation.current}**\n残り ${rotation.remaining}` },
        { name: '次のマップ', value: `**${rotation.next}**` },
      ).setDescription(`[Data provided by Apex Legends Status](${API_SOURCE_URL})`).setTimestamp(rotation.fetchedAt)] });
    }
    if (interaction.commandName === 'team') return this.handleTeam(interaction);
    if (interaction.commandName === 'rankend') {
      await interaction.deferReply();
      const session = this.store.getSession(interaction.guildId, interaction.user.id);
      if (!session) throw new ApexTrackerError('進行中の手動セッションがありません。`/rankstart`で開始してください。');
      const stats = await this.api.fetchPlayer(session.lookup || session.playerName, session.platform);
      const result = this.store.endSession(interaction.guildId, interaction.user.id, stats);
      if (this.store.getRegistration(interaction.guildId, interaction.user.id)) this.store.updateStats(interaction.guildId, interaction.user.id, stats);
      await this.store.save();
      await this.updatePanel(interaction.guildId, client);
      const rpSign = result.rpChange >= 0 ? '+' : '';
      const killChange = result.killsGained === null ? '取得不可（バナーのキルトラッカーが必要）' : `${result.killsGained >= 0 ? '+' : ''}${result.killsGained.toLocaleString('ja-JP')}`;
      const killResult = result.startKills === null || result.endKills === null
        ? killChange
        : `${result.startKills.toLocaleString('ja-JP')} → ${result.endKills.toLocaleString('ja-JP')}（**${killChange}**）`;
      return interaction.editReply({ embeds: [new EmbedBuilder().setColor(result.rpChange >= 0 ? 0x57f287 : 0xed4245).setTitle('🏁 Apex 手動セッション結果').setDescription(
        `**${result.playerName}**\n<t:${Math.floor(result.startedAt / 1_000)}:t> → <t:${Math.floor(result.endedAt / 1_000)}:t>`,
      ).addFields(
        { name: 'RP', value: `${result.startRp.toLocaleString('ja-JP')} → ${result.endRp.toLocaleString('ja-JP')}（**${rpSign}${result.rpChange.toLocaleString('ja-JP')}**）` },
        { name: 'キル', value: killResult },
      )] });
    }

    if (interaction.commandName === 'rankstart') {
      const existing = this.store.getSession(interaction.guildId, interaction.user.id);
      if (existing) throw new ApexTrackerError(`**${existing.playerName}**の手動セッションは既に進行中です。終了には\`/rankend\`を使用してください。`);
    }

    await interaction.deferReply();
    const player = playerOptions(interaction, this.store);
    const stats = await this.api.fetchPlayer(player.playerName, player.platform);
    const registration = this.store.getRegistration(interaction.guildId, interaction.user.id);
    if (registration && (registration.lookup || registration.playerName).toLowerCase() === player.playerName.toLowerCase() && registration.platform === player.platform) {
      this.store.updateStats(interaction.guildId, interaction.user.id, stats);
      await this.store.save();
      await this.updatePanel(interaction.guildId, client);
    }
    if (interaction.commandName === 'rank') {
      return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xda292a).setTitle('🔺 Apexランク情報').setDescription(statsText(stats)).setFooter({ text: 'Data provided by Apex Legends Status' }).setTimestamp(stats.fetchedAt)] });
    }
    this.store.startSession(interaction.guildId, interaction.user.id, stats);
    await this.store.save();
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('▶️ Apex 手動セッション開始').setDescription(`${statsText(stats)}\n\n開始: <t:${Math.floor(Date.now() / 1_000)}:t>\n終了時は\`/rankend\`を実行してください。`)] });
  }

  async handleTeam(interaction) {
    if (!interaction.guild) throw new ApexTrackerError('このコマンドはサーバー内で使用してください。');
    await interaction.deferReply();
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const voiceChannel = member.voice.channel;
    if (!voiceChannel) throw new ApexTrackerError('チーム分けするメンバーと同じボイスチャンネルへ参加してください。');
    const members = [...voiceChannel.members.values()].filter((candidate) => !candidate.user.bot);
    if (members.length < 2) throw new ApexTrackerError('チーム分けにはボイスチャンネル内のメンバーが2人以上必要です。');
    const teamSize = interaction.options.getInteger('size') ?? 3;
    const shuffled = [...members];
    for (let index = shuffled.length - 1; index > 0; index--) {
      const swap = Math.floor(Math.random() * (index + 1));
      [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
    }
    const teams = [];
    for (let index = 0; index < shuffled.length; index += teamSize) teams.push(shuffled.slice(index, index + teamSize));
    if (teams.length > 1 && teams.at(-1).length === 1) teams.at(-2).push(teams.pop()[0]);
    const description = teams.map((team, index) => `**チーム${index + 1}**\n${team.map((candidate) => `• ${candidate}`).join('\n')}`).join('\n\n');
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xda292a).setTitle(`🎲 Apexチーム分け｜${members.length}人`).setDescription(description)], allowedMentions: { parse: [] } });
  }

  async handle(interaction, client) {
    if (!interaction.inGuild()) throw new ApexTrackerError('Apex戦績パネルはサーバー内で使用してください。');
    if (interaction.customId === 'apex:register') {
      return interaction.showModal(new ModalBuilder().setCustomId('apex:register-submit').setTitle('Apexアカウント登録').addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('player').setLabel('EAアカウント名 / Switch UID').setPlaceholder('PC版はEA名、Switch版はUIDを入力').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('platform').setLabel('プラットフォーム').setPlaceholder('PC / PS4 / X1 / SWITCH').setValue('PC').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(6)),
      ));
    }
    if (interaction.customId === 'apex:register-submit') {
      await interaction.deferReply({ ephemeral: true });
      const playerName = validateApexPlayerName(interaction.fields.getTextInputValue('player'));
      const platform = validateApexPlatform(interaction.fields.getTextInputValue('platform'));
      const stats = await this.api.fetchPlayer(playerName, platform);
      this.store.register(interaction.guildId, interaction.user, stats);
      await this.store.save();
      await this.updatePanel(interaction.guildId, client);
      return interaction.editReply(`✅ **${stats.playerName}**（${PLATFORM_LABELS[stats.platform]}）を登録しました。戦績パネルへ反映済みです。`);
    }
    if (interaction.customId === 'apex:refresh-own') {
      await interaction.deferReply({ ephemeral: true });
      const stats = await this.refreshRegistration(interaction.guildId, interaction.user.id);
      await this.updatePanel(interaction.guildId, client);
      return interaction.editReply(`✅ **${stats.playerName}**の戦績を更新しました。`);
    }
    if (interaction.customId === 'apex:remove') {
      if (!this.store.getRegistration(interaction.guildId, interaction.user.id)) throw new ApexTrackerError('削除できるApexアカウント登録がありません。');
      return interaction.reply({ ephemeral: true, content: '登録情報と進行中の手動セッションを削除しますか？', components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('apex:remove-confirm').setLabel('削除する').setStyle(ButtonStyle.Danger),
      )] });
    }
    if (interaction.customId === 'apex:remove-confirm') {
      this.store.removeRegistration(interaction.guildId, interaction.user.id);
      await this.store.save();
      await interaction.update({ content: '✅ Apexアカウント登録を削除しました。', components: [] });
      return this.updatePanel(interaction.guildId, client);
    }
    if (interaction.customId === 'apex:refresh-panel') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new ApexTrackerError('全員分の更新には「サーバーの管理」権限が必要です。');
      await interaction.deferReply({ ephemeral: true });
      await this.refreshGuild(interaction.guildId, client);
      return interaction.editReply('✅ 登録ユーザーの戦績を更新しました。');
    }
    if (interaction.customId.startsWith('apex:page:')) {
      const page = Number(interaction.customId.split(':')[2]);
      if (!Number.isInteger(page) || page < 0) throw new ApexTrackerError('ページ情報が正しくありません。');
      this.store.setPage(interaction.guildId, page);
      await this.store.save();
      return interaction.update(buildApexPanelPayload(this.store, interaction.guildId, page));
    }
    throw new ApexTrackerError('このApexパネル操作は無効になりました。最新のパネルを利用してください。');
  }
}
