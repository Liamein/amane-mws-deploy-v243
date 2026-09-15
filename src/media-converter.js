import { AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, ModalBuilder, OverwriteType, PermissionFlagsBits, TextInputBuilder, TextInputStyle } from 'discord.js';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
import YTDlpWrapModule from 'yt-dlp-wrap';
import { access, chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { PRIMARY_BOT_OWNER_ID } from './command-access.js';

const FFMPEG_PATH = process.env.FFMPEG_PATH?.trim() || ffmpeg.path;

export const MEDIA_CONVERTER_CHANNEL_ID = '1543561839227568179';
export const MEDIA_CONVERTER_OWNER_ID = PRIMARY_BOT_OWNER_ID;
// サーバーの添付上限よりDMの上限が低い場合があるため、DMで確実に送れる上限を使用する。
const DIRECT_MESSAGE_MAX_FILE_BYTES = 8 * 1024 * 1024;
const TEMP_ROOT = fileURLToPath(new URL('../data/media-temp/', import.meta.url));
const YT_DLP_PATH = fileURLToPath(new URL(`../data/media-tools/yt-dlp${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));
const activeJobs = new Set();
const YTDlpWrap = YTDlpWrapModule.default;
// MP4要求でも配信元が音声専用ファイルを返す場合がある。音声形式もここで
// 受け取り、audioOnlyMp4Arguments で再生可能な静止画付きMP4にする。
const MEDIA_SOURCE_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4a', '.mp3', '.aac', '.opus', '.ogg', '.wav', '.flac']);
const YT_DLP_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const YT_DLP_REFRESH_RETRY_DELAY_MS = 30 * 60 * 1_000;
const MEDIA_DOWNLOAD_TIMEOUT_MS = 3 * 60 * 1_000;
const FFMPEG_TIMEOUT_MS = 3 * 60 * 1_000;
const MEDIA_PROGRESS_UPDATE_MS = 30_000;
const MEDIA_PRESETS = Object.freeze({
  'mp3-128': Object.freeze({ format: 'mp3', audioKbps: 128 }),
  'mp3-320': Object.freeze({ format: 'mp3', audioKbps: 320 }),
  'mp4-720': Object.freeze({ format: 'mp4', maxVideoHeight: 720 }),
  'mp4-1080': Object.freeze({ format: 'mp4', maxVideoHeight: 1080 }),
});
const YT_DLP_DIRECT_DOWNLOAD_URL = process.platform === 'win32'
  ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
  : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
let lastYtDlpRefreshAt = 0;
let lastYtDlpRefreshAttemptAt = 0;
let ffmpegExecutableReady;

export async function cleanupMediaTempCache() {
  await mkdir(TEMP_ROOT, { recursive: true });
  const entries = await readdir(TEMP_ROOT, { withFileTypes: true });
  const cutoff = Date.now() - (60 * 60 * 1_000);
  await Promise.all(entries.map(async (entry) => {
    const path = join(TEMP_ROOT, entry.name);
    const detail = await stat(path).catch(() => null);
    if (detail && detail.mtimeMs < cutoff) await rm(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 250 });
  }));
}

function assertSafeMediaUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('http:// または https:// から始まるURLを入力してください。'); }
  if (!['http:', 'https:'].includes(url.protocol) || ['localhost', '127.0.0.1', '::1'].includes(url.hostname)) throw new Error('外部の http:// または https:// URLだけを指定してください。');
  return url.toString();
}

async function downloadYtDlpDirectly() {
  // yt-dlp-wrap の downloadFromGithub は GitHub API を使うため、共有クラウドでは
  // API 上限に達すると変換まで止まる。公開リリースの直接URLなら API 枠を消費しない。
  const response = await fetch(YT_DLP_DIRECT_DOWNLOAD_URL, {
    headers: { 'User-Agent': 'Amane-Discord-Bot/1.0' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`yt-dlp の更新ファイルを取得できませんでした（HTTP ${response.status}）。`);
  const binary = Buffer.from(await response.arrayBuffer());
  if (binary.length < 32 * 1024) throw new Error('yt-dlp の更新ファイルが不完全です。');
  await writeFile(YT_DLP_PATH, binary, { mode: 0o755 });
  if (process.platform !== 'win32') await chmod(YT_DLP_PATH, 0o755);
}

async function ensureYtDlp({ forceRefresh = false } = {}) {
  let executableExists = true;
  try { await access(YT_DLP_PATH, constants.X_OK); } catch { executableExists = false; }
  const now = Date.now();
  const canRefresh = forceRefresh
    && (now - lastYtDlpRefreshAt >= YT_DLP_REFRESH_INTERVAL_MS)
    && (now - lastYtDlpRefreshAttemptAt >= YT_DLP_REFRESH_RETRY_DELAY_MS);
  if (!executableExists || canRefresh) {
    await mkdir(dirname(YT_DLP_PATH), { recursive: true });
    lastYtDlpRefreshAttemptAt = now;
    try {
      await downloadYtDlpDirectly();
      lastYtDlpRefreshAt = Date.now();
    } catch (error) {
      // 更新確認が失敗しても、既存の実行可能な yt-dlp がある限りは変換を続行する。
      if (!executableExists) throw error;
    }
  }
  return new YTDlpWrap(YT_DLP_PATH);
}

async function ensureFfmpegExecutable() {
  if (process.platform === 'win32') return;
  if (!ffmpegExecutableReady) {
    ffmpegExecutableReady = (async () => {
      try { await access(FFMPEG_PATH, constants.X_OK); }
      catch {
        // 一部クラウドでは依存パッケージ内の実行ビットが失われる。実行前に
        // 所有ファイルの権限だけを復元し、失敗時は通常の変換エラーとして扱う。
        await chmod(FFMPEG_PATH, 0o755);
        await access(FFMPEG_PATH, constants.X_OK);
      }
    })();
  }
  return ffmpegExecutableReady;
}

async function runFfmpeg(args, { allowFailure = false, timeoutMs = FFMPEG_TIMEOUT_MS } = {}) {
  await ensureFfmpegExecutable();
  return new Promise((resolve, reject) => {
    const process = spawn(FFMPEG_PATH, args, { windowsHide: true });
    let stderr = '';
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const timeout = setTimeout(() => {
      process.kill();
      finish(reject, new Error(`FFmpeg処理が${Math.floor(timeoutMs / 60_000)}分以内に完了しませんでした。`));
    }, timeoutMs);
    process.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    process.once('error', (error) => finish(reject, error));
    process.once('close', (code) => {
      if (code === 0 || allowFailure) finish(resolve, stderr);
      else finish(reject, new Error(`FFmpeg処理に失敗しました（終了コード ${code}）。${stderr.slice(-1_200)}`));
    });
  });
}

async function executeYtDlp(ytDlp, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEDIA_DOWNLOAD_TIMEOUT_MS);
  try {
    return await ytDlp.execPromise(options, {}, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error('メディアの取得が3分以内に完了しませんでした。短い動画または別の公開URLを指定してください。');
      timeoutError.code = 'MEDIA_DOWNLOAD_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function videoDownloadFormat(maxVideoHeight = 1080) {
  // YouTubeは現在、映像と音声が分離された形式だけを返す場合がある。
  // まず映像ストリームを取得し、存在しない音声サイトでは最後の best へ
  // フォールバックする。映像と音声の結合はyt-dlpに任せず後段のFFmpegで行う。
  const height = maxVideoHeight === 720 ? 720 : 1080;
  // 同梱FFmpegでも確実に復号できるH.264を最優先し、配信元に無い場合だけ
  // VP9/AV1等へフォールバックする。
  return `bv*[height<=${height}][fps<=60][vcodec^=avc1]/bv*[height<=${height}][fps<=60]/bv*[height<=${height}]/bv*/b`;
}

export function audioDownloadFormat() {
  // 音声のMP3化もyt-dlpの後処理を使わず、取得後に同梱FFmpegで行う。
  return 'bestaudio/best';
}

export function mediaDownloadOptions(url, format, output, { maxVideoHeight = 1080 } = {}) {
  const common = [
    url,
    '--no-playlist',
    '--restrict-filenames',
    '--no-warnings',
    '--no-progress',
    '--concurrent-fragments', '3',
    '--retries', '3',
    '--fragment-retries', '3',
    '--extractor-retries', '2',
    '--retry-sleep', '2',
    '--socket-timeout', '30',
    // 新しいYouTube抽出処理はJavaScript challengeの実行環境を必要とする。
    // Bot本体と同じNode.jsを明示し、クラウドでも取得可能な形式を欠落させない。
    '--js-runtimes', 'node',
    '--output', output,
  ];
  return format === 'mp3'
    ? [...common, '--format', audioDownloadFormat()]
    : [...common, '--format', videoDownloadFormat(maxVideoHeight)];
}

export function resolveDmFileLimit(attachmentSizeLimit) {
  const limit = Number(attachmentSizeLimit);
  // Interactionにサーバー側の上限が含まれても、DM側はそれより低いことがある。
  // 実測で413が発生したため、常にDMの安全上限以下に収める。
  return Number.isFinite(limit) && limit >= (1 * 1024 * 1024)
    ? Math.min(limit, DIRECT_MESSAGE_MAX_FILE_BYTES)
    : DIRECT_MESSAGE_MAX_FILE_BYTES;
}

export function mp4NormalizeArguments(inputPath, outputPath, maxVideoHeight = 1080) {
  const height = maxVideoHeight === 720 ? 720 : 1080;
  const width = height === 720 ? 1280 : 1920;
  return [
    '-y', '-i', inputPath,
    '-map', '0:v:0', '-map', '0:a:0?',
    // 同梱FFmpegは force_divisible_by を未対応のため、寸法を2で切り捨てて偶数化する。
    // H.264 は偶数の縦横寸法が必要であり、ここで旧版FFmpegでも確実に満たす。
    '-vf', `scale='trunc(min(${width},iw)/2)*2':'trunc(min(${height},ih)/2)*2':force_original_aspect_ratio=decrease`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-maxrate', '8M', '-bufsize', '16M',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-max_muxing_queue_size', '1024',
    outputPath,
  ];
}

export function mp4MergeArguments(videoPath, audioPath, outputPath, maxVideoHeight = 1080) {
  const height = maxVideoHeight === 720 ? 720 : 1080;
  const width = height === 720 ? 1280 : 1920;
  return [
    '-y', '-i', videoPath, '-i', audioPath,
    '-map', '0:v:0', '-map', '1:a:0?',
    '-vf', `scale='trunc(min(${width},iw)/2)*2':'trunc(min(${height},ih)/2)*2':force_original_aspect_ratio=decrease`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-maxrate', '8M', '-bufsize', '16M',
    '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', '-max_muxing_queue_size', '1024',
    outputPath,
  ];
}

export function audioOnlyMp4Arguments(inputPath, outputPath) {
  // 配信元が音声だけを提供している場合も、変換要求を失敗させず、再生できる
  // 静止画付きMP4を返す。音声データはそのままAACとして格納する。
  return [
    '-y', '-f', 'lavfi', '-i', 'color=c=0x171923:s=1280x720:r=30',
    '-i', inputPath,
    '-map', '0:v:0', '-map', '1:a:0?', '-shortest',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', '26', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
    outputPath,
  ];
}

export function mediaErrorDetails(error) {
  const values = [
    error?.stderr,
    error?.message,
    error?.cause?.stderr,
    error?.cause?.message,
    typeof error === 'string' ? error : null,
  ].filter((value) => typeof value === 'string' && value.trim());
  if (values.length) return values.join('\n').replaceAll(/https?:\/\/\S+/gu, '[URL]').slice(-1_500);
  if (error && typeof error === 'object') {
    const summary = [error.name, error.code, error.statusCode || error.status].filter(Boolean).join(' ');
    return summary || '変換補助ツールから詳細が返されませんでした。';
  }
  return '変換補助ツールから詳細が返されませんでした。';
}

export function isMediaSourceAccessRestricted(error) {
  const details = mediaErrorDetails(error);
  return /sign in to confirm|confirm you.?re not a bot|not a bot|HTTP Error 403|forbidden|access denied/iu.test(details);
}

function mediaFailure(format, error) {
  const details = mediaErrorDetails(error);
  const reason = /Postprocessing|Stream #\d+:/iu.test(details)
    ? (format === 'mp3' ? '音声をMP3へ変換できませんでした。' : '映像と音声の形式をMP4へ変換できませんでした。')
    : 'サイトからメディアを取得できませんでした。';
  const sourceHint = /sign in to confirm|not a bot|confirm you.?re not a bot/iu.test(details)
    ? 'YouTube側がクラウド環境からの自動取得を制限しています。この動画は変換できません。'
    : /HTTP Error 403|forbidden|access denied/iu.test(details)
      ? 'サイト側がこの動画の取得を拒否しています。'
      : /requested format is not available/iu.test(details)
        ? '指定した画質・形式を取得できませんでした。'
        : '';
  const message = `${format.toUpperCase()}変換に失敗しました。${reason}${sourceHint} DRM保護・ライブ配信・非公開動画・利用制限のあるURLには対応していません。`;
  const safeError = new Error(message);
  safeError.cause = error;
  safeError.mediaDetails = details;
  return safeError;
}

async function mediaDurationSeconds(path) {
  const output = await runFfmpeg(['-hide_banner', '-i', path], { allowFailure: true });
  const match = output.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/u);
  if (!match) throw new Error('動画・音声の長さを取得できませんでした。');
  return (Number(match[1]) * 3_600) + (Number(match[2]) * 60) + Number(match[3]);
}

async function sourceHasVideo(path) {
  const output = await runFfmpeg(['-hide_banner', '-i', path], { allowFailure: true });
  return /\bVideo:/iu.test(output);
}

async function encodeToBudget(file, format, directory, totalKbps) {
  const outputPath = join(directory, `optimized-${format}.${format}`);
  if (format === 'mp3') {
    const audioKbps = Math.min(320, Math.max(48, totalKbps - 4));
    await runFfmpeg(['-y', '-i', file.path, '-vn', '-c:a', 'libmp3lame', '-b:a', `${audioKbps}k`, outputPath]);
    return outputPath;
  }

  const audioKbps = Math.min(160, Math.max(48, Math.floor(totalKbps * 0.18)));
  const videoKbps = totalKbps - audioKbps - 12;
  if (videoKbps < 64) throw new Error('動画が長すぎるため、DM上限内で再生可能なMP4を作成できませんでした。');
  // 長時間の2パス処理を避ける。目標ビットレートとバッファを指定した1パスなら
  // Discord上限の再判定を保ちながら、クラウド環境でも待ち時間を大きく減らせる。
  await runFfmpeg(['-y', '-i', file.path, '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${videoKbps}k`, '-maxrate', `${videoKbps}k`, '-bufsize', `${videoKbps * 2}k`, '-c:a', 'aac', '-b:a', `${audioKbps}k`, '-movflags', '+faststart', outputPath]);
  return outputPath;
}

async function fitToDiscordLimit(file, format, directory, maxFileBytes) {
  if (file.size <= maxFileBytes) return file;
  const duration = await mediaDurationSeconds(file.path);
  const targetFileBytes = Math.max(256 * 1024, maxFileBytes - (96 * 1024));
  let totalKbps = Math.floor((targetFileBytes * 8) / duration / 1_000);

  // エンコーダーのコンテナ余白も考慮し、上限を少しでも越えた場合は再計算して再出力する。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const outputPath = await encodeToBudget(file, format, directory, totalKbps);
    const optimizedSize = (await stat(outputPath)).size;
    if (optimizedSize <= maxFileBytes) {
      return { name: file.name.replace(new RegExp(`\\.${format}$`, 'iu'), `-optimized.${format}`), path: outputPath, size: optimizedSize };
    }
    totalKbps = Math.floor(totalKbps * (targetFileBytes / optimizedSize) * 0.98);
  }
  throw new Error('最適化後もDM送信上限を超えました。より短い動画を指定してください。');
}

async function convertOne(url, preset, directory, maxFileBytes) {
  const { format, audioKbps = 320, maxVideoHeight = 1080 } = preset;
  let ytDlp = await ensureYtDlp();
  const output = format === 'mp4'
    ? join(directory, 'source-video.%(ext)s')
    : join(directory, '%(title).80B.%(ext)s');
  // yt-dlpへ --ffmpeg-location を渡さない。クラウドにffprobeが無い状態で
  // yt-dlpの後処理が走ると、公開URLでも変換全体が失敗してしまうため。
  const options = mediaDownloadOptions(url, format, output, { maxVideoHeight });
  try {
    await executeYtDlp(ytDlp, options);
  } catch (firstError) {
    // YouTube等のBot確認・アクセス拒否は、再試行や更新で解消できない。
    // 無意味な更新取得や同じURLへの連続アクセスをせず、明確な案内を返す。
    if (isMediaSourceAccessRestricted(firstError) || firstError?.code === 'MEDIA_DOWNLOAD_TIMEOUT') throw mediaFailure(format, firstError);
    // YouTube等は取得仕様が更新されることがある。既存のyt-dlpが古い場合は
    // 最新版に一度だけ差し替えてから同じURLを再試行する。
    try {
      ytDlp = await ensureYtDlp({ forceRefresh: true });
      await executeYtDlp(ytDlp, options);
    } catch (retryError) {
      throw mediaFailure(format, retryError || firstError);
    }
  }

  const files = await readdir(directory);
  if (format === 'mp3') {
    const sources = files.filter((name) => !['.part', '.ytdl', '.json'].includes(extname(name).toLowerCase()));
    if (sources.length !== 1) throw new Error('音声ファイルを1件に確定できませんでした。プレイリストではない単一のURLを指定してください。');
    const sourcePath = join(directory, sources[0]);
    const outputPath = join(directory, 'audio-discord.mp3');
    try {
      await runFfmpeg(['-y', '-i', sourcePath, '-vn', '-c:a', 'libmp3lame', '-b:a', `${audioKbps}k`, outputPath]);
    } catch (error) {
      throw mediaFailure('mp3', error);
    }
    const file = { name: `${sources[0].replace(/\.[^.]+$/u, '')}-discord.mp3`, path: outputPath, size: (await stat(outputPath)).size };
    return [await fitToDiscordLimit(file, 'mp3', directory, maxFileBytes)];
  }

  const videoSourceName = files.find((name) => name.startsWith('source-video.') && MEDIA_SOURCE_EXTENSIONS.has(extname(name).toLowerCase()));
  if (!videoSourceName) throw new Error('動画ファイルを取得できませんでした。');
  const videoSourcePath = join(directory, videoSourceName);
  const hasVideo = await sourceHasVideo(videoSourcePath);
  let audioSourcePath = null;

  // 分離配信のYouTube動画には音声が含まれないため、音声ストリームを別取得する。
  // SoundCloud等の音声専用URLでは最初の取得物をそのまま静止画付きMP4へ変換する。
  if (hasVideo) {
    const audioOutput = join(directory, 'source-audio.%(ext)s');
    const audioOptions = mediaDownloadOptions(url, 'mp3', audioOutput);
    try {
      await executeYtDlp(ytDlp, audioOptions);
    } catch (firstAudioError) {
      try {
        ytDlp = await ensureYtDlp({ forceRefresh: true });
        await executeYtDlp(ytDlp, audioOptions);
      } catch (retryAudioError) {
        throw mediaFailure('mp4', retryAudioError || firstAudioError);
      }
    }
    const refreshedFiles = await readdir(directory);
    const audioSourceName = refreshedFiles.find((name) => name.startsWith('source-audio.') && MEDIA_SOURCE_EXTENSIONS.has(extname(name).toLowerCase()));
    if (!audioSourceName) throw new Error('動画の音声ストリームを取得できませんでした。');
    audioSourcePath = join(directory, audioSourceName);
  }

  const outputName = 'video-discord.mp4';
  const outputPath = join(directory, outputName);
  try {
    const argumentsForSource = hasVideo
      ? mp4MergeArguments(videoSourcePath, audioSourcePath, outputPath, maxVideoHeight)
      : audioOnlyMp4Arguments(videoSourcePath, outputPath);
    await runFfmpeg(argumentsForSource);
  } catch (error) {
    throw mediaFailure('mp4', error);
  }
  const converted = { name: outputName, path: outputPath, size: (await stat(outputPath)).size };
  return [await fitToDiscordLimit(converted, 'mp4', directory, maxFileBytes)];
}

export function buildMediaConverterPanel() {
  return {
    embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🎵 動画・音声ファイル変換')
      .setDescription('YouTube、SoundCloud、その他の対応した公開メディアURLを、**あなたのDMだけ**へMP3またはMP4として送信します。')
      .addFields(
        { name: '🔒 所有者専用', value: 'このチャンネルはBot所有者だけが閲覧・実行できます。変換ファイルは実行した所有者のDMだけへ送信します。' },
        { name: '⚖️ 利用条件', value: '自作・購入済み・明示的な許諾・利用規約で保存が許可されたコンテンツだけを指定してください。権利確認への同意が必要です。' },
        { name: '🎚️ 出力品質', value: 'MP3は128/320kbps、MP4は720/1080p・最大60fpsから選択できます。元動画に存在しない品質への引き上げは行いません。' },
        { name: '📦 サイズ上限', value: 'DMで確実に受信できるよう、1ファイルは8MiB未満に自動最適化します。指定品質で上限を超える場合だけ、音質・映像ビットレートを自動調整します。' },
        { name: '⚠️ YouTubeの制限', value: 'クラウド環境からの自動取得をYouTube側が制限した動画は、MP3・MP4とも変換できません。認証情報・Cookieを使った回避は行いません。' },
      ).setFooter({ text: '対応外URL・DRM保護・ライブ配信・プレイリストは変換できません。' })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('media:convert:mp3-128').setLabel('MP3 128kbps').setEmoji('🎧').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('media:convert:mp3-320').setLabel('MP3 320kbps').setEmoji('🎵').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('media:convert:mp4-720').setLabel('MP4 720p').setEmoji('🎬').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('media:convert:mp4-1080').setLabel('MP4 1080p').setEmoji('📺').setStyle(ButtonStyle.Success),
    )],
  };
}

export async function enforceMediaConverterChannelPermissions(channel, { ownerId = MEDIA_CONVERTER_OWNER_ID, botId }) {
  if (!channel?.guild || !botId) throw new Error('変換チャンネルまたはBot情報が不足しています。');
  const everyoneId = channel.guild.roles.everyone.id;
  const expectedIds = new Set([everyoneId, ownerId, botId]);
  const existing = [...channel.permissionOverwrites.cache.values()];
  const everyone = channel.permissionOverwrites.cache.get(everyoneId);
  const owner = channel.permissionOverwrites.cache.get(ownerId);
  const bot = channel.permissionOverwrites.cache.get(botId);
  const alreadyStrict = existing.every((overwrite) => expectedIds.has(overwrite.id))
    && everyone?.deny.has(PermissionFlagsBits.ViewChannel)
    && owner?.allow.has(PermissionFlagsBits.ViewChannel)
    && owner?.allow.has(PermissionFlagsBits.ReadMessageHistory)
    && bot?.allow.has(PermissionFlagsBits.ViewChannel)
    && bot?.allow.has(PermissionFlagsBits.SendMessages)
    && bot?.allow.has(PermissionFlagsBits.ReadMessageHistory);

  if (alreadyStrict) return false;
  await channel.permissionOverwrites.set([
    { id: everyoneId, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    { id: ownerId, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] },
    { id: botId, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageChannels] },
  ], 'メディア変換チャンネルをBot所有者専用に固定');
  return true;
}

export async function publishMediaConverterPanel(client) {
  const channel = await client.channels.fetch(MEDIA_CONVERTER_CHANNEL_ID).catch(() => null);
  if (!channel?.isTextBased()) throw new Error('メディア変換パネルの投稿先チャンネルを利用できません。');
  await enforceMediaConverterChannelPermissions(channel, { botId: client.user.id });
  if (!channel.isSendable()) throw new Error('メディア変換パネルの投稿先チャンネルへ送信できません。');
  const messages = await channel.messages.fetch({ limit: 50 });
  const existing = messages.find((message) => message.author.id === client.user.id && message.embeds[0]?.title === '🎵 動画・音声ファイル変換');
  if (existing) return existing.edit(buildMediaConverterPanel());
  return channel.send(buildMediaConverterPanel());
}

export function isMediaConverterInteraction(interaction) {
  return interaction.customId?.startsWith('media:convert:');
}

export function isMediaConverterOwner(userId) {
  return String(userId || '') === MEDIA_CONVERTER_OWNER_ID;
}

export async function handleMediaConverterInteraction(interaction) {
  if (interaction.channelId !== MEDIA_CONVERTER_CHANNEL_ID) throw new Error('この変換パネルは指定チャンネル内でのみ利用できます。');
  // DiscordのAdministrator権限はチャンネル上書きを回避できるため、表示権限だけに
  // 依存せず、操作そのものもBot所有者IDへ固定する。
  if (!isMediaConverterOwner(interaction.user?.id)) throw new Error('この変換パネルはBot所有者だけが利用できます。');
  if (interaction.isButton()) {
    const presetId = interaction.customId.split(':')[2];
    if (!MEDIA_PRESETS[presetId]) throw new Error('この変換パネルは更新されました。品質を選び直してください。');
    return interaction.showModal(new ModalBuilder().setCustomId(`media:convert:${presetId}:submit`).setTitle('メディアを変換')
      .addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('url').setLabel('動画・曲のURL').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(1_000).setPlaceholder('https://...')),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('rights').setLabel('権利確認').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20).setPlaceholder('「同意する」と入力')),
      ));
  }
  const [, , presetId] = interaction.customId.split(':');
  const preset = MEDIA_PRESETS[presetId];
  if (!preset) throw new Error('この変換画面は更新されました。もう一度パネルから品質を選択してください。');
  const { format } = preset;
  const url = assertSafeMediaUrl(interaction.fields.getTextInputValue('url').trim());
  if (interaction.fields.getTextInputValue('rights').trim() !== '同意する') throw new Error('権利確認欄へ「同意する」と入力してください。');
  if (activeJobs.has(interaction.user.id)) throw new Error('すでに変換処理が進行中です。完了までお待ちください。');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.editReply('⏳ 取得と変換を開始しました。進行中はこの表示を閉じずにお待ちください。長時間完了しない場合は放置せず、失敗理由を返します。');
  let directory;
  const startedAt = Date.now();
  let progressTimer;
  activeJobs.add(interaction.user.id);
  try {
    progressTimer = setInterval(() => {
      const elapsedMinutes = Math.max(1, Math.floor((Date.now() - startedAt) / 60_000));
      interaction.editReply(`⏳ 取得・変換・サイズ調整を実行中です（約${elapsedMinutes}分経過）。処理は停止していません。`).catch(() => {});
    }, MEDIA_PROGRESS_UPDATE_MS);
    await mkdir(TEMP_ROOT, { recursive: true });
    directory = await mkdtemp(join(TEMP_ROOT, 'job-'));
    const maxFileBytes = resolveDmFileLimit(interaction.attachmentSizeLimit);
    const formatDirectory = join(directory, format);
    await mkdir(formatDirectory, { recursive: true });
    const outputs = await convertOne(url, preset, formatDirectory, maxFileBytes);
    if (outputs.length !== 1) throw new Error('変換結果を1件に確定できませんでした。プレイリストではない単一のURLを指定してください。');
    const [file] = outputs;
    const sentMessage = await interaction.user.send({
      content: '✅ 変換が完了しました。',
      files: [new AttachmentBuilder(file.path, { name: file.name })],
      allowedMentions: { parse: [] },
    });
    await interaction.client.dmHistoryStore?.track(sentMessage);
    await interaction.editReply('✅ 変換ファイルをあなたのDMへ送信しました。');
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    activeJobs.delete(interaction.user.id);
    if (directory) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try { await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 250 }); break; }
        catch (error) {
          if (attempt === 2) await interaction.client.reportRuntimeError?.('メディア変換の一時ファイル削除', error, [{ name: '操作ユーザーID', value: `\`${interaction.user.id}\`` }]);
          else await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
    }
  }
}
