import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function releaseId(release) {
  return release.id || hash(JSON.stringify({ version: release.version, title: release.title, description: release.description, target: release.target, verification: release.verification }));
}

async function readState(file) {
  try {
    const state = JSON.parse(await readFile(file, 'utf8'));
    return state && typeof state.releases === 'object' ? state : { releases: {} };
  } catch (error) {
    if (error.code === 'ENOENT') return { releases: {} };
    throw error;
  }
}

async function writeState(file, state) {
  await mkdir(new URL('.', file), { recursive: true });
  const temporary = new URL(`${file.href}.tmp`);
  await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
  await rename(temporary, file);
}

export function createReleasePublisher({ stateFile = new URL('../data/release-state.json', import.meta.url), send }) {
  let inFlight = null;
  return {
    async publish(release) {
      if (inFlight) return inFlight;
      inFlight = (async () => {
        const id = releaseId(release);
        const state = await readState(stateFile);
        if (state.releases[id]) return { published: false, releaseId: id, reason: state.releases[id].status };

        // Reserve before the network request. If Discord accepts a request but its
        // response is lost, a restart must prefer no duplicate over a repost.
        state.releases[id] = { status: 'reserved', version: release.version, reservedAt: new Date().toISOString() };
        await writeState(stateFile, state);
        const message = await send(release);
        state.releases[id] = { ...state.releases[id], status: 'sent', messageId: message?.id || null, sentAt: new Date().toISOString() };
        await writeState(stateFile, state);
        return { published: true, releaseId: id, messageId: message?.id || null };
      })().finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}
