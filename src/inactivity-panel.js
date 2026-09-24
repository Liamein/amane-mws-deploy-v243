import { EmbedBuilder } from 'discord.js';
import { DAY_MS, INACTIVITY_KICK_DAYS, INACTIVITY_WARNING_DAYS } from './activity.js';

export const INACTIVITY_PANEL_CHANNEL_ID = '1542845920675233894';
const ROWS_PER_EMBED = 18;
const EMBEDS_PER_MESSAGE = 3;

function statusFor(lastActiveAt, now) {
  const elapsedDays = Math.max(0, Math.floor((now - lastActiveAt) / DAY_MS));
  const remainingDays = Math.max(0, INACTIVITY_KICK_DAYS - elapsedDays);
  if (elapsedDays >= INACTIVITY_WARNING_DAYS[0]) return { icon: '🔴', label: `期限間近・あと${remainingDays}日`, elapsedDays };
  if (elapsedDays >= 7) return { icon: '🟡', label: `あと${remainingDays}日`, elapsedDays };
  return { icon: '🟢', label: `あと${remainingDays}日`, elapsedDays };
}

export function buildInactivityPanelPayloads({ guild, activities, kicked, now = Date.now() }) {
  const activeRows = [...activities]
    .sort((left, right) => left.lastActiveAt - right.lastActiveAt)
    .map((entry) => {
      const status = statusFor(entry.lastActiveAt, now);
      return `${status.icon} <@${entry.userId}>\n　最終活動 <t:${Math.floor(entry.lastActiveAt / 1_000)}:R>　•　**${status.label}**`;
    });
  const kickedRows = [...kicked]
    .sort((left, right) => right.kickedAt - left.kickedAt)
    .map((entry) => `⚫ **${entry.displayName || entry.username || entry.userId}**（\`${entry.userId}\`）\n　Kick済み　•　${entry.dmSent ? 'DM送信済み' : 'DM送信不可'}　•　<t:${Math.floor(entry.kickedAt / 1_000)}:R>`);

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
      .setTitle(index ? `📤 15日超過・退出済み ${index / ROWS_PER_EMBED + 1}` : '📤 15日超過・退出済み')
      .setDescription(kickedRows.slice(index, index + ROWS_PER_EMBED).join('\n\n')));
  }

  const guildIcon = guild.iconURL?.({ size: 256 });
  const author = { name: `${guild.name} • メンバー稼働監視` };
  if (guildIcon) author.iconURL = guildIcon;
  const header = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setAuthor(author)
    .setTitle('🛰️ リアルタイム・アクティブ監視パネル')
    .setDescription('サーバーオーナーとBotを除く全メンバーを監視しています。メッセージ・リアクション・VC・Bot操作で最終活動が更新されます。')
    .addFields(
      { name: '監視中', value: `**${activeRows.length}人**`, inline: true },
      { name: '退出済み', value: `**${kickedRows.length}人**`, inline: true },
      { name: '自動退出', value: `**${INACTIVITY_KICK_DAYS}日**`, inline: true },
      { name: '表示', value: '🟢 7日未満　🟡 7日以上　🔴 期限間近　⚫ 退出済み' },
      { name: '再参加', value: '再参加したユーザーは退出済み欄から外れ、監視中メンバーへ自動復帰します。' },
    )
    .setFooter({ text: 'あまね • 1分ごと＋活動発生時に自動更新' })
    .setTimestamp(now);

  const payloads = [];
  for (let index = 0; index < sections.length; index += EMBEDS_PER_MESSAGE) {
    payloads.push({ embeds: [...(index === 0 ? [header] : []), ...sections.slice(index, index + EMBEDS_PER_MESSAGE)], allowedMentions: { parse: [] } });
  }
  return payloads;
}
