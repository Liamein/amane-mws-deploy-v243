import 'dotenv/config';
import { once } from 'node:events';
import { Client, EmbedBuilder, Events, GatewayIntentBits } from 'discord.js';
import { createReleasePublisher } from './release-publisher.js';
import { CURRENT_RELEASE } from './release.js';

const UPDATE_LOG_CHANNEL_ID = '1543145283687555183';
const LEGACY_DUPLICATE_TITLES = new Set([
  '✅ 不要なゲーム連携を整理し、Botを安定化',
  '✅ 不要な外部連携を削除し、起動時の同期を安定化',
]);

function buildPayload(release) {
  const now = new Date();
  const timestamp = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now);
  return {
    embeds: [new EmbedBuilder().setColor(0x7b61ff).setTitle(`✅ ${release.title}`).setDescription(release.description)
      .addFields({ name: '対象', value: release.target }, { name: '確認', value: release.verification })
      .setFooter({ text: `アップデート記録 • v${release.version} • ${timestamp}` }).setTimestamp(now)],
    allowedMentions: { parse: [] },
  };
}

async function removeLegacyDuplicates(channel, botUserId) {
  const messages = await channel.messages.fetch({ limit: 100 });
  const duplicates = [...messages.values()].filter((message) => message.author.id === botUserId
    && LEGACY_DUPLICATE_TITLES.has(message.embeds[0]?.title)
    && message.embeds[0]?.footer?.text?.includes('アップデート記録 • v2.5.'));
  await Promise.all(duplicates.map((message) => message.delete()));
  return duplicates.length;
}

if (!process.env.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN が設定されていません。');
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
try {
  const ready = once(client, Events.ClientReady);
  await client.login(process.env.DISCORD_TOKEN);
  await ready;
  const channel = await client.channels.fetch(UPDATE_LOG_CHANNEL_ID);
  if (!channel?.isTextBased() || !channel.isSendable()) throw new Error('更新記録チャンネルに送信できません。');
  const publisher = createReleasePublisher({ send: (release) => channel.send(buildPayload(release)) });
  const result = await publisher.publish(CURRENT_RELEASE);
  const removed = result.published ? await removeLegacyDuplicates(channel, client.user.id) : 0;
  console.log(result.published ? `Release ${result.releaseId} published; removed ${removed} legacy duplicates.` : `Release ${result.releaseId} already reserved or sent.`);
} finally {
  client.destroy();
}
