import 'dotenv/config';
import { ChannelType, Client, GatewayIntentBits } from 'discord.js';

const GUILD_ID = '1414606962846601302';
const ASSET_CATEGORY_ID = '1543393587616817162';
const AVATAR_FORUM_ID = '1543399071740461179';
const PARTICLE_SOURCE_FORUM_ID = '1420334204968894535';
const AVATAR_SOURCE_FORUM_ID = '1420353431125626982';
const PARTICLE_FORUM_NAME = 'パーティクル';

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} が設定されていません。`);
  return value;
}

async function fetchAllMessages(thread) {
  const messages = new Map();
  let before;
  while (true) {
    const page = await thread.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    for (const message of page.values()) messages.set(message.id, message);
    if (page.size < 100) break;
    before = page.last()?.id;
    if (!before) break;
  }
  return [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

async function fetchAllThreads(forum) {
  const threads = new Map();
  const active = await forum.threads.fetchActive();
  for (const thread of active.threads.values()) threads.set(thread.id, thread);

  let before;
  while (true) {
    const archived = await forum.threads.fetchArchived({ type: 'public', limit: 100, ...(before ? { before } : {}) });
    for (const thread of archived.threads.values()) threads.set(thread.id, thread);
    // 100件未満なら次のページはない。hasMoreだけを信頼すると、一部フォーラムで
    // 同じアーカイブページを繰り返し取得することがあるため、件数でも停止する。
    if (!archived.hasMore || archived.threads.size < 100) break;
    before = new Date(archived.threads.last()?.archiveTimestamp);
    if (!before) break;
  }
  return [...threads.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

function firstBoothUrl(messages) {
  const urlPattern = /https?:\/\/[^\s<>()]+(?:[a-z0-9-]+\.)?booth\.pm\/[^\s<>()]+/iu;
  for (const message of messages) {
    const match = message.content.match(urlPattern);
    if (match) return match[0].replace(/[.,:;]+$/u, '');
  }
  return null;
}

async function getOrCreateParticleForum(guild) {
  const existing = guild.channels.cache.find((channel) => channel.type === ChannelType.GuildForum && channel.parentId === ASSET_CATEGORY_ID && channel.name === PARTICLE_FORUM_NAME);
  if (existing) return existing;
  return guild.channels.create({
    name: PARTICLE_FORUM_NAME,
    type: ChannelType.GuildForum,
    parent: ASSET_CATEGORY_ID,
    reason: 'あまね: パーティクル保管フォーラムを作成',
  });
}

async function copyForum(sourceForum, targetForum) {
  const existingNames = new Set((await fetchAllThreads(targetForum)).map((thread) => thread.name));
  const sourceThreads = await fetchAllThreads(sourceForum);
  let copied = 0;
  let skipped = 0;

  for (const sourceThread of sourceThreads) {
    if (existingNames.has(sourceThread.name)) {
      skipped += 1;
      continue;
    }
    const messages = await fetchAllMessages(sourceThread);
    const firstMessage = messages.find((message) => message.id === sourceThread.id) || messages[0];
    const boothUrl = firstBoothUrl(messages);
    const content = boothUrl || firstMessage?.content || `**${sourceThread.name}**`;
    const targetThread = await targetForum.threads.create({
      name: sourceThread.name.slice(0, 100),
      autoArchiveDuration: 10_080,
      message: { content, allowedMentions: { parse: [] } },
      reason: `あまね: ${sourceForum.name} からの保管コピー`,
    });

    for (const message of messages) {
      // 添付がない先頭投稿は本文へ引き継いだため重複させない。
      if (message.id === firstMessage?.id && !message.attachments.size) continue;
      await message.forward(targetThread);
    }
    existingNames.add(sourceThread.name);
    copied += 1;
    console.log(`コピー完了: ${sourceThread.name} -> ${targetForum.name}`);
  }
  return { copied, skipped, total: sourceThreads.length };
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const avatarSource = await guild.channels.fetch(AVATAR_SOURCE_FORUM_ID);
    const avatarTarget = await guild.channels.fetch(AVATAR_FORUM_ID);
    if (avatarSource?.type !== ChannelType.GuildForum || avatarTarget?.type !== ChannelType.GuildForum) throw new Error('アバターフォーラムの種類を確認できません。');

    const particleSource = await guild.channels.fetch(PARTICLE_SOURCE_FORUM_ID);
    if (particleSource?.type !== ChannelType.GuildForum) throw new Error('パーティクル移行元がフォーラムではありません。');
    const particleTarget = await getOrCreateParticleForum(guild);

    const avatar = await copyForum(avatarSource, avatarTarget);
    const particle = await copyForum(particleSource, particleTarget);
    console.log(JSON.stringify({ avatar, particle, particleForumId: particleTarget.id }));
  } catch (error) {
    console.error('フォーラム移行に失敗しました:', error);
    process.exitCode = 1;
  } finally {
    client.destroy();
  }
});

client.login(requiredEnv('DISCORD_TOKEN'));
