import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';

const ROWS = Object.freeze({
  operational: { emoji: '🟢', label: '正常', group: 'healthy' },
  degraded: { emoji: '🟡', label: '一部障害', group: 'partial' },
  maintenance: { emoji: '🟡', label: 'メンテナンス', group: 'partial' },
  major: { emoji: '🔴', label: '停止・大規模障害', group: 'down' },
  unknown: { emoji: '⚪', label: '未確認', group: 'unknown' },
});
const ICONS = { valorant: '🎯', apex: '🔺', overwatch: '🛡️', vrchat: '🥽' };
export const CUSTOM_STATUS_CHANNEL_ID = '1543158103330267216';
export const CUSTOM_STATUS_ICONS = Object.freeze({
  valorant: '<:valorant_status:1543896117622874135>',
  apex: '<:apex_predator:1538144690447065148>',
  overwatch: '<:overwatch_status:1543896121447809035>',
  vrchat: '<a:TT_discoDanceOwO:1538144800224837703>',
});

export function gameStatusCounts(statuses) {
  const counts = { healthy: 0, partial: 0, down: 0, unknown: 0 };
  for (const status of statuses) counts[(ROWS[status.state] || ROWS.unknown).group]++;
  return counts;
}

export function buildGameStatusEmbed(statuses, now = Date.now(), { channelId } = {}) {
  const counts = gameStatusCounts(statuses);
  const summary = `🟢 **正常 ${counts.healthy}**　🟡 **一部障害 ${counts.partial}**　🔴 **停止 ${counts.down}**　⚪ **未確認 ${counts.unknown}**`;
  const lines = statuses.map(status => {
    const row = ROWS[status.state] || ROWS.unknown;
    const name = status.name.replace(/[\[\]()*_~`]/g, '');
    const source = /^https:\/\//i.test(status.sourceUrl || '') ? `[${name}](${status.sourceUrl})` : name;
    const icons = channelId === CUSTOM_STATUS_CHANNEL_ID ? CUSTOM_STATUS_ICONS : ICONS;
    return `${icons[status.id] || '🎮'} **${source}**　${row.emoji} ${row.label}`;
  });
  return new EmbedBuilder().setColor(counts.down ? 0xed4245 : counts.partial ? 0xfee75c : 0x57f287)
    .setTitle('📊 ゲームサービス稼働状況')
    .setDescription(`${summary}\n\n${lines.join('\n')}\n\nサービス名から公式情報を確認できます。\n⚪ 情報を取得できないサービスは、正常と断定せず「未確認」と表示します。`)
    .setFooter({ text: '5分ごとにこのパネルを更新・状態変化の個別投稿なし｜最終更新' })
    .setTimestamp(now);
}

export function buildGameStatusPanel(statuses, options = {}) {
  return { embeds: [buildGameStatusEmbed(statuses, Date.now(), options)], components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('game-status:refresh').setLabel('最新の状態に更新').setStyle(ButtonStyle.Primary).setEmoji('🔄'),
  )], allowedMentions: { parse: [] } };
}

export async function upsertGameStatusPanel(channel, messageId, botId, statuses) {
  let message;
  if (messageId) {
    try { message = await channel.messages.fetch(messageId); }
    catch (error) { if (error.code !== 10008) throw error; }
  }
  if (message && message.author.id !== botId) throw new Error('状態パネルのメッセージ作成者がBotではありません。');
  if (message) return message.edit(buildGameStatusPanel(statuses, { channelId: channel.id }));
  return channel.send(buildGameStatusPanel(statuses, { channelId: channel.id }));
}
