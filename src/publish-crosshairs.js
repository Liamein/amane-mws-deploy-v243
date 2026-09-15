import { EmbedBuilder, REST, Routes } from 'discord.js';
import { createCrosshairPreview } from './crosshair-preview.js';
import { loadConfig } from './config.js';
import { ValorantPanelStore } from './valorant-panels.js';

const SOURCE_URL = 'https://valoranttracker.com/api/crosshairs?limit=500';
const POST_DELAY_MS = 850;
const config = loadConfig();

function wait(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

function sourceDescription(description) {
  const copyMatch = String(description || '').match(/Copied:\s*([\d,]+)\s*times/i);
  const addedMatch = String(description || '').match(/Added:\s*([^\n]+)/i);
  return { copies: copyMatch ? `${copyMatch[1]} copies` : 'コピー数は公開されていません', added: addedMatch ? addedMatch[1].trim() : null };
}

function buildCrosshair(crosshair) {
  const { copies, added } = sourceDescription(crosshair.description);
  const filename = `crosshair-${crosshair.id}.png`;
  const embed = new EmbedBuilder().setColor(0xff4655).setTitle(`🎯 ${crosshair.name}`.slice(0, 256))
    .setDescription(`**RANK #${crosshair.rank}**　•　📋 ${copies}${added ? `\n追加日: ${added}` : ''}`)
    .setImage(`attachment://${filename}`)
    .addFields(
      { name: 'インポート用コード', value: `\`${crosshair.code.slice(0, 1_000)}\`` },
      { name: '使い方', value: '上のコードを選択してコピーし、VALORANTの「設定」→「クロスヘア」→「プロフィール」からコードをインポートしてください。' },
    )
    .setFooter({ text: 'あまね • コードはこの投稿内でそのままコピーできます' });
  return {
    body: {
      embeds: [embed.toJSON()],
      attachments: [{ id: '0', filename }],
    },
    // RESTへ直接投稿する場合は、添付メタデータとRawFile(data)の両方が必要です。
    // これにより埋め込みのattachment:// URLとPNG添付を確実に関連付けます。
    files: [{ data: createCrosshairPreview(crosshair.code), name: filename }],
  };
}

async function fetchCrosshairs() {
  const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(30_000), headers: { 'User-Agent': 'AmA-Community-Bot/1.6 (permissioned crosshair catalog)' } });
  if (!response.ok) throw new Error(`クロスヘア一覧の取得に失敗しました (HTTP ${response.status})`);
  const payload = await response.json();
  if (!Array.isArray(payload?.data)) throw new Error('クロスヘア一覧のデータ形式が正しくありません。');
  return payload.data.slice(0, config.valorantCrosshairLimit).map((entry, index) => ({ ...entry, rank: index + 1 })).filter((entry) => entry.id && entry.name && entry.code);
}

async function findLiveCatalogMessages(channelId) {
  const me = await rest.get(Routes.user('@me'));
  const messages = await rest.get(Routes.channelMessages(channelId), { query: new URLSearchParams({ limit: '100' }) });
  const ids = new Map();
  for (const message of messages) {
    if (message.author?.id !== me.id) continue;
    const codeField = message.embeds?.flatMap((embed) => embed.fields || []).find((field) => field.name === 'インポート用コード' || field.name === 'クロスヘアコード');
    if (!codeField?.value) continue;
    ids.set(String(codeField.value).replaceAll('`', '').trim(), message.id);
  }
  return ids;
}

if (!config.valorantCrosshairChannelId) throw new Error('VALORANT_CROSSHAIR_CHANNEL_ID が設定されていません。');

const rest = new REST({ version: '10' }).setToken(config.discordToken);
const channelId = config.valorantCrosshairChannelId;
await rest.get(Routes.channel(channelId));
const store = new ValorantPanelStore(new URL('../data/valorant-panels.json', import.meta.url));
await store.load();
const crosshairs = await fetchCrosshairs();
store.replaceCrosshairs(crosshairs);
let before = store.getGuild(config.discordGuildId);
const replace = process.argv.includes('--replace');
const refresh = process.argv.includes('--refresh');
const resetPreviewState = process.argv.includes('--reset-preview-state');

if (replace) {
  const me = await rest.get(Routes.user('@me'));
  const messages = await rest.get(Routes.channelMessages(channelId), { query: new URLSearchParams({ limit: '100' }) });
  const crosshairMessages = messages.filter((message) => message.author?.id === me.id && (
    message.attachments?.some((attachment) => attachment.filename?.startsWith('crosshair-'))
    || message.embeds?.some((embed) => embed.fields?.some((field) => field.name === 'インポート用コード' || field.name === 'クロスヘアコード'))
    || message.embeds?.some((embed) => embed.title === '🎯 VALORANT クロスヘアカタログ')
  ));
  for (const message of crosshairMessages) {
    await rest.delete(Routes.channelMessage(channelId, message.id)).catch((error) => {
      if (error.status !== 404) throw error;
    });
    await wait(300);
  }
  store.clearCatalog(config.discordGuildId);
  await store.save();
  before = store.getGuild(config.discordGuildId);
  console.log(`既存のクロスヘア投稿 ${crosshairMessages.length}件を差し替えます。`);
}
if (resetPreviewState) {
  store.resetCatalogPreviews(config.discordGuildId);
  await store.save();
  console.log('画像プレビューの更新状態をリセットしました。');
}
if (before.crosshairCatalogChannelId !== channelId || !before.crosshairCatalogIntroMessageId) {
  const intro = await rest.post(Routes.channelMessages(channelId), { body: { embeds: [new EmbedBuilder().setColor(0xff4655).setTitle('🎯 VALORANT クロスヘアカタログ').setDescription(`上位 **${crosshairs.length}件** を掲載しています。\n各パネルのプレビュー画像と、インポート用コードを確認できます。`).setFooter({ text: 'あまね • コードは投稿内から直接コピーできます' }).toJSON()] } });
  store.setCatalogChannel(config.discordGuildId, channelId, intro.id);
  await store.save();
}

const existing = store.getGuild(config.discordGuildId).crosshairCatalogMessages;
const settings = store.getGuild(config.discordGuildId);
const liveMessageIds = refresh ? await findLiveCatalogMessages(channelId) : new Map();
const targets = refresh
  ? store.listCrosshairs().filter((crosshair) => !settings.crosshairCatalogPreviewed[crosshair.id] || !liveMessageIds.has(crosshair.code)).slice(0, 15)
  : store.listCrosshairs().filter((crosshair) => !existing[crosshair.id]);
console.log(`クロスヘアカタログ: ${refresh ? '画像付きパネルへ更新' : '投稿'}する対象は ${targets.length}件です。`);
for (let index = 0; index < targets.length; index += 1) {
  const crosshair = targets[index];
  const currentMessageId = liveMessageIds.get(crosshair.code);
  let message;
  if (refresh && currentMessageId) {
    message = await rest.patch(Routes.channelMessage(channelId, currentMessageId), buildCrosshair(crosshair));
  } else {
    message = await rest.post(Routes.channelMessages(channelId), buildCrosshair(crosshair));
  }
  const filename = `crosshair-${crosshair.id}.png`;
  if (!message.attachments?.some((attachment) => attachment.filename === filename) || !message.embeds?.some((embed) => embed.image?.url?.includes(filename))) {
    throw new Error(`${crosshair.name} のプレビュー画像がDiscord側で確認できませんでした。投稿を中断しました。`);
  }
  store.setCatalogMessage(config.discordGuildId, crosshair.id, message.id);
  if (index % 10 === 9 || index === targets.length - 1) await store.save();
  await wait(POST_DELAY_MS);
}
console.log(`クロスヘアカタログの${refresh ? '更新' : '投稿'}が完了しました。`);
