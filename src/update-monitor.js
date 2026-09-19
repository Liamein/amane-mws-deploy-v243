import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EmbedBuilder } from 'discord.js';

export const UPDATE_LOG_CHANNEL_ID = '1543145283687555183';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STATE_FILE = new URL('../data/update-monitor.json', import.meta.url);
const RUNTIME_DIRECTORIES = new Set(['.git', 'data', 'node_modules', '.cache', 'tmp', 'temp']);
const CONFIG_ENV_KEYS = [
  'DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'COMMAND_OWNER_IDS',
  'BOT_INSTALL_LOG_CHANNEL_ID', 'BOT_DM_LOG_CHANNEL_ID', 'MBTI_WELCOME_CHANNEL_ID',
  'DISCORD_GUILD_ID', 'INACTIVITY_AUTOMATION_ENABLED', 'INACTIVITY_EXEMPT_ROLE_IDS',
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function hashFile(path) {
  try {
    return sha256(await readFile(join(ROOT, path)));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function scanDirectory(path, manifest) {
  let entries;
  try {
    entries = await readdir(join(ROOT, path), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relativePath = path ? `${path}/${entry.name}` : entry.name;
    if (entry.isDirectory() && !RUNTIME_DIRECTORIES.has(entry.name)) await scanDirectory(relativePath, manifest);
    else if (entry.isFile() && !/\.(?:log|tmp)$/i.test(entry.name)) manifest[relativePath] = await hashFile(relativePath);
  }
}

export async function buildUpdateManifest(env = process.env) {
  const manifest = {};
  await scanDirectory('', manifest);
  // Store only a digest. Tokens and other environment variable values never enter Discord or the state file.
  manifest['@environment'] = sha256(JSON.stringify(CONFIG_ENV_KEYS.map((key) => [key, env[key] ?? null])));
  return manifest;
}

export function changedUpdatePaths(previous = {}, current = {}) {
  return [...new Set([...Object.keys(previous), ...Object.keys(current)])]
    .filter((path) => previous[path] !== current[path])
    .sort()
    .map((path) => path === '@environment' ? '環境変数設定' : path === '.env' ? '環境設定ファイル' : path);
}

async function readState() {
  try {
    const state = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    return state && typeof state.manifest === 'object' && state.manifest ? state : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeState(manifest, fingerprint) {
  await mkdir(new URL('.', STATE_FILE), { recursive: true });
  const temporary = new URL('../data/update-monitor.json.tmp', import.meta.url);
  await writeFile(temporary, JSON.stringify({ manifest, fingerprint, notifiedAt: new Date().toISOString() }, null, 2), 'utf8');
  await rename(temporary, STATE_FILE);
}

export function createUpdateMonitor(discord, { version, release, intervalMs = 60_000 } = {}) {
  let inFlight = null;
  let timer = null;

  async function check() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const manifest = await buildUpdateManifest();
      const fingerprint = sha256(JSON.stringify(manifest));
      const previous = await readState();
      if (previous?.fingerprint === fingerprint) return false;

      const channel = await discord.channels.fetch(UPDATE_LOG_CHANNEL_ID);
      if (!channel?.isTextBased() || !channel?.isSendable()) {
        throw new Error(`更新記録チャンネル ${UPDATE_LOG_CHANNEL_ID} に送信できません。`);
      }
      const changes = changedUpdatePaths(previous?.manifest, manifest);
      const confirmed = release || {};
      const now = new Date();
      const timestamp = new Intl.DateTimeFormat('ja-JP', {
        timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(now).replaceAll('/', '/');
      await channel.send({
        embeds: [new EmbedBuilder()
          .setColor(0x7b61ff)
          .setTitle(`✅ ${confirmed.title || 'あまねBotを更新しました'}`)
          .setDescription(confirmed.description || '実際に検出した更新を反映しました。')
          .addFields(
            { name: '対象', value: confirmed.target || `${changes.length}件の変更を反映`, inline: false },
            { name: '確認', value: confirmed.verification || '更新内容を記録しました。', inline: false },
          )
          .setFooter({ text: `アップデート記録 • v${version ?? '未設定'} • ${timestamp}` })
          .setTimestamp(now)],
        allowedMentions: { parse: [] },
      });
      await writeState(manifest, fingerprint);
      console.log(`Bot更新を記録しました (${changes.length} 件)。`);
      return true;
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => check().catch((error) => console.error('Bot更新記録に失敗しました:', error)), intervalMs);
    timer.unref();
  }

  return { check, start };
}
