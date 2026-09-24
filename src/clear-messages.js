const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1_000;
const BULK_DELETE_SAFETY_MS = 60_000;

export async function deleteRequestedMessages(channel, requestedCount, { now = Date.now() } = {}) {
  const selected = [];
  let before;
  while (selected.length < requestedCount) {
    const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!page.size) break;
    for (const message of page.values()) {
      if (message.deletable !== false) selected.push(message);
      if (selected.length === requestedCount) break;
    }
    if (page.size < 100) break;
    before = [...page.keys()].at(-1);
    if (!before) break;
  }

  const cutoff = now - BULK_DELETE_MAX_AGE_MS + BULK_DELETE_SAFETY_MS;
  const recent = selected.filter((message) => message.createdTimestamp >= cutoff);
  const old = selected.filter((message) => message.createdTimestamp < cutoff);
  const deletedIds = new Set();

  if (recent.length >= 2) {
    const deleted = await channel.bulkDelete(recent, true);
    for (const id of deleted.keys()) deletedIds.add(id);
  }
  for (const message of [...recent, ...old]) {
    if (deletedIds.has(message.id)) continue;
    try {
      await message.delete();
      deletedIds.add(message.id);
    } catch {
      // A message may disappear between fetch and deletion. Count only confirmed deletions.
    }
  }

  return { requested: requestedCount, found: selected.length, deleted: deletedIds.size };
}
