import { once } from 'node:events';
import { AttachmentBuilder, Client, EmbedBuilder, Events, GatewayIntentBits } from 'discord.js';
import { createCrosshairPreview } from './crosshair-preview.js';
import { loadConfig } from './config.js';
import { ValorantPanelStore } from './valorant-panels.js';

const BATCH_SIZE = 15;
const POST_DELAY_MS = 850;
const config = loadConfig();

function wait(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

function sourceDescription(description) {
  const copyMatch = String(description || '').match(/Copied:\s*([\d,]+)\s*times/i);
  const addedMatch = String(description || '').match(/Added:\s*([^\n]+)/i);
  return { copies: copyMatch ? `${copyMatch[1]} copies` : 'コピー数は公開されていません', added: addedMatch ? addedMatch[1].trim() : null };
}

function messageOptions(crosshair) {
  const { copies, added } = sourceDescription(crosshair.description);
  const filename = `crosshair-${crosshair.id}.png`;
  const embed = new EmbedBuilder()
    .setColor(0xff4655)
    .setTitle(`🎯 ${crosshair.name}`.slice(0, 256))
    .setDescription(`**RANK #${crosshair.rank}**　•　📋 ${copies}${added ? `\n追加日: ${added}` : ''}`)
    .setImage(`attachment://${filename}`)
    .addFields(
      { name: 'インポート用コード', value: `\`${crosshair.code.slice(0, 1_000)}\`` },
      { name: '使い方', value: '上のコードを選択してコピーし、VALORANTの「設定」→「クロスヘア」→「プロフィール」からコードをインポートしてください。' },
    )
    .setFooter({ text: 'あまね • コードはこの投稿内でそのままコピーできます' });
  return {
    embeds: [embed],
    files: [new AttachmentBuilder(createCrosshairPreview(crosshair.code), { name: filename })],
    components: [],
    attachments: [],
    filename,
  };
}

function codeFromMessage(message) {
  const codeField = message.embeds.flatMap((embed) => embed.fields || []).find((field) => field.name === 'インポート用コード' || field.name === 'クロスヘアコード');
  return codeField?.value ? String(codeField.value).replaceAll('`', '').trim() : null;
}

if (!config.valorantCrosshairChannelId) throw new Error('VALORANT_CROSSHAIR_CHANNEL_ID が設定されていません。');

const store = new ValorantPanelStore(new URL('../data/valorant-panels.json', import.meta.url));
await store.load();
if (process.argv.includes('--reset-preview-state')) {
  store.resetCatalogPreviews(config.discordGuildId);
  await store.save();
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
try {
  const ready = once(client, Events.ClientReady);
  await client.login(config.discordToken);
  await ready;
  const channel = await client.channels.fetch(config.valorantCrosshairChannelId);
  if (!channel?.isTextBased?.() || !channel.isSendable()) throw new Error('クロスヘア投稿先がテキストチャンネルではないか、Botが投稿できません。');
  const recent = await channel.messages.fetch({ limit: 100 });
  const byCode = new Map([...recent.values()].filter((message) => message.author.id === client.user.id).map((message) => [codeFromMessage(message), message]).filter(([code]) => code));
  const settings = store.getGuild(config.discordGuildId);
  const targets = store.listCrosshairs().filter((crosshair) => !settings.crosshairCatalogPreviewed[crosshair.id] || !byCode.has(crosshair.code)).slice(0, BATCH_SIZE);
  console.log(`画像付きパネルへの更新対象: ${targets.length}件`);
  for (let index = 0; index < targets.length; index += 1) {
    const crosshair = targets[index];
    const options = messageOptions(crosshair);
    const current = byCode.get(crosshair.code);
    const message = current ? await current.edit(options) : await channel.send(options);
    // Discordは埋め込み専用の添付画像をattachments配列へ返さない場合があります。
    // 解決済みの画像URL・寸法・CDN応答を確認し、実際に表示可能な画像だけを確定します。
    const image = message.embeds.flatMap((embed) => embed.image ? [embed.image] : []).find((embedImage) => embedImage.url?.includes(options.filename));
    if (!image?.url || image.width !== 720 || image.height !== 360 || !(await fetch(image.url, { method: 'HEAD' })).ok) {
      throw new Error(`${crosshair.name} の画像添付をDiscordから確認できませんでした。`);
    }
    store.setCatalogMessage(config.discordGuildId, crosshair.id, message.id);
    if (index % 10 === 9 || index === targets.length - 1) await store.save();
    await wait(POST_DELAY_MS);
  }
  console.log('画像・文章を検証したクロスヘアパネルの更新が完了しました。');
} finally {
  client.destroy();
}
