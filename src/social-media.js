import { AttachmentBuilder, EmbedBuilder, Events, PermissionFlagsBits } from 'discord.js';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const URL_PATTERN = /https?:\/\/(?:www\.|mobile\.)?(?:x\.com|twitter\.com)\/[A-Za-z0-9_]+\/status\/\d+(?:\?[^\s<>]*)?|https?:\/\/(?:www\.|m\.|vm\.|vt\.)?tiktok\.com\/[^\s<>]+/giu;
const MAX_LINKS = 3;
const MAX_FILES = 4;
const MAX_FILE_BYTES = 9_500_000;
const MAX_INPUT_BYTES = 80_000_000;
const CLAIM_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const PROCESSING_CLAIM_MAX_AGE_MS = 5 * 60_000;
const RECOVERY_MESSAGE_MAX_AGE_MS = 24 * 60 * 60_000;
const CLAIM_ROOT = path.join(process.cwd(), 'data', 'social-media-claims');
const processing = new Set();

export function cleanSocialUrls(content) {
  return [...new Set(content.match(URL_PATTERN) ?? [])].slice(0, MAX_LINKS);
}

function claimPath(messageId, root = CLAIM_ROOT) {
  if (!/^\d{17,20}$/.test(messageId)) throw new Error('DiscordメッセージIDが不正です');
  return path.join(root, `${messageId}.claim`);
}

export async function claimSocialMessage(messageId, root = CLAIM_ROOT) {
  await mkdir(root, { recursive: true });
  const file = claimPath(messageId, root);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(file, 'wx');
      await handle.writeFile(JSON.stringify({ status: 'processing', claimedAt: Date.now() }), 'utf8');
      await handle.close();
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const raw = await readFile(file, 'utf8');
        let claim;
        try { claim = JSON.parse(raw); } catch { claim = { status: 'processing', claimedAt: Number(raw) || 0 }; }
        const timestamp = Number(claim.completedAt || claim.claimedAt || 0);
        const maxAge = claim.status === 'completed' ? CLAIM_MAX_AGE_MS : PROCESSING_CLAIM_MAX_AGE_MS;
        if (Date.now() - timestamp <= maxAge) return false;
        await rm(file, { force: true });
      } catch (readError) {
        if (readError.code !== 'ENOENT') throw readError;
      }
    }
  }
  return false;
}

export async function completeSocialMessageClaim(messageId, root = CLAIM_ROOT) {
  await writeFile(claimPath(messageId, root), JSON.stringify({ status: 'completed', completedAt: Date.now() }), 'utf8');
}

async function cleanupClaims() {
  await mkdir(CLAIM_ROOT, { recursive: true });
  const now = Date.now();
  for (const name of await readdir(CLAIM_ROOT)) {
    if (!/^\d{17,20}\.claim$/.test(name)) continue;
    const file = path.join(CLAIM_ROOT, name);
    try {
      const raw = await readFile(file, 'utf8').catch(() => '');
      let claim;
      try { claim = JSON.parse(raw); } catch { claim = { status: 'processing', claimedAt: Number(raw) || 0 }; }
      const timestamp = Number(claim.completedAt || claim.claimedAt || (await stat(file)).mtimeMs);
      const maxAge = claim.status === 'completed' ? CLAIM_MAX_AGE_MS : PROCESSING_CLAIM_MAX_AGE_MS;
      if (now - timestamp > maxAge) await rm(file, { force: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'amane-discord-bot/2.4' }, signal: AbortSignal.timeout(12_000), redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function isXUrl(url) {
  try { return /(^|\.)((x)|(twitter))\.com$/i.test(new URL(url).hostname); } catch { return false; }
}

function videoCandidates(media) {
  const formats = [...(media.formats ?? media.variants ?? [])]
    .filter((item) => (item.container === 'mp4' || item.content_type === 'video/mp4') && item.url)
    .sort((a, b) => Number(b.bitrate ?? 0) - Number(a.bitrate ?? 0));
  const withinLimit = formats.filter((item) => item.bitrate && media.duration && (Number(item.bitrate) / 8) * Number(media.duration) <= MAX_FILE_BYTES);
  const fallback = formats.filter((item) => !withinLimit.includes(item)).reverse();
  return [...new Set([...withinLimit, ...fallback].map((item) => item.url).concat(media.url ?? []))];
}

async function xPost(original) {
  const match = new URL(original).pathname.match(/^\/([^/]+)\/status\/(\d+)/i);
  if (!match) throw new Error('X URLを解析できません');
  const payload = await fetchJson(`https://api.fxtwitter.com/${encodeURIComponent(match[1])}/status/${match[2]}`);
  const post = payload.tweet ?? payload;
  const author = post.author ?? {};
  const media = (post.media?.all ?? []).slice(0, MAX_FILES).map((item, index) => {
    const video = item.type === 'video' || item.type === 'gif';
    return { urls: video ? videoCandidates(item) : [item.url], name: `x-${post.id ?? match[2]}-${index + 1}.${video ? 'mp4' : (item.format || 'jpg').replace(/^image\//, '')}` };
  }).filter((item) => item.urls.some(Boolean));
  return { platform: 'X', authorName: author.name || author.screen_name || match[1], handle: author.screen_name ? `@${author.screen_name}` : `@${match[1]}`, authorUrl: author.url || `https://x.com/${author.screen_name || match[1]}`, avatar: author.avatar_url || author.avatarUrl, text: post.text || post.description || 'Xの投稿', replies: post.replies, reposts: post.retweets ?? post.reposts, likes: post.likes, views: post.views, media };
}

export async function tiktokPost(original) {
  const payload = await fetchJson(`https://www.tikwm.com/api/?hd=1&url=${encodeURIComponent(original)}`);
  if (payload.code !== 0 || !payload.data) throw new Error(payload.msg || 'TikTok情報を取得できません');
  const data = payload.data;
  const images = Array.isArray(data.images) ? data.images.filter(Boolean) : [];
  const media = images.length
    ? images.slice(0, MAX_FILES).map((url, index) => ({ urls: [url], name: `tiktok-${data.id}-${index + 1}.jpg` }))
    : [{ urls: [data.hdplay, data.play, data.wmplay].filter(Boolean), name: `tiktok-${data.id}.mp4`, transcodeVideo: true, durationSeconds: Number(data.duration) || 0 }];
  return { platform: 'TikTok', authorName: data.author?.nickname || data.author?.unique_id || 'TikTok Creator', handle: data.author?.unique_id ? `@${data.author.unique_id}` : '', authorUrl: data.author?.unique_id ? `https://www.tiktok.com/@${data.author.unique_id}` : original, avatar: data.author?.avatar, text: data.title || 'TikTokの投稿', replies: data.comment_count, reposts: data.share_count, likes: data.digg_count, views: data.play_count, media };
}

async function responseBuffer(response, maxBytes) {
  const announced = Number(response.headers.get('content-length') || 0);
  if (announced > maxBytes) throw new Error(`ファイルが大きすぎます (${announced} bytes)`);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body ?? []) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`ファイルサイズが上限外です (${total} bytes超)`);
    }
    chunks.push(Buffer.from(chunk));
  }
  if (!total) throw new Error('取得したファイルが空です');
  return Buffer.concat(chunks, total);
}

async function responseToFile(response, file, maxBytes) {
  const announced = Number(response.headers.get('content-length') || 0);
  if (announced > maxBytes) throw new Error(`ファイルが大きすぎます (${announced} bytes)`);
  const handle = await open(file, 'w');
  let total = 0;
  try {
    for await (const chunk of response.body ?? []) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`ファイルサイズが上限外です (${total} bytes超)`);
      }
      await handle.write(Buffer.from(chunk));
    }
  } finally {
    await handle.close();
  }
  if (!total) throw new Error('取得したファイルが空です');
  return total;
}

export function targetVideoBitrateKbps(durationSeconds) {
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) return 1800;
  const totalKbps = Math.floor((MAX_FILE_BYTES * 8 * 0.94) / duration / 1000);
  return Math.max(350, Math.min(5000, totalKbps - 144));
}

async function runFfmpeg(args) {
  if (process.platform !== 'win32') await chmod(ffmpeg.path, 0o755);
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg.path, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('動画変換が90秒でタイムアウトしました'));
    }, 90_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg終了コード ${code}: ${stderr.slice(-800)}`));
    });
  });
}

async function transcodeVideoFile(input, output, durationSeconds) {
  const bitrate = targetVideoBitrateKbps(durationSeconds);
  await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-b:v', `${bitrate}k`, '-maxrate', `${bitrate}k`, '-bufsize', `${bitrate * 2}k`, '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', output]);
  const outputSize = (await stat(output)).size;
  if (!outputSize || outputSize > MAX_FILE_BYTES) throw new Error(`Discord互換動画が添付上限を超えました (${outputSize} bytes)`);
}

export async function transcodeDiscordVideo(bytes, durationSeconds) {
  const directory = await mkdtemp(path.join(tmpdir(), 'amane-social-'));
  const input = path.join(directory, 'input.mp4');
  const output = path.join(directory, 'output.mp4');
  try {
    await writeFile(input, bytes);
    await transcodeVideoFile(input, output, durationSeconds);
    const normalized = await readFile(output);
    return normalized;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function downloadAndTranscode(response, durationSeconds) {
  const directory = await mkdtemp(path.join(tmpdir(), 'amane-social-'));
  const input = path.join(directory, 'input.mp4');
  const output = path.join(directory, 'output.mp4');
  try {
    await responseToFile(response, input, MAX_INPUT_BYTES);
    await transcodeVideoFile(input, output, durationSeconds);
    return await readFile(output);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function downloadOne(item) {
  let lastError;
  for (const url of item.urls) {
    try {
      const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; amane-discord-bot/2.4)' }, signal: AbortSignal.timeout(25_000), redirect: 'follow' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = item.transcodeVideo
        ? await downloadAndTranscode(response, item.durationSeconds)
        : await responseBuffer(response, MAX_FILE_BYTES);
      return new AttachmentBuilder(bytes, { name: item.name.replace(/[^A-Za-z0-9._-]/g, '_') });
    } catch (error) { lastError = error; }
  }
  throw lastError ?? new Error('メディアURLがありません');
}

function compactNumber(value) {
  return Number.isFinite(Number(value)) ? new Intl.NumberFormat('ja-JP', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value)) : '0';
}

function resultEmbed(data, original, requester) {
  const embed = new EmbedBuilder().setColor(data.platform === 'X' ? 0x1d9bf0 : 0x25f4ee).setAuthor({ name: `posted by ${data.authorName}${data.handle ? ` (${data.handle})` : ''}`, url: data.authorUrl || original, iconURL: data.avatar || undefined }).setTitle(data.authorName).setURL(original).setDescription(String(data.text).slice(0, 3500)).addFields({ name: '📨 送信者', value: `<@${requester.id}>  ${requester.username} (${requester.id})` }).setFooter({ text: `${data.platform} • あまねBot` }).setTimestamp();
  if ([data.replies, data.reposts, data.likes, data.views].some((value) => value != null)) embed.addFields({ name: '💬 返信', value: compactNumber(data.replies), inline: true }, { name: '🔁 共有', value: compactNumber(data.reposts), inline: true }, { name: '❤ いいね', value: compactNumber(data.likes), inline: true }, { name: '👁 表示', value: compactNumber(data.views), inline: true });
  return embed;
}

async function handleMessage(message) {
  if (!message.inGuild() || message.author.bot || message.webhookId || !message.content || processing.has(message.id)) return;
  const urls = cleanSocialUrls(message.content);
  if (!urls.length || !await claimSocialMessage(message.id)) return;
  processing.add(message.id);
  const sent = [];
  let completed = false;
  let typingTimer;
  try {
    await message.channel.sendTyping().catch(() => {});
    typingTimer = setInterval(() => message.channel.sendTyping().catch(() => {}), 8_000);
    console.log(`SNS自動展開開始: message=${message.id} channel=${message.channelId} urls=${urls.length}`);
    for (const original of urls) {
      const data = isXUrl(original) ? await xPost(original) : await tiktokPost(original);
      const files = [];
      const errors = [];
      for (const item of data.media.slice(0, MAX_FILES)) {
        try { files.push(await downloadOne(item)); } catch (error) { errors.push(error); }
      }
      if (!files.length) throw new Error(errors.map((item) => item.message).filter(Boolean).join(' / ') || 'メディアを添付できません');
      sent.push(await message.channel.send({ embeds: [resultEmbed(data, original, message.author)], files, allowedMentions: { parse: [] } }));
    }
    await message.delete();
    await completeSocialMessageClaim(message.id);
    completed = true;
    console.log(`SNS自動展開完了: message=${message.id} files=${sent.length}`);
  } catch (error) {
    await Promise.allSettled(sent.map((item) => item.delete()));
    await message.reply({ content: `メディア取得に失敗しました。しばらく待ってから再送してください。\n原因: ${String(error.message || error).slice(0, 160)}`, allowedMentions: { repliedUser: false } }).catch(() => {});
    throw error;
  } finally {
    clearInterval(typingTimer);
    processing.delete(message.id);
    if (!completed) await rm(claimPath(message.id), { force: true }).catch(() => {});
  }
}

async function recoverRecentMessages(client) {
  const cutoff = Date.now() - RECOVERY_MESSAGE_MAX_AGE_MS;
  let recovered = 0;
  for (const guild of client.guilds.cache.values()) {
    for (const channel of guild.channels.cache.values()) {
      if (!channel.isTextBased() || !channel.messages?.fetch) continue;
      const permissions = channel.permissionsFor(client.user);
      if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ManageMessages])) continue;
      const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
      if (!messages) continue;
      const candidates = [...messages.values()]
        .filter((message) => message.createdTimestamp >= cutoff && !message.author.bot && !message.webhookId && cleanSocialUrls(message.content || '').length)
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      for (const message of candidates) {
        const before = processing.has(message.id);
        await handleMessage(message).catch((error) => console.error(`SNS復旧処理エラー: message=${message.id} channel=${message.channelId}:`, error.message));
        if (!before && !processing.has(message.id)) recovered += 1;
      }
    }
  }
  console.log(`SNS未処理メッセージ復旧確認: ${recovered} 件を照合。`);
}

export function installSocialMediaEmbeds(client) {
  client.once(Events.ClientReady, async () => {
    await cleanupClaims().catch((error) => console.error('SNS処理ロック清掃エラー:', error.message));
    const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ManageMessages];
    let total = 0; let ready = 0;
    for (const guild of client.guilds.cache.values()) for (const channel of guild.channels.cache.values()) {
      if (!channel.isTextBased() || channel.isThread()) continue;
      total += 1;
      const permissions = channel.permissionsFor(client.user);
      if (permissions && required.every((flag) => permissions.has(flag))) ready += 1;
    }
    console.log(`SNS自動展開権限確認: ${ready}/${total} チャンネル。`);
    console.log('X / TikTok メディア直接添付機能を起動しました。');
    await recoverRecentMessages(client).catch((error) => console.error('SNS未処理メッセージ復旧エラー:', error.message));
  });
  client.on(Events.MessageCreate, (message) => handleMessage(message).catch((error) => console.error(`SNS自動展開エラー: message=${message.id} channel=${message.channelId}:`, error.message)));
}
