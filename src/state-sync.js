import { mkdir, readFile, readdir, watch, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const DATA_DIRECTORY = fileURLToPath(new URL('../data/', import.meta.url));
const SNAPSHOT_KEY = 'discord-bot-state';
const SNAPSHOT_TABLE = 'bot_state_snapshots';
const SAVE_DELAY_MS = 1_000;
const PERIODIC_SYNC_MS = 60_000;

function cloudStateConfig(env = process.env) {
  const url = env.SUPABASE_URL?.trim().replace(/\/+$/, '');
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url && !serviceRoleKey) return null;
  if (!url || !serviceRoleKey) throw new Error('SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY は両方設定してください。');
  return {
    url,
    serviceRoleKey,
    stateKey: env.CLOUD_STATE_KEY?.trim() || SNAPSHOT_KEY,
  };
}

function headers(serviceRoleKey, extra = {}) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    ...extra,
  };
}

function stateEndpoint(config) {
  return `${config.url}/rest/v1/${SNAPSHOT_TABLE}`;
}

function assertSafeFileName(fileName) {
  if (!/^[a-z0-9][a-z0-9-]*\.json$/i.test(fileName)) throw new Error(`不正な状態ファイル名です: ${fileName}`);
  return fileName;
}

export async function readLocalStateSnapshot(directory = DATA_DIRECTORY) {
  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name).sort();
  const payload = {};
  for (const fileName of files) {
    assertSafeFileName(fileName);
    const source = await readFile(join(directory, fileName), 'utf8');
    payload[fileName] = JSON.parse(source);
  }
  return payload;
}

async function fetchRemoteSnapshot(config, fetchImpl = fetch) {
  const requestUrl = new URL(stateEndpoint(config));
  requestUrl.searchParams.set('state_key', `eq.${config.stateKey}`);
  requestUrl.searchParams.set('select', 'payload');
  const response = await fetchImpl(requestUrl, { headers: headers(config.serviceRoleKey) });
  if (!response.ok) throw new Error(`状態データの取得に失敗しました (${response.status})。`);
  const rows = await response.json();
  const payload = rows?.[0]?.payload;
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
}

async function writeLocalStateSnapshot(payload, directory = DATA_DIRECTORY) {
  await mkdir(directory, { recursive: true });
  for (const [fileName, value] of Object.entries(payload)) {
    assertSafeFileName(fileName);
    await writeFile(join(directory, fileName), JSON.stringify(value, null, 2), 'utf8');
  }
}

async function saveRemoteSnapshot(config, payload, fetchImpl = fetch) {
  const response = await fetchImpl(`${stateEndpoint(config)}?on_conflict=state_key`, {
    method: 'POST',
    headers: headers(config.serviceRoleKey, {
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    }),
    body: JSON.stringify({ state_key: config.stateKey, payload, updated_at: new Date().toISOString() }),
  });
  if (!response.ok) throw new Error(`状態データの保存に失敗しました (${response.status})。`);
}

/**
 * Keeps the existing JSON-based settings durable on stateless cloud services.
 * Without SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY this is intentionally a no-op,
 * so local development continues to use the current data directory unchanged.
 */
export async function startCloudStateSync({ env = process.env, directory = DATA_DIRECTORY, fetchImpl = fetch } = {}) {
  const config = cloudStateConfig(env);
  if (!config) return { enabled: false, async stop() {} };

  const remotePayload = await fetchRemoteSnapshot(config, fetchImpl);
  if (remotePayload) {
    await writeLocalStateSnapshot(remotePayload, directory);
    console.log(`クラウド設定を復元しました (${Object.keys(remotePayload).length}件)。`);
  } else {
    const localPayload = await readLocalStateSnapshot(directory);
    if (Object.keys(localPayload).length) {
      await saveRemoteSnapshot(config, localPayload, fetchImpl);
      console.log(`クラウド設定を初回保存しました (${Object.keys(localPayload).length}件)。`);
    }
  }

  let pending = false;
  let saving = Promise.resolve();
  let timer;
  const sync = async () => {
    const payload = await readLocalStateSnapshot(directory);
    if (!Object.keys(payload).length) return;
    await saveRemoteSnapshot(config, payload, fetchImpl);
  };
  const enqueueSync = () => {
    if (pending) return;
    pending = true;
    saving = saving
      .then(async () => {
        pending = false;
        await sync();
      })
      .catch((error) => {
        pending = false;
        console.error(`クラウド設定の同期に失敗しました: ${error.message}`);
      });
  };
  const scheduleSync = () => {
    clearTimeout(timer);
    timer = setTimeout(enqueueSync, SAVE_DELAY_MS);
  };
  const watchAbortController = new AbortController();
  const watcher = watch(directory, { persistent: false, signal: watchAbortController.signal });
  const watchTask = (async () => {
    try {
      for await (const event of watcher) if (event.filename?.endsWith('.json')) scheduleSync();
    } catch (error) {
      if (error?.name !== 'AbortError') console.error(`クラウド設定の監視に失敗しました: ${error.message}`);
    }
  })();
  const interval = setInterval(enqueueSync, PERIODIC_SYNC_MS);
  console.log('クラウド設定の永続同期を有効にしました。');

  return {
    enabled: true,
    async stop() {
      clearTimeout(timer);
      clearInterval(interval);
      watchAbortController.abort();
      enqueueSync();
      await saving;
      await watchTask;
    },
  };
}
