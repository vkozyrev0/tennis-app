// Request chunking for the Inbox bulk actions. Pure: no DOM, no fetch.
//
// Reprocess range used to POST one email id per request, so a range of N stored
// copies issued N sequential requests and read as an endless loop in the
// overlay. The bulk endpoint already takes a list, so a range is sent as a few
// chunks instead.

/**
 * Split ids into per-request chunks: every id appears exactly once, in order,
 * and there are at most ceil(ids.length / maxPerRequest) chunks.
 */
export function classifyChunks(ids, { maxPerRequest = 50 } = {}) {
  if (!Array.isArray(ids) || !ids.length) return [];
  const size = Number.isFinite(maxPerRequest) && maxPerRequest >= 1
    ? Math.floor(maxPerRequest)
    : 50;
  const chunks = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}

/** Overlay counters once chunk `chunkIndex` has been answered. */
export function progressAfter(chunks, chunkIndex) {
  const list = Array.isArray(chunks) ? chunks : [];
  const done = Math.min(Math.max(chunkIndex + 1, 0), list.length);
  let current = 0;
  for (let i = 0; i < done; i++) current += list[i].length;
  let total = 0;
  for (const c of list) total += c.length;
  return { current, total };
}
