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

function abortError() {
  const err = new Error("cancelled");
  err.name = "AbortError";
  return err;
}

/**
 * Parse every id, asking the server for the remainder until nothing is left.
 *
 * The server bounds each request with a model budget and answers with the ids
 * it actually processed, so this loop:
 *   - sends the whole range in one request when the server can do it all,
 *   - keeps asking for the tail when the budget stopped the pass early,
 *   - advances progress by COPIES PARSED, so the bar only reaches the total
 *     when nothing is left (never stuck at 100% while work remains),
 *   - stops instead of spinning when a request makes no progress,
 *   - stops at `budgetMs` of wall clock and reports the remainder, so a slow
 *     or unreachable model cannot turn one press into an hours-long grind.
 *
 * `call(batch, signal)` must resolve to `{ processed_ids, leftover_calls }`.
 * Returns `{ parsed, remaining, requests, leftoverCalls, stopped, reason }`.
 */
export async function runReprocessPass(ids, call, {
  chunks = null, onProgress = null, isCancelled = null, signal = undefined,
  budgetMs = 300000, now = () => Date.now(),
} = {}) {
  const list = Array.isArray(ids) ? ids : [];
  const total = list.length;
  const batches = chunks || classifyChunks(list);
  const started = now();
  let parsed = 0;
  let requests = 0;
  let leftoverCalls = 0;
  let stopped = false;
  let reason = null;
  const report = () => {
    if (typeof onProgress === "function") onProgress({ parsed, total, requests });
  };
  report();
  for (const batch of batches) {
    let pending = batch.slice();
    while (pending.length) {
      if ((typeof isCancelled === "function" && isCancelled()) || (signal && signal.aborted)) {
        throw abortError();
      }
      const res = (await call(pending, signal)) || {};
      requests += 1;
      leftoverCalls += res.leftover_calls || 0;
      const processed = Array.isArray(res.processed_ids) ? res.processed_ids : [];
      const doneSet = new Set(processed);
      const next = pending.filter((id) => !doneSet.has(id));
      parsed += pending.length - next.length;
      report();
      // Nothing came back: the budget is spent or the endpoint refused. Stop
      // and let the caller report the remainder instead of looping forever.
      if (next.length >= pending.length) { stopped = true; reason = "no-progress"; break; }
      if (now() - started >= budgetMs) { stopped = true; reason = "budget"; break; }
      pending = next;
    }
    if (stopped) break;
  }
  return { parsed, remaining: Math.max(0, total - parsed), requests, leftoverCalls, stopped, reason };
}
