import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { DAY_MS, DEFAULT_INACTIVITY_SETTINGS, inactivityWarningDay } from './activity.js';

export const INACTIVITY_PANEL_CHANNEL_ID = '1542845920675233894';
const ROWS_PER_EMBED = 18;
const EMBEDS_PER_MESSAGE = 3;

export function formatRemainingHours(milliseconds) {
  if (milliseconds <= 0) return '0時間';
  return `${Math.ceil(milliseconds / 3_600_000)}時間`;
}

function statusFor(lastActiveAt, settings, now) {
  const elapsedMs = Math.max(0, now - lastActiveAt);
  const elapsedDays = Math.floor(elapsedMs / DAY_MS);
  const remainingMs = Math.max(0, settings.kickDays * DAY_MS - elapsedMs);
  const remaining = formatRemainingHours(remainingMs);
  if (elapsedDays >= inactivityWarningDay(settings)) return { icon: '🔴', label: `期限間近・あと${remaining}` };
  if (elapsedDays >= Math.max(1, Math.floor(settings.kickDays / 2))) return { icon: '🟡', label: `あと${remaining}` };
  return { icon: '🟢', label: `あと${remaining}` };
}

export function buildInactivityPanelPayloads({ guild, activities, kicked, settings = DEFAULT_INACTIVITY_SETTINGS, now = Date.now() }) {
  const activeRows = [...activities]
    .sort((left, right) => left.lastActiveAt - right.lastActiveAt)
    .map((entry) => {
      const status = statusFor(entry.lastActiveAt, settings, now);
      return `${status.icon} <@${entry.userId}>\n　最終活動 <t:${Math.floor(entry.lastActiveAt / 1_000)}:f>　•　**${status.label}**`;
    });
  const kickedRows = [...kicked]
    .sort((left, right) => right.kickedAt - left.kickedAt)
    .map((entry) => `⚫ **${entry.displayName || entry.username || entry.userId}**（\`${entry.userId}\`）\n　Kick済み　•　${entry.dmSent ? 'DM送信済み' : 'DM送信不可'}　•　退出日時 <t:${Math.floor(entry.kickedAt / 1_000)}:f>`);

  const sections = [];
  for (let index = 0; index < activeRows.length; index += ROWS_PER_EMBED) {
    const page = index / ROWS_PER_EMBED + 1;
    sections.push(new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle(`👥 監視中メンバー ${page}`)
      .setDescription(activeRows.slice(index, index + ROWS_PER_EMBED).join('\n\n') || '監視対象はいません。'));
  }
  if (!activeRows.length) sections.push(new EmbedBuilder().setColor(0x57f287).setTitle('👥 監視中メンバー').setDescription('監視対象はいません。'));
  for (let index = 0; index < kickedRows.length; index += ROWS_PER_EMBED) {
    sections.push(new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle(index ? `📤 ${settings.kickDays}日超過・退出済み ${index / ROWS_PER_EMBED + 1}` : `📤 ${settings.kickDays}日超過・退出済み`)
      .setDescription(kickedRows.slice(index, index + ROWS_PER_EMBED).join('\n\n')));
  }

  const guildIcon = guild.iconURL?.({ size: 256 });
  const author = { name: `${guild.name} • メンバー稼働監視` };
  if (guildIcon) author.iconURL = guildIcon;
  const header = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setAuthor(author)
    .setTitle('🛰️ リアルタイム・アクティブ監視パネル')
    .setDescription('管理者とBotを除く全メンバーを監視しています。メッセージ・リアクション・VC・Bot操作で最終活動が更新されます。下の管理ボタンは管理者だけが使用できます。')
    .addFields(
      { name: '監視中', value: `**${activeRows.length}人**`, inline: true },
      { name: '退出済み', value: `**${kickedRows.length}人**`, inline: true },
      { name: '自動退出', value: `**${settings.kickDays}日**`, inline: true },
      { name: '期限前DM', value: `退出の **${settings.warningBeforeDays}日前**`, inline: true },
      { name: '表示', value: '🟢 7日未満　🟡 7日以上　🔴 期限間近　⚫ 退出済み' },
      { name: '再参加', value: '再参加したユーザーは退出済み欄から外れ、監視中メンバーへ自動復帰します。' },
    )
    .setFooter({ text: 'あまね • 1分ごと＋活動発生時に自動更新' })
    .setTimestamp(now);

  const payloads = [];
  for (let index = 0; index < sections.length; index += EMBEDS_PER_MESSAGE) {
    const first = index === 0;
    payloads.push({
      embeds: [...(first ? [header] : []), ...sections.slice(index, index + EMBEDS_PER_MESSAGE)],
      components: first ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('inactivity:configure:kick').setLabel('自動退出の期間').setEmoji('📅').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('inactivity:configure:warning').setLabel('期限前DMの日数').setEmoji('✉️').setStyle(ButtonStyle.Secondary),
      )] : [],
      allowedMentions: { parse: [] },
    });
  }
  return payloads;
}
