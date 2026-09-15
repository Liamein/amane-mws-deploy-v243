import { readFile, writeFile } from 'node:fs/promises';
import { AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder, Events, GatewayIntentBits } from 'discord.js';
import { once } from 'node:events';
import { createCrosshairPreview } from './crosshair-preview.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const catalogUrl = new URL('../data/custom-crosshairs.json', import.meta.url);
const postsUrl = new URL('../data/custom-crosshair-posts.json', import.meta.url);

function buildPanel(entry) {
  const filename = `${entry.id}.png`;
  const embed = new EmbedBuilder()
    .setColor(0x7b61ff)
    .setTitle(`🎯 ${entry.name}`.slice(0, 256))
    .setDescription('VALORANT クロスヘア')
    .setImage(`attachment://${filename}`)
    .addFields({ name: 'コード', value: `\`\`\`diff\n${entry.code}\n\`\`\`` })
    .setFooter({ text: 'あまね • コードは上の表示からコピーできます' });
  const image = entry.imagePath
    ? new AttachmentBuilder(entry.imagePath, { name: filename })
    : new AttachmentBuilder(createCrosshairPreview(entry.code), { name: filename });
  // Explicitly clear legacy buttons when replacing an existing panel.
  return { embeds: [embed], files: [image], components: [] };
}

if (!config.valorantCrosshairChannelId) throw new Error('VALORANT_CROSSHAIR_CHANNEL_ID が設定されていません。');
const entries = JSON.parse(await readFile(catalogUrl, 'utf8'));
let posts = JSON.parse(await readFile(postsUrl, 'utf8'));
if (!Array.isArray(entries) || !entries.length) throw new Error('カスタムクロスヘアが登録されていません。');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
try {
  const ready = once(client, Events.ClientReady);
  await client.login(config.discordToken);
  await ready;
  const channel = await client.channels.fetch(config.valorantCrosshairChannelId);
  if (!channel?.isTextBased?.() || !channel.isSendable()) throw new Error('クロスヘア投稿先が利用できません。');
  for (const entry of entries) {
    if (!entry.id || !entry.name || !entry.code) throw new Error('カスタムクロスヘアの名前・ID・コードを設定してください。');
    const previous = posts[entry.id] && await channel.messages.fetch(posts[entry.id]).catch(() => null);
    const message = previous ? await previous.edit(buildPanel(entry)) : await channel.send(buildPanel(entry));
    posts = { ...posts, [entry.id]: message.id };
    await writeFile(postsUrl, JSON.stringify(posts, null, 2), 'utf8');
  }
  console.log(`${entries.length}件のカスタムクロスヘアパネルを投稿・更新しました。`);
} finally {
  client.destroy();
}
